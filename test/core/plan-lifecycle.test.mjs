/**
 * 测试职责：约束计划草案、发布、版本、焦点与任务成员的集成生命周期。
 * 典型流程：构造合成临时项目或状态 → 执行领域操作 → 比较原始断言与副作用。
 * 覆盖边界：覆盖 计划归属、规范化和相关不变量；不覆盖 任务租约、日志损坏或性能预算。
 * 外部前置：需要可写临时目录；不依赖宿主服务或外部仓库。
 */
import assert from 'node:assert/strict';
import { ProjectService } from '../../lib/core/service.js';

import test from 'node:test';
import { checkState } from '../../lib/core/fsck.js';
import { applyEvent, emptyState, normalizePlanHeads } from '../../lib/core/model.js';
import { cmd, humanCmd, PLAN, setup, publish, taskByTitle } from '../helpers/core-lifecycle-fixture.mjs';

function planHeadByTitle(h, title) {
  const head = Object.values(h.state.planHeads).find((item) => item.title === title);
  assert.ok(head, 'plan ' + title);
  return head;
}

async function createLoose(h, title) {
  const result = await h.command(cmd('task.create', { title, acceptance: [{ text: 'x' }] }));
  return result.events.find((event) => event.type === 'task/created').taskId;
}

function legacyPlanState() {
  const state = emptyState({ id: 'prj_focus', workspacePath: 'C:/focus', phase: 'active' });
  state.plans['pln_a@1'] = { id: 'pln_a', version: 1, status: 'published', title: 'A', steps: [], createdAt: '2026-01-01T00:00:00.000Z', publishedAt: '2026-01-01T00:00:00.000Z' };
  return state;
}

