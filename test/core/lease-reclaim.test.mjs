/**
 * 测试职责：防止命令内租约回收投影被旧任务快照覆盖，并提供受限的过期工作恢复入口。
 * 典型流程：注入时钟推进过期任务 → update/interrupt/reconcile 或非法命令 → 对照提交事件、租约和 allowedOps。
 * 覆盖边界：覆盖 回收原子性、恢复身份例外与失败零写；不覆盖真实时钟调度或多机租约。
 * 外部前置：无；时钟和会话绑定为临时 fixture。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { withProject } from '../helpers/service-fixture.mjs';
import { fail } from '../../lib/host/tools/shared.js';
import { reopenSyntheticHistory } from '../helpers/core-matrix-fixture.mjs';

// Lease expiry inside a command: the expiry is applied to the working projection
// before the command computes its snapshot; interrupt/reconcile are the recovery
// path for the expired lease's own session; rejected commands write nothing.

const START = Date.parse('2026-10-23T00:00:00.000Z');
const TTL_MS = 900 * 1000;
const GRACE_MS = 900 * 1000;
const LAPSE = TTL_MS + GRACE_MS + 1;

let serial = 0;
function cmd(op, extra = {}, sessionId = 's1') {
  return { cmdId: 'cmd_reclaim_' + ++serial, actor: { kind: 'agent', sessionId, agentId: sessionId }, op, ...extra };
}
function human(op, extra = {}) {
  return { ...cmd(op, extra), actor: { kind: 'human', via: 'web' } };
}

async function setup(t) {
  let now = START;
  let h;
  // Close the latest historical fixture writer before withProject removes its roots.
  t.after(() => { if (h && !h.closed) h.close(); });
  const { svc, h: initial, wsDir: ws } = await withProject(t, { clock: () => new Date(now), name: 'Reclaim' });
  h = initial;
  fs.writeFileSync(path.join(ws, 'artifact.txt'), 'v1');
  await h.command(human('project.update', { policy: { verification: 'manual' } }));
  await h.attach({ sessionId: 's1', agentId: 's1', source: 'test', role: 'worker' });
  await h.attach({ sessionId: 's2', agentId: 's2', source: 'test', role: 'worker' });
  const seedBinding = (binding, type = 'session/bound') => {
    // Historical binding/lease mismatches cannot be produced by today's attach API,
    // which correctly releases old leases. Cold replay preserves the original counterexample.
    h = reopenSyntheticHistory(h, [{ type, data: binding }]);
    return h;
  };
  return { svc, h, ws, seedBinding, tick: (ms) => { now += ms; } };
}

const rev = (h, id) => ({ entityRev: h.state.tasks[id].rev });

async function makeTask(h, title) {
  const res = await h.command(cmd('task.create', { title, acceptance: [{ text: 'ok' }] }));
  return res.events.find((event) => event.type === 'task/created').taskId;
}

/** s1 claims and (optionally) opens an intent, then the lease lapses past grace. */
async function lapsed(h, tick, { open = true } = {}) {
  const id = await makeTask(h, 'Lapsing');
  await h.command(cmd('task.claim', { taskId: id, expected: rev(h, id) }));
  const token = h.leases.get(id).token;
  if (open) await h.command(cmd('task.begin', { taskId: id, expected: rev(h, id), fencingToken: token, summary: 'side effects' }));
  tick(LAPSE);
  return { id, token, intentId: h.state.tasks[id].work?.intentId || null };
}

function snapshot(h) {
  return {
    bytes: fs.readFileSync(h.store.commitsFile),
    rev: h.rev,
    state: structuredClone(h.state),
    leases: structuredClone([...h.leases]),
  };
}

async function rejectsClean(h, command, code, label) {
  const before = snapshot(h);
  const error = await h.command(command).then(() => null, (err) => err);
  assert.ok(error, label + ': must be rejected');
  assert.equal(error.code, code, label + ': ' + error.message);
  assert.deepEqual(snapshot(h), before, label + ': rejected command changed log/state/leases/tokens');
  return error;
}

