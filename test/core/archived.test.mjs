/**
 * 测试职责：约束项目和计划归档时的写屏障、活跃工作保护与恢复时机。
 * 典型流程：临时计划和任务 → 领取/归档/恢复或重挂会话 → 对照状态、租约、事件与日志大小。
 * 覆盖边界：覆盖 归档命令准入、解归档恢复原子性和内存绑定；不覆盖真实宿主重启。
 * 外部前置：无；使用合成项目及显式启用的内嵌文档 fixture。
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
  title: 'Archived plan',
  steps: [{
    id: 's1',
    title: 'one',
    tasks: [
      { key: 't1', title: 'T1', acceptance: [{ text: 'artifact exists' }] },
    ],
  }, {
    id: 's2',
    title: 'two',
    tasks: [
      { key: 't2', title: 'T2', deps: ['t1'], acceptance: [{ text: 'second' }] },
    ],
  }],
};

async function setup({ publish = true } = {}) {
  const stateDir = tmp('pb-arch-state');
  const wsDir = tmp('pb-arch-ws');
  const svc = new ProjectService({ rootDir: stateDir, privilegedInlineWrites: true });
  await svc.init();
  const h = await svc.createProject({ workspacePath: wsDir, name: 'Archived' });
  await h.attach({ sessionId: 's1', agentId: 's1', source: 'test', role: 'worker' });
  await h.command(humanCmd('project.update', { policy: { verification: 'manual' } }));
  if (publish) await h.command(cmd('plan.publish', { title: PLAN.title, steps: PLAN.steps }));
  return { svc, h, wsDir };
}

function taskByTitle(h, title) {
  return Object.values(h.state.tasks).find((task) => task.title === title);
}

function tokenOf(h, taskId) {
  const lease = h.leases.get(taskId);
  assert.ok(lease, 'lease ' + taskId);
  return lease.token;
}

async function claimBegin(h, taskId) {
  let task = h.state.tasks[taskId];
  await h.command(cmd('task.claim', { taskId, expected: { entityRev: task.rev } }));
  task = h.state.tasks[taskId];
  await h.command(cmd('task.begin', { taskId, expected: { entityRev: task.rev }, fencingToken: tokenOf(h, taskId), summary: 'work' }));
  return h.state.tasks[taskId];
}

function logSize(h) {
  return fs.statSync(h.store.commitsFile).size;
}

// 责任：暂停和重复设为 active 不得清除进行中任务的 owner 或租约 token。
test('pausing or re-setting active does not clear leases or look like unarchive', async () => {
  const { svc, h } = await setup();
  const t1 = taskByTitle(h, 'T1');
  await claimBegin(h, t1.id);
  const token = tokenOf(h, t1.id);
  await h.command(humanCmd('project.update', { phase: 'paused' }));
  assert.equal(h.state.project.phase, 'paused');
  assert.equal(h.state.tasks[t1.id].state, 'in_progress');
  assert.equal(h.leases.get(t1.id).token, token, 'pausing must not clear the lease');
  assert.equal(h.state.tasks[t1.id].owner.sessionId, 's1');

  await h.command(humanCmd('project.update', { phase: 'active' }));
  assert.equal(h.state.project.phase, 'active');
  assert.equal(h.leases.get(t1.id).token, token, 're-setting active must not clear the lease');

  await h.command(humanCmd('project.update', { phase: 'active' }));
  assert.equal(h.leases.get(t1.id).token, token, 'repeated active must not clear the lease');
  await svc.close();
});

// 责任：有租约和开放意图时归档须拒绝且日志不动，release 结清后才允许归档。
test('archiving refuses live work and leaves the log untouched', async () => {
  const { svc, h } = await setup();
  const t1 = taskByTitle(h, 'T1');
  await claimBegin(h, t1.id);
  const before = { rev: h.rev, size: logSize(h) };
  const refused = await h.command(humanCmd('project.update', { phase: 'archived' })).then(() => null, (error) => error);
  assert.equal(refused.code, 'project-has-live-work');
  assert.ok(refused.details.inProgress.includes(t1.id));
  assert.ok(refused.details.leases.includes(t1.id));
  assert.ok(refused.details.openIntents.length > 0);
  assert.equal(h.rev, before.rev);
  assert.equal(logSize(h), before.size);
  assert.equal(h.state.project.phase, 'active');

  const task = h.state.tasks[t1.id];
  await h.command(cmd('task.release', {
    taskId: t1.id,
    expected: { entityRev: task.rev },
    fencingToken: tokenOf(h, t1.id),
    intent: { outcome: 'stopped', sideEffects: [] },
  }));
  await h.command(humanCmd('project.update', { phase: 'archived' }));
  assert.equal(h.state.project.phase, 'archived');
  await svc.close();
});

// 责任：归档后多类写命令均在副作用前报 project-archived，恢复 active 后可创建任务。
test('archived rejects writes at the bus before side effects; unarchive restores writes', async () => {
  const { svc, h } = await setup({ publish: false });
  await h.command(humanCmd('project.update', { phase: 'archived' }));
  const before = { rev: h.rev, size: logSize(h) };

  const attempts = [
    humanCmd('task.create', { title: 'Nope', acceptance: [{ text: 'x' }] }),
    humanCmd('task.update', { taskId: 'tsk_missing', title: 'Nope' }),
    humanCmd('doc.put', { title: 'Nope', kind: 'note', body: 'x' }),
    humanCmd('plan.publish', { title: 'Nope', steps: [{ id: 's1', title: 's', tasks: [] }] }),
    humanCmd('project.relocate', { workspacePath: h.workspacePath }),
    humanCmd('project.update', { name: 'Renamed' }),
  ];
  for (const command of attempts) {
    const error = await h.command(command).then(() => null, (err) => err);
    assert.equal(error.code, 'project-archived', command.op);
    assert.equal(h.rev, before.rev, command.op + ' moved rev');
    assert.equal(logSize(h), before.size, command.op + ' wrote the log');
  }

  await h.command(humanCmd('project.update', { phase: 'active' }));
  assert.equal(h.state.project.phase, 'active');
  const created = await h.command(humanCmd('task.create', { title: 'After unarchive', acceptance: [{ text: 'x' }] }));
  assert.equal(created.ok, true);
  await svc.close();
});

// 责任：旧归档数据不在 recover 时写日志，解归档须同次提交中断任务并保留待对账意图。
test('opening an archived project does not recover; unarchive carries recovery in the same commit', async () => {
  const { svc, h } = await setup();
  const t1 = taskByTitle(h, 'T1');
  await claimBegin(h, t1.id);
  const beforeRev = h.rev;
  // Simulate legacy archived data: phase archived while a task is still in_progress
  // with an open intent (old project.update did not check live work).
  h.state.project = { ...h.state.project, phase: 'archived' };
  h.recover();
  assert.equal(h.rev, beforeRev, 'recover on archived must not append');
  assert.equal(h.state.tasks[t1.id].state, 'in_progress');

  const result = await h.command(humanCmd('project.update', { phase: 'active' }));
  assert.equal(h.state.project.phase, 'active');
  assert.equal(h.state.tasks[t1.id].state, 'interrupted');
  assert.equal(h.leases.size, 0, 'unarchive clears stale in-memory leases');
  assert.equal(h.recovered, true);
  assert.deepEqual(result.events.map((event) => event.type), ['project/updated', 'task/interrupted']);
  const open = Object.values(h.state.intents).find((intent) => intent.taskId === t1.id && intent.status === 'open');
  assert.ok(open, 'recovery keeps the intent open for reconcile');
  await h.command(cmd('task.reconcile', {
    taskId: t1.id,
    expected: { entityRev: h.state.tasks[t1.id].rev },
    choice: 'discard',
    note: 'legacy work discarded',
  }));
  assert.equal(h.state.tasks[t1.id].state, 'ready');
  await svc.close();
});

// 责任：归档项目 attach/detach 只更新内存绑定，项目版本不得增长。
test('archived attach/detach keep bindings in memory without committing', async () => {
  const { svc, h } = await setup({ publish: false });
  await h.command(humanCmd('project.update', { phase: 'archived' }));
  const rev = h.rev;
  await h.attach({ sessionId: 's2', agentId: 's2', source: 'resume', role: 'worker' });
  assert.equal(h.rev, rev);
  assert.equal(h.state.bindings.s2.sessionId, 's2');
  await h.detach('s2', 'test');
  assert.equal(h.rev, rev);
  assert.ok(h.state.bindings.s2.detachedAt);
  await svc.close();
});

// 责任：归档计划中的 resume、强制进入进行中和 unblock 均须报 plan-archived。
test('archived plan rejects paths that would enter in_progress', async () => {
  const { svc, h } = await setup();
  const t1 = taskByTitle(h, 'T1');
  await claimBegin(h, t1.id);
  await h.command(cmd('task.interrupt', {
    taskId: t1.id,
    expected: { entityRev: h.state.tasks[t1.id].rev },
    fencingToken: tokenOf(h, t1.id),
    note: 'unknown',
  }));
  const planId = h.state.project.focusPlanId;
  await h.command(humanCmd('plan.archive', { planId, expected: { entityRev: h.state.planHeads[planId].rev } }));
  assert.equal(h.state.planHeads[planId].status, 'archived');

  const resume = await h.command(cmd('task.reconcile', {
    taskId: t1.id,
    expected: { entityRev: h.state.tasks[t1.id].rev },
    choice: 'resume',
    note: 'retry',
  })).then(() => null, (error) => error);
  assert.equal(resume.code, 'plan-archived');

  const override = await h.command(humanCmd('override', {
    taskId: t1.id,
    expected: { entityRev: h.state.tasks[t1.id].rev },
    toState: 'in_progress',
    reason: 'force',
    intent: { outcome: 'stopped', sideEffects: [] },
  })).then(() => null, (error) => error);
  assert.equal(override.code, 'plan-archived');

  // A blocked task in an archived plan cannot be unblocked into a new lease.
  const created = await h.command(humanCmd('task.create', { title: 'Blocked', acceptance: [{ text: 'x' }] }));
  const id = created.events.find((event) => event.type === 'task/created').taskId;
  await claimBegin(h, id);
  await h.command(cmd('task.block', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    fencingToken: tokenOf(h, id),
    code: 'wait',
    note: 'hold',
    intent: { outcome: 'stopped', sideEffects: [] },
  }));
  // Re-file the task into a fresh plan and archive it (blocked is not live work).
  const plan2 = await h.command(humanCmd('plan.publish', {
    title: 'Archived plan 2',
    steps: [{ id: 's1', title: 'one', tasks: [] }],
  }));
  const plan2Id = plan2.events.find((event) => event.type === 'plan/published').data.id;
  await h.command(humanCmd('plan.adopt', {
    planId: plan2Id,
    baseVersion: 1,
    expected: { entityRev: h.state.planHeads[plan2Id].rev },
    stepId: 's1',
    taskIds: [id],
  }));
  await h.command(humanCmd('plan.archive', { planId: plan2Id, expected: { entityRev: h.state.planHeads[plan2Id].rev } }));
  const unblock = await h.command(cmd('task.unblock', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    note: 'go',
  })).then(() => null, (error) => error);
  assert.equal(unblock.code, 'plan-archived');
  await svc.close();
});
