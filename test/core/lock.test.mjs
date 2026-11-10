/**
 * 测试职责：维护 JSONL store 单写锁的活进程保护、死进程接管与 nonce 校验。
 * 典型流程：临时项目伪造锁/启动子进程 → open/heartbeat/append/close → 检查只读、锁内容和错误。
 * 覆盖边界：覆盖 基本锁生命周期及失锁写入拒绝；不覆盖多进程同时争抢（由 lock-race 覆盖）。
 * 外部前置：需要能启动 Node 子进程；不触碰真实项目锁。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectService } from '../../lib/core/service.js';
import { JsonlStore, makeCommit } from '../../lib/core/store.js';
import { readJson, writeJson } from '../../lib/core/util.js';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
}

async function makeProject() {
  const stateDir = tmp('pb-lock-state');
  const ws = tmp('pb-lock-ws');
  const svc = new ProjectService({ rootDir: stateDir });
  await svc.init();
  const handle = await svc.createProject({ workspacePath: ws, name: 'Lock' });
  const meta = { ...handle.meta };
  const dir = handle.meta.dir;
  await svc.close();
  return { dir, meta };
}

function lockFile(dir) {
  return path.join(dir, 'lock.json');
}

function commitsFile(dir) {
  return path.join(dir, 'commits.jsonl');
}

function forgeLock(dir, fields) {
  writeJson(lockFile(dir), {
    pid: 1,
    hostname: os.hostname(),
    nonce: 'other-writer',
    startedAt: new Date().toISOString(),
    heartbeatAt: Date.now(),
    ...fields,
  });
}

function openStore(dir, meta, opts = {}) {
  return new JsonlStore(dir, meta, { heartbeatMs: 0, ...opts });
}

async function livePid() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  await once(child, 'spawn');
  return child;
}

async function deadPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid;
  await once(child, 'exit');
  return pid;
}

function commitFor(store, note, cmdId = 'cmd_' + Math.random().toString(36).slice(2)) {
  return makeCommit(store.lastSeq + 1, store.lastHash, { kind: 'agent', sessionId: 's1' }, cmdId, store.lastSeq, [
    { type: 'session/checkpoint', data: { note } },
  ]);
}

// 责任：writer pid 仍活时即使心跳很旧也只能只读跟随，close 不得删除对方锁。
test('a live writer keeps its lock even when its heartbeat looks stale', async () => {
  const { dir, meta } = await makeProject();
  const child = await livePid();
  try {
    forgeLock(dir, { pid: child.pid, heartbeatAt: Date.now() - 10 * 60 * 1000 });
    const store = openStore(dir, meta);
    const data = store.open();
    assert.equal(data.readOnly, true, 'a live pid must degrade to read-only, not steal the lock');
    const lock = readJson(lockFile(dir), null);
    assert.equal(lock.pid, child.pid, 'the other writer keeps its lock');
    assert.equal(lock.nonce, 'other-writer');
    store.close();
    assert.equal(readJson(lockFile(dir), null).pid, child.pid, 'closing a read-only store must not delete the lock');
  } finally {
    child.kill();
  }
});

// 责任：同主机确定已死 pid 的锁须允许接管并换为当前 writer 所有权。
test('a dead writer lock from this host is taken over', async () => {
  const { dir, meta } = await makeProject();
  const pid = await deadPid();
  forgeLock(dir, { pid, heartbeatAt: Date.now() - 10 * 60 * 1000 });
  const store = openStore(dir, meta);
  const data = store.open();
  assert.equal(data.readOnly, false);
  const lock = readJson(lockFile(dir), null);
  assert.equal(lock.pid, process.pid);
  assert.notEqual(lock.nonce, 'other-writer');
  store.close();
});

// 责任：持锁期间 lock.json 被替换后 close 不得删除新 writer 的锁。
test('close() does not remove a lock that was replaced while we held it', async () => {
  const { dir, meta } = await makeProject();
  const store = openStore(dir, meta);
  store.open();
  forgeLock(dir, { pid: 424242, nonce: 'thief' });
  store.close();
  const lock = readJson(lockFile(dir), null);
  assert.ok(lock, 'the thief lock must survive our close');
  assert.equal(lock.nonce, 'thief');
});

// 责任：空闲 writer 的定时心跳须持续刷新，不能只有 append 才更新。
test('an idle writer keeps its heartbeat fresh', async () => {
  const { dir, meta } = await makeProject();
  const store = openStore(dir, meta, { heartbeatMs: 20 });
  store.open();
  const before = readJson(lockFile(dir), null);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const after = readJson(lockFile(dir), null);
  assert.equal(after.pid, process.pid);
  assert.ok(after.heartbeatAt > before.heartbeatAt, 'heartbeat must advance without any append');
  store.close();
});

// 责任：另一个进程替换锁后旧 writer append 必须拒绝，防止失锁继续写。
test('append refuses after another process replaces the lock', async () => {
  const { dir, meta } = await makeProject();
  const store = openStore(dir, meta);
  store.open();
  store.append(commitFor(store, 'first'));
  forgeLock(dir, { pid: process.pid, nonce: 'thief-same-pid' });
  assert.throws(() => store.append(commitFor(store, 'second')), (error) => error.code === 'log-forked');
  assert.equal(store.readOnly, true, 'a stolen writer must degrade to read-only');
});
