/**
 * 测试职责：保证历史签名材料与旧 auto 策略冷重放不改历史，新工作遵守人工验收。
 * 典型流程：构造旧日志与缺失/损坏执行密钥 → 子进程冷开或重开任务 → 对照历史字节及有效策略。
 * 覆盖边界：覆盖 历史证据保留、密钥不修写与新 attempt 的 review 边界；不覆盖真实旧宿主执行。
 * 外部前置：无；子进程使用当前 Node，旧签名由 fixture 生成。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectService } from '../../lib/core/service.js';
import { makeCommit } from '../../lib/core/store.js';
import { signExecution } from '../fixtures/legacy-execution.mjs';

const childFixture = path.join(import.meta.dirname, '../fixtures/evidence-restart-child.mjs');
function cmd(op, extra = {}) {
  return { cmdId: crypto.randomUUID(), actor: { kind: 'human', via: 'test' }, op, ...extra };
}
async function legacyStore(state) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-legacy-'));
  const svc = new ProjectService({ rootDir });
  await svc.init();
  const h = await svc.createProject({ workspacePath: rootDir });
  const result = await h.command(cmd('task.create', { title: 'historical signed material', acceptance: [{ text: 'record' }] }));
  const id = result.events[0].taskId;
  await h.command(cmd('task.claim', { taskId: id, expected: { entityRev: h.state.tasks[id].rev } }));
  const token = h.leases.get(id).token;
  await h.command(cmd('task.begin', { taskId: id, expected: { entityRev: h.state.tasks[id].rev }, fencingToken: token, summary: 'historical host observation' }));
  const task = structuredClone(h.state.tasks[id]);
  const execution = {
    executor: 'host', status: 'ok', exitCode: 0, signal: null, timedOut: false,
    stdoutHash: crypto.createHash('sha256').update('').digest('hex'), stderrHash: crypto.createHash('sha256').update('').digest('hex'), outputBytes: 0,
    proofVersion: 2, taskId: id, attempt: task.work.attempt, intentId: task.work.intentId, token,
    cwd: rootDir, executedAt: '2025-01-01T00:00:00.000Z', commandHash: crypto.createHash('sha256').update('old-unavailable-command').digest('hex'),
  };
  execution.proof = signExecution(execution);
  task.state = state;
  task.owner = null;
  task.rev += state === 'done' ? 2 : 1;
  task.acceptance[0].met = true;
  task.acceptance[0].evidenceIds = ['ev_historical_signed'];
  task.evidence = [{ id: 'ev_historical_signed', taskId: id, kind: 'command', ref: 'old-unavailable-command', hash: null, execution, acceptanceId: task.acceptance[0].id, at: '2025-01-01T00:00:00.000Z' }];
  if (state === 'done') { task.verifiedBy = 'policy'; task.verifiedAt = '2025-01-01T00:00:00.000Z'; }
  const project = structuredClone(h.state.project);
  project.policy.verification = 'auto';
  const intent = h.state.intents[task.work.intentId];
  const submitted = { ...structuredClone(task), state: 'review' };
  if (state === 'done') { submitted.rev -= 1; delete submitted.verifiedBy; delete submitted.verifiedAt; }
  const events = [
    { type: 'project/updated', data: project },
    { type: 'work/result', taskId: id, data: { ...intent, status: 'closed', closedAt: '2025-01-01T00:00:00.000Z' } },
    { type: 'task/submitted', taskId: id, rev: submitted.rev, data: submitted },
  ];
  if (state === 'done') events.push({ type: 'task/verified', taskId: id, rev: task.rev, data: task });
  const commit = makeCommit(h.rev + 1, h.lastHash, { kind: 'system' }, 'historical_signed_policy', h.rev, events);
  h.store.append(commit);
  const projectId = h.id;
  await svc.close();
  return { rootDir, projectId, id, task, project, commit };
}
// 责任：旧 policy 完成任务重开后新 submit 必须停 review，历史 execution 保留并 supersede，有效策略为 manual。
test('a cold historical auto-policy done task reopens under the manual review boundary', async () => {
  const fixture = await legacyStore('done');
  const svc = new ProjectService({ rootDir: fixture.rootDir });
  await svc.init();
  const h = await svc.open(fixture.projectId);
  try {
    assert.equal(h.state.tasks[fixture.id].verifiedBy, 'policy');
    await h.command(cmd('task.reopen', { taskId: fixture.id, expected: { entityRev: h.state.tasks[fixture.id].rev }, reason: 'new attempt' }));
    await h.command(cmd('task.claim', { taskId: fixture.id, expected: { entityRev: h.state.tasks[fixture.id].rev } }));
    const token = h.leases.get(fixture.id).token;
    await h.command(cmd('task.begin', { taskId: fixture.id, expected: { entityRev: h.state.tasks[fixture.id].rev }, fencingToken: token, summary: 'new attempt' }));
    fs.writeFileSync(path.join(fixture.rootDir, 'artifact.txt'), 'new observed content');
    await h.command(cmd('task.submit', { taskId: fixture.id, expected: { entityRev: h.state.tasks[fixture.id].rev }, fencingToken: token, evidence: [{ kind: 'file', ref: 'artifact.txt', acceptanceId: h.state.tasks[fixture.id].acceptance[0].id }] }));
    const task = h.state.tasks[fixture.id];
    assert.equal(task.state, 'review');
    assert.equal(task.verifiedBy, null);
    assert.deepEqual(task.evidence[0].execution, fixture.task.evidence[0].execution);
    assert.ok(task.evidence[0].supersededAt);
    assert.equal(h.state.project.policy.verification, 'auto', 'no operation rewrites the recorded legacy policy');
    assert.equal(h.query('brief').project.policy.verification, 'manual');
  } finally { await svc.close(); }
});

for (const state of ['review', 'done']) {
  for (const key of ['missing', 'corrupt']) {
    // 责任：历史 review/done 与缺失/坏密钥组合冷重放后，证据和历史哈希不变且不创建或修写密钥。
    test(`historical signed ${state}, auto policy and ${key} key replay unchanged`, async () => {
      const fixture = await legacyStore(state);
      const keyFile = path.join(fixture.rootDir, 'execution.key');
      if (key === 'corrupt') fs.writeFileSync(keyFile, 'not-a-valid-key');
      const result = spawnSync(process.execPath, [childFixture, fixture.rootDir, fixture.projectId, fixture.id], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const output = JSON.parse(result.stdout.trim().split('\n').pop());
      assert.equal(output.state, 'done');
      assert.deepEqual(output.historical.evidence, fixture.task.evidence);
      assert.equal(output.historical.verifiedBy, fixture.task.verifiedBy);
      assert.equal(output.persistedPolicy, 'auto');
      assert.equal(output.effectivePolicy, 'manual');
      assert.equal(output.error, null);
      assert.equal(output.historicalHash, fixture.commit.hash);
      assert.equal(fs.existsSync(keyFile), key === 'corrupt');
      if (key === 'corrupt') assert.equal(fs.readFileSync(keyFile, 'utf8'), 'not-a-valid-key');
    });
  }
}
