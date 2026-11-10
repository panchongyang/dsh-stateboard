/**
 * 测试职责：约束租约身份、证据边界、轻编辑权限和创建者来源。
 * 典型流程：构造合成临时项目或状态 → 执行领域操作 → 比较原始断言与副作用。
 * 覆盖边界：覆盖 fencing、租约到期、文件边界和元数据编辑；不覆盖 计划版本或性能套件。
 * 外部前置：需要可写临时目录；证据链接用例需要平台 junction 权限。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ProjectService } from '../../lib/core/service.js';

import test from 'node:test';
import { tmp, cmd, setup, publish, taskByTitle, tokenOf, openSubmittable } from '../helpers/core-lifecycle-fixture.mjs';


// 责任：使用失效 fencingToken begin 必须拒绝，旧执行者不能重新开始工作。
test('a stale fencing token cannot begin the task', async () => {
  const { h, svc } = await openSubmittable();
  const task = taskByTitle(h, 'T1');
  await h.command(cmd('task.claim', { taskId: task.id, expected: { entityRev: task.rev } }));
  const current = h.state.tasks[task.id];
  const error = await h.command(cmd('task.begin', {
    taskId: task.id,
    expected: { entityRev: current.rev },
    fencingToken: tokenOf(h, task.id) + 1,
    summary: 'stale writer',
  })).then(() => null, (err) => err);
  assert.equal(error?.code, 'fencing-stale');
  assert.equal(h.state.tasks[task.id].state, 'in_progress');
  assert.equal(h.state.tasks[task.id].work, null);
  await svc.close();
});

// 责任：另一个会话即使拿到 owner token 也不得 begin，身份守卫不能只看数字 token。
test('a different session cannot use the owner token', async () => {
  const { h, svc } = await openSubmittable();
  const task = taskByTitle(h, 'T1');
  await h.command(cmd('task.claim', { taskId: task.id, expected: { entityRev: task.rev } }));
  const current = h.state.tasks[task.id];
  const error = await h.command({
    ...cmd('task.begin', {
      taskId: task.id,
      expected: { entityRev: current.rev },
      fencingToken: tokenOf(h, task.id),
      summary: 'thief',
    }),
    actor: { kind: 'agent', sessionId: 's2' },
  }).then(() => null, (err) => err);
  assert.equal(error?.code, 'lease-held');
  assert.equal(h.state.tasks[task.id].work, null);
  await svc.close();
});

// 责任：工作区外文件证据须在哈希读取前拒绝，禁止越界取证。
test('evidence outside the workspace is rejected before it is hashed', async () => {
  const { h, svc } = await openSubmittable();
  const task = taskByTitle(h, 'T1');
  await h.command(cmd('task.claim', { taskId: task.id, expected: { entityRev: task.rev } }));
  const current = h.state.tasks[task.id];
  await h.command(cmd('task.begin', {
    taskId: task.id,
    expected: { entityRev: current.rev },
    fencingToken: tokenOf(h, task.id),
    summary: 'try to escape',
  }));
  const begun = h.state.tasks[task.id];
  const error = await h.command(cmd('task.submit', {
    taskId: task.id,
    expected: { entityRev: begun.rev },
    fencingToken: tokenOf(h, task.id),
    evidence: [{ kind: 'file', ref: '../outside.txt', summary: 'escape' }],
  })).then(() => null, (err) => err);
  assert.equal(error?.code, 'invalid-command');
  assert.match(error.message, /escapes the workspace/);
  assert.equal(h.state.tasks[task.id].state, 'in_progress');
  await svc.close();
});

// 责任：死会话遗留租约到期后须释放任务，不能永久占用 ready 工作。
test('a lease left behind by a dead session expires and releases the task', async () => {
  let now = Date.parse('2026-10-23T00:00:00.000Z');
  const stateDir = tmp('pb-expire-state');
  const svc = new ProjectService({ rootDir: stateDir, clock: () => new Date(now), privilegedInlineWrites: true });
  await svc.init();
  const h = await svc.createProject({ workspacePath: tmp('pb-expire-ws'), name: 'Expire' });
  await publish(h);
  const task = taskByTitle(h, 'T1');
  const other = taskByTitle(h, 'T2');
  await h.command(cmd('task.claim', { taskId: task.id, expected: { entityRev: task.rev } }));
  now += 1801 * 1000;
  await h.command(cmd('task.create', { title: 'Trigger a commit', acceptance: [{ text: 'x' }] }));
  assert.equal(h.state.tasks[task.id].state, 'ready');
  assert.equal(h.state.tasks[task.id].owner, null);
  await svc.close();
});

// 责任：证据路径经 junction 逃出根目录时必须拒绝，链接不能绕开工作区边界。
test('evidence cannot escape the workspace through a junction', async () => {
  const { h, wsDir, svc } = await openSubmittable();
  const outside = tmp('pb-outside');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'not yours');
  fs.symlinkSync(outside, path.join(wsDir, 'link'), 'junction');
  const task = taskByTitle(h, 'T1');
  await h.command(cmd('task.claim', { taskId: task.id, expected: { entityRev: task.rev } }));
  const current = h.state.tasks[task.id];
  await h.command(cmd('task.begin', { taskId: task.id, expected: { entityRev: current.rev }, fencingToken: tokenOf(h, task.id), summary: 'try a junction' }));
  const begun = h.state.tasks[task.id];
  const error = await h.command(cmd('task.submit', {
    taskId: task.id,
    expected: { entityRev: begun.rev },
    fencingToken: tokenOf(h, task.id),
    evidence: [{ kind: 'file', ref: 'link/secret.txt', summary: 'escape via junction' }],
  })).then(() => null, (err) => err);
  assert.equal(error?.code, 'invalid-command');
  assert.match(error.message, /through a link/);
  await svc.close();
});

// 责任：超大证据文件须在读取正文前拒绝，避免无界读入内存。
test('an oversized evidence file is refused without being read', async () => {
  const { h, wsDir, svc } = await openSubmittable();
  const big = path.join(wsDir, 'big.bin');
  fs.writeFileSync(big, '');
  fs.truncateSync(big, 17 * 1024 * 1024);
  const task = taskByTitle(h, 'T1');
  await h.command(cmd('task.claim', { taskId: task.id, expected: { entityRev: task.rev } }));
  const current = h.state.tasks[task.id];
  await h.command(cmd('task.begin', { taskId: task.id, expected: { entityRev: current.rev }, fencingToken: tokenOf(h, task.id), summary: 'try a big file' }));
  const begun = h.state.tasks[task.id];
  const started = Date.now();
  const error = await h.command(cmd('task.submit', {
    taskId: task.id,
    expected: { entityRev: begun.rev },
    fencingToken: tokenOf(h, task.id),
    evidence: [{ kind: 'file', ref: 'big.bin', summary: 'too big' }],
  })).then(() => null, (err) => err);
  assert.equal(error?.code, 'invalid-command');
  assert.match(error.message, /too large/);
  assert.ok(Date.now() - started < 1000, 'the file is never hashed');
  await svc.close();
});

// 责任：agent 无租约编辑 backlog/ready 任务须允许，不强迫为轻编辑领取。
test('an agent may edit a backlog/ready task without holding the lease', async () => {
  const { h, svc } = await setup();
  await publish(h);
  const t1 = taskByTitle(h, 'T1');
  const result = await h.command({
    ...cmd('task.update', { taskId: t1.id, expected: { entityRev: t1.rev }, priority: 7, title: 'T1 renamed' }),
    actor: { kind: 'agent', sessionId: 's2' },
  });
  assert.equal(h.state.tasks[t1.id].priority, 7);
  assert.equal(h.state.tasks[t1.id].title, 'T1 renamed');
  const meta = result.events.find((event) => event.type === 'task/meta-edited');
  assert.ok(meta, 'task/meta-edited event');
  assert.deepEqual(meta.data.fields.slice().sort(), ['priority', 'title']);
  assert.equal(meta.data.by.sessionId, 's2');
  assert.equal(h.leases.get(t1.id), undefined, 'the edit took no lease');
  await svc.close();
});

// 责任：进行中任务即使是编辑也必须持有正确租约，不能套用散任务豁免。
test('editing an in_progress task still requires the lease', async () => {
  const { h, svc } = await setup();
  await publish(h);
  const t1 = taskByTitle(h, 'T1');
  await h.command(cmd('task.claim', { taskId: t1.id, expected: { entityRev: t1.rev } }));
  const error = await h.command({
    ...cmd('task.update', { taskId: t1.id, expected: { entityRev: h.state.tasks[t1.id].rev }, priority: 3 }),
    actor: { kind: 'agent', sessionId: 's2' },
  }).then(() => null, (e) => e);
  assert.ok(error, 'must be rejected');
  assert.equal(error.code, 'lease-held');
  assert.equal(h.state.tasks[t1.id].priority, 100);
  await svc.close();
});

// 责任：修改依赖须校验引用并将不再满足条件的 ready 任务降回 backlog。
test('dependency edits validate and demote a ready task', async () => {
  const { h, svc } = await setup();
  await publish(h);
  const t1 = taskByTitle(h, 'T1');
  const t2 = taskByTitle(h, 'T2');
  const attempt = (deps) => h.command(cmd('task.update', { taskId: t1.id, expected: { entityRev: h.state.tasks[t1.id].rev }, deps })).then(() => null, (e) => e);
  assert.equal((await attempt(['tsk_missing'])).code, 'invalid-command');
  assert.equal((await attempt([t1.id])).code, 'invalid-command');
  assert.equal((await attempt([t2.id])).code, 'invalid-command', 't2 depends on t1 -> cycle');
  assert.deepEqual(h.state.tasks[t1.id].deps, []);

  const created = await h.command(cmd('task.create', { title: 'Free', acceptance: [{ text: 'x' }] }));
  const freeId = created.events.find((event) => event.type === 'task/created').taskId;
  assert.equal(h.state.tasks[freeId].state, 'ready');
  await h.command(cmd('task.update', { taskId: freeId, expected: { entityRev: 1 }, deps: [t2.id] }));
  assert.equal(h.state.tasks[freeId].state, 'backlog', 'an unmet dependency must demote ready');
  await svc.close();
});

// 责任：无租约更新虽可编辑轻字段，但不得借机关闭审计门。
test('a leaseless edit cannot close the audit gate', async () => {
  const { h, svc } = await setup();
  await publish(h);
  const t1 = taskByTitle(h, 'T1');
  await h.command({ ...cmd('task.update', { taskId: t1.id, expected: { entityRev: t1.rev }, requiresAudit: true }), actor: { kind: 'agent', sessionId: 's2' } });
  assert.equal(h.state.tasks[t1.id].requiresAudit, true);
  const error = await h.command({
    ...cmd('task.update', { taskId: t1.id, expected: { entityRev: h.state.tasks[t1.id].rev }, requiresAudit: false }),
    actor: { kind: 'agent', sessionId: 's2' },
  }).then(() => null, (e) => e);
  assert.equal(error.code, 'forbidden-role');
  await svc.close();
});

// 责任：createdBy 须从提交 actor 派生，事件 payload 不能另写可伪造身份。
test('createdBy is derived from the commit actor and never written into the payload', async () => {
  const { h, stateDir, svc } = await setup();
  await publish(h);
  const t1 = taskByTitle(h, 'T1');
  assert.equal(t1.createdBy.sessionId, 's1');
  assert.equal(t1.createdBy.kind, 'agent');
  assert.ok(t1.createdBy.at);
  const card = h.query('board', {}).columns.ready.find((item) => item.id === t1.id);
  assert.equal(card.createdBy.sessionId, 's1');
  const lines = fs.readFileSync(path.join(stateDir, 'projects', h.id, 'commits.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const created = lines.flatMap((commit) => commit.events).find((event) => event.type === 'task/created' && event.taskId === t1.id);
  assert.equal(created.data.createdBy, undefined, 'provenance stays in the commit, not the payload');
  await svc.close();
});

// 责任：重启后任务和计划的 createdBy 须保留创建者身份。
test('createdBy survives a reopen and covers plans', async () => {
  const { h, stateDir, svc } = await setup();
  await publish(h);
  const plan = h.query('plan', {}).plan;
  assert.equal(plan.createdBy.sessionId, 's1');
  const planId = plan.id;
  await svc.close();
  const svc2 = new ProjectService({ rootDir: stateDir, privilegedInlineWrites: true });
  await svc2.init();
  const h2 = await svc2.open(h.id);
  assert.equal(taskByTitle(h2, 'T1').createdBy.sessionId, 's1');
  assert.equal(h2.query('plan', { planId }).plan.createdBy.sessionId, 's1');
  const summary = h2.query('plans', {}).plans.find((item) => item.id === planId);
  assert.equal(summary.createdBy.sessionId, 's1');
  await svc2.close();
});

// 责任：task.update 自报 createdBy 必须被拒绝或不能覆盖原创建者。
test('task.update cannot forge createdBy', async () => {
  const { h, svc } = await setup();
  await publish(h);
  const t1 = taskByTitle(h, 'T1');
  const before = structuredClone(h.state.tasks[t1.id]);
  await assert.rejects(h.command(cmd('task.update', { taskId: t1.id, expected: { entityRev: t1.rev }, createdBy: { sessionId: 'evil' }, priority: 5 })), { code: 'invalid-command' });
  assert.equal(h.state.tasks[t1.id].createdBy.sessionId, 's1');
  assert.deepEqual(h.state.tasks[t1.id], before, 'unsupported provenance intent rejects the entire edit');
  await svc.close();
});
