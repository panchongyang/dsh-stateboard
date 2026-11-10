/**
 * 测试职责：约束开放工作意图退出时必须显式结清，未知结果只能中断后对账。
 * 典型流程：临时计划任务 → claim/begin 后 block/release/cancel/interrupt → 比较意图、尝试、租约和日志。
 * 覆盖边界：覆盖 stopped settlement、恢复目标与 fencing；不覆盖真实工作副作用是否已停止。
 * 外部前置：无；副作用列表只是合成观测记录。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectService } from '../../lib/core/service.js';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
}

function cmd(op, extra = {}) {
  return { cmdId: 'cmd_' + crypto.randomUUID(), actor: { kind: 'agent', sessionId: 's1' }, op, ...extra };
}

function humanCmd(op, extra = {}) {
  return { cmdId: 'cmd_' + crypto.randomUUID(), actor: { kind: 'human', via: 'test' }, op, ...extra };
}

const PLAN = {
  title: 'Intent plan',
  steps: [{ id: 's1', title: 'one', tasks: [{ key: 't1', title: 'T1', acceptance: [{ text: 'artifact exists' }] }] }],
};

async function setup() {
  const stateDir = tmp('pb-intent-state');
  const wsDir = tmp('pb-intent-ws');
  const svc = new ProjectService({ rootDir: stateDir });
  await svc.init();
  const h = await svc.createProject({ workspacePath: wsDir, name: 'Intent' });
  await h.attach({ sessionId: 's1', agentId: 's1', source: 'test', role: 'worker' });
  // Keep submissions in review: this file exercises block/interrupt, not auto-verify.
  await h.command(humanCmd('project.update', { policy: { verification: 'manual' } }));
  const published = await h.command(cmd('plan.publish', { title: PLAN.title, steps: PLAN.steps }));
  const taskId = published.events.find((event) => event.type === 'task/created').taskId;
  return { svc, h, wsDir, taskId };
}

function taskOf(h, taskId) {
  return h.state.tasks[taskId];
}

function tokenOf(h, taskId) {
  const lease = h.leases.get(taskId);
  assert.ok(lease, 'live lease for ' + taskId);
  return lease.token;
}

async function claimAndBegin(h, taskId) {
  let task = taskOf(h, taskId);
  await h.command(cmd('task.claim', { taskId, expected: { entityRev: task.rev } }));
  task = taskOf(h, taskId);
  await h.command(cmd('task.begin', {
    taskId,
    expected: { entityRev: task.rev },
    fencingToken: tokenOf(h, taskId),
    summary: 'do the thing',
  }));
  return taskOf(h, taskId);
}

async function reachReview(h, wsDir, taskId) {
  let task = await claimAndBegin(h, taskId);
  const token = tokenOf(h, taskId);
  fs.writeFileSync(path.join(wsDir, 'artifact.txt'), 'ok');
  await h.command(cmd('task.submit', {
    taskId,
    expected: { entityRev: task.rev },
    fencingToken: token,
    evidence: [{ kind: 'file', ref: 'artifact.txt', acceptanceId: task.acceptance[0].id }],
  }));
  return taskOf(h, taskId);
}

function logSnapshot(h) {
  return {
    size: fs.statSync(h.store.commitsFile).size,
    rev: h.rev,
    leases: [...h.leases.keys()].sort(),
  };
}

// 责任：开放意图 block 缺 stopped 结清须拒绝，不能悄悄关闭意图或释放租约。
test('block refuses to close an open intent without a stopped settlement', async () => {
  const { svc, h, taskId } = await setup();
  const task = await claimAndBegin(h, taskId);
  const token = tokenOf(h, taskId);
  const before = logSnapshot(h);

  const missing = await h.command(cmd('task.block', {
    taskId, expected: { entityRev: task.rev }, fencingToken: token, code: 'external', note: 'stop',
  })).then(() => null, (error) => error);
  assert.equal(missing.code, 'intent-unresolved');
  assert.equal(missing.status, 409);
  assert.equal(taskOf(h, taskId).state, 'in_progress');
  assert.deepEqual(logSnapshot(h), before);

  const unknown = await h.command(cmd('task.block', {
    taskId, expected: { entityRev: task.rev }, fencingToken: token, code: 'external', note: 'stop',
    intent: { outcome: 'unknown', sideEffects: [] },
  })).then(() => null, (error) => error);
  assert.equal(unknown.code, 'intent-unresolved');
  assert.equal(unknown.details.outcome, 'unknown');

  const noEffects = await h.command(cmd('task.block', {
    taskId, expected: { entityRev: task.rev }, fencingToken: token, code: 'external', note: 'stop',
    intent: { outcome: 'stopped' },
  })).then(() => null, (error) => error);
  assert.equal(noEffects.code, 'invalid-command');

  const blocked = await h.command(cmd('task.block', {
    taskId, expected: { entityRev: task.rev }, fencingToken: token, code: 'external', note: 'stop',
    intent: { outcome: 'stopped', sideEffects: [{ kind: 'file', ref: 'artifact.txt', note: 'written' }] },
  }));
  assert.equal(blocked.ok, true);
  assert.equal(taskOf(h, taskId).state, 'blocked');
  assert.equal(h.state.intents && Object.values(h.state.intents).some((intent) => intent.status === 'open' && intent.taskId === taskId), false);
  const abandoned = blocked.events.find((event) => event.type === 'work/abandoned');
  assert.ok(abandoned);
  assert.equal(abandoned.data.closeReason, 'blocked');
  assert.equal(abandoned.data.outcome, 'stopped');
  assert.equal(abandoned.data.sideEffects.length, 1);
  assert.equal(abandoned.data.closedBy.kind, 'agent');
  await svc.close();
});

// 责任：unblock 须恢复进行中但不复活旧意图，下一次 begin 必须开启 attempt+1。
test('unblock returns to in_progress without reviving the old intent; begin starts attempt+1', async () => {
  const { svc, h, taskId } = await setup();
  const task = await claimAndBegin(h, taskId);
  const token = tokenOf(h, taskId);
  await h.command(cmd('task.block', {
    taskId, expected: { entityRev: task.rev }, fencingToken: token, code: 'wait', note: 'waiting',
    intent: { outcome: 'stopped', sideEffects: [] },
  }));
  const blockedRev = taskOf(h, taskId).rev;
  await h.command(cmd('task.unblock', { taskId, expected: { entityRev: blockedRev }, note: 'go' }));
  assert.equal(taskOf(h, taskId).state, 'in_progress');
  assert.equal(Object.values(h.state.intents).filter((intent) => intent.taskId === taskId && intent.status === 'open').length, 0);
  const token2 = tokenOf(h, taskId);
  await h.command(cmd('task.begin', {
    taskId, expected: { entityRev: taskOf(h, taskId).rev }, fencingToken: token2, summary: 'retry',
  }));
  const open = Object.values(h.state.intents).find((intent) => intent.taskId === taskId && intent.status === 'open');
  assert.ok(open);
  assert.equal(open.attempt, 2);
  await svc.close();
});

// 责任：interrupt 须转 interrupted 并保留开放意图，供后续 reconcile 明确处理。
test('interrupt parks an in_progress task as interrupted and keeps the intent open', async () => {
  const { svc, h, taskId } = await setup();
  const task = await claimAndBegin(h, taskId);
  const token = tokenOf(h, taskId);
  const result = await h.command(cmd('task.interrupt', {
    taskId, expected: { entityRev: task.rev }, fencingToken: token, note: 'side effects unknown',
    sideEffects: [{ kind: 'command', ref: 'npm test', note: 'exit 1' }],
  }));
  assert.equal(taskOf(h, taskId).state, 'interrupted');
  assert.equal(h.leases.has(taskId), false);
  const open = Object.values(h.state.intents).find((intent) => intent.taskId === taskId && intent.status === 'open');
  assert.ok(open, 'interrupt must preserve the open intent');
  assert.equal(taskOf(h, taskId).interrupt.previousState, 'in_progress');
  assert.equal(taskOf(h, taskId).interrupt.sideEffects[0].ref, 'npm test');
  assert.deepEqual(result.events.map((event) => event.type), ['lease/revoked', 'task/interrupted']);

  const reconciled = await h.command(cmd('task.reconcile', { taskId, expected: { entityRev: taskOf(h, taskId).rev }, choice: 'resume', note: 'retry safely' }));
  assert.equal(taskOf(h, taskId).state, 'in_progress');
  assert.equal(taskOf(h, taskId).interrupt, null);
  const abandoned = reconciled.events.find((event) => event.type === 'work/abandoned');
  assert.equal(abandoned.data.resolution, 'redo');
  const open2 = Object.values(h.state.intents).find((intent) => intent.taskId === taskId && intent.status === 'open');
  assert.equal(open2.attempt, 2);
  await svc.close();
});

// 责任：interrupt 缺 token 或旧 token 时须拒绝，日志、状态及租约不得变化。
test('interrupt rejects missing or stale fencing tokens without touching state', async () => {
  const { svc, h, taskId } = await setup();
  const task = await claimAndBegin(h, taskId);
  const before = logSnapshot(h);
  const missing = await h.command(cmd('task.interrupt', { taskId, expected: { entityRev: task.rev }, note: 'unknown' })).then(() => null, (error) => error);
  assert.equal(missing.code, 'fencing-stale');
  const stale = await h.command(cmd('task.interrupt', {
    taskId, expected: { entityRev: task.rev }, fencingToken: tokenOf(h, taskId) + 999, note: 'unknown',
  })).then(() => null, (error) => error);
  assert.equal(stale.code, 'fencing-stale');
  assert.deepEqual(logSnapshot(h), before);
  await svc.close();
});

// 责任：旧 blocked 加开放意图不能直接 unblock，人工 interrupt 后才可修复流程。
test('legacy blocked + open intent is refused by unblock and repairable by a human interrupt', async () => {
  const { svc, h, taskId } = await setup();
  const task = await claimAndBegin(h, taskId);
  // Simulate an old log produced before RFC-3: state=blocked, intent still open.
  h.state.tasks[taskId] = {
    ...taskOf(h, taskId),
    state: 'blocked',
    owner: null,
    blocker: { code: 'legacy', note: 'old block', since: new Date().toISOString(), resumeTo: 'in_progress' },
  };
  const blocked = taskOf(h, taskId);
  const refused = await h.command(cmd('task.unblock', { taskId, expected: { entityRev: blocked.rev }, note: 'go' })).then(() => null, (error) => error);
  assert.equal(refused.code, 'intent-unresolved');

  await h.command(humanCmd('task.interrupt', { taskId, expected: { entityRev: blocked.rev }, note: 'legacy repair' }));
  assert.equal(taskOf(h, taskId).state, 'interrupted');
  assert.equal(taskOf(h, taskId).interrupt.previousState, 'blocked');
  assert.equal(taskOf(h, taskId).interrupt.previousBlocker.code, 'legacy');
  assert.equal(Object.values(h.state.intents).some((intent) => intent.taskId === taskId && intent.status === 'open'), true);
  await svc.close();
});

// 责任：release/cancel/override 同样必须满足 stopped 结清要求，不能绕过 block 屏障。
test('release/cancel/override use the same settlement rule', async () => {
  const { svc, h, taskId } = await setup();
  let task = await claimAndBegin(h, taskId);
  const token = tokenOf(h, taskId);
  const releaseRefused = await h.command(cmd('task.release', { taskId, expected: { entityRev: task.rev }, fencingToken: token })).then(() => null, (error) => error);
  assert.equal(releaseRefused.code, 'intent-unresolved');
  await h.command(cmd('task.release', {
    taskId, expected: { entityRev: task.rev }, fencingToken: token,
    intent: { outcome: 'stopped', sideEffects: [] },
  }));
  assert.equal(taskOf(h, taskId).state, 'ready');
  assert.equal(Object.values(h.state.intents).some((intent) => intent.taskId === taskId && intent.status === 'open'), false);

  task = await claimAndBegin(h, taskId);
  const token2 = tokenOf(h, taskId);
  const cancelRefused = await h.command(cmd('task.cancel', { taskId, expected: { entityRev: task.rev }, fencingToken: token2, reason: 'stop' })).then(() => null, (error) => error);
  assert.equal(cancelRefused.code, 'intent-unresolved');
  await h.command(cmd('task.cancel', {
    taskId, expected: { entityRev: task.rev }, fencingToken: token2, reason: 'stop',
    intent: { outcome: 'stopped', sideEffects: [] },
  }));
  assert.equal(taskOf(h, taskId).state, 'canceled');

  const created = await h.command(cmd('task.create', { title: 'Override me', acceptance: [{ text: 'x' }] }));
  const id2 = created.events.find((event) => event.type === 'task/created').taskId;
  task = await claimAndBegin(h, id2);
  const overrideRefused = await h.command(humanCmd('override', {
    taskId: id2, expected: { entityRev: task.rev }, toState: 'blocked', reason: 'stop',
  })).then(() => null, (error) => error);
  assert.equal(overrideRefused.code, 'intent-unresolved');
  await h.command(humanCmd('override', {
    taskId: id2, expected: { entityRev: task.rev }, toState: 'blocked', reason: 'stop',
    intent: { outcome: 'stopped', sideEffects: [{ kind: 'network', ref: 'POST /x' }] },
  }));
  assert.equal(taskOf(h, id2).state, 'blocked');
  assert.equal(Object.values(h.state.intents).some((intent) => intent.taskId === id2 && intent.status === 'open'), false);
  assert.equal(h.leases.has(id2), false);
  await svc.close();
});

// 责任：从 review 阻塞须记录 resumeTo=review，unblock 后回 review 而非进行中。
test('block from review keeps resumeTo=review and unblock returns to review', async () => {
  const { svc, h, wsDir, taskId } = await setup();
  const review = await reachReview(h, wsDir, taskId);
  assert.equal(review.state, 'review');
  await h.command(humanCmd('task.block', { taskId, expected: { entityRev: review.rev }, code: 'review-stop', note: 'hold' }));
  assert.equal(taskOf(h, taskId).state, 'blocked');
  assert.equal(taskOf(h, taskId).blocker.resumeTo, 'review');
  assert.equal(Object.values(h.state.intents).some((intent) => intent.taskId === taskId && intent.status === 'open'), false);
  await h.command(humanCmd('task.unblock', { taskId, expected: { entityRev: taskOf(h, taskId).rev }, note: 'resume' }));
  assert.equal(taskOf(h, taskId).state, 'review');
  await svc.close();
});

// 责任：同会话 release 再领取会获得新 token，旧 block/cancel token 必须失效。
test('same-session re-claim after release makes the old block/cancel token stale', async () => {
  const { svc, h, taskId } = await setup();
  let task = await claimAndBegin(h, taskId);
  const oldToken = tokenOf(h, taskId);
  await h.command(cmd('task.release', {
    taskId, expected: { entityRev: task.rev }, fencingToken: oldToken,
    intent: { outcome: 'stopped', sideEffects: [] },
  }));
  task = taskOf(h, taskId);
  await h.command(cmd('task.claim', { taskId, expected: { entityRev: task.rev } }));
  task = taskOf(h, taskId);
  const newToken = tokenOf(h, taskId);
  assert.notEqual(newToken, oldToken);
  const before = logSnapshot(h);
  const staleBlock = await h.command(cmd('task.block', {
    taskId, expected: { entityRev: task.rev }, fencingToken: oldToken, code: 'x', note: 'stale',
  })).then(() => null, (error) => error);
  assert.equal(staleBlock.code, 'fencing-stale');
  const staleCancel = await h.command(cmd('task.cancel', {
    taskId, expected: { entityRev: task.rev }, fencingToken: oldToken, reason: 'stale',
  })).then(() => null, (error) => error);
  assert.equal(staleCancel.code, 'fencing-stale');
  assert.deepEqual(logSnapshot(h), before);

  // reject normally runs on review with no lease; inject a live lease to exercise
  // the defensive token branch without hiding the real transition.
  task = taskOf(h, taskId);
  await h.command(cmd('task.begin', { taskId, expected: { entityRev: task.rev }, fencingToken: newToken, summary: 'review me' }));
  fs.writeFileSync(path.join(h.workspacePath, 'artifact.txt'), 'ok');
  task = taskOf(h, taskId);
  await h.command(cmd('task.submit', {
    taskId, expected: { entityRev: task.rev }, fencingToken: newToken,
    evidence: [{ kind: 'file', ref: 'artifact.txt', acceptanceId: task.acceptance[0].id }],
  }));
  task = taskOf(h, taskId);
  h.leases.set(taskId, {
    taskId,
    sessionId: 's1',
    agentId: 's1',
    epoch: 0,
    token: newToken + 100,
    acquiredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });
  const staleReject = await h.command(cmd('task.reject', {
    taskId, expected: { entityRev: task.rev }, fencingToken: oldToken, reason: 'stale reject',
  })).then(() => null, (error) => error);
  assert.equal(staleReject.code, 'fencing-stale');
  assert.equal(taskOf(h, taskId).state, 'review');
  await svc.close();
});
