/**
 * 测试职责：保证多个活动计划交错修改时各自版本、成员、焦点与归档互不污染。
 * 典型流程：临时项目发布双计划 → 交错 revise/adopt/release/focus/archive → 比较 sibling 状态和摘要。
 * 覆盖边界：覆盖 多计划 CAS、归属孤立语义和摘要稳定；不覆盖真正多进程写压力。
 * 外部前置：无；并发语义通过命令交错模拟。
 */
// Multi-plan concurrency regression (T1): two active plans interleaving
// revises on their own baseVersions, focus switching, archive refusal on live
// work, adopt/release version bumps, orphan semantics and digest stability.
// No new semantics: every assertion documents the behavior already frozen in
// docs/PLAN-V2.md and implemented by lib/core/commands/plan-*.js.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectService } from '../../lib/core/service.js';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
}

function cmd(op, extra = {}) {
  return { cmdId: 'cmd_' + Math.random().toString(36).slice(2), actor: { kind: 'agent', sessionId: 's1' }, op, ...extra };
}

function human(op, extra = {}) {
  return { cmdId: 'cmd_' + Math.random().toString(36).slice(2), actor: { kind: 'human' }, op, ...extra };
}

async function fresh(prefix) {
  const svc = new ProjectService({ rootDir: tmp(prefix) });
  await svc.init();
  const handle = await svc.createProject({ workspacePath: tmp(prefix + '-ws'), name: 'P' });
  return { svc, handle };
}

function publishPlan(title, key) {
  return cmd('plan.publish', {
    title,
    goal: 'g',
    steps: [{ id: 's1', title: 'S', tasks: [{ key, title: 'Task ' + key, acceptance: [{ text: 'x' }] }] }],
  });
}

function publishedId(result) {
  return result.events.find((event) => event.type === 'plan/published').data.id;
}

function taskIn(handle, planId) {
  return Object.values(handle.state.tasks).find((task) => task.planRef && task.planRef.planId === planId);
}

/** Active revise that keeps one existing task under its own key. */
function reviseKeeping(handle, planId, baseVersion, key, title) {
  const task = taskIn(handle, planId);
  return cmd('plan.revise', {
    planId,
    baseVersion,
    steps: [{ id: 's1', title: 'S', tasks: [{ key, taskId: task.id, title }] }],
  });
}

// 责任：交错修订 A/B 须各自推进 baseVersion，A 的旧版本 CAS 拒绝且不改标题或项目 rev。
test('two active plans interleave revises on independent baseVersions; stale CAS is rejected', async () => {
  const { svc, handle } = await fresh('pb-cc-a');
  const planA = publishedId(await handle.command(publishPlan('Plan A', 'a1')));
  const planB = publishedId(await handle.command(publishPlan('Plan B', 'b1')));
  assert.notEqual(planA, planB, 'a second publish creates a second plan, not a 409');

  await handle.command(reviseKeeping(handle, planA, 1, 'a1', 'A v2'));
  assert.equal(handle.state.planHeads[planA].currentVersion, 2, 'A bumped to v2');
  assert.equal(handle.state.planHeads[planB].currentVersion, 1, 'B untouched by the A revise');

  // B revises against its OWN baseVersion while A is already at v2.
  await handle.command(reviseKeeping(handle, planB, 1, 'b1', 'B v2'));
  assert.equal(handle.state.planHeads[planA].currentVersion, 2, 'A stays v2 across the B revise');
  assert.equal(handle.state.planHeads[planB].currentVersion, 2, 'B bumped to v2');

  const revBefore = handle.rev;
  await assert.rejects(
    () => handle.command(reviseKeeping(handle, planA, 1, 'a1', 'stale')),
    (error) => error.code === 'stale-revision' && error.details && error.details.currentVersion === 2,
  );
  assert.equal(handle.rev, revBefore, 'a rejected stale revise writes nothing');
  assert.equal(handle.state.planHeads[planA].currentVersion, 2);
  assert.equal(taskIn(handle, planA).title, 'A v2', 'task title untouched by the stale attempt');
  await svc.close();
});

// 责任：切换 focus 后归档须清空焦点，unarchive 不得自动复活旧 focus。
test('focus switches between two active plans; archive clears focus and unarchive does not resurrect it', async () => {
  const { svc, handle } = await fresh('pb-cc-b');
  const planA = publishedId(await handle.command(publishPlan('Plan A', 'a1')));
  const planB = publishedId(await handle.command(publishPlan('Plan B', 'b1')));
  assert.equal(handle.state.project.focusPlanId, planA, 'the first publish auto-focuses');

  await handle.command(human('plan.focus', { planId: planB }));
  assert.equal(handle.state.project.focusPlanId, planB);
  await handle.command(human('plan.focus', { planId: planA }));
  assert.equal(handle.state.project.focusPlanId, planA);
  await assert.rejects(
    () => handle.command(cmd('plan.focus', { planId: planB })),
    (error) => error.code === 'forbidden-role',
  );
  assert.equal(handle.state.project.focusPlanId, planA, 'the agent refusal changes nothing');

  await handle.command(cmd('plan.archive', { planId: planA, expected: { entityRev: handle.state.planHeads[planA].rev } }));
  assert.equal(handle.state.project.focusPlanId, null, 'archiving the focused plan clears focus');
  await handle.command(cmd('plan.unarchive', { planId: planA, expected: { entityRev: handle.state.planHeads[planA].rev } }));
  assert.equal(handle.state.planHeads[planA].status, 'active');
  assert.equal(handle.state.project.focusPlanId, null, 'unarchive never resurrects a cleared focus');

  await handle.command(human('plan.focus', { planId: planB }));
  assert.equal(handle.state.project.focusPlanId, planB, 'a human can re-focus afterwards');
  await svc.close();
});

