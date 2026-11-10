/**
 * 测试职责：让健康检查只读诊断意图、工作引用、owner 和归档活跃工作的不变量。
 * 典型流程：合成状态/冻结快照或临时完整任务流程 → checkState/health/冷开 → 对照检查名和 ids。
 * 覆盖边界：覆盖 I6/I22、租约有效期及合法历史形态；不覆盖自动修复或真实进程崩溃。
 * 外部前置：无；时钟、损坏与历史数据均由 fixture 注入。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkState } from '../../lib/core/fsck.js';
import { emptyState } from '../../lib/core/model.js';
import { ProjectService } from '../../lib/core/service.js';
import { makeCommit } from '../../lib/core/store.js';

const AT = '2026-10-29T12:00:00.000Z';
const OWNER = { sessionId: 'worker', epoch: 1, fencingToken: 1, leaseUntil: '2026-10-29T12:15:00.000Z' };
function stateWith(taskState = 'in_progress') {
  const state = emptyState({ id: 'prj_fixture', phase: 'active' });
  state.tasks.tsk_one = {
    id: 'tsk_one', state: taskState, rev: 1, deps: [], acceptance: [], evidence: [],
    owner: taskState === 'in_progress' ? { ...OWNER } : null,
    verifiedAt: taskState === 'done' ? AT : null, work: { intentId: 'int_one' },
  };
  state.intents.int_one = { id: 'int_one', taskId: 'tsk_one', status: 'open', actor: { kind: 'agent' }, startedAt: AT };
  return state;
}
function failures(state, options) {
  return checkState(state, options).checks.filter((check) => !check.ok);
}
function expectFailure(state, name, ids, options) {
  const health = checkState(state, options);
  assert.equal(health.ok, false);
  assert.deepEqual(health.checks.filter((check) => !check.ok).map((check) => check.name), [name]);
  for (const id of ids) assert.ok(health.warnings.some((warning) => warning.includes(name) && warning.includes(id)), 'warning locates ' + id);
}
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

// 责任：开放意图引用不存在任务时，诊断必须同时定位 intentId 与 taskId。
test('I6: open intent whose task is missing is diagnosed with both ids', () => {
  const state = stateWith();
  delete state.tasks.tsk_one;
  expectFailure(state, 'intent-task:int_one', ['tsk_one', 'int_one']);
});
for (const taskState of ['blocked', 'review', 'done', 'ready', 'backlog', 'canceled', 'invalid']) {
  // 责任：开放意图挂在不允许状态上须报 intent-state，原状态不得被检查器修复。
  test('I6: open intent on ' + taskState + ' is diagnosed without repairing it', () => {
    const state = stateWith(taskState);
    const before = structuredClone(state);
    const health = checkState(state);
    assert.equal(health.ok, false);
    const failed = health.checks.filter((check) => !check.ok).map((check) => check.name);
    assert.deepEqual(failed, taskState === 'invalid' ? ['task-state:tsk_one', 'intent-state:int_one'] : ['intent-state:int_one']);
    assert.ok(health.warnings.some((warning) => warning.includes('int_one') && warning.includes('tsk_one') && warning.includes(taskState)));
    assert.deepEqual(state, before);
  });
}

// 责任：work 指向不存在意图时即使任务状态也非法，仍须单独报 task-work。
test('work reference must exist, even when the task state is invalid', () => {
  for (const taskState of ['ready', 'invalid']) {
    const state = stateWith(taskState);
    delete state.intents.int_one;
    const health = checkState(state);
    assert.ok(health.checks.some((check) => check.name === 'task-work:tsk_one' && !check.ok));
    assert.ok(health.warnings.some((warning) => warning.includes('tsk_one') && warning.includes('int_one')));
    assert.equal(health.ok, false);
  }
});

// 责任：work 指向别的任务历史意图须报 task-work-task，并列出相关身份。
test('work reference cannot point at another task\'s historical intent', () => {
  const state = stateWith('ready');
  state.intents.int_one = { id: 'int_one', taskId: 'tsk_other', status: 'closed' };
  expectFailure(state, 'task-work-task:tsk_one', ['tsk_one', 'int_one', 'tsk_other']);
});

// 责任：只有 in_progress 可持 owner；缺 owner 或其他状态残留 owner 均须报警。
test('owner is required only in_progress and cannot remain on other task states', () => {
  const missing = stateWith();
  missing.tasks.tsk_one.owner = null;
  expectFailure(missing, 'task-owner:tsk_one', ['tsk_one']);
  for (const taskState of ['interrupted', 'blocked', 'review', 'done', 'ready', 'backlog', 'canceled']) {
    const state = stateWith(taskState);
    state.intents.int_one.status = 'closed';
    state.tasks.tsk_one.owner = { ...OWNER };
    expectFailure(state, 'task-owner:tsk_one', ['tsk_one']);
  }
});

// 责任：合法 pre-begin、unblock、恢复及历史 work 形态须通过，不得把 I6 误做双向约束。
test('I6 stays one-way: pre-begin, post-unblock, recovery and historical work are legal', () => {
  for (const taskState of ['in_progress', 'interrupted', 'blocked', 'review', 'done', 'ready', 'backlog', 'canceled']) {
    for (const status of ['closed', 'abandoned']) {
      const state = stateWith(taskState);
      state.intents.int_one.status = status;
      assert.deepEqual(failures(state), [], taskState + ' with historical ' + status);
    }
  }
  for (const taskState of ['in_progress', 'interrupted']) {
    const state = stateWith(taskState);
    state.tasks.tsk_one.work = null; // Recovery may clear work while keeping an open intent.
    assert.deepEqual(failures(state), []);
  }
  const preBegin = stateWith();
  preBegin.tasks.tsk_one.work = null;
  preBegin.intents = {};
  assert.deepEqual(failures(preBegin), []);
});

// 责任：标记 RFC-3 的不完整结清须报 I22，无标记旧历史关闭记录仍须兼容。
test('I22 diagnoses partial RFC-3 settlements but leaves unmarked legacy closures alone', () => {
  for (const status of ['closed', 'abandoned']) {
    const state = stateWith('ready');
    state.intents.int_one = { id: 'int_one', taskId: 'tsk_one', status, closedAt: AT, resolution: 'discarded' };
    assert.deepEqual(failures(state), [], 'legacy resolution/at do not identify RFC-3');
    state.intents.int_one = {
      ...state.intents.int_one, closeReason: 'reconcile-discard', closedBy: { kind: 'human' },
    };
    assert.deepEqual(failures(state), []);
    for (const field of ['status', 'closedAt', 'closedBy']) {
      const broken = structuredClone(state);
      delete broken.intents.int_one[field];
      expectFailure(broken, 'intent-settlement:int_one', ['tsk_one', 'int_one', field]);
    }
    const reasonless = structuredClone(state);
    delete reasonless.intents.int_one.closeReason;
    delete reasonless.intents.int_one.resolution;
    expectFailure(reasonless, 'intent-settlement:int_one', ['tsk_one', 'int_one']);
  }
});

// 责任：治理结清 outcome=unknown 或缺 sideEffects 不能算合法 settlement。
test('I22 governance outcome=unknown or missing sideEffects is not a valid settlement', () => {
  const state = stateWith('blocked');
  Object.assign(state.intents.int_one, {
    status: 'abandoned', closeReason: 'blocked', closedBy: { kind: 'agent' }, closedAt: AT,
    outcome: 'stopped', sideEffects: [],
  });
  assert.deepEqual(failures(state), []);
  const unknown = structuredClone(state);
  unknown.intents.int_one.outcome = 'unknown';
  expectFailure(unknown, 'intent-settlement:int_one', ['tsk_one', 'int_one', 'outcome']);
  delete state.intents.int_one.sideEffects;
  expectFailure(state, 'intent-settlement:int_one', ['tsk_one', 'int_one', 'sideEffects']);
  delete state.intents.int_one.outcome;
  expectFailure(state, 'intent-settlement:int_one', ['tsk_one', 'int_one', 'outcome', 'sideEffects']);
});

// 责任：归档项目须逐项报告进行中任务、开放意图和活租约，过期租约不算活工作。
test('archived project reports each in_progress task, open intent and live lease, not expired leases', () => {
  const state = stateWith();
  state.project.phase = 'archived';
  const options = { now: Date.parse(AT), leases: [
    { taskId: 'tsk_one', expiresAt: '2026-10-29T12:15:00.000Z' },
    { taskId: 'tsk_expired', expiresAt: AT },
  ] };
  const health = checkState(state, options);
  assert.equal(health.ok, false);
  assert.deepEqual(health.checks.filter((check) => !check.ok).map((check) => check.name), [
    'project-archived-task:tsk_one', 'project-archived-intent:int_one', 'project-archived-lease:tsk_one',
  ]);
  assert.ok(health.warnings.some((warning) => warning.includes('tsk_one') && warning.includes('int_one')));
  state.tasks.tsk_one.state = 'interrupted';
  state.tasks.tsk_one.owner = null;
  state.intents.int_one.status = 'abandoned';
  assert.deepEqual(failures(state, { now: options.now, leases: [options.leases[1]] }), []);
});

// 责任：health 须按运行时续期后的 expiresAt 判断，不使用旧 owner 时间且不续租归档工作。
test('health uses renewed runtime lease expiry, not stale owner.leaseUntil, and does not renew archived work', async (t) => {
  const { h, task, taskId, work } = await fixture(t);
  await work('task.claim');
  await work('task.begin', { summary: 'lease clock test' });
  const oldOwnerExpiry = task().owner.leaseUntil;
  let now = Date.parse(oldOwnerExpiry) - 1000;
  h.clock = () => new Date(now);
  h.touch('worker'); // Active touch extends only the runtime lease.
  const runtimeExpiry = h.leases.get(taskId).expiresAt;
  assert.ok(Date.parse(runtimeExpiry) > Date.parse(oldOwnerExpiry));
  assert.equal(task().owner.leaseUntil, oldOwnerExpiry);
  now = Date.parse(oldOwnerExpiry) + 1;
  h.state.project.phase = 'archived'; // Offline legacy anomaly fixture.
  const before = structuredClone(h.state);
  const leaseBefore = structuredClone(h.leases.get(taskId));
  const live = h.health();
  assert.ok(live.checks.some((check) => check.name === 'project-archived-lease:' + taskId && !check.ok));
  assert.deepEqual(h.state, before);
  assert.deepEqual(h.leases.get(taskId), leaseBefore);
  h.leases.get(taskId).expiresAt = new Date(now).toISOString();
  const expired = h.health();
  assert.ok(!expired.checks.some((check) => check.name === 'project-archived-lease:' + taskId && !check.ok));
  assert.ok(expired.warnings.some((warning) => warning.includes('lease expired but renewable: ' + taskId)));
});

// 责任：对深冻结旧快照派生 plan head 必须只读，不可因规范化修改输入。
test('legacy head derivation is read-only even on deeply frozen snapshots', () => {
  const state = stateWith('ready');
  state.intents.int_one.status = 'closed';
  state.schemaVersion = 1;
  state.project.currentPlanId = 'pln_legacy';
  delete state.project.focusPlanId;
  delete state.planHeads;
  state.plans['pln_legacy@1'] = {
    id: 'pln_legacy', title: 'Legacy', version: 1, status: 'published', steps: [], createdAt: AT,
  };
  const before = structuredClone(state);
  const checked = checkState(deepFreeze(state));
  assert.equal(checked.ok, true);
  assert.deepEqual(state, before);
  const archivedFocus = structuredClone(before);
  archivedFocus.planHeads = { pln_legacy: { id: 'pln_legacy', status: 'archived', archivedFrom: 'active', currentVersion: 1 } };
  archivedFocus.project.focusPlanId = 'pln_legacy';
  const withFocus = structuredClone(archivedFocus);
  assert.equal(checkState(deepFreeze(archivedFocus)).ok, true);
  assert.deepEqual(archivedFocus, withFocus, 'legacy focus derivation must not heal caller state');
});

async function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-fsck-'));
  const rootDir = path.join(base, 'board');
  assert.ok(!path.relative(os.tmpdir(), rootDir).startsWith('..'), 'data root is a temporary fixture');
  const workspacePath = path.join(base, 'workspace');
  fs.mkdirSync(workspacePath);
  const svc = new ProjectService({ rootDir });
  t.after(() => svc.close());
  await svc.init();
  const h = await svc.createProject({ workspacePath, name: 'Synthetic fsck fixture' });
  await h.attach({ sessionId: 'worker', source: 'test', role: 'worker' });
  let seq = 0;
  const command = (op, extra = {}, human = false) => h.command({
    cmdId: 'cmd_fsck_' + ++seq, actor: human ? { kind: 'human' } : { kind: 'agent', sessionId: 'worker' }, op, ...extra,
  });
  const created = await command('task.create', { title: 'One', acceptance: [{ text: 'covered', requiredKinds: ['test'] }] });
  const taskId = created.events.find((event) => event.type === 'task/created').taskId;
  const task = () => h.state.tasks[taskId];
  const work = (op, extra = {}, human = false) => command(op, {
    taskId, expected: { entityRev: task().rev }, fencingToken: h.leases.get(taskId)?.token, ...extra,
  }, human);
  return { base, rootDir, svc, h, command, taskId, task, work };
}

// 责任：完整 claim/begin/block/unblock/interrupt/reconcile/submit/reject/reopen 流程中健康检查须持续通过。
test('legal claim/begin/block/unblock/interrupt/reconcile/submit/reject/reopen paths remain healthy', async (t) => {
  const { h, work, task } = await fixture(t);
  const healthy = () => assert.equal(h.health().ok, true, h.health().warnings.join('\n'));
  await work('task.claim'); healthy(); // no begin is required for health
  await work('task.begin', { summary: 'attempt one' }); healthy();
  await work('task.block', { code: 'wait', note: 'stopped', intent: { outcome: 'stopped', sideEffects: [] } }); healthy();
  await work('task.unblock', { note: 'resume' }); healthy(); // new owner, historical abandoned work
  assert.equal(task().state, 'in_progress');
  await work('task.begin', { summary: 'attempt two' }); healthy();
  await work('task.interrupt', { note: 'unknown' }); healthy();
  await work('task.reconcile', { choice: 'resume', note: 'redo' }); healthy();
  await work('task.interrupt', { note: 'pause' }); healthy();
  await work('task.reconcile', { choice: 'discard', note: 'discard' }); healthy();
  await work('task.claim'); healthy();
  await work('task.begin', { summary: 'attempt three' }); healthy();
  await work('task.submit', { evidence: [{ kind: 'test', ref: 'synthetic self-report only; do not execute', acceptanceId: task().acceptance[0].id }] }); healthy();
  await work('task.reject', { reason: 'redo' }, true); healthy();
  await work('task.release'); healthy();
  await work('task.cancel', { reason: 'stop' }, true); healthy();
  await work('task.reopen', { reason: 'reopen' }, true); healthy();
});

// 责任：health 本身不得写数据，手工破坏意图关系须仅命中新 I6 检查。
test('health is read-only and manual corruption hits exactly the new I6 check', async (t) => {
  const { base, h, taskId, task, work } = await fixture(t);
  await work('task.claim');
  await work('task.begin', { summary: 'read-only check' });
  const intentId = task().work.intentId;
  task().state = 'blocked'; // Synthetic in-memory corruption, not a real store.
  task().owner = null;
  h.leases.clear();
  const marker = path.join(base, 'MUST-NOT-EXIST');
  task().evidence.push({ kind: 'command', ref: 'node -e "require(\'fs\').writeFileSync(' + JSON.stringify(marker) + ', \'bad\')"' });
  const before = {
    state: structuredClone(h.state), rev: h.rev, leases: [...h.leases],
    log: fs.readFileSync(h.store.commitsFile), meta: fs.readFileSync(path.join(h.meta.dir, 'meta.json')),
  };
  for (let i = 0; i < 2; i++) {
    const health = h.health();
    assert.equal(health.ok, false);
    assert.deepEqual(health.checks.filter((check) => !check.ok).map((check) => check.name), ['intent-state:' + intentId]);
    assert.ok(health.warnings.some((warning) => warning.includes(taskId) && warning.includes(intentId)));
  }
  assert.deepEqual(h.state, before.state);
  assert.equal(h.rev, before.rev);
  assert.deepEqual([...h.leases], before.leases);
  assert.deepEqual(fs.readFileSync(h.store.commitsFile), before.log);
  assert.deepEqual(fs.readFileSync(path.join(h.meta.dir, 'meta.json')), before.meta);
  assert.equal(fs.existsSync(marker), false, 'health never executes evidence commands');
});

// 责任：重启恢复清掉 work/owner 但保留开放意图时，合法 interrupted 状态须健康。
test('restart recovery keeps an open intent with cleared work and owner healthy', async (t) => {
  const { rootDir, svc, h, taskId, work } = await fixture(t);
  await work('task.claim');
  await work('task.begin', { summary: 'recover interrupted work' });
  const intentId = h.state.tasks[taskId].work.intentId;
  const id = h.id;
  await svc.close();
  const reopened = new ProjectService({ rootDir });
  t.after(() => reopened.close());
  await reopened.init();
  const again = await reopened.open(id);
  assert.equal(again.state.tasks[taskId].state, 'interrupted');
  assert.equal(again.state.tasks[taskId].owner, null);
  assert.equal(again.state.tasks[taskId].work, null);
  assert.equal(again.state.intents[intentId].status, 'open');
  assert.equal(again.health().ok, true, again.health().warnings.join('\n'));
});

// 责任：快照和旧迁移保留历史 work 时不得产生误报。
test('snapshot and legacy migration preserve historical work without false alarms', async (t) => {
  const { rootDir, svc, h, taskId, work } = await fixture(t);
  await work('task.claim');
  await work('task.begin', { summary: 'snapshot attempt' });
  await work('task.block', { code: 'wait', note: 'stopped', intent: { outcome: 'stopped', sideEffects: [] } });
  const legacy = structuredClone(h.state);
  const intent = Object.values(legacy.intents)[0];
  for (const field of ['closedBy', 'closeReason', 'outcome', 'sideEffects', 'settlementNote']) delete intent[field];
  delete legacy.planHeads;
  delete legacy.project.focusPlanId;
  legacy.schemaVersion = 1;
  fs.writeFileSync(path.join(h.meta.dir, 'snapshot.json'), JSON.stringify({ v: 1, seq: h.rev, hash: h.lastHash, state: legacy }));
  const id = h.id;
  const log = h.store.commitsFile;
  const upgrade = makeCommit(h.rev + 1, h.lastHash, { kind: 'human' }, 'fixture-upgrade-v3', h.rev, [
    { type: 'project/updated', data: { ...h.state.project, schemaVersion: 3 } },
    { type: 'task/updated', data: { ...h.state.tasks[taskId], requiresAudit: false } },
  ]);
  await svc.close();
  fs.appendFileSync(log, JSON.stringify(upgrade) + '\n');
  const reopened = new ProjectService({ rootDir });
  t.after(() => reopened.close());
  await reopened.init();
  const again = await reopened.open(id);
  assert.equal(again.state.schemaVersion, 3);
  assert.equal(again.state.tasks[taskId].work.intentId, intent.id);
  assert.equal(again.health().ok, true, again.health().warnings.join('\n'));
  const before = fs.readFileSync(again.store.commitsFile);
  assert.deepEqual(failures(again.state), []);
  assert.deepEqual(fs.readFileSync(again.store.commitsFile), before);
});
