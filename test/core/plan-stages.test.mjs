/**
 * 测试职责：验证阶段内依赖写闸、历史依赖兼容和阶段推进提示。
 * 典型流程：在合成项目发布计划、修改任务或成员，检查日志及 DSH/MCP 投影。
 * 覆盖边界：覆盖当前版本成员、拒绝原子性、串行写入、冷回放和任务级验收；不覆盖真实宿主进程。
 * 外部前置：仅需可写的合成临时目录。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { assertNoNewStageDependencies } from '../../lib/core/plan-stages.js';
import { createProjectReader } from '../../lib/core/project-reader.js';
import { cmd, humanCmd, setup, taskByTitle } from '../helpers/core-lifecycle-fixture.mjs';

function def(key, deps = []) {
  return { key, title: key, deps, acceptance: [{ text: 'deliver ' + key }] };
}

function step(id, ...tasks) {
  return { id, title: id, tasks };
}

async function fixture(t) {
  const { h, svc } = await setup();
  t.after(() => svc.close());
  const log = path.join(h.store.dir, 'commits.jsonl');
  return { h, svc, log };
}

async function publish(h, steps) {
  const result = await h.command(cmd('plan.publish', { title: 'Stage fixture', steps }));
  return result.events.find(({ type }) => type === 'plan/published').data.id;
}

function updateDeps(h, taskId, deps) {
  return cmd('task.update', { taskId, deps, expected: { entityRev: h.state.tasks[taskId].rev } });
}

async function rejectDependency(h, log, command, stepId) {
  const before = fs.readFileSync(log);
  const rev = h.rev;
  await assert.rejects(h.command(command), (error) => {
    assert.equal(error.code, 'plan-stage-dependency');
    assert.equal(error.status, 409);
    assert.equal(error.details.stepId, stepId);
    assert.ok(error.details.taskId && error.details.dependencyId);
    return true;
  });
  assert.equal(h.rev, rev);
  assert.deepEqual(fs.readFileSync(log), before);
}

// 责任：直发和草案发布拒绝同阶段依赖，保留原日志和草案。
test('publishing rejects direct and indirect same-stage dependencies without publishing the draft', async (t) => {
  const { h, log } = await fixture(t);
  await rejectDependency(h, log, cmd('plan.publish', {
    title: 'Direct', steps: [step('first', def('A'), def('B', ['A']))],
  }), 'first');
  const draft = await h.command(cmd('plan.create', {
    title: 'Indirect', steps: [step('first', def('A'), def('B', ['C'])), step('other', def('C', ['A']))],
  }));
  const planId = draft.events[0].data.id;
  await rejectDependency(h, log, cmd('plan.publish', { planId, expected: { entityRev: 1 } }), 'first');
  assert.equal(h.state.planHeads[planId].status, 'draft');
  assert.deepEqual(Object.keys(h.state.tasks), []);
});

// 责任：修订、归位和改依赖都校验写入后的阶段成员，跨阶段依赖仍可保留。
test('revise, adopt and dependency editing use prospective current-version membership', async (t) => {
  const { h, log } = await fixture(t);
  const planId = await publish(h, [step('first', def('A'), def('B')), step('second', def('C', ['A']))]);
  const { id: a } = taskByTitle(h, 'A');
  const { id: b } = taskByTitle(h, 'B');
  const { id: c } = taskByTitle(h, 'C');
  await rejectDependency(h, log, updateDeps(h, b, [a]), 'first');
  await rejectDependency(h, log, cmd('plan.revise', {
    planId, baseVersion: 1,
    steps: [step('first', { ...def('A'), taskId: a }, { ...def('C', ['A']), taskId: c })],
  }), 'first');
  await h.command(cmd('plan.release', { planId, baseVersion: 1, taskIds: [c] }));
  const adopt = { planId, baseVersion: 2, taskIds: [c] };
  await rejectDependency(h, log, cmd('plan.adopt', { ...adopt, stepId: 'first' }), 'first');
  await h.command(cmd('plan.adopt', { ...adopt, stepId: 'second' }));
  assert.deepEqual(h.state.tasks[c].deps, [a]);
});

// 责任：单独合法的两次并发编辑不能合成违规路径。
test('concurrent edits cannot link same-stage tasks through an inbox task', async (t) => {
  const { h } = await fixture(t);
  await publish(h, [step('first', def('A'), def('B'))]);
  await h.command(cmd('task.create', { title: 'Inbox', acceptance: [{ text: 'deliver inbox' }] }));
  const { id: a } = taskByTitle(h, 'A');
  const { id: b } = taskByTitle(h, 'B');
  const { id: inbox } = taskByTitle(h, 'Inbox');
  const before = h.rev;
  const [first, second] = await Promise.allSettled([
    h.command(updateDeps(h, b, [inbox])),
    h.command(updateDeps(h, inbox, [a])),
  ]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'rejected');
  assert.equal(second.reason.code, 'plan-stage-dependency');
  assert.equal(h.rev, before + 1);
  assert.deepEqual(h.state.tasks[inbox].deps, []);
});

// 责任：旧计划修订可重复引用任务，新增依赖须检查该任务出现的每个当前阶段。
test('new paths check every current stage that references a reused task', async (t) => {
  const { h, log } = await fixture(t);
  await publish(h, [step('original', def('A'), def('B'))]);
  const result = await h.command(cmd('plan.publish', {
    title: 'Other plan', steps: [step('other', def('C'), def('D'))],
  }));
  const planId = result.events.find(({ type }) => type === 'plan/published').data.id;
  const { id: a } = taskByTitle(h, 'A');
  const { id: b } = taskByTitle(h, 'B');
  const { id: c } = taskByTitle(h, 'C');
  await h.command(cmd('plan.revise', {
    planId, baseVersion: 1,
    steps: [step('other', { ...def('A'), taskId: a }, { ...def('C'), taskId: c })],
  }));
  await rejectDependency(h, log, updateDeps(h, b, [a]), 'original');
  await rejectDependency(h, log, updateDeps(h, c, [a]), 'other');
});

// 责任：旧阶段重叠时保留已有任务对，合并阶段产生的新关系仍须拒绝。
test('revising overlapping legacy stages preserves only previously grouped pairs', async (t) => {
  const { h, log } = await fixture(t);
  const planId = await publish(h, [step('first', def('A'), def('B')), step('second', def('C'))]);
  const { id: a } = taskByTitle(h, 'A');
  const { id: b } = taskByTitle(h, 'B');
  const { id: c } = taskByTitle(h, 'C');
  const revisedSteps = (suffix, aDeps = [], bDeps = []) => [
    step('first' + suffix, { ...def('A', aDeps), taskId: a }, { ...def('B', bDeps), taskId: b }),
    step('second' + suffix, { ...def('A', aDeps), key: 'also-a', taskId: a }, { ...def('C'), taskId: c }),
  ];
  const overlap = revisedSteps('');
  overlap[0].tasks[0].deps = [b];
  await h.command(cmd('plan.revise', { planId, baseVersion: 1, steps: overlap }));
  assert.deepEqual(h.state.tasks[a].deps, [], 'only the final definition determines the dependency change');
  const legacyEdges = [[a, c], [b, a]].map(([id, dep]) => {
    const task = h.state.tasks[id];
    const rev = task.rev + 1;
    return { type: 'task/updated', taskId: id, rev, data: { ...task, rev, state: 'backlog', deps: [dep] } };
  });
  h._appendEvents(legacyEdges, { kind: 'human' }, 'legacy-overlapping-stage-dependencies', h.rev);
  await h.command(cmd('plan.revise', { planId, baseVersion: 2, steps: revisedSteps('-renamed', [c], [a]) }));
  const join = (deps) => cmd('plan.revise', {
    planId, baseVersion: 3,
    steps: [step('joined', { ...def('A', deps), taskId: a }, { ...def('B', [a]), taskId: b }, { ...def('C'), taskId: c })],
  });
  await rejectDependency(h, log, join([c]), 'joined');
  await h.command(updateDeps(h, a, []));
  await h.command(join([]));
  assert.deepEqual(h.state.tasks[b].deps, [a]);
});

async function submit(h, taskId) {
  const work = (op, extra = {}) => h.command(humanCmd(op, {
    taskId, expected: { entityRev: h.state.tasks[taskId].rev },
    fencingToken: h.leases.get(taskId)?.token, ...extra,
  }));
  await work('task.claim');
  await work('task.begin', { summary: 'Implement stage task' });
  await work('task.submit', {
    evidence: [{ kind: 'note', ref: 'Delivered', acceptanceId: h.state.tasks[taskId].acceptance[0].id }],
  });
}

// 责任：阶段提示与任务提交、人工验收和前置解锁同步，两种读入口投影一致。
test('DSH and MCP show implementation then the audit cohort and the next stage', async (t) => {
  const { h, svc } = await fixture(t);
  const reader = createProjectReader(svc);
  t.after(() => reader.close());
  const projectId = h.id;
  const planId = await publish(h, [step('empty'), step('first', def('A'), def('B')), step('next', def('C', ['A', 'B']))]);
  const { id: a } = taskByTitle(h, 'A');
  const { id: b } = taskByTitle(h, 'B');
  const { id: c } = taskByTitle(h, 'C');
  const stage = () => h.query('brief').stageWork;
  await submit(h, a);
  assert.deepEqual(stage(), {
    planId, stepId: 'first', title: 'first', mode: 'implement',
    remainingCount: 1, readyCount: 1, reviewCount: 1, readyTaskIds: [b], reviewTaskIds: [a],
  });
  assert.deepEqual((await reader.getWorkContext({ projectId, taskId: b })).stageWork, stage());
  await submit(h, b);
  assert.equal(stage().mode, 'audit');
  assert.deepEqual(stage().reviewTaskIds, [a, b]);
  assert.deepEqual((await reader.getWorkContext({ projectId })).stageWork, stage());
  assert.match(h.digest(), /CURRENT STAGE .*first.*audit/);
  for (const taskId of [a, b]) {
    await h.command(humanCmd('task.verify', { taskId, expected: { entityRev: h.state.tasks[taskId].rev } }));
  }
  assert.equal(stage().stepId, 'next');
  assert.deepEqual(stage().readyTaskIds, [c]);
});

// 责任：旧依赖可回放、改阶段名或解绑，禁止额外路径和解除后重建。
test('legacy same-stage dependencies replay, can unblock via review, and cannot be reintroduced', async (t) => {
  const { h, svc, log } = await fixture(t);
  const projectId = h.id;
  const planId = await publish(h, [step('first', def('A'), def('B'))]);
  const a = taskByTitle(h, 'A');
  const b = taskByTitle(h, 'B');
  // Append a valid pre-rule commit, then reopen via the normal reader and writer.
  h._appendEvents([{ type: 'task/updated', taskId: b.id, rev: 2, data: { ...b, rev: 2, state: 'backlog', deps: [a.id] } }],
    { kind: 'human' }, 'legacy-stage-dependency', h.rev);
  await submit(h, a.id);
  assert.equal(h.query('brief').stageWork.mode, 'waiting');
  await h.close();
  const before = fs.readFileSync(log);
  const reader = createProjectReader(svc);
  t.after(() => reader.close());
  const cold = await reader.getWorkContext({ projectId });
  assert.equal(cold.stageWork.mode, 'waiting');
  assert.deepEqual(cold.stageWork.reviewTaskIds, [a.id]);
  assert.deepEqual(fs.readFileSync(log), before);
  const opened = await svc.open(projectId);
  await opened.command(cmd('plan.revise', {
    planId, baseVersion: 1, steps: [step('renamed', { ...def('A'), taskId: a.id }, { ...def('B', ['A']), taskId: b.id })],
  }));
  const unrelated = await opened.command(cmd('task.create', { title: 'Unrelated', acceptance: [{ text: 'independent work' }] }));
  const unrelatedId = unrelated.events.find(({ type }) => type === 'task/created').taskId;
  await opened.command(updateDeps(opened, b.id, [a.id, unrelatedId]));
  await opened.command(updateDeps(opened, b.id, [a.id]));
  const inbox = await opened.command(cmd('task.create', { title: 'Inbox', deps: [a.id], acceptance: [{ text: 'deliver inbox' }] }));
  const inboxId = inbox.events.find(({ type }) => type === 'task/created').taskId;
  await rejectDependency(opened, log, updateDeps(opened, b.id, [a.id, inboxId]), 'renamed');
  await opened.command(humanCmd('task.verify', { taskId: a.id, expected: { entityRev: opened.state.tasks[a.id].rev } }));
  assert.equal(opened.state.tasks[b.id].state, 'ready');
  await opened.command(updateDeps(opened, b.id, []));
  await rejectDependency(opened, log, updateDeps(opened, b.id, [a.id]), 'renamed');
});

// 责任：大型旧依赖链的阶段改名、归位和外部依赖编辑只访问线性数量的依赖记录。
test('unrelated changes on a large legacy stage do not rescan existing paths', () => {
  const taskIds = Array.from({ length: 2000 }, (_, i) => 'old-' + i);
  const first = taskIds[0];
  let reads = 0;
  const observedTask = (id, deps) => ({
    id,
    get deps() {
      reads += 1;
      return deps;
    },
  });
  const tasks = Object.fromEntries(taskIds.map((id, i) => [id, observedTask(id, i ? [taskIds[i - 1]] : [])]));
  tasks.outside = observedTask('outside', []);
  const plan = { id: 'plan', steps: [{ id: 'legacy', taskIds }] };
  const state = { tasks, plans: { 'plan@1': plan }, currentPlans: { plan: 1 } };

  for (const ids of [taskIds, [...taskIds, 'outside']]) {
    reads = 0;
    const revised = { ...plan, steps: [{ id: 'renamed', taskIds: ids }] };
    assertNoNewStageDependencies(state, [{ type: 'plan/revised', data: revised }]);
    assert.ok(reads < taskIds.length * 4, 'stage change read ' + reads + ' dependency records');
  }
  reads = 0;
  assertNoNewStageDependencies(state, [{ type: 'task/updated', data: { id: first, deps: ['outside'] } }]);
  assert.ok(reads < taskIds.length * 4, 'external dependency change read ' + reads + ' dependency records');

  reads = 0;
  const small = { id: 'overlap', taskIds: [first] };
  const overlapping = { ...plan, steps: [...plan.steps, small] };
  const revised = { ...plan, steps: [{ ...plan.steps[0], taskIds: [...taskIds, 'outside'] }, small] };
  assertNoNewStageDependencies({ ...state, plans: { 'plan@1': overlapping } }, [{ type: 'plan/revised', data: revised }]);
  assert.ok(reads < taskIds.length * 4, 'overlapping stage adoption read ' + reads + ' dependency records');
});