function lastCommit(h) {
  const lines = fs.readFileSync(h.store.commitsFile, 'utf8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

function types(events) {
  return events.map((event) => event.type);
}

// 责任：工作副本中的过期回收可使用调用者看到的版本；随后的独立修改不能再次消费这一旧版本。
test('expiry CAS alias does not authorize two independent edits of the same task', async t => {
  const { h, tick } = await setup(t);
  const { id } = await lapsed(h, tick);
  const before = snapshot(h), expected = rev(h, id);
  const header = { cmdId: 'expiry-cas-batch', actor: { kind: 'human' }, taskId: id, expected };
  const start = () => h.model.beginCommand(header, [{ kind: 'lease.normalizeBeforeCommand', args: {} }], h._transactionPorts(h.service)).sample;
  const edit = title => ({ kind: 'task.editMetadata', args: { taskId: id, title } });
  assert.throws(() => h.model.submitOperations(start(), [edit('first'), edit('second')]),
    e => e.code === 'stale-revision' && e.details.currentRev === expected.entityRev + 2);
  assert.deepEqual(snapshot(h), before, 'both edits and the provisional sweep are discarded');
  const accepted = h.model.submitOperations(start(), [edit('first')]);
  assert.equal(accepted.projectRev, before.rev + 1);
  assert.equal(h.state.tasks[id].rev, expected.entityRev + 2);
  assert.ok(accepted.events.some(e => e.type === 'lease/expired'));
});

// 责任：暂缓生成到期处置的请求不能用另一种终态蒙混过关，必须由模型实际产生目标的中断事实。
test('deferred expiry cannot be settled by an unrelated kind of terminal transition', async t => {
  const { h, tick } = await setup(t);
  const { id, token } = await lapsed(h, tick, { open: false });
  const before = snapshot(h);
  const header = { cmdId: 'deferred-interruption', actor: { kind: 'human' }, taskId: id, fencingToken: token, expected: rev(h, id) };
  const start = () => h.model.beginCommand(header, [{ kind: 'lease.normalizeBeforeCommand', args: { recoverTaskId: id, deferDisposition: true } }], h._transactionPorts(h.service)).sample;
  assert.throws(() => h.model.submitOperations(start(), [{ kind: 'task.cancelOpenWork', args: { taskId: id, reason: 'wrong transition' } }]),
    e => e.code === 'invalid-command');
  assert.deepEqual(snapshot(h), before, 'expiry, lease generation and exact log bytes survive rejection');
  const ok = h.model.submitOperations(start(), [{ kind: 'task.flagInterruptedWork', args: { taskId: id, note: 'explicit interruption' } }]);
  assert.deepEqual(types(ok.events), ['lease/expired', 'task/interrupted']);
  assert.equal(h.state.tasks[id].state, 'interrupted');
});

// 责任：人工编辑过期有意图任务后仍须 interrupted/owner=null，旧快照不能覆盖回收结果。
test('human task.update on an expired task keeps interrupted/owner=null; the old snapshot cannot overwrite the expiry', async (t) => {
  const { svc, h, tick } = await setup(t);
  const { id, intentId } = await lapsed(h, tick);
  const committedRev = h.state.tasks[id].rev;
  const res = await h.command(human('task.update', { taskId: id, expected: { entityRev: committedRev }, title: 'Renamed' }));
  assert.deepEqual(types(res.events).slice(0, 3), ['lease/expired', 'task/interrupted', 'task/updated']);
  const task = h.state.tasks[id];
  assert.equal(task.state, 'interrupted');
  assert.equal(task.owner, null);
  assert.equal(task.assignee, null);
  assert.equal(task.title, 'Renamed');
  assert.equal(task.rev, committedRev + 2, 'expiry and update each advance the rev once');
  assert.equal(h.leases.has(id), false, 'runtime lease is gone');
  assert.equal(h.state.intents[intentId].status, 'open', 'the open intent waits for an explicit settlement');
  const persisted = lastCommit(h);
  assert.deepEqual(types(persisted.events), types(res.events), 'one commit carries expiry and update');
  for (const event of persisted.events.filter((e) => e.taskId === id && e.data?.state)) {
    assert.notEqual(event.data.state, 'in_progress', event.type + ' must not resurrect in_progress');
  }
  // The task is not stuck: the human can reconcile it right away.
  await h.command(human('task.reconcile', { taskId: id, expected: rev(h, id), choice: 'discard', note: 'drop it' }));
  assert.equal(h.state.tasks[id].state, 'ready');
  await svc.close();
});

// 责任：expectedRev 必须匹配已提交版本，不能接受仅在回收工作投影里增长的版本。
test('expectedRev matches only the committed rev; the expiry-bumped working rev is never accepted', async (t) => {
  const { svc, h, tick } = await setup(t);
  const { id, token } = await lapsed(h, tick);
  const committed = h.state.tasks[id].rev;
  const counter = h.state.counters.leaseToken;
  for (const ahead of [1, 2, 5]) {
    const at = { entityRev: committed + ahead };
    const label = 'committed+' + ahead;
    const update = await rejectsClean(h, human('task.update', { taskId: id, expected: at, title: 'X' }), 'stale-revision', 'update ' + label);
    assert.equal(update.details.currentRev, committed);
    await rejectsClean(h, human('task.interrupt', { taskId: id, expected: at, note: 'x' }), 'stale-revision', 'human interrupt ' + label);
    await rejectsClean(h, cmd('task.interrupt', { taskId: id, expected: at, fencingToken: token, note: 'x' }), 'stale-revision', 'agent interrupt ' + label);
    await rejectsClean(h, cmd('task.reconcile', { taskId: id, expected: at, fencingToken: token, choice: 'discard', note: 'x' }), 'stale-revision', 'agent reconcile ' + label);
  }
  await rejectsClean(h, human('task.update', { taskId: id, expected: { entityRev: committed - 1 }, title: 'X' }), 'stale-revision', 'committed-1');
  assert.equal(h.state.counters.leaseToken, counter);
  assert.equal(h.state.tasks[id].rev, committed);
  const ok = await h.command(human('task.update', { taskId: id, expected: { entityRev: committed }, title: 'Y' }));
  assert.equal(ok.committed, true);
  assert.equal(h.state.tasks[id].state, 'interrupted');
  await svc.close();
});

// 责任：无意图的过期任务经业务命令须回 ready，再领取可同提交完成而无状态倒灌。
test('a business command on an expired task without an intent lands in ready, and a claim succeeds in one commit', async (t) => {
  const { svc, h, tick } = await setup(t);
  const { id } = await lapsed(h, tick, { open: false });
  const stale = h.state.tasks[id].rev;
  const res = await h.command(human('task.update', { taskId: id, expected: { entityRev: stale }, priority: 3 }));
  assert.deepEqual(types(res.events).slice(0, 3), ['lease/expired', 'task/readied', 'task/updated']);
  assert.equal(h.state.tasks[id].state, 'ready');
  assert.equal(h.state.tasks[id].owner, null);
  assert.equal(h.leases.has(id), false);

  const { id: other } = await lapsed(h, tick, { open: false });
  const claimed = await h.command(cmd('task.claim', { taskId: other, expected: rev(h, other) }, 's2'));
  assert.deepEqual(types(claimed.events), ['lease/expired', 'task/readied', 'lease/granted', 'task/claimed']);
  assert.equal(h.state.tasks[other].owner.sessionId, 's2');
  await svc.close();
});

// 责任：原 agent 使用过期 token interrupt 属合法恢复，只写一次转移并保留开放意图。
test('agent interrupt with the expired token is the recovery path: one transition, intent stays open', async (t) => {
  const { svc, h, tick } = await setup(t);
  const { id, token, intentId } = await lapsed(h, tick);
  const counter = h.state.counters.leaseToken;
  const before = h.rev;
  const res = await h.command(cmd('task.interrupt', { taskId: id, expected: rev(h, id), fencingToken: token, note: 'lost track of side effects' }));
  assert.deepEqual(types(res.events), ['lease/expired', 'task/interrupted'], 'exactly one task transition, no grant/revoke');
  assert.equal(h.rev, before + 1, 'one commit');
  const task = h.state.tasks[id];
  assert.equal(task.state, 'interrupted');
  assert.equal(task.owner, null);
  assert.equal(task.interrupt.note, 'lost track of side effects');
  assert.equal(task.interrupt.previousState, 'in_progress');
  assert.equal(h.leases.has(id), false);
  assert.equal(h.state.counters.leaseToken, counter, 'no token was issued');
  assert.equal(h.state.intents[intentId].status, 'open', 'interrupt does not settle the intent');

  const settled = await h.command(cmd('task.reconcile', { taskId: id, expected: rev(h, id), choice: 'discard', note: 'nothing happened' }));
  assert.deepEqual(types(settled.events), ['work/abandoned', 'task/reconciled']);
  assert.equal(h.state.intents[intentId].status, 'abandoned');
  await svc.close();
});

// 责任：人工 interrupt 过期任务只能写一次转移，不能先 expiry 再重复 interrupt。
test('human interrupt on an expired task writes one transition (no expiry + interrupt duplicate)', async (t) => {
  const { svc, h, tick } = await setup(t);
  const { id, intentId } = await lapsed(h, tick);
  const res = await h.command(human('task.interrupt', { taskId: id, expected: rev(h, id), note: 'operator stop' }));
  assert.deepEqual(types(res.events), ['lease/expired', 'task/interrupted']);
  assert.equal(h.state.tasks[id].interrupt.by.kind, 'human');
  assert.equal(h.state.intents[intentId].status, 'open');
  assert.equal(h.leases.has(id), false);
  await svc.close();
});

// 责任：agent 可单条 reconcile 恢复过期任务，resume 须恰好发放一份新租约。
test('agent reconcile recovers an expired task in one command; resume issues exactly one new lease', async (t) => {
  const { svc, h, tick } = await setup(t);
  const first = await lapsed(h, tick);
  const discard = await h.command(cmd('task.reconcile', { taskId: first.id, expected: rev(h, first.id), fencingToken: first.token, choice: 'discard', note: 'undo' }));
  assert.deepEqual(types(discard.events), ['lease/expired', 'task/interrupted', 'work/abandoned', 'task/reconciled']);
  assert.equal(h.state.tasks[first.id].state, 'ready');
  assert.equal(h.state.intents[first.intentId].resolution, 'discarded');

  const second = await lapsed(h, tick);
  const counter = h.state.counters.leaseToken;
  const resume = await h.command(cmd('task.reconcile', { taskId: second.id, expected: rev(h, second.id), fencingToken: second.token, choice: 'resume', note: 'redo it' }));
  assert.deepEqual(types(resume.events), ['lease/expired', 'task/interrupted', 'work/abandoned', 'lease/granted', 'work/intent', 'task/reconciled']);
  const lease = h.leases.get(second.id);
  assert.equal(lease.token, counter + 1, 'token change rides in the same commit');
  assert.equal(h.state.tasks[second.id].owner.fencingToken, lease.token);
  assert.equal(lastCommit(h).events.filter((event) => event.type === 'lease/granted').length, 1);

  // The old token can never terminate the new lease.
  await rejectsClean(h, cmd('task.interrupt', { taskId: second.id, expected: rev(h, second.id), fencingToken: second.token, note: 'stale' }), 'fencing-stale', 'old token vs new lease');
  assert.equal(h.leases.get(second.id).token, lease.token);
  await svc.close();
});

// 责任：过期 token 例外仅限恢复，begin/submit/release/renew 仍须拒绝并提示 interrupt/reconcile。
test('only the recovery commands get the exception: begin/submit/release/renew still refuse and point at interrupt/reconcile', async (t) => {
  const { svc, h, tick } = await setup(t);
  const { id, token } = await lapsed(h, tick);
  const begin = await rejectsClean(h, cmd('task.begin', { taskId: id, expected: rev(h, id), fencingToken: token, summary: 'again' }), 'lease-expired', 'begin');
  assert.equal(begin.details.hint, 'interrupt-or-reconcile');
  const submit = await rejectsClean(h, cmd('task.submit', { taskId: id, expected: rev(h, id), fencingToken: token, evidence: [{ kind: 'file', ref: 'artifact.txt' }] }), 'lease-expired', 'submit');
  assert.equal(submit.details.hint, 'interrupt-or-reconcile');
  await rejectsClean(h, cmd('task.release', { taskId: id, expected: rev(h, id), fencingToken: token, intent: { outcome: 'stopped', sideEffects: [] } }), 'lease-expired', 'release');
  const renew = await rejectsClean(h, cmd('task.renew', { taskId: id, expected: rev(h, id), fencingToken: token }), 'lease-expired', 'renew');
  assert.equal(renew.details.hint, 'interrupt-or-reconcile');
  const wrapped = JSON.parse(fail(begin).message);
  assert.match(wrapped.next, /op=interrupt .*op=reconcile/);
  assert.doesNotMatch(wrapped.next, /claim/);
  await svc.close();
});

// 责任：旧/缺 token、异会话、变更 epoch 或已 detach 绑定均不得用恢复例外。
test('stale/missing token, another session, a moved epoch or a detached binding cannot recover', async (t) => {
  let { svc, h, tick, seedBinding } = await setup(t);
  const { id, token } = await lapsed(h, tick);
  const interrupt = (extra, sessionId = 's1') => cmd('task.interrupt', { taskId: id, expected: rev(h, id), note: 'try', ...extra }, sessionId);
  const reconcile = (extra, sessionId = 's1') => cmd('task.reconcile', { taskId: id, expected: rev(h, id), choice: 'discard', note: 'try', ...extra }, sessionId);

  for (const [label, make] of [['interrupt', interrupt], ['reconcile', reconcile]]) {
    const stale = await rejectsClean(h, make({ fencingToken: token - 1 }), 'lease-expired', label + ' stale token');
    assert.equal(stale.details.reason, 'fencing-token');
    await rejectsClean(h, make({}), 'lease-expired', label + ' missing token');
    const foreign = await rejectsClean(h, make({ fencingToken: token }, 's2'), 'lease-expired', label + ' other session');
    assert.equal(foreign.details.hint, 'human-interrupt');
  }

  const binding = structuredClone(h.state.bindings.s1);
  const epoch = binding.epoch;
  h = seedBinding({ ...binding, epoch: epoch + 1 });
  await rejectsClean(h, interrupt({ fencingToken: token }), 'lease-expired', 'epoch moved (interrupt)');
  await rejectsClean(h, reconcile({ fencingToken: token }), 'lease-expired', 'epoch moved (reconcile)');
  h = seedBinding({ ...binding, epoch, detachedAt: new Date(START).toISOString() }, 'session/detached');
  await rejectsClean(h, interrupt({ fencingToken: token }), 'lease-expired', 'detached (interrupt)');
  await rejectsClean(h, reconcile({ fencingToken: token }), 'lease-expired', 'detached (reconcile)');
  h = seedBinding(binding);

  // Without an open intent there is nothing to recover: the expiry returns it to ready.
  const { id: plain, token: plainToken } = await lapsed(h, tick, { open: false });
  const noIntent = await rejectsClean(h, cmd('task.interrupt', { taskId: plain, expected: rev(h, plain), fencingToken: plainToken, note: 'x' }), 'lease-expired', 'no intent');
  assert.equal(noIntent.details.hint, 'claim');
  await svc.close();
});

// 责任：过期后另一会话已重新领取时，旧 token 不得终止其新租约。
test('stale token cannot terminate a lease another session took after the expiry', async (t) => {
  const { svc, h, tick } = await setup(t);
  const { id, token } = await lapsed(h, tick, { open: false });
  await h.command(cmd('task.claim', { taskId: id, expected: rev(h, id) }, 's2'));
  const live = structuredClone(h.leases.get(id));
  await rejectsClean(h, cmd('task.interrupt', { taskId: id, expected: rev(h, id), fencingToken: token, note: 'mine' }), 'fencing-stale', 's1 old token');
  await rejectsClean(h, cmd('task.reconcile', { taskId: id, expected: rev(h, id), fencingToken: token, choice: 'discard', note: 'mine' }), 'illegal-transition', 's1 reconcile on live work');
  assert.deepEqual(h.leases.get(id), live);
  await svc.close();
});

// 责任：非法对账选择或证据审计失败须丢弃暂存回收，日志和运行时租约完全不变。
test('a failed choice or evidence audit drops the provisional expiry entirely', async (t) => {
  const { svc, h, ws, tick } = await setup(t);
  const id = await makeTask(h, 'Audited');
  const acceptanceId = h.state.tasks[id].acceptance[0].id;
  await h.command(cmd('task.claim', { taskId: id, expected: rev(h, id) }));
  let token = h.leases.get(id).token;
  await h.command(cmd('task.begin', { taskId: id, expected: rev(h, id), fencingToken: token, summary: 'write' }));
  await h.command(cmd('task.submit', { taskId: id, expected: rev(h, id), fencingToken: token, evidence: [{ kind: 'file', ref: 'artifact.txt', acceptanceId }] }));
  await h.command(human('task.reject', { taskId: id, expected: rev(h, id), reason: 'again' }));
  token = h.leases.get(id).token;
  await h.command(cmd('task.interrupt', { taskId: id, expected: rev(h, id), fencingToken: token, note: 'pause' }));
  await h.command(cmd('task.reconcile', { taskId: id, expected: rev(h, id), choice: 'resume', note: 'continue' }));
  token = h.leases.get(id).token;
  assert.equal(h.state.tasks[id].state, 'in_progress');
  fs.writeFileSync(path.join(ws, 'artifact.txt'), 'v2');
  tick(LAPSE);

  const reconcile = (extra) => cmd('task.reconcile', { taskId: id, expected: rev(h, id), fencingToken: token, note: 'finish', ...extra });
  await rejectsClean(h, reconcile({ choice: 'maybe' }), 'invalid-command', 'invalid choice');
  const drift = await rejectsClean(h, reconcile({ choice: 'completed' }), 'evidence-drift', 'hard audit');
  assert.equal(drift.details.stage, 'reconcile');
  await rejectsClean(h, reconcile({ choice: 'completed', evidence: [{ kind: 'file', ref: 'artifact.txt', hash: '0'.repeat(64), acceptanceId }] }), 'missing-evidence', 'bad evidence');
  assert.equal(h.state.tasks[id].state, 'in_progress', 'committed state still pre-expiry');
  assert.ok(h.leases.has(id), 'the lapsed lease waits for a committing command');

  const done = await h.command(reconcile({ choice: 'completed', evidence: [{ kind: 'file', ref: 'artifact.txt', acceptanceId }] }));
  assert.deepEqual(types(done.events).slice(0, 2), ['lease/expired', 'task/interrupted']);
  assert.equal(types(done.events).at(-1), 'task/reconciled');
  assert.equal(h.state.tasks[id].state, 'review');
  await svc.close();
});

// 责任：纯内存命令不得提前移除尚未提交的过期租约。
test('a memory-only command does not drop an uncommitted expiry from the runtime lease table', async (t) => {
  let { svc, h, seedBinding } = await setup(t);
  const id = await makeTask(h, 'Lapsing');
  await h.command(cmd('task.claim', { taskId: id, expected: rev(h, id) }));
  const other = await makeTask(h, 'Live');
  await h.command(cmd('task.claim', { taskId: other, expected: rev(h, other) }, 's2'));
  // s1's binding generation moved: its lease is reclaimable, s2's is live.
  h = seedBinding({ ...h.state.bindings.s1, epoch: h.state.bindings.s1.epoch + 1 });
  const bytes = fs.readFileSync(h.store.commitsFile);
  const res = await h.command(cmd('task.renew', { taskId: other, expected: rev(h, other), fencingToken: h.leases.get(other).token }, 's2'));
  assert.equal(res.committed, false);
  assert.deepEqual(fs.readFileSync(h.store.commitsFile), bytes);
  assert.ok(h.leases.has(id), 'expired lease stays until a commit carries lease/expired');
  assert.equal(h.state.tasks[id].state, 'in_progress');
  await svc.close();
});

// 责任：preflight 须看规范化后的任务投影，但不得留下任何回收副作用。
test('preflight sees the normalized projection and leaves no trace', async (t) => {
  const { svc, h, tick } = await setup(t);
  const { id, token } = await lapsed(h, tick);
  const before = snapshot(h);
  assert.equal(await h._preflight(cmd('task.reconcile', { taskId: id, expected: rev(h, id), fencingToken: token, choice: 'discard', note: 'x' })), true);
  await assert.rejects(h._preflight(cmd('task.reconcile', { taskId: id, expected: rev(h, id), fencingToken: token, choice: 'discard', note: 'x' }, 's2')), { code: 'lease-expired' });
  assert.deepEqual(snapshot(h), before);
  assert.equal(h._lapsed, null);
  await svc.close();
});

// 责任：过期任务 allowedOps 必须只提供实际可执行操作，与回收后的守卫一致。
test('allowedOps for an expired task offer only what works after the expiry', async (t) => {
  const { svc, h, tick } = await setup(t);
  const { id } = await lapsed(h, tick);
  const ops = (sessionId) => Object.fromEntries(h.query('task', { taskId: id, sessionId }).allowedOps.map((op) => [op.op, op]));
  const owner = ops('s1');
  for (const op of ['begin', 'submit', 'release', 'renew', 'block']) {
    assert.equal(owner[op].enabled, false, 'owner ' + op);
    assert.equal(owner[op].reason, 'the lease expired');
  }
  assert.equal(owner.interrupt.enabled, true);
  assert.equal(owner.reconcile.enabled, true);
  assert.equal(owner.claim.enabled, false);
  const foreign = ops('s2');
  assert.equal(foreign.interrupt.enabled, false);
  assert.equal(foreign.reconcile.enabled, false);
  assert.equal(foreign.claim.enabled, false);
  const person = ops(undefined);
  assert.equal(person.interrupt.enabled, true);
  assert.equal(person.reconcile.enabled, true);
  assert.equal(person.release.enabled, false);
  assert.equal(person.update.enabled, true);

  const { id: plain } = await lapsed(h, tick, { open: false });
  const plainOps = Object.fromEntries(h.query('task', { taskId: plain, sessionId: 's2' }).allowedOps.map((op) => [op.op, op]));
  assert.equal(plainOps.claim.enabled, true, 'without an intent the expiry frees it for a claim');
  assert.equal(plainOps.reconcile.enabled, false);
  await svc.close();
});


// 责任：项目配额、会话配额与到期预览在读提示和真正领取中使用同一条规则。
test('claim hint and command agree on WIP and on the slot freed by expiry', async (t) => {
  const { h, tick } = await setup(t);
  await h.command(human('project.update', { policy: { maxInProgress: 1, maxPerSession: 1 } }));
  const occupied = await makeTask(h, 'Occupies a slot');
  const next = await makeTask(h, 'Waiting for a slot');
  await h.command(cmd('task.claim', { taskId: occupied, expected: rev(h, occupied) }));
  const attempt = cmd('task.claim', { taskId: next, expected: rev(h, next) });
  const hint = () => h.query('task', { taskId: next, sessionId: 's1' }).allowedOps.find((op) => op.op === 'claim');

  tick(TTL_MS + 1);
  let error = await rejectsClean(h, attempt, 'illegal-transition', 'renewable lease occupies project WIP');
  assert.match(error.message, /project WIP limit/);
  assert.deepEqual(hint(), { op: 'claim', enabled: false, reason: error.message });
  await h.command(human('project.update', { policy: { maxInProgress: 2 } }));
  error = await rejectsClean(h, attempt, 'illegal-transition', 'renewable lease occupies session WIP');
  assert.match(error.message, /session WIP limit/);
  assert.deepEqual(hint(), { op: 'claim', enabled: false, reason: error.message });
  assert.equal(h.query('task', { taskId: next }).allowedOps.find((op) => op.op === 'claim').enabled, true, 'human is exempt from session WIP');
  await h.command(human('project.update', { policy: { maxInProgress: 1 } }));

  tick(GRACE_MS);
  const before = snapshot(h);
  assert.deepEqual(hint(), { op: 'claim', enabled: true, reason: null });
  assert.deepEqual(snapshot(h), before, 'preview did not apply the lease expiry');
  const stale = { ...attempt, expected: { entityRev: 0 } };
  await rejectsClean(h, stale, 'stale-revision', 'CAS still checks the committed revision');
  const result = await h.command(attempt);
  assert.deepEqual(types(result.events), ['lease/expired', 'task/readied', 'lease/granted', 'task/claimed']);
  assert.equal(h.state.tasks[occupied].state, 'ready');
  assert.equal(h.state.tasks[next].state, 'in_progress');
});

// 责任：解绑后的正确版本也不能领租，显式重新挂接后可以开始工作。
test('detached agent claim is atomic until explicit reattach, then begin works', async (t) => {
  const { h, tick } = await setup(t);
  const id = await makeTask(h, 'No lease for a detached worker');
  const oldEpoch = h.state.bindings.s1.epoch;
  tick(1000);
  await h.detach('s1', 'test-detach');
  assert.ok(h.state.bindings.s1.detachedAt);
  const expected = { projectRev: h.rev, entityRev: h.state.tasks[id].rev };
  tick(1000);
  const hint = (sessionId) => h.query('task', { taskId: id, sessionId }).allowedOps.find(op => op.op === 'claim');
  const before = snapshot(h);
  const error = await rejectsClean(h, cmd('task.claim', { taskId: id, expected }), 'lease-expired', 'detached claim');
  assert.equal(error.status, 409);
  assert.equal(error.details.reason, 'session-detached');
  assert.deepEqual(hint('s1'), { op: 'claim', enabled: false, reason: error.message });
  assert.deepEqual(hint('never-bound'), { op: 'claim', enabled: true, reason: null });
  assert.deepEqual(snapshot(h), before, 'denial and read hints leave log, revisions, token, lastSeenAt and leases unchanged');

  const rebound = await h.attach({ sessionId: 's1', agentId: 's1', source: 'test', role: 'worker' });
  assert.equal(rebound.epoch, oldEpoch + 1);
  assert.equal(hint('s1').enabled, true);
  const grant = await h.command(cmd('task.claim', { taskId: id, expected: { projectRev: h.rev, ...rev(h, id) } }));
  assert.deepEqual(types(grant.events), ['lease/granted', 'task/claimed']);
  const lease = h.leases.get(id);
  assert.equal(lease.epoch, rebound.epoch);
  assert.equal(lease.token, before.state.counters.leaseToken + 1);
  assert.deepEqual(types((await h.command(cmd('task.begin', { taskId: id, expected: rev(h, id), fencingToken: lease.token, summary: 'Start after reattach' }))).events), ['work/intent', 'task/updated']);
});

// 责任：解绑时不能结算意图并授租，未授租的恢复路径仍可用。
test('detached resume cannot close the intent or grant a lease; non-grant recovery still works', async (t) => {
  const { h } = await setup(t);
  const id = await makeTask(h, 'Recover without granting to a detached worker');
  const blocked = await makeTask(h, 'Unblock to pool');
  await h.command(cmd('task.claim', { taskId: id, expected: rev(h, id) }));
  const fencingToken = h.leases.get(id).token;
  await h.command(cmd('task.begin', { taskId: id, expected: rev(h, id), fencingToken, summary: 'Original work' }));
  const intentId = h.state.tasks[id].work.intentId;
  await h.command(cmd('task.interrupt', { taskId: id, expected: rev(h, id), fencingToken, note: 'Work interrupted' }));
  await h.command(cmd('task.claim', { taskId: blocked, expected: rev(h, blocked) }));
  await h.command(cmd('task.block', { taskId: blocked, expected: rev(h, blocked), fencingToken: h.leases.get(blocked).token }));
  await h.detach('s1', 'test-detach');

  const resume = { taskId: id, expected: rev(h, id), choice: 'resume', note: 'Try to redo work' };
  const denied = await rejectsClean(h, cmd('task.reconcile', resume), 'lease-expired', 'detached resume');
  assert.equal(denied.details.reason, 'session-detached');
  assert.equal(h.state.intents[intentId].status, 'open');
  const cleared = await h.command(cmd('task.unblock', { taskId: blocked, expected: rev(h, blocked) }));
  assert.deepEqual(types(cleared.events), ['task/unblocked', 'task/assignment']);
  assert.equal(h.state.tasks[blocked].state, 'ready');
  assert.equal(h.state.tasks[blocked].owner, null);
  const completed = await h.command(cmd('task.reconcile', { ...resume, choice: 'completed', evidence: [
    { kind: 'note', ref: 'Recovered material', acceptanceId: h.state.tasks[id].acceptance[0].id },
  ] }));
  assert.deepEqual(types(completed.events), ['work/result', 'task/reconciled']);
  assert.equal(h.leases.has(id), false);
  const verified = await h.command(human('task.verify', { taskId: id, expected: rev(h, id) }));
  assert.equal(verified.committed, true);
  assert.equal(h.state.tasks[id].state, 'done');

  // A session never represented in bindings is not a detached one.
  const unbound = 'never-bound';
  const claimed = await h.command(cmd('task.claim', { taskId: blocked, expected: rev(h, blocked) }, unbound));
  assert.deepEqual(types(claimed.events), ['lease/granted', 'task/claimed']);
  assert.equal(h.leases.get(blocked).epoch, 0);
});

for (const earlyActivity of [false, true]) {
  // 责任：t0授租、t50活动或仅显式续期、t100再活动，只有未失活的同代令牌可以begin，旧锚点不能被刷新复活。
  test('t0/t50/t100 trusted activity preserves pre-state fencing eligibility; earlyActivity=' + earlyActivity, async t => {
    const { h, tick } = await setup(t);
    await h.command(human('project.update', { policy: { leaseTtlSec: 60, leaseGraceSec: 30 } }));
    const id = await makeTask(h, 'activity fencing');
    await h.command(cmd('task.claim', { taskId: id, expected: rev(h, id) }));
    const token = h.leases.get(id).token;
    const epoch = h.state.bindings.s1.epoch;
    tick(50000);
    if (earlyActivity) h.touch('s1');
    else await h.command(cmd('task.renew', { taskId: id, expected: rev(h, id), fencingToken: token }));
    const at50 = snapshot(h);
    assert.equal(Date.parse(h.leases.get(id).expiresAt), START + 110000);
    assert.equal(h.state.bindings.s1.lastSeenAt, new Date(START + (earlyActivity ? 50000 : 0)).toISOString());
    tick(50000);
    h.touch('s1');
    assert.equal(h.rev, at50.rev, 'activity writes no audit commit');
    assert.equal(h.state.bindings.s1.epoch, epoch);
    assert.deepEqual(fs.readFileSync(h.store.commitsFile), at50.bytes);
    const begin = cmd('task.begin', { taskId: id, expected: rev(h, id), fencingToken: token, summary: 'new side effects' });
    if (earlyActivity) {
      assert.equal(h.state.bindings.s1.lastSeenAt, new Date(START + 100000).toISOString());
      assert.equal(Date.parse(h.leases.get(id).expiresAt), START + 160000);
      const result = await h.command(begin);
      assert.equal(result.committed, true);
      assert.deepEqual(types(result.events), ['work/intent', 'task/updated']);
    } else {
      assert.equal(h._leaseOf(id), null, 'touch revived a reclaimable token');
      assert.equal(h.state.bindings.s1.lastSeenAt, new Date(START).toISOString(), 'lost stale binding anchor');
      assert.equal(Date.parse(h.leases.get(id).expiresAt), START + 110000);
      await rejectsClean(h, begin, 'lease-expired', 'old token begin after activity');
      const swept = h._expireLeases();
      assert.equal(swept.committed, true);
      assert.deepEqual(types(swept.events), ['lease/expired', 'task/readied']);
      assert.equal(swept.events[0].data.token, token);
      assert.equal(h.state.tasks[id].state, 'ready');
      assert.equal(h.leases.has(id), false);
      await h.command(cmd('task.claim', { taskId: id, expected: rev(h, id) }));
      assert.equal(h.leases.get(id).token, token + 1, 'grant duplicated the persistent token counter');
      h.touch('s1');
      assert.ok(h._leaseOf(id), 'a genuinely new grant must accept later activity');
    }
    assert.equal(Object.keys(h.leases.get(id)).some(key => /inactive|expired|reclaim/i.test(key)), false);
  });
}

// 责任：名义过期但仍在宽限内的有效代次仍可接受可信活动，不把到期与不可回收混为一谈。
test('trusted activity inside grace can extend a still-valid generation', async t => {
  const { h, tick } = await setup(t);
  await h.command(human('project.update', { policy: { leaseTtlSec: 60, leaseGraceSec: 30 } }));
  const id = await makeTask(h, 'grace activity');
  await h.command(cmd('task.claim', { taskId: id, expected: rev(h, id) }));
  const token = h.leases.get(id).token, before = h.rev;
  tick(70000);
  h.touch('s1');
  assert.equal(h.rev, before);
  assert.equal(Date.parse(h.leases.get(id).expiresAt), START + 130000);
  assert.equal(h.leases.get(id).renewCount, 0);
  tick(30000);
  assert.equal((await h.command(cmd('task.begin', { taskId: id, expected: rev(h, id), fencingToken: token, summary: 'within grace' }))).committed, true);
});