// 责任：归档有活工作计划须拒绝，兄弟计划的版本和任务完全不变。
test('archiving one plan refuses live work and leaves the sibling plan untouched', async () => {
  const { svc, handle } = await fresh('pb-cc-c');
  const planA = publishedId(await handle.command(publishPlan('Plan A', 'a1')));
  const planB = publishedId(await handle.command(publishPlan('Plan B', 'b1')));
  const taskA = taskIn(handle, planA);
  const taskB = taskIn(handle, planB);

  const claimed = await handle.command(cmd('task.claim', { taskId: taskA.id, expected: { entityRev: taskA.rev } }));
  const token = claimed.events.find((event) => event.type === 'lease/granted').data.token;
  assert.equal(handle.state.tasks[taskA.id].state, 'in_progress');

  await assert.rejects(
    () => handle.command(cmd('plan.archive', { planId: planA, expected: { entityRev: handle.state.planHeads[planA].rev } })),
    (error) => error.code === 'plan-has-live-work',
  );
  assert.equal(handle.state.planHeads[planA].status, 'active');
  assert.equal(handle.state.planHeads[planB].status, 'active');
  assert.equal(handle.state.tasks[taskB.id].state, 'ready', 'the sibling plan task is untouched');
  assert.equal(handle.state.project.focusPlanId, planA, 'focus survives the refused archive');

  await handle.command(cmd('task.release', { taskId: taskA.id, expected: { entityRev: handle.state.tasks[taskA.id].rev }, fencingToken: token }));
  await handle.command(cmd('plan.archive', { planId: planA, expected: { entityRev: handle.state.planHeads[planA].rev } }));
  assert.equal(handle.state.planHeads[planA].status, 'archived');
  assert.equal(handle.state.planHeads[planA].archivedFrom, 'active');
  assert.equal(handle.state.planHeads[planB].status, 'active', 'the sibling stays active');
  assert.equal(handle.state.project.focusPlanId, null, 'archiving the focused plan clears focus');
  await svc.close();
});

// 责任：adopt/release 各自推进所属计划版本，旧 CAS、跨计划直收录和移出非成员须拒绝。
test('adopt/release bump versions per plan; stale adopt, cross-plan adopt and release of non-members are refused', async () => {
  const { svc, handle } = await fresh('pb-cc-d');
  const planA = publishedId(await handle.command(publishPlan('Plan A', 'a1')));
  const planB = publishedId(await handle.command(publishPlan('Plan B', 'b1')));
  const taskA = taskIn(handle, planA);
  const loose = await handle.command(cmd('task.create', { title: 'Loose', acceptance: [{ text: 'x' }] }));
  const looseId = loose.events.find((event) => event.type === 'task/created').taskId;

  await handle.command(cmd('plan.adopt', { planId: planA, baseVersion: 1, stepId: 's1', taskIds: [looseId] }));
  assert.equal(handle.state.planHeads[planA].currentVersion, 2, 'adopt bumps the version');
  assert.deepEqual(handle.state.tasks[looseId].planRef, { planId: planA, version: 2, stepId: 's1' });
  assert.equal(handle.state.planHeads[planB].currentVersion, 1, 'B is not bumped by the A adopt');

  await assert.rejects(
    () => handle.command(cmd('plan.adopt', { planId: planA, baseVersion: 1, stepId: 's1', taskIds: [looseId] })),
    (error) => error.code === 'stale-revision',
  );
  await assert.rejects(
    () => handle.command(cmd('plan.adopt', { planId: planB, baseVersion: 1, stepId: 's1', taskIds: [looseId] })),
    (error) => error.code === 'plan-task-in-use',
  );
  await assert.rejects(
    () => handle.command(cmd('plan.release', { planId: planB, baseVersion: 1, taskIds: [taskA.id] })),
    (error) => error.code === 'invalid-command',
  );

  await handle.command(cmd('plan.release', { planId: planA, baseVersion: 2, taskIds: [looseId] }));
  assert.equal(handle.state.planHeads[planA].currentVersion, 3, 'release bumps the version');
  assert.equal(handle.state.tasks[looseId].planRef, null, 'released tasks keep living with a null planRef');
  assert.equal(handle.state.tasks[looseId].state, 'ready', 'release never deletes the task');
  await assert.rejects(
    () => handle.command(cmd('plan.release', { planId: planA, baseVersion: 3, taskIds: [looseId] })),
    (error) => error.code === 'invalid-command',
    'releasing a task twice is refused',
  );
  await svc.close();
});

