/**
 * 测试职责：封住终态编辑、依赖成环、过期版本与跨项目任务修订的非法转移。
 * 典型流程：临时任务/计划 → 发非法 update/claim/revise → 比较错误、旧字段与事件尾部。
 * 覆盖边界：覆盖 状态机拒绝的原子性；不覆盖完整 happy path 或真实并发。
 * 外部前置：无；临时服务 fixture。
 */
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

async function makeTask(handle, title = 'T') {
  const res = await handle.command(cmd('task.create', { title, acceptance: [{ text: 'ok' }] }));
  return res.events.find((event) => event.type === 'task/created').taskId;
}

// 责任：取消任务后再改标题须 illegal-transition，原标题不得被静默重写。
test('task.update refuses a terminal task', async () => {
  const { svc, handle } = await fresh('pb-sm-a');
  const id = await makeTask(handle, 'Broken');
  await handle.command(human('task.cancel', { taskId: id, expected: { entityRev: handle.state.tasks[id].rev }, reason: 'no longer needed' }));
  const error = await handle.command(human('task.update', {
    taskId: id,
    expected: { entityRev: handle.state.tasks[id].rev },
    title: 'Silently rewritten',
  })).then(() => null, (err) => err);
  assert.equal(error?.code, 'illegal-transition');
  assert.equal(handle.state.tasks[id].title, 'Broken');
  await svc.close();
});

// 责任：把 A→B 再设 B→A 须拒绝依赖环，B 的 deps 仍为空。
test('task.update refuses a dependency cycle', async () => {
  const { svc, handle } = await fresh('pb-sm-b');
  const a = await makeTask(handle, 'A');
  const b = await makeTask(handle, 'B');
  await handle.command(human('task.update', { taskId: a, expected: { entityRev: handle.state.tasks[a].rev }, deps: [b] }));
  const error = await handle.command(human('task.update', {
    taskId: b,
    expected: { entityRev: handle.state.tasks[b].rev },
    deps: [a],
  })).then(() => null, (err) => err);
  assert.equal(error?.code, 'invalid-command');
  assert.match(error.message, /cycle/);
  assert.deepEqual(handle.state.tasks[b].deps, [], 'the rejected update did not stick');
  await svc.close();
});

// 责任：项目版本过期的命令须 stale-revision，不能顺带泄漏 lease/expired 事件。
test('a stale projectRev command appends no lease/expired events', async () => {
  const { svc, handle } = await fresh('pb-sm-c');
  const id = await makeTask(handle, 'Leased');
  await handle.command(cmd('task.claim', { taskId: id, expected: { entityRev: handle.state.tasks[id].rev } }));
  const lease = handle.leases.get(id);
  lease.expiresAt = new Date(Date.now() - 60_000).toISOString();
  const before = handle.state.lastSeq;
  const error = await handle.command(cmd('task.claim', {
    taskId: id,
    expected: { entityRev: handle.state.tasks[id].rev, projectRev: before - 5 },
  })).then(() => null, (err) => err);
  assert.equal(error?.code, 'stale-revision');
  assert.equal(handle.state.lastSeq, before, 'the rejected command wrote nothing');
  const tail = handle.state.events ?? [];
  assert.ok(!(tail.some((event) => event.type === 'lease/expired')), 'no expiry event leaked');
  await svc.close();
});

// 责任：计划 revise 引用本项目不存在 taskId 必须拒绝，不能创建外来任务。
test('plan.revise refuses a taskId that is not in this project', async () => {
  const { svc, handle } = await fresh('pb-sm-d');
  const published = await handle.command(cmd('plan.publish', {
    title: 'P1',
    goal: 'g',
    steps: [{ id: 's1', title: 'S', tasks: [{ key: 'a', title: 'A', acceptance: [{ text: 'x' }] }] }],
  }));
  const planId = published.events.find((event) => event.type === 'plan/published').data.id;
  const head = handle.state.planHeads[planId];
  const error = await handle.command(cmd('plan.revise', {
    planId,
    baseVersion: head.currentVersion,
    steps: [{ id: 's1', title: 'S', tasks: [{ key: 'a', taskId: 'tsk_from_another_project', title: 'A', acceptance: [{ text: 'x' }] }] }],
  })).then(() => null, (err) => err);
  assert.equal(error?.code, 'invalid-command');
  assert.match(error.message, /not in this project/);
  assert.equal(handle.state.tasks['tsk_from_another_project'], undefined, 'no phantom task was created');
  await svc.close();
});
