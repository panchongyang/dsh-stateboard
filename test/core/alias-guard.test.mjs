/**
 * 测试职责：保证 handle 与 store 共享同一个状态对象，避免提交后读模型丢写。
 * 典型流程：临时项目 → 成功/拒绝命令及人为分离状态 → 比较对象身份、版本与读模型。
 * 覆盖边界：覆盖 提交和拒绝路径的状态别名及脱离报警；不覆盖跨进程并发或磁盘损坏。
 * 外部前置：无；使用 Node 临时目录。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectService } from '../../lib/core/service.js';
import { assertStateAttached } from '../../lib/core/handle.js';

/**
 * store.append() returns the state it applied events to and the handle adopts
 * it explicitly; assertStateAttached() is the tripwire. If a store ever returns
 * a detached copy, writes would be silently lost, so the guard fails loudly.
 */
// 责任：创建任务并提交/拒绝命令后，handle 与 store 仍引用同一状态且拒绝不涨版本。
test('handle.state and store.state stay the same object across commits', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-alias-state-'));
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-alias-ws-'));
  const service = new ProjectService({ rootDir });
  await service.init();
  const handle = await service.createProject({ workspacePath, name: 'alias' });
  const actor = { kind: 'agent', sessionId: 'session-alias' };

  try {
    assert.equal(handle.state, handle.store.state, 'initial state aliases diverged');
    assert.equal(handle.rev, handle.store.lastSeq);

    const created = await handle.command({
      cmdId: 'cmd-alias-create', op: 'task.create', actor,
      title: 'alias', acceptance: [{ text: 'done' }],
    });
    assert.equal(handle.state, handle.store.state, 'state aliases diverged after a commit');
    const taskId = created.events[0].data.id;
    assert.equal(handle.state.tasks[taskId].rev, 1, 'event was not applied to handle.state');
    assert.equal(handle.state.project.rev, handle.rev);
    assert.equal(handle.store.state.project.rev, handle.rev);

    const before = handle.rev;
    await assert.rejects(
      handle.command({ cmdId: 'cmd-alias-stale', op: 'task.claim', actor, taskId, expected: { entityRev: 42 } }),
      (error) => error.code === 'stale-revision',
    );
    assert.equal(handle.state, handle.store.state, 'state aliases diverged during a failed command');
    assert.equal(handle.rev, before, 'failed command moved rev');

    const reopened = await handle.query('task', { taskId });
    assert.equal(reopened.task.id, taskId, 'read model lost the committed task');
  } finally {
    await service.close();
    for (const dir of [rootDir, workspacePath]) {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
    }
  }
});

// 责任：把 handle.state 换成克隆后须抛 state-desync，恢复原引用后守卫放行。
test('a detached handle.state is rejected by the alias guard', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-alias-detach-'));
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-alias-detach-ws-'));
  const service = new ProjectService({ rootDir });
  await service.init();
  const handle = await service.createProject({ workspacePath, name: 'detached' });

  try {
    assert.doesNotThrow(() => assertStateAttached(handle));

    handle.state = structuredClone(handle.state);
    assert.throws(
      () => assertStateAttached(handle),
      (error) => error.code === 'state-desync',
      'a detached state must be rejected before it can swallow a commit',
    );

    handle.state = handle.store.state;
    assert.doesNotThrow(() => assertStateAttached(handle));
  } finally {
    handle.state = handle.store.state;
    await service.close();
    for (const dir of [rootDir, workspacePath]) {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
    }
  }
});
