/**
 * 测试职责：验证具名模型转移及纯业务决策的非法来源、所有权、恢复与显式输入边界。
 * 典型流程：构造合成草稿和事实 → 执行具名操作 → 比较合法结果或错误且拒绝时不改草稿。
 * 覆盖边界：覆盖任务、计划、文档、意图与租约模型及资格决策；不覆盖真实介质与宿主授权。
 * 外部前置：无，全部样本是内存合成值，不读取真实 profile。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as task from '../../lib/core/domain/task-transitions.js';
import * as plan from '../../lib/core/domain/plan-transitions.js';
import * as doc from '../../lib/core/domain/document-transitions.js';
import { openWorkIntent, completeWorkIntent, abandonWorkIntent } from '../../lib/core/domain/work-transitions.js';
import { grantRuntimeLease, renewRuntimeLease, activityRuntimeLease } from '../../lib/core/domain/lease-transitions.js';
import { renewalExpiry, leaseReclaimable } from '../../lib/core/business/lease-policy.js';
import { beginDecision, submissionDecision, verificationDecision } from '../../lib/core/business/task-policy.js';
import { assertPlanArchivable } from '../../lib/core/business/plan-policy.js';
import { documentStatusDecision } from '../../lib/core/business/document-policy.js';
import { TASK_STATES } from '../../lib/shared/contract.js';
import { projectOperations } from '../../lib/core/domain/operations/projects.js';
import { sessionOperations } from '../../lib/core/domain/operations/sessions.js';
import { emptyState } from '../../lib/core/model.js';
import { mergeAcceptance, normalizeSteps } from '../../lib/core/normalize.js';

const at = '2026-01-02T03:04:05.000Z';
const now = Date.parse(at);
const actor = { kind: 'agent', sessionId: 'synthetic', agentId: 'synthetic' };
const lease = { taskId: 't', sessionId: actor.sessionId, agentId: actor.agentId, token: 42, epoch: 3, expiresAt: '2026-01-02T03:05:05.000Z' };
const sample = (state) => ({ id: 't', state, rev: 1, owner: { fencingToken: 1 }, assignee: { sessionId: 'old' }, workers: [], acceptance: [], evidence: [], work: null, blocker: null });

// 责任：每个具名操作拒绝全部非法来源，拒绝不改变私有草稿。
test('named task operations enforce every source edge without a state setter', () => {
  const rows = [
    ['claim', ['ready'], (t) => task.claimTask(t, lease, at), 'in_progress'],
    ['submit', ['in_progress'], task.submitTask, 'review'],
    ['verify', ['review'], (t) => task.verifyTask(t, at, 'human'), 'done'],
    ['reject/resume', ['review'], (t) => task.rejectTask(t, lease, at), 'in_progress'],
    ['reject/pool', ['review'], (t) => task.rejectTask(t, null, at), 'ready'],
    ['block', ['in_progress', 'review'], (t) => task.blockTask(t, { code: 'wait', since: at }), 'blocked'],
    ['unblock', ['blocked'], (t) => task.unblockTask(t, lease, at), 'in_progress'],
    ['release', ['in_progress'], task.releaseTask, 'ready'],
    ['reconcile/resume', ['interrupted'], (t) => task.reconcileResumeTask(t, lease, { id: 'i', attempt: 2 }, at), 'in_progress'],
    ['reconcile/completed', ['interrupted'], (t) => task.reconcileCompletedTask(t, null), 'review'],
    ['reconcile/discard', ['interrupted'], task.reconcileDiscardTask, 'ready'],
    ['reopen', ['done', 'canceled'], (t) => task.reopenTask(t, null, true, at), 'ready'],
    ['ready', ['backlog'], task.readyTask, 'ready'],
  ];
  let checked = 0;
  for (const [name, sources, change, target] of rows) for (const state of TASK_STATES) {
    const t = sample(state), before = structuredClone(t);
    if (sources.includes(state)) {
      change(t); assert.equal(t.state, target, name);
      if (target === 'in_progress') assert.equal(t.owner.fencingToken, lease.token, name);
      else if (target !== 'blocked' && name !== 'ready') assert.equal(t.owner, null, name);
    } else { assert.throws(() => change(t), { code: 'illegal-transition' }, name + '/' + state); assert.deepEqual(t, before); }
    checked++;
  }
  assert.equal(checked, rows.length * TASK_STATES.length);
  assert.equal(task.setState, undefined);
});

// 责任：正常状态机不能冒充 override 或恢复；人类修复必须显式带上开放意图事实。
test('override and recovery are explicit named escapes with preserved ownership invariants', () => {
  const t = sample('done'), before = structuredClone(t);
  assert.throws(() => task.humanOverrideTask(t, 'ready', actor), { code: 'forbidden-role' });
  assert.deepEqual(t, before);
  assert.throws(() => task.humanOverrideTask(t, 'invented', { kind: 'human' }), { code: 'invalid-command' });
  task.humanOverrideTask(t, 'ready', { kind: 'human' });
  assert.equal(t.owner, null); assert.equal(t.assignee, null);
  const blocked = sample('blocked'); blocked.blocker = { resumeTo: 'review', code: 'historical' };
  assert.throws(() => task.interruptTask(structuredClone(blocked), {}), { code: 'illegal-transition' });
  task.interruptTask(blocked, { at }, { humanRepair: true, hasOpenIntent: true });
  assert.equal(blocked.state, 'interrupted'); assert.equal(blocked.interrupt.previousBlocker.code, 'historical');
  assert.equal(blocked.owner, null); assert.equal(blocked.assignee, null);
  for (const open of [false, true]) {
    const released = task.recoverReleasedTask(sample('in_progress'), open);
    assert.equal(released.state, open ? 'interrupted' : 'ready'); assert.equal(released.owner, null);
  }
  assert.throws(() => task.claimTask(sample('ready'), { ...lease, taskId: 'foreign' }, at), { code: 'illegal-transition' });
});

// 责任：意图只能从 open 具名结清；回放历史不是重复申请转移。
test('work intent model does not reopen or double settle historical outcomes', () => {
  const open = openWorkIntent({ id: 'i', taskId: 't', token: 42 });
  const closed = completeWorkIntent(open, { closedAt: at });
  const abandoned = abandonWorkIntent(open, { outcome: 'stopped', sideEffects: [] });
  assert.equal(open.status, 'open'); assert.equal(closed.status, 'closed'); assert.equal(abandoned.status, 'abandoned');
  assert.throws(() => completeWorkIntent(closed, {}), { code: 'illegal-transition' });
  assert.throws(() => abandonWorkIntent(abandoned, {}), { code: 'illegal-transition' });
});

// 责任：计划版本只允许后继修订；归档和取消归档不改变不可变版本事实。
test('plan lifecycle, version succession and cross-object archive policy are distinct', () => {
  const draft = plan.draftHead('p', 'Synthetic', { steps: [] }, at);
  const active = plan.publishedHead({ planId: 'p', title: 'Synthetic', head: draft }, at);
  const current = plan.planVersionPayload({ id: 'p', version: 1, steps: [{ id: 's', taskIds: ['t'] }], title: 'Synthetic' });
  assert.equal(active.status, 'active');
  const archived = plan.archivePlan(active, at);
  assert.equal(plan.unarchivePlan(archived, at).status, 'active');
  assert.equal(plan.unarchivePlan(plan.archivePlan(draft, at), at).status, 'draft');
  assert.throws(() => plan.publishedHead({ planId: 'p', title: 'x', head: archived }, at), { code: 'plan-archived' });
  assert.throws(() => plan.revisePlanHead(active, 3, at), { code: 'stale-revision' });
  assert.equal(plan.revisePlanHead(active, 2, at).currentVersion, 2);
  assert.equal(plan.supersedePlanVersion(current, { planId: 'p', version: 2 }).status, 'superseded');
  assert.equal(current.status, 'published');
  assert.throws(() => plan.supersedePlanVersion(current, { planId: 'other', version: 2 }), { code: 'illegal-transition' });
  const state = { plans: { 'p@1': current }, tasks: { t: sample('ready') } };
  assert.throws(() => assertPlanArchivable(state, active, new Set(['t'])), { code: 'plan-has-live-work' });
  state.tasks.t.state = 'in_progress';
  assert.throws(() => assertPlanArchivable(state, active, new Set()), { code: 'plan-has-live-work' });
});

// 责任：文档政策定资格，模型仍独立拒绝非法边和注销后的写入。
test('external document management has named legal edges and explicit archive recovery', () => {
  const d = doc.registerExternalDocument({ id: 'doc_synthetic', source: 'external', rev: 1, title: 'Synthetic', kind: 'spec',
    locator: { bindingId: 'b', relPath: 'docs/spec.md' }, links: { taskIds: [], planRefs: [] },
    baseline: null, baselineInContext: false, unregistered: null, createdAt: at, updatedAt: at });
  assert.throws(() => doc.adoptDocument(d), { code: 'illegal-transition' });
  const reviewed = doc.requestDocumentReview(d), adopted = doc.adoptDocument(reviewed), archived = doc.archiveDocument(adopted);
  assert.equal(d.status, 'draft'); assert.equal(adopted.status, 'adopted');
  assert.throws(() => documentStatusDecision(archived, { status: 'draft' }), { code: 'invalid-command' });
  assert.equal(documentStatusDecision(archived, { status: 'draft', reason: 'Reopen synthetic' }).to, 'draft');
  assert.equal(doc.reopenDocument(archived).status, 'draft');
  assert.equal(doc.returnDocumentDraft(reviewed).status, 'draft');
  const removed = doc.unregisterExternalDocument(archived, { at, reason: 'archive' }, at);
  assert.throws(() => doc.reopenDocument(removed), { code: 'illegal-transition' });
});

// 责任：接纳续租是具名模型事实，持有者/token/epoch/无进展限制都不能被读侧绕过。
test('runtime renewals and trusted activity enforce token epoch and progress ceilings', () => {
  const state = { counters: { leaseToken: 0 }, bindings: { synthetic: { epoch: 3 } } }, leases = new Map();
  const policy = { leaseTtlSec: 60, leaseGraceSec: 30, maxRenewalsWithoutProgress: 2 };
  const l = grantRuntimeLease(state, leases, { id: 't' }, actor, { at, now, ttlSec: 60 });
  const expiry = renewalExpiry(l, policy, now + 10_000);
  const before = structuredClone(l);
  assert.equal(activityRuntimeLease(state, l, { now, expiry, policy, sessionId: actor.sessionId, token: 999, max: 2 }), false);
  assert.deepEqual(l, before);
  assert.equal(activityRuntimeLease(state, l, { now, expiry, policy, sessionId: actor.sessionId, token: l.token, max: 2 }), true);
  assert.equal(l.renewCount, 0);
  renewRuntimeLease(state, l, { now, expiry, actor, token: l.token, max: 2 });
  assert.equal(l.renewCount, 1);
  state.bindings.synthetic.epoch = 4;
  const unchanged = structuredClone(l);
  assert.throws(() => renewRuntimeLease(state, l, { now, expiry, actor, token: l.token, max: 2 }), { code: 'lease-expired' });
  assert.equal(activityRuntimeLease(state, l, { now, expiry, policy, sessionId: actor.sessionId, token: l.token, max: 2 }), false);
  assert.deepEqual(l, unchanged);
  assert.equal(leaseReclaimable(state, l, policy, now), true);
  assert.equal(renewalExpiry({ ...l, renewCount: 2 }, policy, now), null);
});

// 责任：纯政策和规范化只能使用传入事实/ID，不隐含读盘、取钟或创建ID。
test('pure use-case eligibility preserves error precedence and explicit ID allocation', () => {
  assert.throws(() => beginDecision({ id: 'i' }, ''), { code: 'illegal-transition' });
  assert.throws(() => submissionDecision(null, { requireIntentFor: 'all' }, []), { code: 'illegal-transition' });
  assert.throws(() => verificationDecision({ ...sample('review'), acceptance: [{ met: false }] }, { actor: { kind: 'system' } }), { code: 'forbidden-role' });
  const ids = []; const allocate = (prefix) => { ids.push(prefix); return prefix + '_' + ids.length; };
  assert.equal(mergeAcceptance([], [{ text: 'A' }], allocate)[0].id, 'acc_1');
  assert.equal(normalizeSteps([{ id: 's', tasks: [{ key: 't', title: 'Synthetic', acceptance: [{ text: 'A' }] }] }], allocate)[0].tasks[0].acceptance[0].id, 'acc_2');
  assert.throws(() => mergeAcceptance([], [{ text: 'Missing port' }]), { code: 'invalid-command' });
  assert.deepEqual(ids, ['acc', 'acc']);
});

// 责任：失效事实只依赖传入时钟、策略和代次，旧绑定锚点不能被已经续期的expiresAt掩盖，纯判定与拒绝不改输入。
test('shared lease-time facts keep stale-generation activity fenced without project defaults', () => {
  const policy = Object.freeze({ leaseTtlSec: 60, leaseGraceSec: 30, maxRenewalsWithoutProgress: 2 });
  const state = { bindings: { synthetic: { epoch: 3, boundAt: at, lastSeenAt: at } } };
  const l = { ...lease, grantedAt: at, progressAt: at, renewCount: 1, expiresAt: new Date(now + 110000).toISOString() };
  const before = structuredClone({ state, l });
  assert.equal(leaseReclaimable(state, l, policy, now + 89999), false);
  assert.equal(leaseReclaimable(state, l, policy, now + 90000), true);
  assert.equal(renewalExpiry(l, policy, now + 100000), now + 160000);
  assert.equal(activityRuntimeLease(state, l, { now: now + 100000, expiry: now + 160000,
    sessionId: actor.sessionId, token: l.token, max: 2, policy }), false);
  assert.deepEqual({ state, l }, before);
  const fresh = { bindings: { synthetic: { ...state.bindings.synthetic, lastSeenAt: new Date(now + 50000).toISOString() } } };
  assert.equal(leaseReclaimable(fresh, l, policy, now + 100000), false);
  assert.equal(activityRuntimeLease(fresh, l, { now: now + 100000, expiry: now + 160000,
    sessionId: actor.sessionId, token: l.token, max: 2, policy }), true);
  assert.equal(l.renewCount, 1);
  assert.equal(l.expiresAt, new Date(now + 160000).toISOString());
  assert.deepEqual(state, before.state);
});

// 责任：项目模型独立执行也保留活工作归档闸；命令不是资格判定的必要前置。
test('project operation owns archive qualification independently from command assembly', () => {
  for (const mode of ['task', 'lease', 'intent']) {
    const state = emptyState({ id: 'p', phase: 'active', name: 'Synthetic' });
    const work = { state, leases: new Map(), clock: () => new Date(at), rev: 0 };
    if (mode === 'task') state.tasks.t = sample('in_progress');
    if (mode === 'lease') work.leases.set('t', lease);
    if (mode === 'intent') state.intents.i = { id: 'i', status: 'open' };
    const before = structuredClone(state);
    assert.throws(() => projectOperations['project.applyUpdate'](work, { phase: 'archived' }, { actor: { kind: 'human' } }), { code: 'project-has-live-work' });
    assert.deepEqual(state, before);
  }
  const work = { state: emptyState({ id: 'p', phase: 'active' }), leases: new Map(), clock: () => new Date(at), rev: 0 };
  assert.throws(() => projectOperations['project.applyUpdate'](work, { policy: { verification: 'auto' } }, { actor: { kind: 'human' } }), { code: 'invalid-command' });
});

// 责任：相同可信身份与参数可选择两种具名会话事实；事件语义不依赖公开命令名。
test('session operation itself selects checkpoint or handoff fact and rejects spoofed identity', () => {
  const state = emptyState({ id: 'p', phase: 'active' });
  const work = { state, clock: () => new Date(at) };
  const identity = { cmdId: 'synthetic', actor };
  Object.defineProperty(identity, 'op', { get() { throw Error('public name must not be read'); } });
  const args = { note: '交接', nextActions: ['继续'] };
  assert.equal(sessionOperations['session.recordCheckpoint'](work, args, identity).events[0].type, 'session/checkpoint');
  assert.equal(sessionOperations['session.recordHandoff'](work, args, identity).events[0].type, 'session/handoff');
  assert.throws(() => sessionOperations['session.recordHandoff'](work, { ...args, actor: { kind: 'human' } }, identity), { code: 'invalid-command' });
  assert.throws(() => sessionOperations['session.recordHandoff'](work, args, { actor: { kind: 'human', sessionId: actor.sessionId } }), { code: 'forbidden-role' });
});
