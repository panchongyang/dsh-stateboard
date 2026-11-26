/**
 * 测试职责：MCP 完整权限准入、冷拒绝、普通验收、漂移与过期恢复回归。
 * 典型流程：合成项目与独立上下文经真实 HTTP 执行，核对持久状态。
 * 覆盖边界：覆盖 全部任务 op 的正反流程由默认 agent-workflow-parity 门禁覆盖。；不覆盖真实用户数据与 LLM 推理。
 * 外部前置：临时回环端口；无真实 store。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture, text, error, READ, WRITE } from '../helpers/agent-parity-fixture.mjs';
import { createMcpWrite } from '../../lib/host/mcp-write.js';
import { ENV } from '../helpers/mcp-fixture.mjs';

// 责任：拒绝无授权写配置，且不同凭据代次和关闭实例不能复用句柄。
test('write opt-in requires a nonempty allowlist and distinct private credential', async t => {
  const f = await fixture(t);
  for (const settings of [undefined, {}, { enabled: false }, { enabled: 'true' }, { enabled: true, projectIds: [] }, { enabled: true, projectIds: ['bad'] }]) {
    assert.equal(createMcpWrite(f.runtime, settings, ENV, READ), null);
  }
  assert.equal(createMcpWrite(f.runtime, f.settings, { ...ENV, PROJECT_BOARD_MCP_WRITE_TOKEN: READ }, READ), null);
  assert.equal(createMcpWrite(f.runtime, f.settings, {}, READ), null);
  const old = await f.open();
  const replacement = createMcpWrite(f.runtime, f.settings, { ...ENV, PROJECT_BOARD_MCP_WRITE_TOKEN: 'ef'.repeat(32) }, READ);
  t.after(() => replacement.close());
  const board = replacement.tools.find(({ name }) => name === 'project_board');
  await assert.rejects(board.run({ view: 'health', context: old.context }), { code: 'work-session-invalid' });
  await replacement.close();
  await assert.rejects(board.run({ view: 'health', context: old.context }), { code: 'closed' });
});

// 责任：凭据和参数拒绝发生在冷 writer 获取之前，日志保持原样。
test('bad credentials, contexts and malformed intake cannot open a cold writer', async t => {
  const f = await fixture(t);
  const { context } = await f.open();
  const before = fs.readFileSync(f.h.store.commitsFile);
  await f.h.close();
  f.svc.openByWorkspace = () => assert.fail('denial must precede writer acquisition');
  f.svc.commandInWorkspace = () => assert.fail('MCP cannot create a project from an owning cwd');
  error(await f.call('project_task', { op: 'create', title: 'x', acceptance: [{ text: 'ok' }] }), 'work-session-invalid');
  error(await f.call('project_plan', { op: 'create', title: 'x' }), 'work-session-invalid');
  error(await f.call('project_session', { op: 'init' }), 'work-session-invalid');
  error(await f.call('project_task', { op: 'create', title: 'x', acceptance: [{ text: 'ok' }], context: 'forged' }), 'work-session-invalid');
  error(await f.call('project_task', { op: 'create', title: 'x', acceptance: [{ text: 'ok' }], actor: { kind: 'human' }, context }), 'invalid-command');
  error(await f.call('project_task', { op: 'create', title: 'x', acceptance: [{ text: 'ok' }], requiresAudit: 'true', context }), 'INVALID_ARGS');
  error(await f.call('project_doc', { op: 'register', title: 'x', relPath: 'x.md', bindingID: 'typo', context }), 'invalid-command');
  error(await f.call('project_task', { op: 'create', title: 'x', context }, READ), 'forbidden-role');
  assert.deepEqual(fs.readFileSync(f.h.store.commitsFile), before);
});

// 责任：普通提交者验收可用，漂移必须返工并重新提交。
test('ordinary submitter may verify; evidence drift is rejected and remains in review', async t => {
  const f = await fixture(t);
  const { context } = await f.open();
  const file = path.join(f.wsDir, 'proof.txt');
  fs.writeFileSync(file, 'original proof');
  text(await f.call('project_task', { op: 'create', title: 'ordinary', acceptance: [{ text: 'proof', requiredKinds: ['file'] }], context }));
  const taskId = Object.keys(f.h.state.tasks)[0];
  const act = async (op, extra = {}, denied) => {
    const args = { op, context, taskId, expectedRev: f.h.state.tasks[taskId].rev, ...extra };
    const lease = f.h.leases.get(taskId);
    if (lease) args.fencingToken = lease.token;
    const response = await f.call('project_task', args);
    return denied ? error(response, denied) : text(response);
  };
  const evidence = () => [{ kind: 'file', ref: 'proof.txt', acceptanceId: f.h.state.tasks[taskId].acceptance[0].id }];
  await act('claim'); await act('begin', { summary: 'produce proof' }); await act('submit', { evidence: evidence() });
  fs.writeFileSync(file, 'changed proof');
  await act('verify', {}, 'evidence-drift');
  assert.equal(f.h.state.tasks[taskId].state, 'review');
  await act('reject', { reason: 'refresh changed file' });
  assert.equal(f.h.state.tasks[taskId].state, 'in_progress');
  await act('begin', { summary: 'resubmit observed content' }); await act('submit', { evidence: evidence() });
  await act('verify');
  assert.equal(f.h.state.tasks[taskId].state, 'done');
});

// 责任：过期上下文与已关闭服务不得复活工作或写入记录。
test('expired contexts and closed controllers cannot revive or mutate work', async t => {
  const f = await fixture(t);
  const { context } = await f.open();
  text(await f.call('project_task', { op: 'create', title: 'expiry', acceptance: [{ text: 'ok' }], context }));
  const before = f.h.rev;
  f.advance(24 * 3600000);
  error(await f.call('project_board', { view: 'health', context }), 'work-session-invalid');
  assert.equal(f.h.rev, before, 'expired request has no business effects');
  await f.write.close();
  const closedRev = f.h.rev;
  error(await f.call('project_session', { op: 'open', projectId: f.h.id }, WRITE), 'closed');
  assert.equal(f.h.rev, closedRev, 'closed controller cannot mutate after its lifecycle detach');
});

// 责任：关闭完整凭据实例释放其工作者，不能自动恢复到已无法调用的身份，也不释放原生租约。
test('closing one MCP authority detaches its workers before reject can auto-resume them', async t => {
  const f = await fixture(t);
  const { context } = await f.open();
  fs.writeFileSync(path.join(f.wsDir, 'proof.txt'), 'proof');
  const create = async title => {
    text(await f.call('project_task', { op: 'create', title, acceptance: [{ text: 'ok' }], context }));
    return Object.values(f.h.state.tasks).find(task => task.title === title).id;
  };
  const act = async (taskId, op, extra = {}) => text(await f.call('project_task', {
    op, context, taskId, expectedRev: f.h.state.tasks[taskId].rev,
    ...(f.h.leases.has(taskId) ? { fencingToken: f.h.leases.get(taskId).token } : {}), ...extra,
  }));
  const review = await create('review');
  await act(review, 'claim'); await act(review, 'begin', { summary: 'prepare evidence' });
  await act(review, 'submit', { evidence: [{ kind: 'file', ref: 'proof.txt', acceptanceId: f.h.state.tasks[review].acceptance[0].id }] });
  const active = await create('active');
  await act(active, 'claim'); await act(active, 'begin', { summary: 'unfinished work' });
  const actor = f.h.leases.get(active).sessionId;
  await f.nativeCall('project_task', { op: 'create', title: 'native', acceptance: [{ text: 'ok' }] });
  const native = Object.values(f.h.state.tasks).find(task => task.title === 'native').id;
  await f.nativeCall('project_task', { op: 'claim', taskId: native, expectedRev: 1 });
  await f.write.close();
  assert.ok(f.h.state.bindings[actor].detachedAt);
  assert.equal(f.h.leases.has(active), false);
  assert.equal(f.h.state.tasks[active].state, 'interrupted');
  assert.equal(f.h.leases.has(native), true, 'another authority is untouched');
  assert.equal(f.runtime.sessionProjectRefs.has(actor), false);
  await f.nativeCall('project_task', { op: 'reject', taskId: review, expectedRev: f.h.state.tasks[review].rev, reason: 'needs rework' });
  assert.equal(f.h.state.tasks[review].state, 'ready');
  assert.equal(f.h.leases.has(review), false);
});

// 责任：首次写（native/full MCP）把会话绑定并入同一 commit；stale 请求不写、不绑、
// 不动已持租约的 expiry/lastSeen；并发首次 checkpoint 只绑一次；重试不刷。
test('first-write boundaries bind once and stale requests leave no side effects', async t => {
  const f = await fixture(t);
  const nativeExec = { agent: { id: 'first-native', session: { header: { cwd: f.wsDir } } }, callId: 'first-native-call' };
  const createTask = async title => {
    const result = await f.h.command({ cmdId: 'cmd_setup_' + title, actor: { kind: 'human', via: 'test' }, op: 'task.create', title, acceptance: [{ text: 'ok' }] });
    return result.events.find(e => e.type === 'task/created').taskId;
  };
  const first = await createTask('native-first');
  const before = f.h.rev;
  const claimed = await f.nativeCall('project_task', { op: 'claim', taskId: first, expectedRev: 1, projectRev: before }, nativeExec);
  assert.equal(claimed.ok, true);
  assert.equal(f.h.rev, before + 1, 'the first native write is exactly one commit');
  assert.ok(f.h.state.bindings['first-native'], 'the first native write binds its session');
  const claimCommit = f.h.store.commits.at(-1);
  assert.deepEqual(claimCommit.events.map(e => e.type), ['session/bound', 'lease/granted', 'task/claimed'], 'binding and claim share one commit');

  const context = (await f.open()).context;
  const remoteTask = await createTask('mcp-first');
  const remoteBefore = f.h.rev;
  text(await f.call('project_task', { op: 'claim', taskId: remoteTask, expectedRev: f.h.state.tasks[remoteTask].rev, projectRev: remoteBefore, context }));
  assert.equal(f.h.rev, remoteBefore + 1, 'the first full-MCP write is exactly one commit');
  assert.deepEqual(f.h.store.commits.at(-1).events.map(e => e.type), ['session/bound', 'lease/granted', 'task/claimed']);

  // stale claim from a fresh session: no write, no binding, no log line.
  const staleExec = { agent: { id: 'stale-worker', session: { header: { cwd: f.wsDir } } } };
  const staleTask = await createTask('stale-target');
  const log = fs.readFileSync(f.h.store.commitsFile);
  const staleRev = f.h.rev;
  let stale;
  try { await f.nativeCall('project_task', { op: 'claim', taskId: staleTask, expectedRev: 999 }, staleExec); } catch (error) { stale = error.boardFailure; }
  assert.equal(stale.code, 'stale-revision');
  assert.equal(f.h.rev, staleRev);
  assert.equal(f.h.state.bindings['stale-worker'], undefined);
  assert.deepEqual(fs.readFileSync(f.h.store.commitsFile), log);

  // stale begin must not refresh the already-held lease or binding lastSeen.
  const held = await f.h.state.tasks[first];
  const lease = f.h.leases.get(first);
  const lastSeen = f.h.state.bindings['first-native'].lastSeenAt;
  let begin;
  try { await f.nativeCall('project_task', { op: 'begin', taskId: first, expectedRev: 999, fencingToken: lease.token, summary: 'stale' }, nativeExec); } catch (error) { begin = error.boardFailure; }
  assert.equal(begin.code, 'stale-revision');
  assert.equal(f.h.leases.get(first).expiresAt, lease.expiresAt);
  assert.equal(f.h.state.bindings['first-native'].lastSeenAt, lastSeen);

  // two concurrent first checkpoints from the same new session bind once.
  const cpExec = { agent: { id: 'cp-worker', session: { header: { cwd: f.wsDir } } } };
  const cpBefore = f.h.rev;
  await Promise.all([
    f.nativeCall('project_session', { op: 'checkpoint', note: 'first' }, cpExec),
    f.nativeCall('project_session', { op: 'checkpoint', note: 'second' }, cpExec),
  ]);
  const added = f.h.store.commits.filter(c => c.seq > cpBefore).flatMap(c => c.events).filter(e => e.type === 'session/bound');
  assert.equal(added.length, 1, 'two concurrent first checkpoints bind exactly once');
  assert.equal(f.h.rev, cpBefore + 2, 'each successful first checkpoint is one commit');

  // same cmdId retry is deduped and does not refresh rev or bindings.
  const { applicationFor } = await import('../../lib/host/application.js');
  const application = applicationFor(f.runtime);
  const dto = { cmdId: 'cmd_retry_once', actor: { kind: 'agent', sessionId: 'retry-worker', agentId: 'retry-worker', via: 'test' }, op: 'session.checkpoint', note: 'retry' };
  const retryRev = f.h.rev;
  const one = await application.command(f.h.id, dto, { agentSessionSource: 'test' });
  assert.equal(one.committed, true);
  const two = await application.command(f.h.id, dto, { agentSessionSource: 'test' });
  assert.equal(two.deduped, true);
  assert.equal(f.h.rev, retryRev + 1, 'retry does not write a second commit');

  // Only the native commands that create an entity can initialize a workspace.
  const unbound = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-unbound-'));
  const projectsBefore = fs.readdirSync(f.svc.projectsDir).length;
  const unboundExec = { agent: { id: 'unbound-agent', session: { header: { cwd: unbound } } } };
  await assert.rejects(f.nativeCall('project_task', { op: 'claim', taskId: 'tsk_missing', expectedRev: 1 }, unboundExec), { code: 'not-found' });
  assert.equal(fs.readdirSync(f.svc.projectsDir).length, projectsBefore, 'a claim never creates a project');
  assert.equal(f.svc.resolveWorkspace(unbound), null);
  fs.rmSync(unbound, { recursive: true, force: true });
});
