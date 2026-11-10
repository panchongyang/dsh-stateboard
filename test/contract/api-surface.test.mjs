/**
 * 测试职责：冻结 ProjectHandle 的公开成员、命令结果键、正常任务事件顺序和看板读模型。
 * 典型流程：建立临时服务 → create/claim/begin/submit → 比较公开结果、事件和失败后的日志。
 * 覆盖边界：覆盖 公开成员与结果形状、过期版本拒绝的零写入；不覆盖 HTTP 翻译或 UI。
 * 外部前置：无；执行证明由本地 fixture 签名。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectService } from '../../lib/core/service.js';
import { boardView } from '../../lib/core/views.js';
import { signExecution } from '../fixtures/legacy-execution.mjs';
import { command, withProject } from '../helpers/service-fixture.mjs';

const PUBLIC_MEMBERS = [
  'id', 'name', 'workspacePath', 'rev', 'readOnly', 'state', 'leases', 'timeline',
  'command', 'query', 'health', 'digest', 'touch', 'attach', 'detach', 'close',
];

const COMMAND_RESULT_KEYS = ['ok', 'committed', 'deduped', 'projectRev', 'entityRev', 'events'];

function fresh() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-api-state-'));
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-api-ws-'));
  return { rootDir, workspacePath, cleanup() {
    for (const dir of [rootDir, workspacePath]) {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
    }
  } };
}

// 责任：依次创建、领取、开始、提交后，结果键保持冻结列表且任务停在 review。
test('ProjectHandle public surface and command result shape are frozen', async () => {
  const temp = fresh();
  const service = new ProjectService({ rootDir: temp.rootDir });
  await service.init();
  const handle = await service.createProject({ workspacePath: temp.workspacePath, name: 'api' });
  const actor = { kind: 'agent', sessionId: 'session-api' };

  try {
    for (const member of PUBLIC_MEMBERS) {
      assert.ok(member in handle, 'ProjectHandle lost public member: ' + member);
    }
    assert.equal(typeof handle.command, 'function');
    assert.equal(typeof handle.query, 'function');
    assert.equal(handle.readOnly, false);

    const events = [];
    const run = async (op, extra) => {
      const result = await handle.command({ cmdId: 'cmd-' + op, op, actor, ...extra });
      assert.deepEqual(Object.keys(result), COMMAND_RESULT_KEYS, 'command result shape changed for ' + op);
      events.push(...(result.events || []).map((event) => event.type));
      return result;
    };

    const created = await run('task.create', { title: 'frozen surface', acceptance: [{ text: 'done' }] });
    const task = created.events[0].data;
    assert.equal(task.state, 'ready');
    const acceptanceId = task.acceptance[0].id;

    const claimed = await run('task.claim', { taskId: task.id, expected: { entityRev: 1 } });
    const fencingToken = claimed.events.find((event) => event.type === 'lease/granted').data.token;
    const claimedCard = handle.query('board').columns.in_progress[0];
    assert.equal(claimedCard.intent, null);
    assert.equal(claimedCard.leaseExpired, false);
    assert.equal(claimedCard.owner.sessionId, actor.sessionId);

    await run('task.begin', {
      taskId: task.id,
      expected: { entityRev: 2 },
      fencingToken,
      summary: 'api-surface',
    });
    const currentTask = handle.state.tasks[task.id];
    const working = handle.query('board').columns.in_progress[0];
    assert.deepEqual(working.intent, { summary: 'api-surface', startedAt: currentTask.work.startedAt });
    assert.equal(working.leaseExpiresAt, handle.leases.get(task.id).expiresAt);
    const execRecord = {
      executor: 'host',
      status: 'ok',
      exitCode: 0,
      stdoutHash: '0'.repeat(64),
      stderrHash: '0'.repeat(64),
      commandHash: crypto.createHash('sha256').update('node -e ""').digest('hex'),
      outputBytes: 0,
      executedAt: new Date().toISOString(),
      timedOut: false,
      taskId: task.id,
      attempt: currentTask.work?.attempt || 0,
      intentId: currentTask.work?.intentId || null,
      token: fencingToken,
    };
    execRecord.proof = signExecution(execRecord);
    await run('task.submit', {
      taskId: task.id,
      expected: { entityRev: 3 },
      fencingToken,
      evidence: [{
        kind: 'command',
        ref: 'node -e ""',
        acceptanceId,
        execution: execRecord,
      }],
    });

    assert.deepEqual(events, [
      'task/created',
      'lease/granted',
      'task/claimed',
      'work/intent',
      'task/updated',
      'work/result',
      'task/submitted',
    ], 'happy-path event sequence changed');

    const after = handle.query('task', { taskId: task.id });
    assert.equal(after.task.state, 'review');
    const reviewCard = handle.query('board').columns.review[0];
    assert.equal(reviewCard.intent, null);
    assert.equal(reviewCard.verifiedBy, null);
    assert.equal(reviewCard.verifiedAt, null);

    await handle.command(command('task.verify', { taskId: task.id, expected: { entityRev: after.task.rev } }));
    const doneCard = handle.query('board').columns.done[0];
    assert.equal(doneCard.verifiedBy, 'human');
    assert.equal(doneCard.verifiedAt, handle.state.tasks[task.id].verifiedAt);
  } finally {
    await service.close();
    temp.cleanup();
  }
});

// 责任：计划步骤和卡片暴露依赖图所需 ID，派发顺序完整复用 brief 的排序且读取不推进版本。
test('board projects plan members, dependencies and complete dispatch ordering', async (t) => {
  const { h } = await withProject(t);
  const acceptance = [{ text: 'done' }];
  const draft = await h.command(command('plan.create', {
    title: 'Flow fixture',
    steps: [
      { id: 'prepare', title: 'Prepare', tasks: [
        { key: 'sample', title: 'Sample', priority: 40, acceptance },
        { key: 'design', title: 'Design', priority: 10, acceptance },
        { key: 'draft', title: 'Draft', priority: 30, acceptance },
        { key: 'inspect', title: 'Inspect', priority: 20, acceptance },
      ] },
      { id: 'build', title: 'Build', tasks: [
        { key: 'deliver', title: 'Deliver', deps: ['design', 'sample'], acceptance },
      ] },
    ],
  }));
  const planId = draft.events[0].data.id;
  assert.deepEqual(h.query('plans').plans[0].steps.map((step) => step.taskIds), [[], []]);
  await h.command(command('plan.publish', { planId, expected: { entityRev: 1 } }));

  const before = h.rev;
  const board = h.query('board');
  const ids = Object.fromEntries(Object.values(h.state.tasks).map((task) => [task.title, task.id]));
  const stepIds = [[ids.Sample, ids.Design, ids.Draft, ids.Inspect], [ids.Deliver]];
  assert.deepEqual(board.plans[0].steps.map((step) => step.taskIds), stepIds);
  assert.deepEqual(h.query('plan', { planId }).head.steps.map((step) => step.taskIds), stepIds);
  const deliver = board.columns.backlog[0];
  assert.deepEqual(deliver.deps, [ids.Design, ids.Sample]);
  assert.deepEqual(board.columns.ready[0].deps, []);
  assert.deepEqual(board.readyOrder, [ids.Design, ids.Inspect, ids.Draft, ids.Sample]);
  assert.deepEqual(h.query('brief').next.map((task) => task.id), board.readyOrder.slice(0, 3));
  assert.equal(h.rev, before);

  // 调用者修改摘要副本时，持久状态中的边和步骤成员不受影响。
  deliver.deps.length = 0;
  board.plans[0].steps[0].taskIds.length = 0;
  assert.deepEqual(h.state.tasks[ids.Deliver].deps, [ids.Design, ids.Sample]);
  assert.deepEqual(h.query('board').plans[0].steps.map((step) => step.taskIds), stepIds);
});

// 责任：实时看板读取续期后的租约，离线快照没有运行时租约时返回未知。
test('board shows renewed runtime expiry and does not write when a lease expires', async (t) => {
  let now = Date.now();
  const { h } = await withProject(t, { clock: () => new Date(now) });
  const created = await h.command(command('task.create', { title: 'Running', acceptance: [{ text: 'done' }] }));
  const taskId = created.events[0].taskId;
  const claimed = await h.command(command('task.claim', { taskId, expected: { entityRev: 1 } }));
  const fencingToken = claimed.events.find((event) => event.type === 'lease/granted').data.token;
  const oldExpiry = h.state.tasks[taskId].owner.leaseUntil;
  now = Date.parse(oldExpiry) - 1000;
  await h.command(command('task.renew', { taskId, expected: { entityRev: 2 }, fencingToken }));
  const expiry = h.leases.get(taskId).expiresAt;
  assert.ok(Date.parse(expiry) > Date.parse(oldExpiry));

  now = Date.parse(oldExpiry) + 1;
  const before = h.rev;
  const read = () => h.query('board').columns.in_progress[0];
  assert.equal(read().owner.leaseUntil, oldExpiry);
  assert.equal(read().leaseExpiresAt, expiry);
  assert.equal(read().leaseExpired, false);
  now = Date.parse(expiry);
  assert.equal(read().leaseExpired, true);
  const offline = boardView({ state: h.state, timeline: h.timeline, rev: before }).columns.in_progress[0];
  assert.equal(offline.owner.leaseUntil, oldExpiry);
  assert.equal(offline.leaseExpiresAt, null);
  assert.equal(offline.leaseExpired, null);
  assert.equal(h.rev, before);
});

// 责任：以错误实体版本领取任务须报 stale-revision，项目版本和提交数不变。
test('failed commands do not move the public revision or the event log', async () => {
  const temp = fresh();
  const service = new ProjectService({ rootDir: temp.rootDir });
  await service.init();
  const handle = await service.createProject({ workspacePath: temp.workspacePath, name: 'stale' });
  const actor = { kind: 'agent', sessionId: 'session-api' };

  try {
    const created = await handle.command({
      cmdId: 'cmd-create', op: 'task.create', actor,
      title: 'stale guard', acceptance: [{ text: 'done' }],
    });
    const taskId = created.events[0].data.id;
    const before = { rev: handle.rev, commits: handle.store.commits.length };

    await assert.rejects(
      handle.command({ cmdId: 'cmd-stale', op: 'task.claim', actor, taskId, expected: { entityRev: 99 } }),
      (error) => error.code === 'stale-revision',
    );
    assert.equal(handle.rev, before.rev, 'failed command advanced project rev');
    assert.equal(handle.store.commits.length, before.commits, 'failed command appended a commit');
  } finally {
    await service.close();
    temp.cleanup();
  }
});
