/**
 * 测试职责：两入口实际执行全部任务操作与租约/意图/独立审计分支。
 * 典型流程：对 native/MCP 各运行同一工作流并核对持久状态和权限拒绝。
 * 覆盖边界：覆盖 业务效果、注册 op 穷举；不把渲染字符串当成状态证明。；不覆盖真实用户数据与 LLM 推理。
 * 外部前置：Node、合成临时文件与回环 HTTP；不允许跳过。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, text, error } from '../helpers/agent-parity-fixture.mjs';
import { TASK_OPS } from '../../lib/shared/contract.js';

// 责任：两入口各执行所有任务操作，并断言意图、租约和审计门状态。
for (const channel of ['native', 'mcp']) test(channel + ' covers the entire task state machine with DSH behavior', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.wsDir, 'artifact.txt'), 'synthetic verified artifact');
  const worker = await f.open();
  const reviewer = await f.open();
  await f.h.attach({ sessionId: f.exec.agent.id, agentId: f.exec.agent.id, source: 'tool', role: 'worker' });
  const ops = new Set();
  const invoke = async (name, args, who = worker, denial) => {
    if (name === 'project_task') ops.add(args.op);
    if (channel === 'mcp') {
      const response = await f.call(name, { ...args, context: who.context });
      return denial ? error(response, denial) : text(response);
    }
    const exec = who === worker ? f.exec : { ...f.exec, agent: { ...f.exec.agent, id: 'native-reviewer' } };
    if (denial) return assert.rejects(f.nativeCall(name, args, exec), { code: denial });
    const value = await f.nativeCall(name, args, exec);
    assert.ok(f.render(name, args, value).length);
    return value;
  };
  const create = async (title, extra = {}) => {
    const before = new Set(Object.keys(f.h.state.tasks));
    await invoke('project_task', { op: 'create', title, acceptance: [{ text: 'artifact exists', requiredKinds: ['file'] }], ...extra });
    return Object.keys(f.h.state.tasks).find((id) => !before.has(id));
  };
  const task = async (id, op, extra = {}, who = worker, denial) => invoke('project_task', {
    op, taskId: id, expectedRev: f.h.state.tasks[id].rev,
    ...(f.h.leases.has(id) ? { fencingToken: f.h.leases.get(id).token } : {}), ...extra,
  }, who, denial);
  const dep = await create('dependency');
  const id = await create('full workflow', { deps: [dep] });
  assert.equal(f.h.state.tasks[id].state, 'backlog');
  await task(id, 'ready', {}, worker, 'dependency-unmet');
  await task(id, 'update', { deps: [] });
  await task(id, 'ready');
  await task(id, 'gate', { requiresAudit: true });
  await task(id, 'gate', { requiresAudit: false }, worker, 'forbidden-role');
  await task(id, 'claim');
  const firstToken = f.h.leases.get(id).token;
  await task(id, 'begin', { summary: 'Must not take another agent work' }, reviewer, 'lease-held');
  await task(id, 'begin', { summary: 'Synthetic implementation' });
  await task(id, 'renew');
  await task(id, 'renew');
  assert.equal(f.h.leases.get(id).renewCount, 2);
  assert.equal(Object.hasOwn(f.h.leases.get(id), 'mcpRenewals'), false, 'no transport-specific lease payload or dedupe state');
  await task(id, 'renew', {}, worker, 'lease-expired');
  await task(id, 'block', { code: 'waiting', intent: { outcome: 'stopped', sideEffects: [] } });
  await task(id, 'unblock', { note: 'ready to continue' });
  assert.equal(f.h.state.tasks[id].state, 'in_progress');
  assert.ok(f.h.leases.get(id).token > firstToken, 'unblock automatically resumes the original assignee');
  await task(id, 'begin', { summary: 'Resume implementation' });
  await task(id, 'release', { intent: { outcome: 'stopped', sideEffects: [] } });
  await task(id, 'claim');
  await task(id, 'begin', { summary: 'Observe interrupted work' });
  await task(id, 'interrupt', { note: 'Unknown external outcome', sideEffects: [] });
  await task(id, 'reconcile', { choice: 'resume', note: 'Observed the synthetic artifact and continue' });
  const evidence = () => [{ kind: 'file', ref: 'artifact.txt', acceptanceId: f.h.state.tasks[id].acceptance[0].id }];
  await task(id, 'submit', { evidence: evidence() });
  assert.equal(f.h.state.tasks[id].state, 'review');
  await task(id, 'verify', { audit: { report: 'Self verification must not satisfy the independent audit gate.' } }, worker, 'forbidden-role');
  await task(id, 'reject', { reason: 'Exercise independent review rework' }, reviewer);
  assert.equal(f.h.state.tasks[id].state, 'in_progress', 'reject automatically resumes the original assignee');
  assert.ok(f.h.leases.has(id));
  await task(id, 'begin', { summary: 'Complete requested rework' });
  await task(id, 'submit', { evidence: evidence() });
  await task(id, 'verify', { audit: { report: 'Independent fixture reviewer inspected artifact content and acceptance coverage.' } }, reviewer);
  assert.equal(f.h.state.tasks[id].state, 'done');
  assert.equal(f.h.state.tasks[id].lastAudit.verdict, 'pass');
  await task(id, 'reopen', {}, worker, 'forbidden-role');
  await task(dep, 'cancel', { reason: 'Synthetic unused dependency' });
  assert.equal(f.h.state.tasks[dep].state, 'canceled');
  for (const op of ['checkpoint', 'handoff']) await invoke('project_session', { op, note: 'Synthetic workflow complete', nextActions: [] });
  assert.deepEqual([...ops].sort(), [...TASK_OPS].sort(), 'any new task op requires an explicit end-to-end regression');
});

// 责任：并发首次调用只绑定一次，独立上下文竞争只产生一个有效租约。
test('parallel first calls attach once; separate logical agents compete for one lease', async (t) => {
  const f = await fixture(t);
  const one = await f.open(), two = await f.open();
  const before = f.h.rev;
  await Promise.all([1, 2, 3].map(() => f.call('project_board', { view: 'health', context: one.context })));
  assert.equal(f.h.rev, before, 'reads never attach a session or bump the project rev');
  text(await f.call('project_task', { op: 'create', title: 'competition', acceptance: [{ text: 'done' }], context: one.context }));
  const id = Object.keys(f.h.state.tasks)[0];
  const responses = await Promise.all([one, two].map(({ context }) => f.call('project_task', { op: 'claim', taskId: id, expectedRev: 1, context })));
  assert.equal(responses.filter((r) => !r.result.isError).length, 1);
  assert.equal(f.h.leases.size, 1);
  const token = f.h.leases.get(id).token;
  await f.call('project_board', { view: 'health', context: one.context });
  assert.equal(f.h.leases.get(id).token, token, 'subsequent calls must never reattach and revoke');
});
