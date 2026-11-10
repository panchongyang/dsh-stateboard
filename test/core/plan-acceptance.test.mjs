/**
 * 测试职责：守住计划物化任务必须有验收点，既有任务修订不得无意丢失验收要求。
 * 典型流程：临时服务 → 发布缺失/空/有效验收点的计划或修订任务 → 对照错误与验收数组。
 * 覆盖边界：覆盖 发布验收必填、修订继承与空更新保留；不覆盖验收证据质量或审计独立性。
 * 外部前置：无；仅临时项目。
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

async function fresh(prefix) {
  const svc = new ProjectService({ rootDir: tmp(prefix) });
  await svc.init();
  const handle = await svc.createProject({ workspacePath: tmp(prefix + '-ws'), name: 'P' });
  return { svc, handle };
}

function publish(steps) {
  return cmd('plan.publish', { title: 'Plan', goal: 'g', steps });
}

// 责任：发布任务缺 acceptance 须 invalid-command，任务集合仍为空。
test('plan.publish rejects a task without acceptance', async () => {
  const { svc, handle } = await fresh('pb-acc-a');
  await assert.rejects(
    () => handle.command(publish([{ id: 's1', title: 'S', tasks: [{ key: 'a', title: 'A' }] }])),
    (error) => error.code === 'invalid-command' && /acceptance/.test(error.message),
  );
  assert.equal(Object.keys(handle.state.tasks).length, 0, 'nothing was created');
  await svc.close();
});

// 责任：发布 acceptance=[] 同样必须拒绝，不能视为空验收已满足。
test('an empty acceptance array is rejected as well', async () => {
  const { svc, handle } = await fresh('pb-acc-b');
  await assert.rejects(
    () => handle.command(publish([{ id: 's1', title: 'S', tasks: [{ key: 'a', title: 'A', acceptance: [] }] }])),
    (error) => error.code === 'invalid-command',
  );
  await svc.close();
});

// 责任：发布有一条有效验收点的任务须成功，物化任务 ready 且保留该验收点。
test('a valid plan still publishes and its tasks carry acceptance', async () => {
  const { svc, handle } = await fresh('pb-acc-c');
  const result = await handle.command(publish([{ id: 's1', title: 'S', tasks: [{ key: 'a', title: 'A', acceptance: [{ text: 'done' }] }] }]));
  const task = Object.values(handle.state.tasks)[0];
  assert.equal(task.acceptance.length, 1);
  assert.equal(task.state, 'ready');
  assert.ok(result);
  await svc.close();
});

// 责任：修订已有任务省略 acceptance 时须继承原验收文本，不能清空。
test('active revise may omit acceptance for a task it already owns', async () => {
  const { svc, handle } = await fresh('pb-acc-d');
  await handle.command(publish([{ id: 's1', title: 'S', tasks: [{ key: 'a', title: 'A', acceptance: [{ text: 'first' }] }] }]));
  const task = Object.values(handle.state.tasks)[0];
  const head = Object.values(handle.state.plans).find((plan) => plan.status === 'published');
  await handle.command(cmd('plan.revise', {
    planId: head.id,
    baseVersion: head.version,
    steps: [{ id: 's1', title: 'S', tasks: [{ key: 'a', taskId: task.id, title: 'A renamed' }] }],
  }));
  const after = handle.state.tasks[task.id];
  assert.equal(after.title, 'A renamed');
  assert.equal(after.acceptance.length, 1, 'acceptance is inherited from the existing task');
  assert.equal(after.acceptance[0].text, 'first');
  await svc.close();
});
// 责任：持租约 update 传空验收数组后须仍保留原验收点。
test('task.update cannot strip acceptance with an empty list', async () => {
  const { svc, handle } = await fresh('pb-acc-e');
  const created = await handle.command(cmd('task.create', { title: 'Keep me', acceptance: [{ text: 'keep' }] }));
  const taskId = created.events.find((event) => event.type === 'task/created').taskId;
  await handle.command(cmd('task.claim', { taskId, expected: { entityRev: 1 } }));
  await handle.command(cmd('task.update', {
    taskId,
    expected: { entityRev: handle.state.tasks[taskId].rev },
    fencingToken: handle.leases.get(taskId).token,
    acceptance: [],
  }));
  const after = handle.state.tasks[taskId];
  assert.equal(after.acceptance.length, 1);
  assert.equal(after.acceptance[0].text, 'keep');
  await svc.close();
});
