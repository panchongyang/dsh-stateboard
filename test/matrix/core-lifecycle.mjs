/**
 * 测试职责：用真实命令链补齐归档、重领、意图重试及驳回复用租约的交互边界。
 * 典型流程：隔离 fixture → 连续 claim/begin/release/block/reconcile 或构造旧归档数据 → 对照完整事件账本。
 * 覆盖边界：覆盖 跨命令 token 演进、归档恢复与拒绝优先级；不覆盖真实工作副作用或宿主 UI。
 * 外部前置：必须在 launcher 注入的最小隔离环境执行；不读真实 profile。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { NOW, TASK, actor, assertIsolation, fixture } from '../helpers/core-matrix-fixture.mjs';

assertIsolation();

function currentCommand(f, op, extra = {}) {
  return f.command(op, { expected: { entityRev: f.h.state.tasks[TASK].rev }, fencingToken: f.h.leases.get(TASK)?.token, ...extra });
}

function addArchivedPlan(f, status = 'archived') {
  const task = f.h.state.tasks[TASK];
  const head = { id: 'pln_matrix', title: 'synthetic legacy plan', status, archivedFrom: status === 'archived' ? 'active' : null, currentVersion: 1, rev: 1 };
  const binding = { sessionId: 'owner', agentId: 'owner', epoch: 0, boundAt: new Date(NOW).toISOString(), lastSeenAt: new Date(NOW).toISOString() };
  // Persist these synthetic legacy facts before exercising public command guards.
  f.h._appendEvents([
    { type: status === 'archived' ? 'plan/archived' : 'plan/updated', data: head },
    { type: 'session/bound', data: binding },
    { type: 'task/updated', taskId: TASK, rev: task.rev + 1,
      data: { ...task, rev: task.rev + 1, planRef: { planId: head.id, version: 1, stepId: 's1' }, assignee: { sessionId: 'owner', epoch: 0 } } },
  ], actor('human'), 'cmd_plan_seed', f.h.rev);
}

// 责任：归档计划所有进入工作路径须拒绝，unarchive 后 claim 才可合法发租约。
test('archived plan guards all work-entry paths, then unarchive permits claim (12 rejected + 2 allowed)', async (t) => {
  const f = fixture();
  const entries = [
    ['claim', 'ready', false, {}],
    ['reconcile', 'interrupted', true, { choice: 'resume' }],
    ['unblock', 'blocked', false, {}],
    ['reject', 'review', false, {}],
    ['reopen', 'done', false, {}],
    ['override', 'interrupted', true, { toState: 'in_progress', intent: { outcome: 'stopped', sideEffects: [] } }],
  ];
  try {
    for (const [op, state, open, extra] of entries) for (const kind of ['human', 'agent']) {
      f.reset({ state, open, lease: 'none' });
      addArchivedPlan(f);
      const error = kind === 'agent' && ['reopen', 'override'].includes(op) ? 'forbidden-role' : 'plan-archived';
      await f.check(currentCommand(f, op, { actor: actor(kind), ...extra }), { error }, op + '/' + kind);
    }
    f.reset({ state: 'ready', lease: 'none' });
    addArchivedPlan(f);
    await f.check(currentCommand(f, 'unused', { op: 'plan.unarchive', planId: 'pln_matrix', expected: { entityRev: 1 } }), { state: 'ready', events: ['plan/unarchived'] });
    await f.check(currentCommand(f, 'claim'), { state: 'in_progress', events: ['lease/granted', 'task/claimed'] });
    t.diagnostic('14 cases');
  } finally { f.close(); }
});

// 责任：真实 release/reclaim 后旧 token 在各写入口均须失效，block/unblock 后新 begin 增 attempt。
test('real claim/begin/release/reclaim and block/unblock retry ledger (21 commands)', async (t) => {
  const f = fixture();
  try {
    f.reset({ state: 'ready', lease: 'none' });
    await f.h.attach({ sessionId: 'owner', agentId: 'owner' });
    await f.check(currentCommand(f, 'claim'), { state: 'in_progress', events: ['lease/granted', 'task/claimed'] });
    const oldToken = f.h.leases.get(TASK).token;
    await f.check(currentCommand(f, 'begin'), { state: 'in_progress', events: ['work/intent', 'task/updated'] });
    await f.check(currentCommand(f, 'release'), { error: 'intent-unresolved' });
    await f.check(currentCommand(f, 'release', { intent: { outcome: 'stopped', sideEffects: [] } }), { state: 'ready', events: ['work/abandoned', 'lease/revoked', 'task/released'] });
    await f.check(currentCommand(f, 'claim'), { state: 'in_progress', events: ['lease/granted', 'task/claimed'] });
    assert.ok(f.h.leases.get(TASK).token > oldToken);
    for (const op of ['begin', 'submit', 'release', 'block', 'cancel', 'interrupt']) {
      await f.check(currentCommand(f, op, { fencingToken: oldToken }), { error: 'fencing-stale' }, op + ' genuine old grant');
    }
    await f.check(currentCommand(f, 'begin'), { state: 'in_progress', events: ['work/intent', 'task/updated'] });
    const oldIntent = f.h.state.tasks[TASK].work.intentId;
    await f.check(currentCommand(f, 'block', { intent: { outcome: 'stopped', sideEffects: [] } }), { state: 'blocked', events: ['work/abandoned', 'lease/revoked', 'task/blocked'] });
    await f.check(currentCommand(f, 'unblock'), { state: 'in_progress', events: ['lease/granted', 'task/unblocked', 'task/assignment'] });
    assert.equal(f.h.state.intents[oldIntent].status, 'abandoned');
    assert.equal(Object.values(f.h.state.intents).filter((intent) => intent.status === 'open').length, 0);
    await f.check(currentCommand(f, 'begin'), { state: 'in_progress', events: ['work/intent', 'task/updated'] });
    assert.equal(f.h.state.tasks[TASK].work.attempt, 2);
    await f.check(currentCommand(f, 'submit'), { state: 'review', events: ['work/result', 'task/submitted'] });
    assert.equal(f.h.leases.size, 0);
    await f.check(currentCommand(f, 'reject', { actor: actor('human') }), { state: 'in_progress', events: ['lease/granted', 'task/rejected', 'task/assignment'] });
    // Old closed submit intent is history, not an unresolved new attempt.
    await f.check(currentCommand(f, 'begin'), { state: 'in_progress', events: ['work/intent', 'task/updated'] });
    await f.check(currentCommand(f, 'interrupt'), { state: 'interrupted', events: ['lease/revoked', 'task/interrupted'] });
    await f.check(currentCommand(f, 'reconcile', { choice: 'discard' }), { state: 'ready', events: ['work/abandoned', 'task/reconciled'] });
    t.diagnostic('20 checked task commands + attach fixture setup; 6 genuine re-claim stale-token rejects');
  } finally { f.close(); }
});

// 责任：旧 closed/abandoned 意图仅是历史，不得要求重复结清或阻止后续合法操作。
test('legacy closed/abandoned intents are history, not new settlement requirements (8 cases)', async (t) => {
  const f = fixture();
  try {
    for (const status of ['closed', 'abandoned']) for (const op of ['begin', 'release', 'block', 'cancel']) {
      f.reset({ state: 'in_progress', lease: 'live', open: true });
      const legacy = { ...f.h.state.intents.int_matrix, status, closedAt: new Date(NOW).toISOString() };
      // Legacy records intentionally omit RFC-3 settlement identity fields.
      f.h._appendEvents([{ type: status === 'closed' ? 'work/result' : 'work/abandoned', taskId: TASK, data: legacy }], actor(), 'cmd_legacy_seed', f.h.rev);
      const expected = {
        begin: { state: 'in_progress', events: ['work/intent', 'task/updated'] },
        release: { state: 'ready', events: ['lease/revoked', 'task/released'] },
        block: { state: 'blocked', events: ['lease/revoked', 'task/blocked'] },
        cancel: { state: 'canceled', events: ['lease/revoked', 'task/canceled'] },
      }[op];
      await f.check(currentCommand(f, op), expected, status + '/' + op);
      assert.equal(f.h.state.intents.int_matrix.status, status);
      if (op === 'begin') assert.equal(f.h.state.tasks[TASK].work.attempt, 2);
    }
    t.diagnostic('8 legacy cases');
  } finally { f.close(); }
});

// 责任：项目 CAS 须先于归档屏障判定，非法/缺任务请求失败必须零写。
test('entry project CAS precedes archived gate; invalid/missing task checks are atomic (6 cases)', async (t) => {
  const f = fixture();
  try {
    f.reset({ phase: 'archived', state: 'in_progress', lease: 'live', open: true });
    await f.check(f.command('cancel', { expected: { projectRev: 0, entityRev: 7 } }), { error: 'stale-revision' });
    f.reset({ state: 'ready', lease: 'none' });
    for (const extra of [{ taskId: '' }, { taskId: null }, { taskId: 'tsk_missing' }]) {
      await f.check(f.command('claim', extra), { error: extra.taskId === 'tsk_missing' ? 'not-found' : 'invalid-command' });
    }
    await f.check(f.command('claim', { cmdId: '' }), { error: 'invalid-command' });
    await f.check(f.command('unused', { op: 'not.an.op' }), { error: 'invalid-command' });
    t.diagnostic('6 entry cases');
  } finally { f.close(); }
});

// DESIGN I21 applies to every path entering in_progress, not only a new grant.
// These legacy review+lease inputs are intentionally supported defensive cases.
for (const plan of ['archived', 'active']) for (const kind of ['human', 'agent']) {
  for (const lease of ['live', 'grace']) for (const open of [false, true]) {
    // 责任：驳回复用租约的计划/角色/租约/意图组合须按 oracle 决定，不能意外重发或偷换 owner。
    test(`reject lease reuse: ${plan}/${kind}/${lease}/open=${open} (6 combinations)`, async (t) => {
      const f = fixture();
      try {
        for (const token of ['correct', 'stale', 'missing']) for (const unassign of [false, true]) {
          f.reset({ state: 'review', lease, open });
          addArchivedPlan(f, plan);
          const cmd = currentCommand(f, 'reject', { actor: actor(kind), unassign });
          if (token === 'stale') cmd.fencingToken--;
          if (token === 'missing') delete cmd.fencingToken;
          if (open) cmd.intent = { outcome: 'stopped', sideEffects: [] };
          const label = JSON.stringify({ plan, kind, lease, open, token, unassign });
          // Independent rule order: token -> unassign role -> settlement -> work-entry plan.
          let error = null;
          if (kind === 'agent' && token !== 'correct') error = 'fencing-stale';
          else if (kind === 'agent' && unassign) error = 'forbidden-role';
          else if (plan === 'archived' && !unassign) error = 'plan-archived';
          const events = [...(open ? ['work/abandoned'] : []), ...(unassign ? ['lease/revoked'] : []), 'task/rejected', 'task/assignment'];
          const beforeLease = structuredClone([...f.h.leases]);
          await f.check(cmd, error ? { error } : { state: unassign ? 'ready' : 'in_progress', events }, label);
          if (!error) {
            assert.deepEqual([...f.h.leases], unassign ? [] : beforeLease, label + ': no re-grant or renewal');
            if (open) {
              assert.equal(f.h.state.intents.int_matrix.status, 'abandoned');
              assert.equal(f.h.state.intents.int_matrix.outcome, 'stopped');
            }
          }
        }
        t.diagnostic('6 checked combinations');
      } finally { f.close(); }
    });
  }
}

// 责任：驳回校验须保持 token 先于 settlement、settlement 先于计划守卫的错误优先级。
test('reject lease reuse preserves settlement-before-plan and token-before-settlement priority (36 combinations)', async (t) => {
  const f = fixture();
  try {
    for (const lease of ['live', 'grace']) for (const kind of ['human', 'agent']) {
      for (const token of ['correct', 'stale', 'missing']) for (const settlement of ['absent', 'unknown', 'missing-effects']) {
        f.reset({ state: 'review', lease, open: true });
        addArchivedPlan(f);
        const cmd = currentCommand(f, 'reject', { actor: actor(kind) });
        if (token === 'stale') cmd.fencingToken--;
        if (token === 'missing') delete cmd.fencingToken;
        if (settlement === 'unknown') cmd.intent = { outcome: 'unknown', sideEffects: [] };
        if (settlement === 'missing-effects') cmd.intent = { outcome: 'stopped' };
        const error = kind === 'agent' && token !== 'correct' ? 'fencing-stale'
          : settlement === 'missing-effects' ? 'invalid-command' : 'intent-unresolved';
        await f.check(cmd, { error }, JSON.stringify({ lease, kind, token, settlement }));
      }
    }
    t.diagnostic('36 checked combinations; no attempted settlement is committed on refusal');
  } finally { f.close(); }
});
