/**
 * 测试职责：用独立 oracle 穷举租约、角色、token、归档和必填字段边界的命令原子性。
 * 典型流程：先断言最小环境隔离 → 重置合成 fixture/注入时钟 → 执行组合命令 → 比较字节、版本、事件及租约。
 * 覆盖边界：覆盖 TTL/fencing/归档优先级和失败零写；不覆盖真实宿主、真实副作用或随机压力。
 * 外部前置：必须由 core-matrix launcher 提供隔离环境；直接带真实 DSH 环境运行会被拒绝。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { TASK, TOKEN, actor, assertIsolation, fixture } from '../helpers/core-matrix-fixture.mjs';
import { OPS, SETTLERS, STATES, oracle, settlementPayload } from '../helpers/core-matrix-oracle.mjs';

assertIsolation();
function commandFor(f, row) {
  const cmd = f.command(row.op, { actor: actor(row.kind || 'agent', row.foreign ? 'other' : 'owner') });
  if (row.token === 'missing') delete cmd.fencingToken;
  if (row.token === 'stale') cmd.fencingToken = TOKEN - 1;
  if (row.open && SETTLERS.includes(row.op)) cmd.intent = settlementPayload('stopped');
  if (row.choice) cmd.choice = row.choice;
  return cmd;
}

// A validated command first applies the reclaimable lease's expiry to its working
// projection (in_progress -> interrupted|ready, lease gone), then runs against that.
function expiredOracle(row) {
  // The fixture owner has no live binding, so the recovery path is closed to it.
  if (row.op === 'interrupt') return { error: 'lease-expired' };
  const released = row.state === 'in_progress';
  const expected = oracle({ ...row, lease: 'none', state: released ? (row.open ? 'interrupted' : 'ready') : row.state });
  if (!expected.error) expected.events.unshift('lease/expired', ...(released ? [row.open ? 'task/interrupted' : 'task/readied'] : []));
  return expected;
}

// 责任：穷举 TTL/宽限/硬过期及 token/意图组合，结果必须与回收投影 oracle 一致。
test('injected-clock TTL/grace/hard-expiry versus fencing token (126 combinations)', async (t) => {
  const f = fixture();
  let count = 0;
  try {
    for (const op of ['begin', 'submit', 'release', 'block', 'cancel', 'reject', 'interrupt']) {
      for (const lease of ['live', 'grace', 'expired']) for (const token of ['correct', 'stale', 'missing']) for (const open of [false, true]) {
        const row = { op, state: op === 'reject' ? 'review' : 'in_progress', kind: 'agent', lease, token, open };
        f.reset(row);
        const expected = lease === 'expired' ? expiredOracle(row) : oracle(row);
        await f.check(commandFor(f, row), expected, JSON.stringify(row));
        count++;
      }
    }
    assert.equal(count, 126);
    t.diagnostic('126 combinations; live=+60s, grace=expiry-1ms, hard=expiry+30s exactly; clock is fixed');
  } finally { f.close(); }
});

// 责任：异 owner 与审计门取消的角色/token 组合须遵守身份边界，不得因人工例外放宽 agent。
test('foreign owner and gated cancellation preserve token/role boundaries (84 combinations)', async (t) => {
  const f = fixture();
  let count = 0;
  try {
    for (const op of ['begin', 'submit', 'release', 'block', 'cancel', 'reject', 'interrupt']) {
      for (const kind of ['agent', 'human']) for (const token of ['correct', 'stale', 'missing']) for (const open of [false, true]) {
        const row = { op, state: op === 'reject' ? 'review' : 'in_progress', kind, token, open, lease: 'live', foreign: true, gated: op === 'cancel' };
        f.reset(row);
        f.h.state.tasks[TASK].requiresAudit = row.gated;
        await f.check(commandFor(f, row), oracle(row), JSON.stringify(row));
        count++;
      }
    }
    assert.equal(count, 84);
    t.diagnostic('84 combinations');
  } finally { f.close(); }
});

// 责任：有无旧意图的三类 reconcile 须正确结清，resume 只增一次 attempt 并发一份租约。
test('reconcile choices with/without legacy intent, no token required (12 combinations)', async (t) => {
  const f = fixture();
  try {
    for (const kind of ['human', 'agent']) for (const open of [false, true]) for (const choice of ['resume', 'completed', 'discard']) {
      const row = { op: 'reconcile', state: 'interrupted', lease: 'none', token: 'missing', kind, open, choice };
      f.reset(row);
      const result = await f.check(commandFor(f, row), oracle(row), JSON.stringify(row));
      if (open) {
        const closed = f.h.state.intents.int_matrix;
        assert.equal(closed.resolution, { resume: 'redo', completed: 'applied', discard: 'discarded' }[choice]);
        assert.equal(closed.closedBy.kind, kind);
        assert.ok(closed.closedAt);
      }
      if (choice === 'resume') {
        assert.equal(f.h.state.tasks[TASK].work.attempt, open ? 2 : 1);
        assert.deepEqual(result.events.slice(-3).map((event) => event.type), ['lease/granted', 'work/intent', 'task/reconciled']);
      }
      assert.equal(f.h.state.tasks[TASK].interrupt, null);
    }
    t.diagnostic('12 combinations');
  } finally { f.close(); }
});

// 责任：缺 summary/note/reason、坏 choice 或证据不满足时须原子拒绝，字节和租约全不变。
test('required command fields and submit evidence reject atomically (12 cases)', async (t) => {
  const f = fixture();
  const cases = [
    ['begin', false, { summary: '' }, 'invalid-command'],
    ['interrupt', true, { note: '' }, 'invalid-command'],
    ['reject', true, { reason: '' }, 'invalid-command'],
    ['reconcile', true, { note: '' }, 'invalid-command'],
    ['reconcile', true, { choice: 'unknown' }, 'invalid-command'],
    ['submit', true, { evidence: [] }, 'missing-evidence'],
    ['submit', true, { evidence: [{ kind: 'note', ref: 'unlinked material' }] }, 'missing-evidence'],
    ['submit', true, { evidence: [{ kind: 'file', ref: 'artifact.txt' }] }, 'missing-evidence'],
    ['submit', true, { evidence: [{ kind: 'file', ref: 'absent.txt', acceptanceId: 'acc_matrix' }] }, 'missing-evidence'],
    ['submit', true, { evidence: [{ kind: 'file', ref: '../outside.txt', acceptanceId: 'acc_matrix' }] }, 'invalid-command'],
    ['submit', true, { evidence: [{ kind: 'file', ref: 'artifact.txt', hash: '0'.repeat(64), acceptanceId: 'acc_matrix' }] }, 'missing-evidence'],
    ['submit', true, { expected: { projectRev: 0, entityRev: 7 } }, 'stale-revision'],
  ];
  try {
    for (const [op, open, extra, error] of cases) {
      f.reset({ state: op === 'reject' ? 'review' : op === 'reconcile' ? 'interrupted' : 'in_progress', open, lease: 'live' });
      await f.check(f.command(op, extra), { error }, op + ' ' + JSON.stringify(extra));
    }
    t.diagnostic('12 cases; each compares bytes, both revisions, full leases and state');
  } finally { f.close(); }
});

// 责任：归档入口守卫须压过状态、租约、角色与意图分支，任何组合都不能写。
test('archived entry gate dominates state/lease/role/intent (704 combinations)', async (t) => {
  const f = fixture();
  let count = 0;
  try {
    for (const op of OPS) for (const state of STATES) for (const kind of ['human', 'agent']) for (const open of [false, true]) for (const lease of ['none', 'live']) {
      const row = { op, state, kind, open, lease, phase: 'archived' };
      f.reset(row);
      await f.check(commandFor(f, row), { error: 'project-archived' }, JSON.stringify(row));
      count++;
    }
    assert.equal(count, 704);
    t.diagnostic('704 combinations');
  } finally { f.close(); }
});

// 责任：归档有活工作组合须拒绝，解归档恢复须按有无意图生成准确事件。
test('project archive live-work guard and unarchive recovery (32 combinations)', async (t) => {
  const f = fixture();
  try {
    for (const state of ['ready', 'in_progress']) for (const lease of ['none', 'live']) for (const open of [false, true]) {
      f.reset({ state, lease, open });
      const blocked = state === 'in_progress' || lease === 'live' || open;
      await f.check(f.command('unused', { op: 'project.update', actor: actor('human'), phase: 'archived' }),
        blocked ? { error: 'project-has-live-work' } : { state, events: ['project/updated'] });
      for (const phase of ['active', 'paused']) {
        f.reset({ state, lease, open, phase: 'archived' });
        const recovering = state === 'in_progress';
        await f.check(f.command('unused', { op: 'project.update', actor: actor('human'), phase }), {
          state: recovering ? (open ? 'interrupted' : 'ready') : state,
          events: ['project/updated', ...(recovering ? [open ? 'task/interrupted' : 'task/readied'] : [])],
        });
        assert.equal(f.h.leases.size, 0);
        assert.equal(f.h.state.project.phase, phase);
        if (open) assert.equal(f.h.state.intents.int_matrix.status, 'open');
      }
    }
    // Not unarchive: active -> paused/active preserves lease and owner.
    for (const phase of ['active', 'paused']) for (const open of [false, true]) for (const kind of ['human', 'agent']) {
      f.reset({ state: 'in_progress', lease: 'live', open });
      const lease = structuredClone([...f.h.leases]);
      await f.check(f.command('unused', { op: 'project.update', actor: actor(kind), phase }), kind === 'agent'
        ? { error: 'forbidden-role' } : { state: 'in_progress', events: ['project/updated'] });
      assert.deepEqual([...f.h.leases], lease);
    }
    t.diagnostic('32 combinations: 8 archive, 16 unarchive, 8 active updates');
  } finally { f.close(); }
});

// 责任：归档生命周期、preflight 和底层 append 也须零写，不能绕过总线屏障。
test('archived no-write lifecycle and preflight/append backstops', async () => {
  const f = fixture();
  try {
    f.reset({ state: 'in_progress', lease: 'expired', open: true, phase: 'archived' });
    const before = f.snapshot();
    f.h.recover();
    f.h._expireLeases();
    f.h.touch('owner');
    assert.deepEqual(f.snapshot(), before);
    await assert.rejects(f.h._preflight(f.command('submit')), { code: 'project-archived' });
    assert.deepEqual(f.snapshot(), before);
    assert.throws(() => f.h._appendEvents([{ type: 'task/readied' }], actor(), 'cmd_no', 1), { code: 'project-archived' });
    assert.deepEqual(f.snapshot(), before);
    for (const op of ['doc.put', 'plan.publish', 'project.relocate', 'session.checkpoint', 'session.handoff', 'project.update']) {
      await f.check(f.command('unused', { op, body: 'not written', title: 'not written' }), { error: 'project-archived' });
    }
    await f.h.attach({ sessionId: 'ephemeral' });
    await f.h.detach('ephemeral');
    const after = f.snapshot();
    assert.deepEqual(after.bytes, before.bytes);
    assert.equal(after.rev, before.rev);
    assert.equal(after.projectRev, before.projectRev);
    assert.deepEqual(after.leases, before.leases);
    assert.ok(f.h.state.bindings.ephemeral.detachedAt);
  } finally { f.close(); }
});
