/**
 * 测试职责：冻结 ProjectHandle 的公开成员、命令结果键和正常任务事件顺序。
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
import { signExecution } from '../fixtures/legacy-execution.mjs';

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

    await run('task.begin', {
      taskId: task.id,
      expected: { entityRev: 2 },
      fencingToken,
      summary: 'api-surface',
    });
    const currentTask = handle.state.tasks[task.id];
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
  } finally {
    await service.close();
    temp.cleanup();
  }
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
