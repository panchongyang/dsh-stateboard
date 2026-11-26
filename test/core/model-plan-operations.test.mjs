/**
 * 测试职责：验证计划命令只提交具名操作序列，计划模型独占合法转移与原子发布。
 * 典型流程：构造合成计划/任务事实 → 执行命令或模型批 → 对照记录顺序、CAS 与拒绝后的零写入。
 * 覆盖边界：覆盖发布/修订/成员/归档/跨计划冲突；不覆盖宿主、网络或真实项目数据。
 * 外部前置：无；使用临时目录与合成 JSONL store。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { PLAN_HANDLERS } from '../../lib/core/commands/plan.js';
import { PLAN_OPERATIONS, assertPlanOperationBatch, assertPlanOperationCompletion } from '../../lib/core/domain/operations/plans.js';
import { applyEvent, emptyState } from '../../lib/core/model.js';
import { freezeValue } from '../../lib/core/transaction/model.js';
import { cmd, setup } from '../helpers/core-lifecycle-fixture.mjs';
import { seedStageHistory, seedStageMembership } from '../helpers/plan-stage-history-fixture.mjs';

const at = new Date('2026-01-01T00:00:00.000Z');
const task = (key, extra = {}) => ({ key, title: key, acceptance: [{ text: 'deliver ' + key }], ...extra });
const step = (id, ...tasks) => ({ id, title: id, tasks });
function sample() {
  let seq = 0;
  const state = emptyState({ id: 'prj_synthetic', phase: 'active', name: 'Synthetic' });
  return { state, leases: new Map(), scratch: new Map(), rev: 0, clock: () => at, newId: (prefix) => prefix + '_' + (++seq) };
}
function execute(work, operations, request) {
  const events = [];
  for (const operation of operations) {
    const before = structuredClone(work.state);
    const result = PLAN_OPERATIONS[operation.kind](work, operation.args, request);
    assert.deepEqual(work.state, before, 'model action must not separately mutate state before installing its records');
    for (const event of result.events || []) applyEvent(work.state, structuredClone(event), { at: at.toISOString(), actor: request.actor });
    events.push(...(result.events || []));
  }
  if ([...work.scratch.values()].every((scope) => scope.pending.size === 0)) assertPlanOperationCompletion(work);
  return events;
}
function readOf(work) { return Object.freeze({ ...work, state: freezeValue(structuredClone(work.state)), leases: structuredClone(work.leases) }); }

// Responsibility: write authority and entity post-images are absent from the command protocol.
// 责任：计划命令只提交受限具名操作序列，并在冻结读样本上判定资格。
test('plan command emits a restricted named sequence over a frozen read sample', () => {
  const work = sample();
  const request = cmd('plan.publish', { title: 'Plan', steps: [step('one', task('A')), step('two', task('B', { deps: ['A'] }))] });
  const assembled = PLAN_HANDLERS[request.op](readOf(work), request);
  assert.equal(assembled.events, undefined);
  assert.deepEqual(assembled.operations.map(({ kind }) => kind), [
    'plans.createDraft', 'plans.publishVersion', 'plans.createTask', 'plans.createTask', 'plans.autoFocus',
  ]);
  const membership = assembled.operations[1].args.steps;
  assert.equal(typeof membership[0].taskIds[0], 'string');
  const creation = assembled.operations[2].args;
  assert.deepEqual(creation.acceptance, [{ text: 'deliver A', requiredKinds: [] }]);
  for (const args of assembled.operations.map(({ args }) => args)) {
    for (const key of ['state', 'events', 'data', 'head', 'lease', 'patch', 'callback', 'executeCommand']) assert.equal(Object.hasOwn(args, key), false);
  }
  assert.deepEqual(work.state.tasks, {});
  const events = execute(work, assembled.operations, request);
  assert.deepEqual(events.map(({ type }) => type), ['plan/created', 'plan/published', 'task/created', 'task/created', 'plan/focused', 'project/updated']);
  const [a, b] = Object.values(work.state.tasks);
  assert.equal(a.state, 'ready');
  assert.equal(b.state, 'backlog');
  assert.deepEqual(b.deps, [a.id]);
  assert.match(a.acceptance[0].id, /^acc_/);
  assert.equal(a.acceptance[0].met, false);
});

// Responsibility: the model reads current records, owns CAS, and rejects caller implementation hooks.
// 责任：计划操作注册表冻结，拒绝快照、原始记录与过期 CAS。
test('plan registry is frozen and rejects snapshots, raw records and stale CAS', () => {
  assert.ok(Object.isFrozen(PLAN_OPERATIONS));
  const work = sample();
  const request = cmd('plan.create');
  const created = PLAN_OPERATIONS['plans.createDraft'](work, { planId: 'pln_a', title: 'A' }, request);
  assert.deepEqual(work.state.planHeads, {});
  applyEvent(work.state, created.events[0]);
  for (const key of ['events', 'patch', 'state', 'head', 'data', 'lease', 'callback']) {
    assert.throws(() => PLAN_OPERATIONS['plans.rename'](work, { planId: 'pln_a', expectedRev: 1, title: 'B', [key]: {} }, request), { code: 'invalid-command' });
  }
  assert.throws(() => PLAN_OPERATIONS['plans.rename'](work, { planId: 'pln_a', expectedRev: 0, title: 'B' }, request), { code: 'stale-revision' });
  assert.equal(work.state.planHeads.pln_a.title, 'A');
  const rename = PLAN_OPERATIONS['plans.rename'](work, { planId: 'pln_a', expectedRev: 1, title: 'B' }, request);
  assert.equal(rename.events[0].data.rev, 2);
  assert.equal(work.state.planHeads.pln_a.title, 'A');
  assert.throws(() => PLAN_OPERATIONS['plans.createDraft'](work, { planId: 'pln_b', title: 'B', steps: [step('one', task('T', { acceptance: [{ text: 'x', met: true }] }))] }, request), { code: 'invalid-command' });
});

// Responsibility: task membership is checked against the version actually installed by prior actions.
// 责任：计划模型任务操作不能越过当前成员关系创建或编辑任务。
test('plan model task operations cannot create or edit outside current membership', () => {
  const work = sample();
  const request = cmd('plan.publish', { title: 'Plan', steps: [step('one', task('A'))] });
  const { operations } = PLAN_HANDLERS[request.op](readOf(work), request);
  execute(work, operations.slice(0, 2), request);
  const creation = operations[2].args;
  assert.throws(() => PLAN_OPERATIONS['plans.createTask'](work, { ...creation, stepId: 'absent' }, request), { code: 'invalid-command' });
  assert.throws(() => PLAN_OPERATIONS['plans.createTask'](work, { ...creation, acceptance: [{ text: 'forged', evidenceIds: ['fake'] }] }, request), { code: 'invalid-command' });
  execute(work, operations.slice(2), request);
  assert.throws(() => PLAN_OPERATIONS['plans.createTask'](work, creation, request), { code: 'invalid-command' });
  assert.throws(() => PLAN_OPERATIONS['plans.focus'](work, { planId: creation.planId }, request), { code: 'forbidden-role' });
});

// Responsibility: version/member and task ownership actions remain separate,
// restricted transitions, including orphan re-adoption and explicit release.
// 责任：计划成员序列保留历史并清理孤立归档引用。
test('plan model membership sequence preserves history and clears orphan filing', () => {
  const work = sample();
  const publication = cmd('plan.publish', { title: 'Plan', steps: [step('one', task('A'))] });
  const events = execute(work, PLAN_HANDLERS[publication.op](readOf(work), publication).operations, publication);
  const planId = events[0].data.id;
  const member = Object.values(work.state.tasks)[0];
  const revise = cmd('plan.revise', { planId, baseVersion: 1, steps: [step('one')] });
  assert.deepEqual(execute(work, PLAN_HANDLERS[revise.op](readOf(work), revise).operations, revise).map(({ type }) => type), ['plan/superseded', 'plan/revised', 'task/orphaned']);
  assert.equal(work.state.tasks[member.id].orphaned, true);
  assert.equal(work.state.tasks[member.id].planRef.version, 1);
  const adopt = cmd('plan.adopt', { planId, baseVersion: 2, stepId: 'one', taskIds: [member.id] });
  const adoption = PLAN_HANDLERS[adopt.op](readOf(work), adopt);
  assert.deepEqual(adoption.operations.map(({ kind }) => kind), ['plans.addMembers', 'plans.assignTask']);
  execute(work, adoption.operations, adopt);
  assert.equal(work.state.tasks[member.id].orphaned, false);
  assert.equal(work.state.tasks[member.id].planRef.version, 3);
  assert.deepEqual(work.state.plans[planId + '@2'].steps[0].taskIds, []);
  const repeated = PLAN_HANDLERS[adopt.op](readOf(work), { ...adopt, baseVersion: 3 });
  assert.deepEqual(repeated.operations, []);
  const release = cmd('plan.release', { planId, baseVersion: 3, taskIds: [member.id] });
  execute(work, PLAN_HANDLERS[release.op](readOf(work), release).operations, release);
  assert.equal(work.state.tasks[member.id].planRef, null);
  assert.deepEqual(work.state.plans[planId + '@4'].steps[0].taskIds, []);
  assert.deepEqual(work.state.plans[planId + '@1'].steps[0].taskIds, [member.id]);
});

// Responsibility: a model caller cannot evade archive live-work or immutable-version CAS.
// 责任：计划模型自行校验运行租约与归档边，版本 CAS 不可变。
test('plan model owns runtime lease archive guards and immutable version CAS', () => {
  const work = sample();
  const publication = cmd('plan.publish', { title: 'Plan', steps: [step('one', task('A'))] });
  const events = execute(work, PLAN_HANDLERS[publication.op](readOf(work), publication).operations, publication);
  const planId = events[0].data.id;
  const member = Object.values(work.state.tasks)[0];
  work.leases.set(member.id, { token: 1, taskId: member.id });
  const before = structuredClone(work.state);
  assert.throws(() => PLAN_OPERATIONS['plans.archive'](work, { planId, expectedRev: 2 }, publication), { code: 'plan-has-live-work' });
  assert.deepEqual(work.state, before);
  assert.equal(work.leases.get(member.id).token, 1);
  assert.throws(() => PLAN_OPERATIONS['plans.reviseVersion'](work, { planId, baseVersion: 0, steps: [{ id: 'one', title: 'one', taskIds: [] }] }, publication), { code: 'stale-revision' });
  assert.throws(() => PLAN_OPERATIONS['plans.reviseVersion'](work, { planId, baseVersion: 1, steps: [{ id: 'one', title: 'one', taskIds: [member.id, member.id] }] }, publication), { code: 'invalid-command' });
  assert.deepEqual(work.state, before);
});

// Responsibility: incomplete operation groups cannot use missing later actions
// as a bypass, and successful completion clears only this domain's scratch.
// 责任：计划完成校验拒绝截断发布，只清理本次拥有的作用域。
test('plan model completion rejects truncated publication and cleans only owned scopes', () => {
  const work = sample();
  const before = structuredClone(work.state);
  const request = cmd('plan.publish', { title: 'Plan', steps: [step('one', task('A'))] });
  const { operations } = PLAN_HANDLERS[request.op](readOf(work), request);
  const preceding = execute(work, operations.slice(0, 2), request);
  assert.throws(() => assertPlanOperationCompletion(work), { code: 'invalid-command' });
  assert.throws(() => assertPlanOperationBatch(before, work.state, preceding), { code: 'invalid-command' });
  const following = execute(work, operations.slice(2), request);
  assert.equal(work.scratch.size, 0);
  assert.doesNotThrow(() => assertPlanOperationBatch(before, work.state, [...preceding, ...following]));
  const member = Object.values(work.state.tasks)[0];
  const args = { ...operations[2].args, title: 'Arbitrary edit' };
  assert.throws(() => PLAN_OPERATIONS['plans.reviseTask'](work, args, request), { code: 'invalid-command' });
  work.state.project.focusPlanId = null;
  assert.throws(() => PLAN_OPERATIONS['plans.autoFocus'](work, { planId: member.planRef.planId }, request), { code: 'invalid-command' });
  work.scratch.set('another-domain', { kept: true });
  assertPlanOperationCompletion(work);
  assert.deepEqual(work.scratch.get('another-domain'), { kept: true });
});

// Responsibility: new-transaction checks must not turn into a forced rewrite
// or rejection of an unrelated retained historical plan defect.
// 责任：计划批校验只看新增关系，保留无关的历史事实。
test('plan model batch checks only new relationships and keeps unrelated legacy facts', () => {
  const work = sample();
  work.state.plans['legacy@1'] = { id: 'legacy', version: 1, status: 'published', title: 'Legacy', steps: [{ id: 'old', title: 'old', taskIds: ['historically-missing'] }] };
  work.state.planHeads.legacy = { id: 'legacy', title: 'Legacy', status: 'active', currentVersion: 1 };
  work.state.currentPlans.legacy = 1;
  const before = structuredClone(work.state);
  const request = cmd('plan.publish', { title: 'New', steps: [step('one', task('A'))] });
  const events = execute(work, PLAN_HANDLERS[request.op](readOf(work), request).operations, request);
  assert.doesNotThrow(() => assertPlanOperationBatch(before, work.state, events));
  assert.deepEqual(work.state.plans['legacy@1'], before.plans['legacy@1']);
});

async function fixture(t) {
  const { h, svc } = await setup();
  t.after(() => svc.close());
  return { h, log: path.join(h.store.dir, 'commits.jsonl') };
}
function unchanged(h, log) {
  const state = h.state;
  const leases = structuredClone(h.leases);
  const bytes = fs.readFileSync(log);
  const rev = h.rev;
  return () => {
    assert.equal(h.state, state, 'no partial model publication');
    assert.deepEqual(h.leases, leases, 'runtime leases are unchanged');
    assert.equal(h.rev, rev);
    assert.deepEqual(fs.readFileSync(log), bytes, 'rejected batch adds zero project log bytes');
  };
}

const modelOp = (kind, args) => ({ kind: 'plans.' + kind, args });
const modelPlan = 'pln_fixture', modelA = 'tsk_fixture_a', modelB = 'tsk_fixture_b';
const stage = (id, ...taskIds) => ({ id, title: id, taskIds });
const modelTask = (taskId, stepId, deps = [], version = 1) => ({
  planId: modelPlan, version, taskId, stepId, title: taskId, deps, acceptance: [{ text: 'deliver ' + taskId }],
});
function submitPlanBatch(h, cmdId, operations) {
  const header = { cmdId, actor: { kind: 'human', via: 'web' }, expected: { projectRev: h.rev } };
  const { sample } = h.model.beginCommand(header, [{ kind: 'lease.normalizeBeforeCommand', args: {} }], h._transactionPorts(h.service));
  return h.model.submitOperations(sample, operations);
}
function modelPublication({ sameStage = false, aDeps, bDeps } = {}) {
  const stageB = sameStage ? 'first' : 'second';
  const steps = sameStage ? [stage('first', modelA, modelB)] : [stage('first', modelA), stage('second', modelB)];
  return [modelOp('createDraft', { planId: modelPlan, title: 'Fixture' }),
    modelOp('publishVersion', { planId: modelPlan, expectedRev: 1, steps }),
    modelOp('createTask', modelTask(modelA, 'first', aDeps)),
    modelOp('createTask', modelTask(modelB, stageB, bDeps)),
    modelOp('autoFocus', { planId: modelPlan })];
}
async function assertPlanReopens(h, log) {
  const { service, id, rev, state } = h;
  const bytes = fs.readFileSync(log);
  await h.close();
  const reopened = await service.open(id);
  assert.notEqual(reopened, h);
  assert.equal(reopened.rev, rev);
  assert.deepEqual(reopened.state, state);
  assert.deepEqual(fs.readFileSync(log), bytes);
  return reopened;
}
function assertOnePlanCommit(h, log, before, rev, cmdId, result) {
  assert.equal(result.committed, true);
  assert.equal(result.projectRev, rev + 1);
  assert.equal(h.rev, rev + 1);
  const bytes = fs.readFileSync(log);
  assert.deepEqual(bytes.subarray(0, before.length), before);
  const lines = bytes.subarray(before.length).toString('utf8').split('\n');
  assert.equal(lines.length, 2, 'exactly one line, with a trailing LF');
  assert.equal(lines[1], '');
  const commit = JSON.parse(lines[0]);
  assert.equal(commit.cmdId, cmdId);
  assert.equal(commit.seq, rev + 1);
  assert.equal(commit.baseRev, rev);
  assert.deepEqual(commit.events, result.events);
}

for (const { label, args, code } of [
  { label: 'a same-stage dependency', args: { sameStage: true, bDeps: [modelA] }, code: 'plan-stage-dependency' },
  { label: 'a cross-stage cycle', args: { aDeps: [modelB], bDeps: [modelA] }, code: 'invalid-command' },
  { label: 'a missing dependency', args: { bDeps: ['tsk_fixture_missing'] }, code: 'invalid-command' },
]) {
  // 责任：绕过命令预检的完整发布批也必须拒绝；不得落下任务、计划、焦点或已提交身份。
  test('direct plan publication rejects ' + label + ' atomically', async (t) => {
    const { h, log } = await fixture(t);
    const check = unchanged(h, log);
    assert.throws(() => submitPlanBatch(h, 'invalid-plan', modelPublication(args)), { code });
    check();
    const reopened = await assertPlanReopens(h, log);
    assert.equal(reopened.model.cmdIds.has('invalid-plan'), false);
  });
}

// 责任：发布按完整批解析后定义的跨阶段目标；只追加一条记录，重开保持同一状态。
test('direct plan publication accepts a later-defined cross-stage dependency and replays exactly', async (t) => {
  const { h, log } = await fixture(t);
  const before = fs.readFileSync(log);
  const rev = h.rev;
  const result = submitPlanBatch(h, 'valid-plan', modelPublication({ aDeps: [modelB] }));
  assertOnePlanCommit(h, log, before, rev, 'valid-plan', result);
  assert.deepEqual(h.state.tasks[modelA].deps, [modelB]);
  assert.deepEqual(h.state.tasks[modelB].deps, []);
  assert.equal(h.state.tasks[modelA].state, 'backlog');
  assert.equal(h.state.tasks[modelB].state, 'ready');
  assert.deepEqual(h.state.plans[modelPlan + '@1'].steps.map(({ taskIds }) => taskIds), [[modelA], [modelB]]);
  await assertPlanReopens(h, log);
});

// 责任：修订新增边要穿过计划外任务查成环；合法修订、移出和跨阶段归位均不重写依赖。
test('direct plan revise, release and adopt protect the prospective dependency graph', async (t) => {
  const { h, log } = await fixture(t);
  submitPlanBatch(h, 'publish-members', modelPublication({ aDeps: [modelB] }));
  const inbox = await h.command(cmd('task.create', { title: 'inbox', acceptance: [{ text: 'deliver inbox' }], deps: [modelA] }));
  const inboxId = inbox.events.find(({ type }) => type === 'task/created').taskId;
  const steps = [stage('first', modelA), stage('second', modelB)];
  const revise = (bDeps) => [modelOp('reviseVersion', { planId: modelPlan, baseVersion: 1, steps }),
    modelOp('reviseTask', modelTask(modelA, 'first', [modelB], 2)),
    modelOp('reviseTask', modelTask(modelB, 'second', bDeps, 2))];
  let check = unchanged(h, log);
  assert.throws(() => submitPlanBatch(h, 'cycle-revise', revise([inboxId])), { code: 'invalid-command' });
  check();
  const commit = (cmdId, operations) => {
    const [before, rev] = [fs.readFileSync(log), h.rev];
    assertOnePlanCommit(h, log, before, rev, cmdId, submitPlanBatch(h, cmdId, operations));
  };
  commit('valid-revise', revise([]));
  commit('release-member', [modelOp('removeMembers', { planId: modelPlan, baseVersion: 2, taskIds: [modelB] }),
    modelOp('releaseTask', { planId: modelPlan, version: 3, taskId: modelB })]);
  const adopt = (stepId) => [modelOp('addMembers', { planId: modelPlan, baseVersion: 3, stepId, taskIds: [modelB] }),
    modelOp('assignTask', { planId: modelPlan, version: 4, stepId, taskId: modelB })];
  check = unchanged(h, log);
  assert.throws(() => submitPlanBatch(h, 'invalid-adopt', adopt('first')), { code: 'plan-stage-dependency' });
  check();
  commit('valid-adopt', adopt('second'));
  assert.deepEqual(h.state.tasks[modelA].deps, [modelB]);
  assert.deepEqual(h.state.tasks[modelB].deps, []);
  await assertPlanReopens(h, log);
});

// Responsibility: successful cross-entity actions preserve semantic record order in ONE commit.
// 责任：计划发布与修订各只提交一次，并保留有序语义记录。
test('plan publish and revise sequences commit once and retain ordered semantic records', async (t) => {
  const { h, log } = await fixture(t);
  const rev = h.rev;
  const result = await h.command(cmd('plan.publish', { title: 'Plan', steps: [step('one', task('A'), task('B'))] }));
  assert.equal(h.rev, rev + 1);
  assert.deepEqual(result.events.map(({ type }) => type), ['plan/created', 'plan/published', 'task/created', 'task/created', 'plan/focused', 'project/updated']);
  const planId = result.events[0].data.id;
  const a = Object.values(h.state.tasks).find(({ title }) => title === 'A');
  const b = Object.values(h.state.tasks).find(({ title }) => title === 'B');
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n').length;
  const revised = await h.command(cmd('plan.revise', { planId, baseVersion: 1, steps: [step('one', task('A', { taskId: a.id, acceptance: [] }))] }));
  assert.equal(h.rev, rev + 2);
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, lines + 1);
  assert.deepEqual(revised.events.map(({ type }) => type), ['plan/superseded', 'plan/revised', 'task/updated', 'task/orphaned']);
  assert.equal(h.state.tasks[a.id].acceptance[0].id, a.acceptance[0].id);
  assert.equal(h.state.tasks[b.id].orphaned, true);
});

// Responsibility: a later model refusal discards preceding version and task actions together.
// 责任：批中拒绝修订不写项目日志，也不改成员关系。
test('mid-batch plan revise refusal leaves zero project log and no member changes', async (t) => {
  const { h, log } = await fixture(t);
  const initial = await h.command(cmd('plan.publish', { title: 'Plan', steps: [step('one', task('A'), task('B', { requiresAudit: true }))] }));
  const planId = initial.events[0].data.id;
  const [a, b] = Object.values(h.state.tasks);
  const check = unchanged(h, log);
  await assert.rejects(h.command(cmd('plan.revise', { planId, baseVersion: 1, steps: [step('one',
    task('A changed', { taskId: a.id }),
    task('New task'),
    task('B', { taskId: b.id, requiresAudit: false }),
  )] })), { code: 'forbidden-role' });
  check();
  assert.equal(h.state.planHeads[planId].currentVersion, 1);
  assert.equal(h.state.plans[planId + '@2'], undefined);
  assert.equal(Object.keys(h.state.tasks).length, 2);
  assert.equal(h.state.tasks[a.id].title, 'A');
});

// Responsibility: ordinary writes cannot create or expand overlapping task membership;
// retained historical definitions still execute in sequence, using the real current revision.
// 责任：新重叠整体拒绝，历史重叠按最后定义有界呈现，存量同阶段依赖和原记录保持可回放。
test('new overlap is atomic refusal and historical overlap is bounded with last definition winning', async (t) => {
  let { h, log } = await fixture(t);
  const initial = await h.command(cmd('plan.publish', { title: 'Plan', steps: [step('one', task('A'), task('B'))] }));
  const planId = initial.events[0].data.id;
  const [a, b] = Object.values(h.state.tasks);
  const overlap = [step('one', task('A first', { taskId: a.id, priority: 3 }), task('B', { taskId: b.id })),
    step('two', task('A last', { taskId: a.id, priority: 7 }))];
  let check = unchanged(h, log);
  await assert.rejects(h.command(cmd('plan.revise', { planId, baseVersion: 1, steps: overlap })), { code: 'invalid-command' });
  check();
  h = await seedStageMembership(h, planId, [{ id: 'one', title: 'one', taskIds: [a.id, b.id] }, { id: 'two', title: 'two', taskIds: [a.id] }]);
  const historicalB = h.state.tasks[b.id];
  const oldB = { ...historicalB, rev: historicalB.rev + 1, deps: [a.id], state: 'backlog' };
  h = await seedStageHistory(h, [{ type: 'task/updated', taskId: b.id, rev: oldB.rev, data: oldB }]);
  assert.deepEqual(h.state.tasks[b.id].deps, [a.id]);
  overlap[0].tasks[1].deps = [a.id];
  check = unchanged(h, log);
  await assert.rejects(h.command(cmd('plan.revise', { planId, baseVersion: 2, steps: [...overlap, step('three', task('A extra', { taskId: a.id }))] })), { code: 'invalid-command' });
  check();
  const taskRev = h.state.tasks[a.id].rev;
  const projectRev = h.rev;
  const before = fs.readFileSync(log);
  const revise = cmd('plan.revise', { planId, baseVersion: 2, steps: overlap });
  const result = await h.command(revise);
  assertOnePlanCommit(h, log, before, projectRev, revise.cmdId, result);
  const records = result.events.filter((event) => event.taskId === a.id);
  assert.deepEqual(records.map((event) => event.rev), [taskRev + 1, taskRev + 2]);
  assert.deepEqual(records.map((event) => event.data.title), ['A first', 'A last']);
  assert.equal(h.state.tasks[a.id].title, 'A last');
  assert.equal(h.state.tasks[a.id].priority, 7);
  assert.equal(h.state.tasks[a.id].planRef.stepId, 'two');
  assert.deepEqual(h.state.tasks[b.id].deps, [a.id]);
  assert.deepEqual(h.state.plans[planId + '@3'].steps.map(({ taskIds }) => taskIds), [[a.id, b.id], [a.id]]);
  h = await assertPlanReopens(h, log);
  const cleanup = await h.command(cmd('plan.revise', { planId, baseVersion: 3, steps: [step('one', task('B', { taskId: b.id }))] }));
  assert.equal(cleanup.events.filter((event) => event.taskId === a.id).length, 1);
  assert.equal(h.state.tasks[a.id].orphaned, true);
});

// Responsibility: final model validation rejects new cross-plan conflict pairs even
// when old historical pointers are missing and a local ownership guard cannot see it.
// 责任：认领不能借缺失指针扩大历史跨计划冲突。
test('adopt cannot grow historical cross-plan conflicts through a missing pointer', async (t) => {
  let { h, log } = await fixture(t);
  await h.command(cmd('plan.publish', { title: 'First', steps: [step('one', task('A'))] }));
  const second = await h.command(cmd('plan.publish', { title: 'Second', steps: [step('one', task('B'))] }));
  const planId = second.events[0].data.id;
  const a = Object.values(h.state.tasks).find((entry) => entry.title === 'A');
  h = await seedStageHistory(h, [{ type: 'task/updated', taskId: a.id, rev: a.rev + 1, data: { ...a, rev: a.rev + 1, planRef: null } }]);
  const check = unchanged(h, log);
  await assert.rejects(h.command(cmd('plan.adopt', { planId, baseVersion: 1, stepId: 'one', taskIds: [a.id] })), { code: 'plan-task-in-use' });
  check();
  assert.equal(h.state.tasks[a.id].planRef, null);
  assert.equal(h.state.currentPlans[planId], 1);
});

// Responsibility: ownership validation is model-owned, not merely a command convention.
// 责任：跨计划修订被拒时双方计划与成员指针保持原样。
test('cross-plan revise refusal preserves both plans and all membership pointers', async (t) => {
  const { h, log } = await fixture(t);
  const first = await h.command(cmd('plan.publish', { title: 'First', steps: [step('one', task('A'))] }));
  await h.command(cmd('plan.publish', { title: 'Second', steps: [step('one', task('B'))] }));
  const planId = first.events[0].data.id;
  const [a, b] = Object.values(h.state.tasks);
  const check = unchanged(h, log);
  await assert.rejects(h.command(cmd('plan.revise', { planId, baseVersion: 1, steps: [step('one', task('A', { taskId: a.id }), task('B', { taskId: b.id }))] })), { code: 'plan-task-in-use' });
  check();
});
