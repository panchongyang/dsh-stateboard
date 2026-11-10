/**
 * 测试职责：维护同进程多 service 共享 handle 的引用计数与锁释放时机。
 * 典型流程：两个 service 打开同一临时项目 → 依次关闭或手工关闭 handle → 检查缓存、锁和写能力。
 * 覆盖边界：覆盖 共享句柄存活、最后引用释放和关闭后重建；不覆盖跨进程锁竞争。
 * 外部前置：无；本地临时 store。
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

async function setup() {
  const root = tmp('pb-hl-state');
  const ws = tmp('pb-hl-ws');
  const A = new ProjectService({ rootDir: root });
  await A.init();
  const handle = await A.createProject({ workspacePath: ws, name: 'HL' });
  const B = new ProjectService({ rootDir: root });
  await B.init();
  return { root, ws, A, B, handle };
}

// 责任：首个 service 关闭后共享 handle 和锁须继续存活，另一个 service 仍可写检查点。
test('closing the first service keeps the shared handle and the lock alive', async () => {
  const { A, B, handle } = await setup();
  const same = await B.open(handle.id);
  assert.equal(same, handle, 'both services must share one handle');
  const lock = path.join(handle.meta.dir, 'lock.json');

  await A.close();
  assert.equal(handle.closed, false, 'A.close must not close the handle B is using');
  assert.ok(fs.existsSync(lock), 'A.close must not remove the lock');

  const result = await same.command(cmd('session.checkpoint', { note: 'B after A close' }));
  assert.equal(result.committed, true, 'B must still be able to write');

  const reopened = await B.open(handle.id);
  assert.equal(reopened.closed, false);
  assert.equal(reopened, handle);
  await B.close();
});

// 责任：最后一个引用 service 关闭时 handle 必须关闭并释放锁文件。
test('the last service to close releases the handle and the lock', async () => {
  const { A, B, handle } = await setup();
  await B.open(handle.id);
  await A.close();
  await B.close();
  assert.equal(handle.closed, true, 'the last reference must close the store');
  assert.equal(fs.existsSync(path.join(handle.meta.dir, 'lock.json')), false);
});

// 责任：缓存 handle 已手工关闭后再 open 须重建新实例，且新实例可以提交。
test('a closed handle is rebuilt instead of being handed out again', async () => {
  const { root, ws, A, handle } = await setup();
  await A.close();
  const C = new ProjectService({ rootDir: root });
  await C.init();
  const first = await C.open(handle.id);
  first.close();
  assert.equal(first.closed, true);

  const second = await C.open(handle.id);
  assert.notEqual(second, first, 'a closed handle must not be cached forever');
  assert.equal(second.closed, false);
  const result = await second.command(cmd('session.checkpoint', { note: 'after rebuild' }));
  assert.equal(result.committed, true);
  await C.close();
  assert.ok(ws);
});
