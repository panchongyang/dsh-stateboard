/**
 * 测试职责：维护同进程多 service 共享 handle 的引用计数与锁释放时机。
 * 典型流程：两个 service 打开同一临时项目 → 依次关闭或手工关闭 handle → 检查缓存、锁和写能力。
 * 覆盖边界：覆盖 共享句柄存活、最后引用释放和关闭后重建；不覆盖跨进程锁竞争。
 * 外部前置：无；本地临时 store。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectService } from '../../lib/core/service.js';
import { createLifecycleApi } from '../../lib/core/runtime/lifecycle-api.js';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
}

function cmd(op, extra = {}) {
  return { cmdId: 'cmd_' + Math.random().toString(36).slice(2), actor: { kind: 'agent', sessionId: 's1' }, op, ...extra };
}

async function setup(options = {}) {
  const root = tmp('pb-hl-state');
  const ws = tmp('pb-hl-ws');
  const A = new ProjectService({ rootDir: root, ...options });
  await A.init();
  const handle = await A.createProject({ workspacePath: ws, name: 'HL' });
  const B = new ProjectService({ rootDir: root, ...options });
  await B.init();
  return { root, ws, A, B, handle };
}

// 责任：首个 service 关闭后共享 handle 和锁须继续存活，另一个 service 仍可写检查点。
test('closing the first service keeps the shared handle and the lock alive', async () => {
  const { A, B, handle } = await setup();
  const same = await B.open(handle.id);
  assert.notEqual(same, handle, 'service authority requires a distinct scoped handle');
  assert.equal(same.store, handle.store, 'services must share one physical writer');
  assert.equal(same.state, handle.state, 'services must observe the same committed value');
  const lock = path.join(handle.meta.dir, 'lock.json');

  await A.close();
  assert.equal(handle.closed, false, 'A.close must not close the handle B is using');
  assert.ok(fs.existsSync(lock), 'A.close must not remove the lock');

  const result = await same.command(cmd('session.checkpoint', { note: 'B after A close' }));
  assert.equal(result.committed, true, 'B must still be able to write');

  const reopened = await B.open(handle.id);
  assert.equal(reopened.closed, false);
  assert.equal(reopened, same, 'one service reuses its own scoped handle');
  await assert.rejects(handle.command(cmd('session.checkpoint', { note: 'closed A must not write via B' })), { code: 'handle-closed' });
  assert.equal(reopened.store, handle.store);
  await B.close();
});

// 责任：最后一个引用 service 关闭时 handle 必须关闭并释放锁文件。
test('the last service to close releases the handle and the lock', async () => {
  const { A, B, handle } = await setup();
  await B.open(handle.id);
  await A.close();
  await B.close();
  assert.equal(handle.closed, true, 'the last reference must close the store');
  assert.equal(fs.existsSync(path.join(handle.meta.dir, 'lock.json')), false);
});

// 责任：缓存 handle 已手工关闭后再 open 须重建新实例，且新实例可以提交。
test('a closed handle is rebuilt instead of being handed out again', async () => {
  const { root, ws, A, handle } = await setup();
  await A.close();
  const C = new ProjectService({ rootDir: root });
  await C.init();
  const first = await C.open(handle.id);
  first.close();
  assert.equal(first.closed, true);

  const second = await C.open(handle.id);
  assert.notEqual(second, first, 'a closed handle must not be cached forever');
  assert.equal(second.closed, false);
  const result = await second.command(cmd('session.checkpoint', { note: 'after rebuild' }));
  assert.equal(result.committed, true);
  await C.close();
  assert.ok(ws);
});

function lifecycle(service) {
  return createLifecycleApi({ service, read: () => assert.fail('ensure must not route through a read') });
}
function snapshot(h) {
  return { bytes: fs.readFileSync(h.store.commitsFile), rev: h.rev, hash: h.lastHash,
    state: structuredClone(h.state), leases: structuredClone([...h.leases]), records: structuredClone(h.store.commits) };
}
async function task(h, title = 'Synthetic lifecycle task') {
  const result = await h.command(cmd('task.create', { title, acceptance: [{ text: 'ok' }] }));
  return result.events.find(event => event.type === 'task/created').taskId;
}

// 责任：并行首次挂接只产生一个代次，已有有效租约不会被重入回收。
test('concurrent lifecycle ensures share one attach across services and preserve a live lease on reentry', async t => {
  let now = Date.parse('2026-10-23T00:00:00Z');
  const { A, B, handle: h } = await setup({ clock: () => new Date(now) });
  t.after(async () => { await A.close(); await B.close(); });
  await B.open(h.id);
  const apis = [lifecycle(A), lifecycle(B)];
  const args = { projectId: h.id, sessionId: 's1', agentId: 'a1', source: 'trusted-host' };
  const before = h.rev;
  await Promise.all(Array.from({ length: 16 }, (_, i) => apis[i % 2][i % 3 ? 'ensureAgentProject' : 'ensureProjectForSession'](args)));
  assert.equal(h.rev, before + 1);
  assert.equal(h.state.bindings.s1.epoch, 1);
  assert.equal(h.state.bindings.s1.agentId, 'a1');
  assert.equal(h.store.commits.at(-1).events.filter(event => event.type === 'session/bound').length, 1);
  const id = await task(h);
  await h.command(cmd('task.claim', { taskId: id, expected: { entityRev: h.state.tasks[id].rev } }));
  const stable = snapshot(h);
  now += 30_000;
  await Promise.all(apis.flatMap(api => [api.ensureAgentProject(args), api.ensureProjectForSession(args)]));
  assert.deepEqual(snapshot(h), stable, 'reentrant ensure must not attach, touch, or release the lease');
});

// 责任：首开 service 关闭后，存活 facade 的可信活动和解绑仍使用自己的权限及共有租约。
test('trusted activity and detach use the surviving service, not the closed writer opener', async t => {
  let now = Date.parse('2026-10-23T00:00:00Z');
  const { A, B, handle: h } = await setup({ clock: () => new Date(now) });
  t.after(async () => { await A.close(); await B.close(); });
  const peer = await B.open(h.id);
  const args = { projectId: h.id, sessionId: 's1', agentId: 'a1', source: 'trusted-host' };
  await lifecycle(B).ensureAgentProject(args);
  const id = await task(peer);
  await peer.command(cmd('task.claim', { taskId: id, expected: { entityRev: peer.state.tasks[id].rev } }));
  await A.close();
  assert.throws(() => h.touch(args.sessionId), { code: 'handle-closed' });
  const before = snapshot(peer);
  now += 30_000;
  assert.equal((await lifecycle(B).recordActivity(args)).rev, before.rev);
  assert.equal(peer.state.bindings.s1.lastSeenAt, new Date(now).toISOString());
  assert.ok(peer.leases.get(id).expiresAt > before.leases[0][1].expiresAt);
  assert.deepEqual(snapshot(peer).bytes, before.bytes, '可信活动只更新运行时状态');
  assert.equal((await lifecycle(B).detachAgentSession(args)).detached, true);
  assert.equal(peer.rev, before.rev + 1);
  assert.ok(peer.state.bindings.s1.detachedAt);
  assert.equal(peer.leases.has(id), false);
  assert.equal(peer.state.tasks[id].state, 'ready');
  assert.deepEqual(peer.store.commits.at(-1).events.map(event => event.type), ['lease/revoked', 'task/readied', 'session/detached']);
});

// 责任：普通 ensure 不复活解绑的会话，只有显式挂接才建立新代次。
test('ensure preserves explicit detach while explicit lifecycle attach starts a new epoch', async t => {
  const { A, B, handle: h } = await setup();
  t.after(async () => { await A.close(); await B.close(); });
  const api = lifecycle(A);
  const args = { projectId: h.id, sessionId: 's1', source: 'trusted-host' };
  await api.ensureAgentProject(args);
  await api.detachAgentSession(args);
  const detached = snapshot(h);
  assert.ok(h.state.bindings.s1.detachedAt);
  await Promise.all([api.ensureAgentProject(args), api.ensureProjectForSession(args)]);
  assert.deepEqual(snapshot(h), detached);
  await h.command(cmd('session.checkpoint', { note: 'metadata does not reattach' }), { agentSessionSource: 'native-tool' });
  assert.deepEqual(h.state.bindings.s1, detached.state.bindings.s1);
  await h.attach({ sessionId: 's1', source: 'explicit-trusted-reattach' });
  assert.equal(h.state.bindings.s1.epoch, detached.state.bindings.s1.epoch + 1);
  assert.equal(h.state.bindings.s1.detachedAt, undefined);
});

// 责任：首次绑定与业务同批提交，拒绝、空操作和幂等重试不留下绑定。
test('command binding is atomic with success and absent for rejection no-op and dedupe', async t => {
  const { A, B, handle: h } = await setup();
  t.after(async () => { await A.close(); await B.close(); });
  const id = await task(h);
  await h.command(cmd('task.gate', { taskId: id, expected: { entityRev: h.state.tasks[id].rev }, requiresAudit: true }));
  const rejected = snapshot(h);
  await assert.rejects(h.command(cmd('task.claim', { taskId: id, expected: { entityRev: 999 },
    actor: { kind: 'agent', sessionId: 'stale-new' } }), { agentSessionSource: 'native-tool' }), { code: 'stale-revision' });
  assert.deepEqual(snapshot(h), rejected);
  const noOp = await h.command(cmd('task.gate', { taskId: id, expected: { entityRev: h.state.tasks[id].rev },
    requiresAudit: true, actor: { kind: 'agent', sessionId: 'noop-new' } }), { agentSessionSource: 'native-tool' });
  assert.equal(noOp.committed, false);
  assert.deepEqual(snapshot(h), rejected);
  const command = cmd('session.checkpoint', { note: 'same transaction', actor: { kind: 'agent', sessionId: 'success-new', agentId: 'agent-new' } });
  const before = h.rev;
  const result = await h.command(command, { agentSessionSource: 'native-tool' });
  assert.equal(result.committed, true);
  assert.equal(h.rev, before + 1);
  assert.equal(h.state.bindings['success-new'].agentId, 'agent-new');
  assert.equal(h.state.bindings['success-new'].source, 'native-tool');
  assert.notEqual(h.state.bindings['success-new'].autoResume, false, 'ordinary worker binding preserves normal rework eligibility');
  assert.equal(result.events.filter(event => event.type === 'session/bound').length, 1);
  assert.ok(result.events.some(event => event.type !== 'session/bound'));
  const stable = snapshot(h);
  const duplicate = await h.command(command, { agentSessionSource: 'different-trusted-entry' });
  assert.equal(duplicate.deduped, true);
  assert.deepEqual(snapshot(h), stable);
  const duplicateFromNewSession = await h.command({ ...command, actor: { kind: 'agent', sessionId: 'dedupe-unbound' } },
    { agentSessionSource: 'native-tool' });
  assert.equal(duplicateFromNewSession.deduped, true);
  assert.deepEqual(snapshot(h), stable, 'dedupe cannot leave a binding for a new request actor');
});

// 责任：仅显式领租可用兼容绑定，普通业务不能替代可信活动续期。
test('workSessionSource remains grant-only and successful business commands never imply activity', async t => {
  let now = Date.parse('2026-10-23T00:00:00Z');
  const { A, B, handle: h } = await setup({ clock: () => new Date(now) });
  t.after(async () => { await A.close(); await B.close(); });
  await h.command(cmd('session.checkpoint', { note: 'not a grant' }), { workSessionSource: 'explicit-grant' });
  assert.equal(h.state.bindings.s1, undefined);
  const id = await task(h);
  await h.command(cmd('task.claim', { taskId: id, expected: { entityRev: h.state.tasks[id].rev } }), { workSessionSource: 'explicit-grant' });
  assert.equal(h.state.bindings.s1.source, 'explicit-grant');
  assert.equal(h.state.bindings.s1.autoResume, false, 'grant-only binding cannot authorize automatic reassignment');
  const binding = structuredClone(h.state.bindings.s1), lease = structuredClone(h.leases.get(id));
  now += 30_000;
  await h.command(cmd('session.checkpoint', { note: 'ordinary business' }), { agentSessionSource: 'native-tool' });
  assert.deepEqual(h.state.bindings.s1, binding);
  assert.deepEqual(h.leases.get(id), lease);
  await lifecycle(A).recordActivity({ projectId: h.id, sessionId: 's1' });
  assert.notEqual(h.state.bindings.s1.lastSeenAt, binding.lastSeenAt, 'independent trusted activity must still work');
  assert.ok(h.leases.get(id).expiresAt > lease.expiresAt);
});

// 责任：缺失或空白来源不能建立会话绑定。
test('empty command binding sources never create a session binding', async t => {
  const { A, B, handle: h } = await setup();
  t.after(async () => { await A.close(); await B.close(); });
  for (const source of [undefined, '', '   ']) {
    const result = await h.command(cmd('session.checkpoint', { note: 'business only' }), { agentSessionSource: source });
    assert.equal(result.committed, true);
    assert.equal(result.events.some(event => event.type === 'session/bound'), false);
    assert.equal(h.state.bindings.s1, undefined);
  }
});