function headOf(status) {
  return { id: 'pln_a', title: 'A', status, rev: 1, currentVersion: 1, draft: null, archivedFrom: status === 'archived' ? 'active' : null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
}

// 责任：多个草案可共存但标题不可重名，rename 只推进 head rev 不物化版本。
test('plan.create: drafts coexist, titles are unique, rename bumps head rev only', async () => {
  const { h, svc } = await setup();
  const a = await h.command(cmd('plan.create', { title: 'Alpha' }));
  const b = await h.command(cmd('plan.create', { title: 'Beta' }));
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(Object.keys(h.state.planHeads).length, 2);
  assert.ok(Object.values(h.state.planHeads).every((head) => head.status === 'draft' && head.currentVersion === 0));
  assert.equal(Object.keys(h.state.tasks).length, 0, 'plan.create makes no tasks');

  const dup = await h.command(cmd('plan.create', { title: 'ALPHA' })).then(() => null, (e) => e);
  assert.equal(dup.code, 'plan-title-taken');
  assert.equal(dup.status, 409);

  const beta = Object.values(h.state.planHeads).find((head) => head.title === 'Beta');
  const conflict = await h.command(cmd('plan.rename', { planId: beta.id, expected: { entityRev: beta.rev }, title: 'alpha' })).then(() => null, (e) => e);
  assert.equal(conflict.code, 'plan-title-taken');
  const stale = await h.command(cmd('plan.rename', { planId: beta.id, expected: { entityRev: 99 }, title: 'Gamma' })).then(() => null, (e) => e);
  assert.equal(stale.code, 'stale-revision');
  const renamed = await h.command(cmd('plan.rename', { planId: beta.id, expected: { entityRev: beta.rev }, title: 'Gamma' }));
  assert.equal(renamed.ok, true);
  assert.equal(h.state.planHeads[beta.id].title, 'Gamma');
  assert.equal(h.state.planHeads[beta.id].rev, beta.rev + 1);
  assert.equal(Object.keys(h.state.plans).length, 0, 'rename creates no version');
  await svc.close();
});

// 责任：按 planId 发布草案须原子物化，重复发布同草案必须拒绝。
test('plan.publish with planId materializes the draft atomically; republish fails', async () => {
  const { h, svc } = await setup();
  const created = await h.command(cmd('plan.create', {
    title: 'Drafty',
    goal: 'v1 goal',
    steps: [
      { id: 's1', title: 'one', tasks: [{ key: 't1', title: 'D1', acceptance: [{ text: 'x' }] }] },
      { id: 's2', title: 'two', tasks: [{ key: 't2', title: 'D2', deps: ['t1'], acceptance: [{ text: 'y' }] }] },
    ],
  }));
  const planId = created.events[0].data.id;
  assert.equal(h.state.planHeads[planId].status, 'draft');

  // Draft steps keep their task definitions until publish: the editor needs
  // them to edit existing tasks, and hiding them made a draft save drop them.
  const draftView = h.query('plan', { planId });
  assert.equal(draftView.plan.status, 'draft');
  assert.equal(draftView.steps.length, 2);
  assert.equal(draftView.steps[0].tasks.length, 1);
  assert.equal(draftView.steps[0].tasks[0].key, 't1');
  assert.equal(draftView.steps[0].tasks[0].title, 'D1');
  assert.deepEqual(draftView.steps[0].taskIds, ['t1']);
  assert.deepEqual(draftView.steps[1].tasks[0].deps, ['t1']);

  const revised = await h.command(cmd('plan.revise', { planId, expected: { entityRev: 1 }, goal: 'v2 goal', title: 'Drafty 2' }));
  assert.equal(revised.ok, true);
  assert.equal(h.state.planHeads[planId].draft.goal, 'v2 goal');
  assert.equal(h.state.planHeads[planId].title, 'Drafty 2');
  assert.equal(h.state.planHeads[planId].currentVersion, 0, 'draft revise creates no version');
  assert.equal(Object.keys(h.state.plans).length, 0);
  assert.equal(h.query('plan', { planId }).steps[1].tasks[0].deps[0], 't1', 'a draft revise without steps keeps task definitions');

  const revBefore = h.rev;
  const published = await h.command(cmd('plan.publish', { planId, expected: { entityRev: h.state.planHeads[planId].rev } }));
  assert.equal(published.ok, true);
  assert.equal(h.rev, revBefore + 1, 'publish is one atomic commit');
  const head = h.state.planHeads[planId];
  assert.equal(head.status, 'active');
  assert.equal(head.currentVersion, 1);
  assert.equal(head.draft, null);
  assert.equal(h.state.project.focusPlanId, planId, 'auto-focus when none was set');
  const tasks = Object.values(h.state.tasks);
  assert.equal(tasks.length, 2);
  assert.ok(tasks.every((task) => task.planRef.planId === planId && task.planRef.version === 1));
  assert.equal(h.state.plans[planId + '@1'].title, 'Drafty 2');

  const again = await h.command(cmd('plan.publish', { planId, expected: { entityRev: head.rev } })).then(() => null, (e) => e);
  assert.equal(again.code, 'plan-not-draft');
  await svc.close();
});

// 责任：有活跃工作时计划归档须拒绝，清理后可归档/恢复，归档内任务不得领取。
test('plan.archive refuses live work, then unarchive restores; archived tasks cannot be claimed', async () => {
  const { h, svc } = await setup();
  await publish(h);
  const planId = h.state.project.focusPlanId;
  const t1 = taskByTitle(h, 'T1');
  await h.command(cmd('task.claim', { taskId: t1.id, expected: { entityRev: t1.rev } }));

  const refused = await h.command(humanCmd('plan.archive', { planId, expected: { entityRev: h.state.planHeads[planId].rev } })).then(() => null, (e) => e);
  assert.equal(refused.code, 'plan-has-live-work');

  await h.command(cmd('task.release', { taskId: t1.id, expected: { entityRev: h.state.tasks[t1.id].rev }, fencingToken: h.leases.get(t1.id).token }));
  const archived = await h.command(humanCmd('plan.archive', { planId, expected: { entityRev: h.state.planHeads[planId].rev } }));
  assert.equal(archived.ok, true);
  assert.equal(h.state.planHeads[planId].status, 'archived');
  assert.equal(h.state.planHeads[planId].archivedFrom, 'active');
  assert.equal(h.state.project.focusPlanId, null, 'archive clears the focus');

  const claimErr = await h.command(cmd('task.claim', { taskId: t1.id, expected: { entityRev: h.state.tasks[t1.id].rev } })).then(() => null, (e) => e);
  assert.equal(claimErr.code, 'plan-archived');
  const claimHint = h.query('task', { taskId: t1.id, sessionId: 's1' }).allowedOps.find((op) => op.op === 'claim');
  assert.deepEqual(claimHint, { op: 'claim', enabled: false, reason: claimErr.message });

  const revived = await h.command(humanCmd('plan.unarchive', { planId, expected: { entityRev: h.state.planHeads[planId].rev } }));
  assert.equal(revived.ok, true);
  assert.equal(h.state.planHeads[planId].status, 'active');
  assert.equal(h.state.planHeads[planId].archivedFrom, null);
  await svc.close();
});

// 责任：只有人工可切换/清空 focus，非 active 计划不得成为焦点。
test('plan.focus switches and clears; agents and non-active plans are refused', async () => {
  const { h, svc } = await setup();
  await publish(h);
  const first = h.state.project.focusPlanId;
  assert.ok(first, 'legacy publish auto-focuses the first plan');
  const created = await h.command(cmd('plan.create', { title: 'Second', steps: [{ id: 's1', title: 'one', tasks: [{ key: 't1', title: 'S1', acceptance: [{ text: 'x' }] }] }] }));
  const secondId = created.events[0].data.id;
  await h.command(cmd('plan.publish', { planId: secondId, expected: { entityRev: 1 } }));
  assert.equal(h.state.project.focusPlanId, first, 'no auto-focus when a focus exists');

  const agentFocus = await h.command(cmd('plan.focus', { planId: secondId })).then(() => null, (e) => e);
  assert.equal(agentFocus.code, 'forbidden-role');

  const focused = await h.command(humanCmd('plan.focus', { planId: secondId }));
  assert.equal(focused.ok, true);
  assert.equal(h.state.project.focusPlanId, secondId);
  assert.equal(h.query('board', {}).plan.id, secondId, 'board follows focus');
  assert.equal(h.query('plan', {}).plan.id, secondId, 'plan view follows focus');

  await h.command(humanCmd('plan.focus', { planId: null }));
  assert.equal(h.state.project.focusPlanId, null);
  assert.equal(h.query('board', {}).plan, null);

  const draft = await h.command(cmd('plan.create', { title: 'Drafty' }));
  const draftErr = await h.command(humanCmd('plan.focus', { planId: draft.events[0].data.id })).then(() => null, (e) => e);
  assert.equal(draftErr.code, 'plan-not-active');
  await h.command(humanCmd('plan.archive', { planId: secondId, expected: { entityRev: h.state.planHeads[secondId].rev } }));
  const archivedErr = await h.command(humanCmd('plan.focus', { planId: secondId })).then(() => null, (e) => e);
  assert.equal(archivedErr.code, 'plan-not-active');
  await svc.close();
});

// 责任：旧日志缺 planHeads 时规范化须派生正确 head 与 focus。
test('normalizePlanHeads derives heads and focus from a legacy log', async () => {
  const project = { schemaVersion: 2, id: 'prj_legacy', workspacePath: '.', name: 'Legacy', phase: 'active', rev: 0, createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' };
  const state = emptyState(project);
  const at = '2020-01-02T00:00:00.000Z';
  const legacyPlan = { id: 'pln_old', version: 1, status: 'published', title: 'Old plan', goal: '', assumptions: [], risks: [], steps: [{ id: 's1', title: 'one', taskIds: [] }], createdAt: at, publishedAt: at };
  applyEvent(state, { type: 'plan/published', data: legacyPlan }); // old-style event without head
  assert.equal(state.project.currentPlanId, 'pln_old', 'legacy event still writes currentPlanId');
  assert.deepEqual(state.planHeads, {});
  normalizePlanHeads(state);
  const head = state.planHeads.pln_old;
  assert.equal(head.status, 'active');
  assert.equal(head.rev, 1);
  assert.equal(head.currentVersion, 1);
  assert.equal(head.title, 'Old plan');
  assert.equal(head.archivedFrom, null);
  assert.equal(state.project.focusPlanId, 'pln_old');
  assert.equal(state.schemaVersion, 2);
  const snapshot = structuredClone(head);
  normalizePlanHeads(state); // idempotent
  assert.deepEqual(state.planHeads.pln_old, snapshot);
});

// 责任：构造 I16/I17/I18/I19/I21 反例后 fsck 必须逐项检测不变量违规。
test('fsck flags I16/I17/I18/I19/I21 counterexamples', async () => {
  const project = { id: 'prj_x', workspacePath: '.', name: 'Fsck', phase: 'active', rev: 0, focusPlanId: null, createdAt: 't', updatedAt: 't' };
  const state = emptyState(project);
  const task = (id, taskState, planRef) => ({ id, rev: 1, title: id, description: '', state: taskState, priority: 100, weight: 1, labels: [], requiresAudit: false, deps: [], acceptance: [{ id: 'acc_' + id, text: 'x', met: false, evidenceIds: [], requiredKinds: [] }], evidence: [], planRef: planRef || null, owner: taskState === 'in_progress' ? { sessionId: 's' } : null, assignee: null, work: null, blocker: null, createdAt: 't', updatedAt: 't' });
  state.tasks.t1 = task('t1', 'in_progress', { planId: 'pln_a', version: 1, stepId: 's1' });
  state.tasks.t2 = task('t2', 'ready', { planId: 'pln_a', version: 9, stepId: 's1' }); // I16: dangling planRef
  state.plans['pln_a@1'] = { id: 'pln_a', version: 1, status: 'published', title: 'Alpha', goal: '', assumptions: [], risks: [], steps: [{ id: 's1', title: 'one', taskIds: ['t1'] }], createdAt: 't', publishedAt: 't' };
  state.planHeads.pln_a = { id: 'pln_a', title: 'Alpha', status: 'archived', rev: 1, currentVersion: 1, draft: null, archivedFrom: 'active', createdAt: 't', updatedAt: 't' }; // I21: archived with in_progress
  state.planHeads.pln_draft = { id: 'pln_draft', title: 'Draft', status: 'draft', rev: 1, currentVersion: 5, draft: { goal: '', assumptions: [], risks: [], steps: [] }, archivedFrom: null, createdAt: 't', updatedAt: 't' }; // I17: draft must be 0
  state.planHeads.pln_dup = { id: 'pln_dup', title: 'alpha', status: 'draft', rev: 1, currentVersion: 0, draft: { goal: '', assumptions: [], risks: [], steps: [] }, archivedFrom: null, createdAt: 't', updatedAt: 't' }; // I19: duplicate title
  state.project.focusPlanId = 'pln_draft'; // I18: focus on a draft

  const checked = checkState(state);
  const failed = checked.checks.filter((check) => !check.ok).map((check) => check.name);
  assert.ok(failed.includes('task-planref:t2'), JSON.stringify(failed));
  assert.ok(failed.includes('plan-head-version:pln_draft'), JSON.stringify(failed));
  assert.ok(failed.includes('plan-focus'), JSON.stringify(failed));
  assert.ok(failed.includes('plan-titles'), JSON.stringify(failed));
  assert.ok(failed.includes('plan-archived-tasks:pln_a'), JSON.stringify(failed));
});

// 责任：不带 planId 的兼容发布须创建第二个计划，不得误判已有计划而报冲突。
test('legacy publish without planId creates a second plan instead of 409', async () => {
  const { h, svc } = await setup();
  await publish(h);
  const firstPlanId = h.state.project.focusPlanId;
  const second = await h.command({ ...cmd('plan.publish', { title: 'Second legacy', steps: [{ id: 's1', title: 'one', tasks: [{ key: 't1', title: 'S1', acceptance: [{ text: 'x' }] }] }] }), cmdId: 'plan-second' });
  assert.equal(second.ok, true);
  const heads = Object.values(h.state.planHeads);
  assert.equal(heads.length, 2);
  assert.equal(Object.keys(h.state.currentPlans).length, 2);
  assert.equal(h.state.project.focusPlanId, firstPlanId, 'focus stays on the first plan');
  assert.equal(h.query('board', {}).plan.id, firstPlanId);
  const secondHead = heads.find((head) => head.id !== firstPlanId);
  assert.equal(secondHead.status, 'active');
  assert.equal(secondHead.currentVersion, 1);
  await svc.close();
});

// 责任：修订 active 计划须同时推进版本和 head.currentVersion，旧 baseVersion 必须拒绝。
test('active revise bumps version and head.currentVersion; stale baseVersion rejected', async () => {
  const { h, svc } = await setup();
  await publish(h);
  const planId = h.state.project.focusPlanId;
  const stale = await h.command(cmd('plan.revise', { planId, baseVersion: 99, steps: PLAN.steps })).then(() => null, (e) => e);
  assert.equal(stale.code, 'stale-revision');
  const revised = await h.command(cmd('plan.revise', { planId, baseVersion: 1, title: 'Demo plan v2', steps: PLAN.steps }));
  assert.equal(revised.ok, true);
  assert.equal(h.state.planHeads[planId].currentVersion, 2);
  assert.equal(h.state.planHeads[planId].title, 'Demo plan v2');
  assert.ok(h.state.plans[planId + '@2']);
  assert.equal(h.state.plans[planId + '@1'].status, 'superseded');
  await svc.close();
});

// 责任：收录散任务再移出时归属和计划快照须更新，每次操作推进计划版本。
test('plan.adopt adds a loose task and plan.release removes it, both bump version', async () => {
  const { h, svc } = await setup();
  await publish(h);
  const head = planHeadByTitle(h, 'Demo plan');
  const looseId = await createLoose(h, 'Loose task');
  const adopted = await h.command(cmd('plan.adopt', { planId: head.id, baseVersion: 1, taskIds: [looseId], stepId: 's1' }));
  assert.equal(adopted.ok, true);
  assert.equal(h.state.planHeads[head.id].currentVersion, 2);
  assert.deepEqual(h.state.tasks[looseId].planRef, { planId: head.id, version: 2, stepId: 's1' });
  let view = h.query('plan', {});
  assert.ok(view.steps[0].tasks.some((task) => task.id === looseId));

  const released = await h.command(cmd('plan.release', { planId: head.id, baseVersion: 2, taskIds: [looseId] }));
  assert.equal(released.ok, true);
  assert.equal(h.state.planHeads[head.id].currentVersion, 3);
  assert.equal(h.state.tasks[looseId].planRef, null);
  view = h.query('plan', {});
  assert.equal(view.steps.some((step) => step.tasks.some((task) => task.id === looseId)), false);
  await svc.close();
});

// 责任：重复 adopt 已在计划内的任务须幂等，不能制造重复成员。
test('plan.adopt is idempotent for a task already in the plan', async () => {
  const { h, svc } = await setup();
  await publish(h);
  const head = planHeadByTitle(h, 'Demo plan');
  const looseId = await createLoose(h, 'Loose task');
  await h.command(cmd('plan.adopt', { planId: head.id, baseVersion: 1, taskIds: [looseId], stepId: 's1' }));
  const rev = h.rev;
  const again = await h.command(cmd('plan.adopt', { planId: head.id, baseVersion: 2, taskIds: [looseId], stepId: 's1' }));
  assert.equal(again.ok, true);
  assert.equal(again.committed, false);
  assert.equal(h.rev, rev);
  assert.equal(h.state.planHeads[head.id].currentVersion, 2);
  await svc.close();
});

// 责任：收录时旧 baseVersion、缺 step、异计划归属或进行中任务均须被守卫拒绝。
test('plan membership guards: stale baseVersion, missing step, foreign plan, in_progress', async () => {
  const { h, svc } = await setup();
  await publish(h);
  const head = planHeadByTitle(h, 'Demo plan');
  const looseId = await createLoose(h, 'Loose task');
  const stale = await h.command(cmd('plan.adopt', { planId: head.id, baseVersion: 99, taskIds: [looseId], stepId: 's1' })).then(() => null, (e) => e);
  assert.equal(stale.code, 'stale-revision');
  const noStep = await h.command(cmd('plan.adopt', { planId: head.id, baseVersion: 1, taskIds: [looseId], stepId: 'nope' })).then(() => null, (e) => e);
  assert.equal(noStep.code, 'plan-step-not-found');

  await publish(h, { title: 'Other plan', steps: [{ id: 'o1', title: 'other', tasks: [{ key: 'o1', title: 'Other task', acceptance: [{ text: 'x' }] }] }] }, 'plan-other');
  const other = planHeadByTitle(h, 'Other plan');
  await h.command(cmd('plan.adopt', { planId: head.id, baseVersion: 1, taskIds: [looseId], stepId: 's1' }));
  const inUse = await h.command(cmd('plan.adopt', { planId: other.id, baseVersion: 1, taskIds: [looseId], stepId: 'o1' })).then(() => null, (e) => e);
  assert.equal(inUse.code, 'plan-task-in-use');

  const busyId = await createLoose(h, 'Busy task');
  await h.command(cmd('task.claim', { taskId: busyId, expected: { entityRev: 1 } }));
  const busy = await h.command(cmd('plan.adopt', { planId: head.id, baseVersion: 2, taskIds: [busyId], stepId: 's1' })).then(() => null, (e) => e);
  assert.equal(busy.code, 'plan-task-in-progress');
  await svc.close();
});

// 责任：release 进行中任务必须拒绝，计划版本不得因此改变。
test('plan.release rejects in_progress tasks and keeps the plan version unchanged', async () => {
  const { h, svc } = await setup();
  await publish(h);
  const head = planHeadByTitle(h, 'Demo plan');
  const looseId = await createLoose(h, 'Loose task');
  await h.command(cmd('plan.adopt', { planId: head.id, baseVersion: 1, taskIds: [looseId], stepId: 's1' }));
  await h.command(cmd('task.claim', { taskId: looseId, expected: { entityRev: h.state.tasks[looseId].rev } }));
  const busy = await h.command(cmd('plan.release', { planId: head.id, baseVersion: 2, taskIds: [looseId] })).then(() => null, (e) => e);
  assert.equal(busy.code, 'plan-task-in-progress');
  assert.equal(h.state.planHeads[head.id].currentVersion, 2);
  assert.equal(h.state.tasks[looseId].planRef.version, 2);
  await svc.close();
});

// 责任：跨计划移动须先 release 再 adopt，最终成员归属只落目标计划。
test('cross-plan move is release then adopt', async () => {
  const { h, svc } = await setup();
  await publish(h);
  const first = planHeadByTitle(h, 'Demo plan');
  const looseId = await createLoose(h, 'Mover');
  await h.command(cmd('plan.adopt', { planId: first.id, baseVersion: 1, taskIds: [looseId], stepId: 's1' }));
  await publish(h, { title: 'Target plan', steps: [{ id: 't1', title: 'target', tasks: [{ key: 't1', title: 'Target task', acceptance: [{ text: 'x' }] }] }] }, 'plan-target');
  const target = planHeadByTitle(h, 'Target plan');
  await h.command(cmd('plan.release', { planId: first.id, baseVersion: 2, taskIds: [looseId] }));
  await h.command(cmd('plan.adopt', { planId: target.id, baseVersion: 1, taskIds: [looseId], stepId: 't1' }));
  assert.equal(h.state.tasks[looseId].planRef.planId, target.id);
  assert.equal(h.state.tasks[looseId].planRef.stepId, 't1');
  await svc.close();
});

// 责任：移出后孤立任务保留历史 planRef，重新 adopt 后才更新引用。
test('orphaned task keeps its old planRef until adopted again', async () => {
  const { h, svc } = await setup();
  await publish(h);
  const head = planHeadByTitle(h, 'Demo plan');
  const t1 = taskByTitle(h, 'T1');
  const t2 = taskByTitle(h, 'T2');
  await h.command(cmd('plan.revise', {
    planId: head.id,
    baseVersion: 1,
    steps: [{ id: 's1', title: 'first', tasks: [{ key: 'keep', taskId: t1.id, title: 'T1', acceptance: [{ text: 'artifact exists' }] }] }],
  }));
  assert.equal(h.state.planHeads[head.id].currentVersion, 2);
  assert.equal(h.state.tasks[t2.id].orphaned, true);
  assert.equal(h.state.tasks[t2.id].planRef.version, 1);

  await h.command(cmd('plan.adopt', { planId: head.id, baseVersion: 2, taskIds: [t2.id], stepId: 's1' }));
  assert.equal(h.state.tasks[t2.id].orphaned, false);
  assert.equal(h.state.tasks[t2.id].planRef.version, 3);
  await svc.close();
});

// 责任：同一任务同时出现在两个 step 时 fsck 必须报 I20。
test('fsck I20 flags a task that appears in two steps', async () => {
  const { h, svc } = await setup();
  await publish(h);
  const head = planHeadByTitle(h, 'Demo plan');
  const pv = h.state.plans[head.id + '@' + head.currentVersion];
  pv.steps[1].taskIds.push(pv.steps[0].taskIds[0]);
  const report = checkState(h.state);
  const check = report.checks.find((item) => item.name === 'plan-step-unique:' + head.id);
  assert.ok(check, 'I20 check present');
  assert.equal(check.ok, false);
  await svc.close();
});

// 责任：允许发布有步骤但无任务的计划，随后 adopt 须能填入散任务。
test('publish accepts a plan whose steps have no tasks, then adopt fills it', async () => {
  const { h, svc } = await setup();
  const result = await h.command(cmd('plan.publish', { title: 'Skeleton plan', steps: [{ id: 's1', title: 'empty' }] }));
  assert.equal(result.ok, true);
  const head = planHeadByTitle(h, 'Skeleton plan');
  assert.equal(head.currentVersion, 1);
  assert.deepEqual(h.state.plans[head.id + '@1'].steps[0].taskIds, []);
  assert.equal(h.query('plan', { planId: head.id }).progress.total, 0);
  assert.equal(checkState(h.state).warnings.filter((warning) => warning.includes('plan-step-unique')).length, 0);

  const looseId = await createLoose(h, 'Loose task');
  await h.command(cmd('plan.adopt', { planId: head.id, baseVersion: 1, taskIds: [looseId], stepId: 's1' }));
  assert.equal(h.state.planHeads[head.id].currentVersion, 2);
  assert.deepEqual(h.state.tasks[looseId].planRef, { planId: head.id, version: 2, stepId: 's1' });
  assert.equal(h.query('plan', { planId: head.id }).progress.total, 1);
  await svc.close();
});

// 责任：无步骤或 tasks 非数组的发布请求仍必须拒绝，不能随空计划支持而放宽。
test('publish still rejects no steps and a non-array tasks field', async () => {
  const { h, svc } = await setup();
  const noSteps = await h.command(cmd('plan.publish', { title: 'No steps', steps: [] })).then(() => null, (error) => error);
  assert.equal(noSteps.code, 'invalid-command');
  const badStep = await h.command(cmd('plan.publish', { title: 'Bad step', steps: [{ id: 's1', title: 'x', tasks: 'nope' }] })).then(() => null, (error) => error);
  assert.equal(badStep.code, 'invalid-command');
  await svc.close();
});

// 责任：修订后保留空步骤须合法，与 release 后的计划形态保持一致。
test('revise can leave an existing step empty (consistent with release)', async () => {
  const { h, svc } = await setup();
  await publish(h);
  const head = planHeadByTitle(h, 'Demo plan');
  const revised = await h.command(cmd('plan.revise', { planId: head.id, baseVersion: 1, steps: [{ id: 's1', title: 'first' }] }));
  assert.equal(revised.ok, true);
  assert.equal(h.state.planHeads[head.id].currentVersion, 2);
  assert.deepEqual(h.state.plans[head.id + '@2'].steps[0].taskIds, []);
  assert.equal(h.state.tasks[taskByTitle(h, 'T1').id].orphaned, true);
  await svc.close();
});

// 责任：显式清空 focus 后规范化不得从兼容 currentPlanId 复活旧焦点。
test('normalizePlanHeads never resurrects a cleared focus from currentPlanId', () => {
  // explicit null + archived legacy pointer: stays null
  const s1 = legacyPlanState();
  s1.project.focusPlanId = null;
  s1.project.currentPlanId = 'pln_a';
  s1.planHeads.pln_a = headOf('archived');
  normalizePlanHeads(s1);
  assert.equal(s1.project.focusPlanId, null);

  // truly legacy (field absent) + active pointer: inherits
  const s2 = legacyPlanState();
  delete s2.project.focusPlanId;
  s2.project.currentPlanId = 'pln_a';
  // truly legacy: no head events at all; normalize must derive the head and inherit focus
  normalizePlanHeads(s2);
  assert.equal(s2.project.focusPlanId, 'pln_a');

  // explicit focus on an archived head: cleared
  const s3 = legacyPlanState();
  s3.project.focusPlanId = 'pln_a';
  s3.planHeads.pln_a = headOf('archived');
  normalizePlanHeads(s3);
  assert.equal(s3.project.focusPlanId, null);
});

// 责任：归档焦点计划后 focus 须清空，并在重新打开后仍保持空值。
test('archiving the focused plan keeps focus cleared across reopen', async () => {
  const { h, svc, stateDir } = await setup();
  await publish(h);
  const head = planHeadByTitle(h, 'Demo plan');
  assert.equal(h.state.project.focusPlanId, head.id);
  await h.command(cmd('plan.archive', { planId: head.id, expected: { entityRev: head.rev } }));
  assert.equal(h.state.project.focusPlanId, null);
  await svc.close();

  const svc2 = new ProjectService({ rootDir: stateDir, privilegedInlineWrites: true });
  await svc2.init();
  const h2 = await svc2.open(h.id);
  assert.equal(h2.state.project.focusPlanId, null);
  assert.equal(h2.health().warnings.filter((warning) => warning.includes('plan-focus')).length, 0);
  await svc2.close();
});
