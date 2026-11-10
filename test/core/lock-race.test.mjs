/**
 * 测试职责：保证多进程抢锁、死锁接管和 claim 清理不会形成双 writer。
 * 典型流程：临时项目与子进程屏障 → 并发 open 或注入 claim 替换 → 检查 writer 数、nonce 和哈希链。
 * 覆盖边界：覆盖 进程竞态、旧心跳/claim 保护和异主机锁拒抢；不覆盖真实网络文件系统锁。
 * 外部前置：需要能启动 Node 子进程；进程仅操作临时日志。
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

const root = path.resolve(import.meta.dirname, '../..');
const childScript = path.join(root, 'test/fixtures/lock-child.mjs');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
}

async function makeProject() {
  const stateDir = tmp('pb-lockrace-state');
  const ws = tmp('pb-lockrace-ws');
  const svc = new ProjectService({ rootDir: stateDir });
  await svc.init();
  const handle = await svc.createProject({ workspacePath: ws, name: 'Lock race' });
  const meta = { ...handle.meta };
  const dir = handle.meta.dir;
  await svc.close();
  return { dir, meta };
}

function lockFile(dir) {
  return path.join(dir, 'lock.json');
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

function commitFor(store, note) {
  return makeCommit(store.lastSeq + 1, store.lastHash, { kind: 'agent', sessionId: 's1' }, 'cmd_' + Math.random().toString(36).slice(2), store.lastSeq, [
    { type: 'session/checkpoint', data: { note } },
  ]);
}

function parseCommits(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function deadPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid;
  await once(child, 'exit');
  return pid;
}

async function livePid() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  await once(child, 'spawn');
  return child;
}

function claimDir(dir) {
  return path.join(dir, 'lock.json.claim');
}

function claimOwnerFile(dir) {
  return path.join(claimDir(dir), 'owner.json');
}

function claimOwner(dir) {
  return readJson(claimOwnerFile(dir), null);
}

async function race(dir, meta, count) {
  const metaPath = path.join(dir, 'meta-race.json');
  const releasePath = path.join(dir, 'race-release');
  fs.writeFileSync(metaPath, JSON.stringify(meta));
  const results = [];
  const children = [];
  const exits = [];
  for (let i = 0; i < count; i += 1) {
    const resultPath = path.join(dir, 'race-' + i + '.json');
    results.push(resultPath);
    const child = spawn(process.execPath, [childScript, dir, metaPath, resultPath, releasePath], { stdio: 'ignore' });
    children.push(child);
    exits.push(once(child, 'exit'));
  }
  try {
    const deadline = Date.now() + 10_000;
    while (results.some((file) => !fs.existsSync(file))) {
      assert.ok(children.every((child, index) => child.exitCode === null || fs.existsSync(results[index])), 'no child may exit without reporting');
      if (Date.now() >= deadline) throw new Error('lock race children did not all report before the deadline');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Every contender must attempt open while the winner is still alive. A
    // fixed hold time allows a slow-starting process to become a legal later
    // writer, which is not a simultaneous-lock failure.
    assert.ok(children.every((child) => child.exitCode === null), 'all contenders must remain alive until the cohort has reported');
    const reports = results.map((file) => readJson(file, null));
    assert.ok(reports.every((report) => report && !report.error && typeof report.readOnly === 'boolean'), 'every child must report a successful open');
    return reports;
  } finally {
    fs.writeFileSync(releasePath, 'release');
    const outcomes = await Promise.all(exits);
    assert.ok(outcomes.every(([code, signal]) => code === 0 && signal === null), 'all children must close normally');
  }
}

// 责任：多个子进程同时抢空锁只能一名 writer，其他必须只读。
test('N processes racing for an empty lock: exactly one writer; the rest are read-only', async () => {
  const { dir, meta } = await makeProject();
  const results = await race(dir, meta, 6);
  assert.ok(results.every(Boolean), 'every child must report');
  const writers = results.filter((result) => result.readOnly === false);
  assert.equal(writers.length, 1, 'exactly one writer');
  assert.ok(writers[0].nonce && writers[0].nonce !== 'other-writer');
  const commits = parseCommits(path.join(dir, 'commits.jsonl'));
  let prev = 'genesis';
  for (let i = 0; i < commits.length; i += 1) {
    assert.equal(commits[i].seq, i + 1);
    assert.equal(commits[i].prev, prev);
    prev = commits[i].hash;
  }
});

// 责任：多个进程抢死 writer 锁只能一名接管，追加日志序号和哈希链须连续。
test('N processes racing for a dead writer lock: exactly one takes over, chain stays contiguous', async () => {
  const { dir, meta } = await makeProject();
  const pid = await deadPid();
  forgeLock(dir, { pid, heartbeatAt: Date.now() - 60_000 });
  const results = await race(dir, meta, 6);
  assert.ok(results.every(Boolean), 'every child must report');
  const writers = results.filter((result) => result.readOnly === false);
  assert.equal(writers.length, 1, 'exactly one writer');
  assert.ok(writers[0].nonce && writers[0].nonce !== 'other-writer');
  const commits = parseCommits(path.join(dir, 'commits.jsonl'));
  for (let i = 0; i < commits.length; i += 1) assert.equal(commits[i].seq, i + 1);
});

// 责任：被接管旧 writer 的心跳只能写自己 nonce 文件，不能夺回 lock.json。
test('a heartbeat after takeover writes only its nonce file and cannot reclaim lock.json', async () => {
  const { dir, meta } = await makeProject();
  const store = openStore(dir, meta);
  store.open();
  const oldNonce = store.lockNonce;
  forgeLock(dir, { pid: 424242, hostname: os.hostname(), nonce: 'new-owner' });
  store.touchLock(true);
  assert.equal(readJson(lockFile(dir), null).nonce, 'new-owner', 'old heartbeat must not overwrite the new lock');
  assert.ok(fs.existsSync(path.join(dir, 'lock.json.hb.' + oldNonce)), 'old owner writes only its nonce heartbeat file');
  assert.throws(() => store.append(commitFor(store, 'stale')), (error) => error.code === 'log-forked');
  assert.equal(store.readOnly, true);
  store.close();
  assert.equal(readJson(lockFile(dir), null).nonce, 'new-owner', 'close must not delete the new lock');
});

// 责任：claim mtime 很旧但 claimant pid 仍活时不得被抢占。
test('a live claimant is never stolen just because its claim mtime is old', async () => {
  const { dir, meta } = await makeProject();
  const child = await livePid();
  const claimDir = path.join(dir, 'lock.json.claim');
  try {
    fs.mkdirSync(claimDir);
    fs.writeFileSync(path.join(claimDir, 'owner.json'), JSON.stringify({ pid: child.pid, hostname: os.hostname(), nonce: 'live-claim', at: Date.now() }));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(claimDir, old, old);
    const store = openStore(dir, meta);
    const data = store.open();
    assert.equal(data.readOnly, true, 'a live claim must not be reclaimed by age');
    store.close();
    assert.ok(fs.existsSync(claimDir), 'the live claim survives');
  } finally {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
  const store = openStore(dir, meta);
  const data = store.open();
  assert.equal(data.readOnly, false, 'after the claimant dies the claim is reclaimable');
  store.close();
});

// 责任：回收旧 claim 的 rename 前若出现新 claim，清理不得删除这份新所有权。
test('a stale-claim reclaim cannot delete a fresh claim installed before the rename', async () => {
  const { dir, meta } = await makeProject();
  const dead = await deadPid();
  fs.mkdirSync(claimDir(dir));
  writeJson(claimOwnerFile(dir), { pid: dead, hostname: os.hostname(), nonce: 'stale-a', at: Date.now() });
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(claimDir(dir), old, old);
  const child = await livePid();
  const originalRename = fs.renameSync;
  let injected = false;
  // Simulate contender C completing its own stale reclaim and installing a
  // fresh live claim after B has decided the old claim is dead but before B's
  // rename. B must notice it moved the wrong owner and put it back.
  fs.renameSync = function renameWithReplacement(from, to) {
    if (!injected && String(from).endsWith('lock.json.claim') && String(to).includes('.stale.')) {
      injected = true;
      fs.rmSync(from, { recursive: true, force: true });
      fs.mkdirSync(from);
      writeJson(path.join(from, 'owner.json'), { pid: child.pid, hostname: os.hostname(), nonce: 'replaced-live', at: Date.now() });
    }
    return originalRename.call(fs, from, to);
  };
  try {
    const store = openStore(dir, meta);
    const data = store.open();
    assert.equal(injected, true, 'the replacement window was exercised');
    assert.equal(data.readOnly, true, 'a live replacement claim must not be reclaimed');
    assert.equal(claimOwner(dir)?.nonce, 'replaced-live', 'the live claim survives the stale reclaim');
    store.close();
  } finally {
    fs.renameSync = originalRename;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
});

// 责任：锁标记来自另一主机时不得自动接管，不能凭本机 pid 猜其已死。
test('a lock from another host is never auto-taken-over', async () => {
  const { dir, meta } = await makeProject();
  forgeLock(dir, { pid: 999999, hostname: 'other-host', heartbeatAt: Date.now() - 60_000 });
  const store = openStore(dir, meta);
  const data = store.open();
  assert.equal(data.readOnly, true);
  assert.equal(readJson(lockFile(dir), null).nonce, 'other-writer');
  store.close();
});
