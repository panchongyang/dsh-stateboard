/**
 * 测试职责：验证任务提交、续租与验收在模型事务中同成同败，并只留下可回放记录。
 * 典型流程：合成任务/租约/证据 → 直接执行模型操作及公共任务命令 → 对比事件顺序、日志字节与回滚结果。
 * 覆盖边界：覆盖稳定事务头、权限、CAS、fencing、提交回滚、批次完整性、运行租约与验收提升；不覆盖宿主或真实数据。
 * 外部前置：无；使用临时目录与合成 JSONL store。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { COMMAND_HANDLERS } from '../../lib/core/commands/index.js';
import { taskOperations } from '../../lib/core/domain/operations/tasks.js';
import { ProjectService } from '../../lib/core/service.js';

const worker = { kind: 'agent', sessionId: 'test-worker', agentId: 'test-agent', callId: 'test-call' };
const human = { kind: 'human', sessionId: 'test-human', via: 'web' };

async function fixture(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-model-task-'));
  const rootDir = path.join(root, 'store');
  const workspacePath = path.join(root, 'workspace');
  fs.mkdirSync(workspacePath);
  let nowMs = Date.parse('2026-01-01T00:00:00Z');
  const clock = () => new Date(nowMs);
  const svc = new ProjectService({ rootDir, clock });
  t.after(() => svc.close());
  await svc.init();
  const handle = await svc.createProject({ workspacePath, name: label });
  await handle.attach({ sessionId: worker.sessionId, agentId: worker.agentId, role: 'worker' });
  let commandNo = 0;
  const request = (op, taskId, args = {}, actor = worker) => ({
    cmdId: 'cmd_test_' + ++commandNo, op, actor,
    ...(taskId ? { taskId, expected: { entityRev: handle.state.tasks[taskId].rev } } : {}), ...args,
  });
  const doTask = (op, taskId, args, actor) => handle.command(request(op, taskId, args, actor));
  const create = async (title, args = {}) => (await doTask('task.create', null, { title, acceptance: [{ text: 'demo criterion' }], ...args })).events[0].taskId;
  const claimAndBegin = async taskId => {
    const claim = await doTask('task.claim', taskId);
    const fencingToken = claim.events.find(event => event.type === 'lease/granted').data.token;
    const begun = await doTask('task.begin', taskId, { fencingToken, summary: 'Demonstrate task transaction' });
    return { fencingToken, intentId: begun.events.find(event => event.type === 'work/intent').data.id };
  };
  return { svc, handle, rootDir, workspacePath, request, doTask, create, claimAndBegin, clock, tick: seconds => { nowMs += seconds * 1000; } };
}

function log(handle) {
  return fs.readFileSync(handle.store.commitsFile, 'utf8');
}

function types(reply) {
  return reply.events.map(event => event.type);
}

// The production command bus, engine, persistence and replay all run normally;
// the third step is replaced with an attempted second settlement. That step
// fails only because the first two have already staged evidence and closed the intent.
// 责任：提交在评审转移被拒时回滚证据与已结清意图。
test('submission rolls back evidence and a settled intent when the review transition rejects', async t => {
  const { svc, handle, rootDir, create, claimAndBegin, request, clock } = await fixture(t, 'Atomic task submit');
  const taskId = await create('Atomic');
  const { fencingToken, intentId } = await claimAndBegin(taskId);
  const acceptanceId = handle.state.tasks[taskId].acceptance[0].id;
  const submit = request('task.submit', taskId, {
    fencingToken,
    evidence: [{
      kind: 'note', ref: 'worker declaration', acceptanceId,
      execution: { exitCode: 0 }, producedBy: { sessionId: 'forged' }, supersededAt: 'forged',
    }],
    events: [{ type: 'task/verified' }],
  });
  const before = handle.committedSnapshot();
  const beforeLog = log(handle);
  const original = COMMAND_HANDLERS['task.submit'];
  const mock = t.mock.method(COMMAND_HANDLERS, 'task.submit', (read, command) => {
    assert.equal(read._grantLease, undefined);
    assert.equal(read._markLeaseProgress, undefined);
    assert.ok(Object.isFrozen(read.state.tasks[taskId].acceptance[0]));
    const plan = original(read, command);
    assert.deepEqual(Object.keys(plan), ['operations']);
    assert.deepEqual(plan.operations.map(({ kind }) => kind), [
      'evidence.stageSubmission', 'work.completeSubmission', 'task.enterReviewFromWork', 'lease.releaseSubmittedWork',
    ]);
    assert.ok(Object.isFrozen(taskOperations));
    const material = plan.operations[0].args.materials[0];
    assert.equal(material.producedBy, undefined);
    assert.equal(material.execution, undefined);
    assert.equal(material.supersededAt, undefined);
    return { operations: plan.operations.map((operation, i) => i === 2 ? plan.operations[1] : operation) };
  });
  await assert.rejects(handle.command(submit), {
    code: 'invalid-command', message: 'operation requires the current open intent',
  });
  mock.mock.restore();
  assert.deepEqual(handle.committedSnapshot(), before);
  assert.equal(log(handle), beforeLog);
  assert.equal(handle.state.intents[intentId].status, 'open');
  assert.equal(handle.leases.get(taskId).token, fencingToken);

  const accepted = await handle.command(submit);
  assert.deepEqual(types(accepted), ['work/result', 'task/submitted']);
  assert.equal(accepted.projectRev, before.lastSeq + 1);
  assert.equal(accepted.entityRev, before.state.tasks[taskId].rev + 1);
  assert.equal(handle.state.intents[intentId].status, 'closed');
  assert.equal(handle.state.tasks[taskId].state, 'review');
  assert.equal(handle.state.tasks[taskId].owner, null);
  assert.equal(handle.leases.has(taskId), false);
  const [recorded] = handle.state.tasks[taskId].evidence;
  assert.deepEqual(recorded.producedBy, { sessionId: worker.sessionId, agentId: worker.agentId, callId: worker.callId });
  assert.equal(recorded.execution, null);
  assert.equal(recorded.supersededAt, undefined);
  const commits = handle.store.commits.filter(entry => entry.cmdId === submit.cmdId);
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0].events, accepted.events);
  const deduped = await handle.command(submit);
  assert.equal(deduped.deduped, true);
  assert.equal(handle.rev, accepted.projectRev);

  const projectId = handle.id;
  const expected = handle.committedSnapshot();
  await svc.close();
  const reopened = new ProjectService({ rootDir, clock });
  t.after(() => reopened.close());
  await reopened.init();
  const replayed = await reopened.open(projectId);
  assert.deepEqual(replayed.committedSnapshot(), expected);
});

// 责任：省略已提交工作的租约释放不能发布部分批次。
test('omitting the submitted-work lease release cannot publish a partial batch', async t => {
  const { handle, create, claimAndBegin, doTask } = await fixture(t, 'Incomplete task batch');
  const taskId = await create('Incomplete batch');
  const { fencingToken } = await claimAndBegin(taskId);
  const acceptanceId = handle.state.tasks[taskId].acceptance[0].id;
  const before = handle.committedSnapshot();
  const durable = log(handle);
  const original = COMMAND_HANDLERS['task.submit'];
  t.mock.method(COMMAND_HANDLERS, 'task.submit', (read, command) => {
    const { operations } = original(read, command);
    assert.equal(operations.at(-1).kind, 'lease.releaseSubmittedWork');
    return { operations: operations.slice(0, -1) };
  });
  await assert.rejects(doTask('task.submit', taskId, { fencingToken, evidence: [{ kind: 'note', ref: 'draft', acceptanceId }] }));
  assert.deepEqual(handle.committedSnapshot(), before);
  assert.equal(log(handle), durable);
});

// 责任：显式续租只改运行租约，新尝试重置无进展计数。
test('explicit renewal only updates the runtime lease; an attempt resets the no-progress count', async t => {
  const { handle, create, doTask, tick } = await fixture(t, 'Task renewal');
  const taskId = await create('Runtime lease');
  const fencingToken = (await doTask('task.claim', taskId)).events[0].data.token;
  tick(5);
  const persisted = log(handle);
  const before = handle.state;
  const renewed = await doTask('task.renew', taskId, { fencingToken });
  assert.equal(renewed.committed, false);
  assert.deepEqual(renewed.events, []);
  assert.equal(renewed.renewCount, 1);
  assert.equal(handle.leases.get(taskId).renewCount, 1);
  assert.deepEqual(handle.state, before);
  assert.equal(log(handle), persisted);
  tick(5);
  assert.deepEqual(types(await doTask('task.begin', taskId, { fencingToken, summary: 'Begin' })), ['work/intent', 'task/updated']);
  assert.equal(handle.leases.get(taskId).renewCount, 0);
});

// 责任：人工文件刷新与依赖提升在同一次验收中持久化。
test('human file refresh and dependent promotion form one durable verification', async t => {
  const { handle, create, claimAndBegin, workspacePath, doTask } = await fixture(t, 'Model verify');
  const taskId = await create('Review source');
  const dependentId = await create('Dependent', { deps: [taskId] });
  const { fencingToken } = await claimAndBegin(taskId);
  const acceptanceId = handle.state.tasks[taskId].acceptance[0].id;
  const file = path.join(workspacePath, 'observed.txt');
  fs.writeFileSync(file, 'before');
  await doTask('task.submit', taskId, { fencingToken, evidence: [{ kind: 'file', ref: 'observed.txt', acceptanceId }] });
  const rev = handle.rev;
  const first = handle.state.tasks[taskId].evidence[0];
  fs.writeFileSync(file, 'after');
  await assert.rejects(doTask('task.verify', taskId, { refreshDrift: true, reason: 'Fresh contents' }), { code: 'forbidden-role' });
  assert.equal(handle.rev, rev);
  const verified = await doTask('task.verify', taskId, { refreshDrift: true, reason: 'Fresh contents' }, human);
  assert.deepEqual(types(verified), ['task/verified', 'task/readied']);
  assert.equal(verified.projectRev, rev + 1);
  assert.equal(verified.entityRev, handle.state.tasks[taskId].rev);
  assert.equal(handle.state.tasks[dependentId].state, 'ready');
  const task = handle.state.tasks[taskId];
  assert.deepEqual(task.lastAudit.by, { kind: 'human', sessionId: human.sessionId, agentId: null, via: 'web' });
  assert.equal(task.lastAudit.taskRev, task.rev);
  assert.equal(task.lastAudit.evidence.count, 1);
  const [old, current] = task.evidence;
  assert.equal(old.id, first.id);
  assert.equal(old.supersededBy, current.id);
  assert.equal(old.supersedeReason, 'verify-refresh');
  assert.notEqual(current.hash, first.hash);
  assert.deepEqual(task.refreshedDrift.items[0], { evidenceId: current.id, supersededIds: [first.id], ref: first.ref, oldHash: first.hash, newHash: current.hash });
});

function modelBatch(handle, identity, operations) {
  const { sample, receipt } = handle.model.beginCommand(identity, [
    { kind: 'lease.normalizeBeforeCommand', args: {} },
  ], handle._transactionPorts(handle.service));
  return receipt ?? handle.model.submitOperations(sample, operations);
}

function assertRejectedBatch(handle, run, code) {
  const before = handle.committedSnapshot();
  const bytes = fs.readFileSync(handle.store.commitsFile);
  assert.throws(run, { code });
  assert.deepEqual(handle.committedSnapshot(), before);
  assert.deepEqual(fs.readFileSync(handle.store.commitsFile), bytes);
}

// 责任：模型仅用稳定事务头领租、开启尝试；角色、CAS、目标、状态、token 与未完成配对均不能绕过。
test('stable metadata can grant and begin work without any public command identity', async t => {
  const { handle, create } = await fixture(t, 'Command-independent work');
  const taskId = await create('Candidate');
  const otherId = await create('Different target');
  const identity = { cmdId: 'cmd_model_grant', actor: worker, taskId, expected: { entityRev: handle.state.tasks[taskId].rev } };
  const claim = [{ kind: 'task.claimReadyWork', args: { taskId } }];
  assertRejectedBatch(handle, () => modelBatch(handle, { ...identity, actor: { kind: 'system' } }, claim), 'forbidden-role');
  assertRejectedBatch(handle, () => modelBatch(handle, { ...identity, expected: { entityRev: 0 } }, claim), 'stale-revision');
  assertRejectedBatch(handle, () => modelBatch(handle, { ...identity, taskId: otherId }, claim), 'invalid-command');
  assertRejectedBatch(handle, () => modelBatch(handle, identity, [{ kind: 'task.promoteFromBacklog', args: { taskId } }]), 'illegal-transition');
  const granted = modelBatch(handle, identity, claim);
  assert.deepEqual(types(granted), ['lease/granted', 'task/claimed']);
  const fencingToken = handle.leases.get(taskId).token;
  assert.equal(granted.events[0].data.token, fencingToken);
  const begin = { ...identity, cmdId: 'cmd_model_begin', expected: { entityRev: granted.entityRev }, fencingToken };
  const intentId = 'int_model_attempt';
  const open = { kind: 'work.openAttempt', args: { taskId, intentId, summary: 'Model-owned attempt' } };
  const link = { kind: 'task.beginAttempt', args: { taskId, intentId } };
  assertRejectedBatch(handle, () => modelBatch(handle, { ...begin, fencingToken: fencingToken - 1 }, [open, link]), 'fencing-stale');
  assertRejectedBatch(handle, () => modelBatch(handle, begin, [link]), 'invalid-command');
  assertRejectedBatch(handle, () => modelBatch(handle, begin, [open]), 'invalid-command');
  const begun = modelBatch(handle, begin, [open, link]);
  assert.deepEqual(types(begun), ['work/intent', 'task/updated']);
  assert.equal(handle.state.tasks[taskId].work.intentId, intentId);
  assert.equal(handle.state.intents[intentId].token, fencingToken);
  assert.equal(handle.state.intents[intentId].status, 'open');
  assert.equal(handle.leases.get(taskId).token, fencingToken);
  assert.deepEqual(handle.store.commits.at(-1).events, begun.events);
});

// 责任：提交草稿不能被其他处置消费；缺少结清、越权强制或错意图失败后，原租约、状态、日志字节不变。
test('a staged submission cannot be completed by borrowing another task disposition', async t => {
  const { handle, create, claimAndBegin } = await fixture(t, 'Independent dispositions');
  const taskId = await create('Submission');
  const { fencingToken, intentId } = await claimAndBegin(taskId);
  const acceptanceId = handle.state.tasks[taskId].acceptance[0].id;
  const identity = { cmdId: 'cmd_model_stop', actor: worker, taskId, expected: { entityRev: handle.state.tasks[taskId].rev }, fencingToken };
  const stage = { kind: 'evidence.stageSubmission', args: {
    taskId, materials: [{ id: 'ev_model_note', kind: 'note', ref: 'declared result', acceptanceId }], fileIdentities: {}, captures: [], warnings: [],
  } };
  const result = { kind: 'work.completeSubmission', args: { taskId, intentId } };
  const enter = { kind: 'task.enterReviewFromWork', args: { taskId } };
  const release = { kind: 'lease.releaseSubmittedWork', args: { taskId } };
  const park = { kind: 'task.parkForBlocker', args: { taskId, stopped: { intentId, outcome: 'stopped', sideEffects: [] } } };
  assertRejectedBatch(handle, () => modelBatch(handle, identity, [stage, result, park]), 'invalid-command');
  assertRejectedBatch(handle, () => modelBatch(handle, identity, [stage, enter, release]), 'intent-unresolved');
  assertRejectedBatch(handle, () => modelBatch(handle, identity, [stage, result, enter]), 'invalid-command');
  assertRejectedBatch(handle, () => modelBatch(handle, identity, [{ kind: 'task.applyHumanOverride', args: { ...park.args, toState: 'ready' } }]), 'forbidden-role');
  assertRejectedBatch(handle, () => modelBatch(handle, identity, [{ ...park, args: { ...park.args, stopped: { ...park.args.stopped, intentId: 'wrong' } } }]), 'invalid-command');
  const stopped = modelBatch(handle, identity, [park]);
  assert.deepEqual(types(stopped), ['work/abandoned', 'lease/revoked', 'task/blocked']);
  assert.equal(handle.state.intents[intentId].closeReason, 'blocked');
  assert.equal(handle.state.intents[intentId].status, 'abandoned');
  assert.equal(handle.leases.has(taskId), false);
  assert.equal(handle.state.tasks[taskId].state, 'blocked');
  assert.deepEqual(handle.store.commits.at(-1).events, stopped.events);
});

// 责任：通用过期整理产生的临时 interrupted 不可由其他会话借用；原租约持有者带旧 token 才能同批收口。
test('a provisional interruption requires the lapsed lease authority even without a recovery command', async t => {
  const { handle, create, claimAndBegin, tick } = await fixture(t, 'Lapsed model authority');
  const taskId = await create('Recoverable attempt');
  const { fencingToken, intentId } = await claimAndBegin(taskId);
  const identity = { cmdId: 'cmd_model_recover', actor: worker, taskId, expected: { entityRev: handle.state.tasks[taskId].rev }, fencingToken };
  const discard = [{ kind: 'task.discardInterruptedWork', args: { taskId, note: 'No irreversible effect' } }];
  tick(3600);
  assertRejectedBatch(handle, () => modelBatch(handle, { ...identity, actor: { ...worker, sessionId: 'other-session' } }, discard), 'lease-expired');
  assertRejectedBatch(handle, () => modelBatch(handle, { ...identity, fencingToken: fencingToken - 1 }, discard), 'lease-expired');
  const recovered = modelBatch(handle, identity, discard);
  assert.deepEqual(types(recovered), ['lease/expired', 'task/interrupted', 'work/abandoned', 'task/reconciled']);
  assert.equal(handle.state.intents[intentId].resolution, 'discarded');
  assert.equal(handle.leases.has(taskId), false);
  assert.equal(handle.state.tasks[taskId].state, 'ready');
});
