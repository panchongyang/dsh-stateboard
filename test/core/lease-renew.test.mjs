/**
 * 测试职责：限制显式续租与隐式 touch 的无进展占用时间，保护会话/epoch 边界。
 * 典型流程：临时时钟和双会话 → renew/touch/begin 并推进时间 → 检查截止、计数、日志与 owner。
 * 覆盖边界：覆盖 TTL/宽限、无进展封顶和有效进展重置；不覆盖真实宿主心跳或调度延迟。
 * 外部前置：无；时间由注入时钟推进。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { withProject } from '../helpers/service-fixture.mjs';

const START = Date.parse('2026-10-23T00:00:00.000Z');
const TTL_MS = 900 * 1000;
const GRACE_MS = 900 * 1000;

function cmd(op, extra = {}) {
  return { cmdId: 'cmd_' + Math.random().toString(36).slice(2), actor: { kind: 'agent', sessionId: 's1' }, op, ...extra };
}

async function setup(t) {
  let now = START;
  const { svc, h } = await withProject(t, { clock: () => new Date(now), name: 'Renew' });
  await h.attach({ sessionId: 's1', agentId: 's1', source: 'test', role: 'worker' });
  await h.attach({ sessionId: 's2', agentId: 's2', source: 'test', role: 'worker' });
  const tick = (ms) => { now += ms; };
  return { svc, h, tick, now: () => now };
}

async function makeTask(h, title, sessionId = 's1') {
  const res = await h.command({ ...cmd('task.create', { title, acceptance: [{ text: 'ok' }] }), actor: { kind: 'agent', sessionId } });
  return res.events.find((event) => event.type === 'task/created').taskId;
}

async function claim(h, taskId, sessionId = 's1') {
  await h.command({ ...cmd('task.claim', { taskId, expected: { entityRev: h.state.tasks[taskId].rev } }), actor: { kind: 'agent', sessionId } });
  return h.leases.get(taskId);
}

function renew(h, taskId, token, sessionId = 's1') {
  return h.command({
    ...cmd('task.renew', {
      taskId,
      expected: { entityRev: h.state.tasks[taskId].rev },
      fencingToken: token,
    }),
    actor: { kind: 'agent', sessionId },
  });
}

// 责任：宽限内 renew 只延长内存到新时刻加 TTL，不提交日志，异会话续租须拒绝。
test('task.renew inside grace extends in memory without a commit', async (t) => {
  const { svc, h, tick, now } = await setup(t);
  const id = await makeTask(h, 'Renewable');
  const lease = await claim(h, id);
  tick(TTL_MS + 1);
  const rev = h.rev;
  const size = fs.statSync(h.store.commitsFile).size;
  const result = await renew(h, id, lease.token);
  assert.equal(result.ok, true);
  assert.equal(result.committed, false);
  assert.equal(h.rev, rev);
  assert.equal(fs.statSync(h.store.commitsFile).size, size);
  assert.equal(h.leases.get(id).expiresAt, new Date(now() + TTL_MS).toISOString());
  assert.equal(h.leases.get(id).renewCount, 1);

  const other = await renew(h, id, lease.token, 's2').then(() => null, (error) => error);
  assert.equal(other.code, 'lease-held');
  await svc.close();
});

// 责任：超过宽限 renew 须拒绝，后续命令回收后旧 token 不能复活任务。
test('renew after grace is refused; a later command reclaims and the old token cannot revive', async (t) => {
  const { svc, h, tick } = await setup(t);
  const id = await makeTask(h, 'Expired');
  const lease = await claim(h, id);
  tick(TTL_MS + GRACE_MS + 1);
  const refused = await renew(h, id, lease.token).then(() => null, (error) => error);
  assert.equal(refused.code, 'lease-expired');
  assert.equal(h.state.tasks[id].state, 'in_progress');

  const other = await makeTask(h, 'Other');
  await claim(h, other, 's2');
  assert.equal(h.state.tasks[id].state, 'ready', 'claiming another task sweeps the dead lease');
  assert.equal(h.leases.has(id), false);
  const revived = await renew(h, id, lease.token).then(() => null, (error) => error);
  assert.equal(revived.code, 'lease-expired');
  await svc.close();
});

// 责任：无进展可显式续租两次，第三次必须拒绝。
test('two renewals without progress are allowed; the third is refused', async (t) => {
  const { svc, h, tick } = await setup(t);
  const id = await makeTask(h, 'Capped');
  const lease = await claim(h, id);
  const token = lease.token;
  let task = h.state.tasks[id];
  await h.command(cmd('task.begin', { taskId: id, expected: { entityRev: task.rev }, fencingToken: token, summary: 'work' }));
  tick(TTL_MS + 1);
  assert.equal((await renew(h, id, token)).renewCount, 1);
  assert.equal((await renew(h, id, token)).renewCount, 2);
  const third = await renew(h, id, token).then(() => null, (error) => error);
  assert.equal(third.code, 'lease-expired');
  assert.equal(third.details.reason, 'renewal-limit');
  await svc.close();
});

// 责任：touch 只延长调用父会话的租约，等待中的子会话租约保持过期但可自行 renew。
test('touch only extends the calling parent lease; a waiting child lease stays expired but renewable', async (t) => {
  const { svc, h, tick, now } = await setup(t);
  const parentTask = await makeTask(h, 'Parent');
  const childTask = await makeTask(h, 'Child');
  const parentLease = await claim(h, parentTask, 's1');
  const childLease = await claim(h, childTask, 's2');
  tick(TTL_MS + 1);
  h.touch('s1');
  assert.equal(h.leases.get(parentTask).expiresAt, new Date(now() + TTL_MS).toISOString());
  assert.equal(h.leases.get(childTask).expiresAt, childLease.expiresAt, 'parent touch must not renew the child lease');
  const health = h.health();
  assert.ok(health.warnings.some((line) => line.includes(childTask) && line.includes('renewable')));
  const renewed = await renew(h, childTask, childLease.token, 's2');
  assert.equal(renewed.committed, false);
  await svc.close();
});

// 责任：无进展续租额度耗尽后 touch 不得继续滑动 expiresAt。
test('touch cannot extend a lease after the no-progress renewal cap is exhausted', async (t) => {
  const { svc, h, tick } = await setup(t);
  const id = await makeTask(h, 'Touch cap');
  const lease = await claim(h, id);
  const token = lease.token;
  let task = h.state.tasks[id];
  await h.command(cmd('task.begin', { taskId: id, expected: { entityRev: task.rev }, fencingToken: token, summary: 'work' }));
  tick(TTL_MS + 1);
  await renew(h, id, token);
  await renew(h, id, token);
  const before = h.leases.get(id).expiresAt;
  tick(5_000);
  h.touch('s1');
  assert.equal(h.leases.get(id).expiresAt, before, 'touch must not bypass the renewal cap');
  const third = await renew(h, id, token).then(() => null, (error) => error);
  assert.equal(third.code, 'lease-expired');
  await svc.close();
});

// 责任：只有 touch 活动也须有有限无进展截止，超过后最终必须回收。
test('touch-only activity has a finite no-progress deadline and is eventually reclaimed', async (t) => {
  const { svc, h, tick } = await setup(t);
  t.after(() => svc.close());
  const id = await makeTask(h, 'Touch only');
  await claim(h, id);
  const rev = h.rev;
  const size = fs.statSync(h.store.commitsFile).size;
  const deadline = START + 3 * TTL_MS;
  for (let i = 0; i < 8; i += 1) {
    tick(TTL_MS / 2);
    h.touch('s1');
    assert.ok(Date.parse(h.leases.get(id).expiresAt) <= deadline, 'touch-only must not slide beyond three TTLs');
  }
  assert.equal(h.leases.get(id).renewCount, 0, 'reads do not consume the explicit renewal count');
  assert.equal(h.rev, rev);
  assert.equal(fs.statSync(h.store.commitsFile).size, size);
  await makeTask(h, 'Sweep');
  assert.equal(h.leases.has(id), false);
  assert.equal(h.state.tasks[id].state, 'ready');
});

// 责任：混合 touch 与 renew 必须受同一无进展截止裁剪，不能交替规避。
test('mixed touch and renew clip expiry to the same no-progress deadline', async (t) => {
  const { svc, h, tick } = await setup(t);
  t.after(() => svc.close());
  const id = await makeTask(h, 'Mixed');
  const lease = await claim(h, id);
  tick(TTL_MS / 2);
  await renew(h, id, lease.token);
  for (let i = 0; i < 3; i += 1) {
    tick(TTL_MS / 2);
    h.touch('s1');
  }
  tick(TTL_MS / 2);
  await renew(h, id, lease.token);
  assert.equal(Date.parse(h.leases.get(id).expiresAt), START + 3 * TTL_MS);
});

// 责任：达到无进展截止后即使显式续租次数未耗尽也必须拒绝。
test('renew is refused at the deadline even when the explicit count is not exhausted', async (t) => {
  const { svc, h, tick } = await setup(t);
  t.after(() => svc.close());
  const id = await makeTask(h, 'Deadline');
  const lease = await claim(h, id);
  tick(TTL_MS / 2);
  await renew(h, id, lease.token);
  for (let i = 0; i < 5; i += 1) {
    tick(TTL_MS / 2);
    h.touch('s1');
  }
  const before = structuredClone(h.leases.get(id));
  const rev = h.rev;
  const size = fs.statSync(h.store.commitsFile).size;
  await assert.rejects(renew(h, id, lease.token), (error) => error.code === 'lease-expired' && error.details.reason === 'renewal-limit');
  assert.deepEqual(h.leases.get(id), before);
  assert.equal(h.rev, rev);
  assert.equal(fs.statSync(h.store.commitsFile).size, size);
});

// 责任：成功 begin 属真实进展，须按注入时钟重置共享无进展截止。
test('real begin progress resets the shared deadline using the injected clock', async (t) => {
  const { svc, h, tick, now } = await setup(t);
  t.after(() => svc.close());
  const id = await makeTask(h, 'Progress');
  const lease = await claim(h, id);
  assert.equal(lease.progressAt, new Date(START).toISOString());
  for (let i = 0; i < 5; i += 1) {
    tick(TTL_MS / 2);
    h.touch('s1');
  }
  await h.command(cmd('task.begin', { taskId: id, expected: { entityRev: h.state.tasks[id].rev }, fencingToken: lease.token, summary: 'real progress' }));
  const deadline = now() + 3 * TTL_MS;
  for (let i = 0; i < 6; i += 1) {
    tick(TTL_MS / 2);
    h.touch('s1');
  }
  assert.equal(Date.parse(h.leases.get(id).expiresAt), deadline);
  assert.ok(deadline > START + 3 * TTL_MS);
});

// 责任：失败 begin 不得重置截止，也不得改租约或历史。
test('failed begin does not reset the deadline or mutate leases and history', async (t) => {
  const { svc, h, tick } = await setup(t);
  t.after(() => svc.close());
  const id = await makeTask(h, 'Failed progress');
  const lease = await claim(h, id);
  tick(TTL_MS / 2);
  const before = structuredClone(h.leases.get(id));
  const rev = h.rev;
  const size = fs.statSync(h.store.commitsFile).size;
  await assert.rejects(h.command(cmd('task.begin', { taskId: id, expected: { entityRev: h.state.tasks[id].rev }, fencingToken: lease.token, summary: '' })), { code: 'invalid-command' });
  assert.deepEqual(h.leases.get(id), before);
  assert.equal(h.rev, rev);
  assert.equal(fs.statSync(h.store.commitsFile).size, size);
});

// 责任：只读、归档或关闭 handle 的 touch 不得改 expiresAt 或绑定活跃度。
test('read-only, archived and closed touch cannot change lease expiry or binding liveness', async (t) => {
  const { svc, h, tick } = await setup(t);
  t.after(() => svc.close());
  const id = await makeTask(h, 'Read only');
  await claim(h, id);
  const before = structuredClone(h.leases.get(id));
  const binding = structuredClone(h.state.bindings.s1);
  tick(TTL_MS / 2);
  h.readOnly = true;
  h.touch('s1');
  assert.deepEqual(h.leases.get(id), before);
  assert.deepEqual(h.state.bindings.s1, binding);
  h.readOnly = false;
  h.state.project.phase = 'archived';
  h.touch('s1');
  assert.deepEqual(h.leases.get(id), before);
  assert.deepEqual(h.state.bindings.s1, binding);
  h.state.project.phase = 'active';
  h.closed = true;
  h.touch('s1');
  assert.deepEqual(h.leases.get(id), before);
  assert.deepEqual(h.state.bindings.s1, binding);
  h.closed = false;
});

// 责任：touch 不能续租其他会话、已 detach 绑定或不匹配 epoch 的工作。
test('touch cannot renew another session, detached binding, or mismatched epoch', async (t) => {
  const { svc, h, tick } = await setup(t);
  t.after(() => svc.close());
  const id = await makeTask(h, 'Wrong owner');
  await claim(h, id);
  const before = structuredClone(h.leases.get(id));
  tick(TTL_MS / 2);
  h.touch('s2');
  h.touch('unknown');
  assert.deepEqual(h.leases.get(id), before);
  h.state.bindings.s1.epoch += 1;
  h.touch('s1');
  assert.deepEqual(h.leases.get(id), before);
  h.state.bindings.s1.epoch = before.epoch;
  h.state.bindings.s1.detachedAt = new Date().toISOString();
  h.touch('s1');
  assert.deepEqual(h.leases.get(id), before);
});

// 责任：续租预算为零仍允许初始 TTL，但 touch/renew 均不能让截止继续滑动。
test('zero renewal budget still permits the initial TTL but cannot slide it', async (t) => {
  const { svc, h, tick } = await setup(t);
  t.after(() => svc.close());
  h.state.project.policy.maxRenewalsWithoutProgress = 0;
  const id = await makeTask(h, 'No renewals');
  const lease = await claim(h, id);
  tick(TTL_MS / 2);
  h.touch('s1');
  assert.equal(Date.parse(h.leases.get(id).expiresAt), START + TTL_MS);
  await assert.rejects(renew(h, id, lease.token), { code: 'lease-expired' });
});

// 责任：unblock 遇到失效 assignee 不得发放新租约。
test('unblock does not grant a lease to a stale assignee', async (t) => {
  const { svc, h, tick } = await setup(t);
  const id = await makeTask(h, 'Stale assignee');
  const lease = await claim(h, id);
  let task = h.state.tasks[id];
  await h.command(cmd('task.begin', { taskId: id, expected: { entityRev: task.rev }, fencingToken: lease.token, summary: 'work' }));
  task = h.state.tasks[id];
  await h.command(cmd('task.block', {
    taskId: id,
    expected: { entityRev: task.rev },
    fencingToken: lease.token,
    code: 'wait',
    note: 'hold',
    intent: { outcome: 'stopped', sideEffects: [] },
  }));
  tick(TTL_MS + GRACE_MS + 1);
  task = h.state.tasks[id];
  await h.command(cmd('task.unblock', { taskId: id, expected: { entityRev: task.rev }, note: 'go' }));
  assert.equal(h.state.tasks[id].state, 'ready');
  assert.equal(h.state.tasks[id].owner, null);
  assert.equal(h.leases.has(id), false);
  await svc.close();
});

// 责任：interrupted 任务 renew 必须拒绝并提示 reconcile，而非发放或延长租约。
test('renew on an interrupted task points at reconcile', async (t) => {
  const { svc, h } = await setup(t);
  const id = await makeTask(h, 'Interrupted');
  const lease = await claim(h, id);
  await h.command(cmd('task.interrupt', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    fencingToken: lease.token,
    note: 'side effects unknown',
  }));
  const error = await renew(h, id, lease.token).then(() => null, (err) => err);
  assert.equal(error.code, 'lease-expired');
  assert.equal(error.details.hint, 'reconcile');
  await svc.close();
});