// 责任：孤立任务保留历史 planRef，重新收录后才清 orphaned 标志。
test('an orphaned task keeps its old planRef until adopted back, which clears the flag', async () => {
  const { svc, handle } = await fresh('pb-cc-e');
  const planA = publishedId(await handle.command(publishPlan('Plan A', 'a1')));
  const taskA = taskIn(handle, planA);

  // Revise drops the task from the step list: it is orphaned, not deleted.
  await handle.command(cmd('plan.revise', {
    planId: planA,
    baseVersion: 1,
    steps: [{ id: 's1', title: 'S', tasks: [] }],
  }));
  const orphan = handle.state.tasks[taskA.id];
  assert.equal(orphan.orphaned, true);
  assert.deepEqual(orphan.planRef, { planId: planA, version: 1, stepId: 's1' }, 'orphan keeps the old planRef');
  assert.equal(handle.state.planHeads[planA].currentVersion, 2);

  await handle.command(cmd('plan.adopt', { planId: planA, baseVersion: 2, stepId: 's1', taskIds: [taskA.id] }));
  const adopted = handle.state.tasks[taskA.id];
  assert.equal(adopted.orphaned, false, 're-adopting clears the orphan flag');
  assert.deepEqual(adopted.planRef, { planId: planA, version: 3, stepId: 's1' });
  assert.equal(handle.state.planHeads[planA].currentVersion, 3);
  await svc.close();
});

// 责任：board/plans 读模型须同时反映多计划，归档过滤不能漏掉或混入错误计划。
test('board and plans views reflect the multi-plan set and archived filtering', async () => {
  const { svc, handle } = await fresh('pb-cc-f');
  const planA = publishedId(await handle.command(publishPlan('Plan A', 'a1')));
  const planB = publishedId(await handle.command(publishPlan('Plan B', 'b1')));
  await handle.command(cmd('plan.create', { title: 'Draft C' }));
  const draft = Object.values(handle.state.planHeads).find((head) => head.status === 'draft');

  const board = handle.query('board');
  assert.deepEqual(board.plans.map((plan) => plan.id).sort(), [planA, planB].sort(), 'board.plans lists every active plan');
  assert.equal(board.plan.id, planA, 'board.plan stays the focus alias');
  const plans = handle.query('plans');
  assert.deepEqual(plans.plans.map((plan) => plan.id).sort(), [planA, planB, draft.id].sort(), 'plans view lists active + draft');
  assert.equal(plans.focusPlanId, planA);

  await handle.command(cmd('plan.archive', { planId: planB, expected: { entityRev: handle.state.planHeads[planB].rev } }));
  assert.deepEqual(handle.query('board').plans.map((plan) => plan.id), [planA], 'archived plans leave the board');
  assert.deepEqual(
    handle.query('plans').plans.map((plan) => [plan.id, plan.status]).sort(),
    [[draft.id, 'draft'], [planA, 'active'], [planB, 'archived']].sort(),
  );
  assert.deepEqual(
    handle.query('plans', { includeArchived: false }).plans.map((plan) => plan.id).sort(),
    [planA, draft.id].sort(),
    'includeArchived=false filters only archived heads',
  );
  await svc.close();
});

// 责任：重复 digest、失败命令及重开项目后，未变业务数据的摘要字节必须稳定。
test('the session digest is byte-stable across calls, failed commands and reopens', async () => {
  const rootDir = tmp('pb-cc-g');
  const svc = new ProjectService({ rootDir });
  await svc.init();
  const handle = await svc.createProject({ workspacePath: tmp('pb-cc-g-ws'), name: 'P' });
  const planA = publishedId(await handle.command(publishPlan('Plan A', 'a1')));
  await handle.command(publishPlan('Plan B', 'b1'));
  await handle.command(cmd('plan.create', { title: 'Draft C' }));

  const d1 = handle.digest('sess-digest');
  assert.equal(handle.digest('sess-digest'), d1, 'same state and session digest byte-identically');
  await assert.rejects(
    () => handle.command(reviseKeeping(handle, planA, 99, 'a1', 'stale')),
    (error) => error.code === 'stale-revision',
  );
  assert.equal(handle.digest('sess-digest'), d1, 'a rejected command does not change the digest');
  assert.ok(d1.includes('RULES'), 'the digest keeps the RULES block');

  const id = handle.id;
  const revBefore = handle.rev;
  await svc.close();
  const reopened = new ProjectService({ rootDir });
  await reopened.init();
  const again = await reopened.open(id);
  assert.equal(again.digest('sess-digest'), d1, 'reopening the same log reproduces the same digest');
  assert.equal(again.rev, revBefore, 'rev is unchanged across reopen');
  await reopened.close();
});
