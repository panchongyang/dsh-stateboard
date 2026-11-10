/**
 * 测试职责：保证不确定 WAL 尾部先验证再修帧，完整无 LF 记录不丢失、不完整残片不公开。
 * 典型流程：隔离故障 fixture → 注入写入/回滚/修复错误 → 只读观察与冷重启 → 对照字节、cmdId 与文档。
 * 覆盖边界：覆盖 尾部 framing、快照组合和修复失败只读；不覆盖真实断电或生产数据抢救。
 * 外部前置：必须在 fault launcher 最小隔离环境运行；使用实例级 fs adapter。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { JsonlStore } from '../../lib/core/store.js';
import { setup, logState, retryAndReplay } from '../helpers/fault-fixture.mjs';
import { ioError, partialWrite } from '../helpers/fault-fs.mjs';

const cmd = (op, extra) => ({ cmdId: 'cmd_' + crypto.randomUUID(), actor: { kind: 'human' }, op, ...extra });
const isLog = (file) => file.endsWith('commits.jsonl');
const isRepair = (file) => file.includes('commits.jsonl.tmp-');

async function uncertainTail(f, snapshot, partial = false) {
  if (snapshot === 'before') f.h.store.saveSnapshot();
  const command = cmd('doc.put', { title: 'Unknown framed commit', body: 'body may be committed after cold replay' });
  const before = fs.readFileSync(f.h.store.commitsFile, 'utf8');
  f.faults.arm('writeFileSync', isLog, ([fd, bytes]) => {
    f.faults.arm('ftruncateSync', isLog, () => { throw ioError(); });
    if (partial) partialWrite([fd, bytes]);
    fs.writeFileSync(fd, bytes.subarray(0, -1)); // complete JSON, but delimiter absent
    fs.fsyncSync(fd);
    throw ioError();
  });
  await assert.rejects(f.h.command(command), { code: 'log-write-uncertain' });
  f.faults.consumed();
  assert.equal(f.h.readOnly, true);
  await assert.rejects(f.h.command(command), { code: 'read-only' });
  const raw = fs.readFileSync(f.h.store.commitsFile, 'utf8');
  assert.equal(raw.endsWith('\n'), false);
  if (snapshot === 'at-tail') {
    const peek = new JsonlStore(f.h.meta.dir, f.h.meta, { lock: false });
    try {
      const data = peek.open();
      fs.writeFileSync(f.h.store.snapshotFile, JSON.stringify({ v: 1, seq: data.lastSeq, hash: data.lastHash, state: data.state }));
    } finally { peek.close(); }
  }
  return { command, before, raw };
}

function readonlyUnchanged(f, raw, expectedSeq) {
  const before = f.faults.calls.length;
  const peek = new JsonlStore(f.h.meta.dir, f.h.meta, { lock: false, fs: f.faults.io });
  try {
    const data = peek.open();
    assert.equal(data.readOnly, true);
    assert.equal(data.lastSeq, expectedSeq);
  } finally { peek.close(); }
  assert.deepEqual(f.faults.calls.slice(before), [], 'read-only open has no adapter writes');
  assert.equal(fs.readFileSync(f.h.store.commitsFile, 'utf8'), raw, 'read-only open never normalizes framing');
}

for (const snapshot of ['none', 'before', 'at-tail']) {
  // 责任：完整 JSON 缺 LF 的不确定提交在各快照位置冷开须保留并去重，补 LF 后可继续提交。
  test('complete no-LF uncertain doc survives cold open and subsequent commit: snapshot ' + snapshot, async (t) => {
    const f = await setup(t);
    const { command, raw } = await uncertainTail(f, snapshot);
    readonlyUnchanged(f, raw, 2);
    await f.restart();
    assert.equal(f.h.rev, 2, 'valid record is retained, not discarded');
    assert.equal((await f.h.command(command)).deduped, true);
    const doc = Object.values(f.h.state.docs)[0];
    assert.equal(f.h.query('doc', { docId: doc.id }).body, command.body, 'unknown write can become public after replay');
    assert.equal(logState(f.h).bytes, raw + '\n', 'writable open durably restores delimiter before append');
    const next = cmd('project.update', { name: 'After no-LF tail' });
    assert.equal((await f.h.command(next)).committed, true);
    const state = structuredClone(f.h.state);
    const bytes = logState(f.h).bytes;
    await f.restart();
    assert.deepEqual(f.h.state, state);
    assert.equal((await f.h.command(command)).deduped, true);
    assert.equal((await f.h.command(next)).deduped, true);
    assert.equal(logState(f.h).bytes, bytes);
  });
}

// 责任：不完整乱码 JSON 尾须在验证前缀后丢弃，不公开文档，原 cmdId 可重试一次。
test('garbled incomplete JSON tail is discarded after validation, including with a snapshot', async (t) => {
  const f = await setup(t);
  const { command, before, raw } = await uncertainTail(f, 'before', true);
  readonlyUnchanged(f, raw, 1);
  await f.restart();
  assert.equal(f.h.rev, 1);
  assert.equal(f.h.cmdIds.has(command.cmdId), false);
  assert.deepEqual(f.h.query('docs').docs, []);
  assert.equal(logState(f.h).bytes, before);
  await retryAndReplay(f, command);
  assert.equal((await f.h.command(cmd('project.update', { name: 'After discarded partial tail' }))).committed, true);
  const state = structuredClone(f.h.state);
  await f.restart();
  assert.deepEqual(f.h.state, state);
  logState(f.h);
});

for (const bad of ['hash', 'version']) {
  // 责任：坏哈希或不支持版本必须先拒绝，任何读写打开都不得先修写后部残片。
  test('validate ' + bad + ' before any writable or read-only garbled-tail repair', async (t) => {
    const f = await setup(t);
    f.h.store.saveSnapshot();
    await f.stop();
    const file = f.h.store.commitsFile;
    const commit = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (bad === 'hash') commit.hash = 'sha256:' + '0'.repeat(64);
    else commit.v = 99;
    const raw = JSON.stringify(commit) + '\n{"garbled';
    fs.writeFileSync(file, raw);
    for (const lock of [false, true]) {
      const store = new JsonlStore(f.h.meta.dir, f.h.meta, { lock, fs: f.faults.io });
      assert.throws(() => store.open(), { code: bad === 'hash' ? 'hash-chain-broken' : 'unsupported-version' });
      assert.equal(store.closed, true);
      assert.equal(fs.readFileSync(file, 'utf8'), raw, 'invalid committed prefix cannot be rewritten');
    }
  });
}

for (const stage of ['fsyncSync', 'rename-after']) {
  // 责任：冷开修帧 fsync/rename 后失败不得返回可写 handle，重开只能按实际持久结果恢复。
  test('cold-open framing repair ' + stage + ' failure returns no writable handle', async (t) => {
    const f = await setup(t);
    const { command, raw } = await uncertainTail(f, 'before');
    await f.stop();
    f.faults.arm(stage === 'rename-after' ? 'renameSync' : stage, isRepair, (_args, real) => {
      if (stage === 'rename-after') real();
      throw ioError();
    });
    const store = new JsonlStore(f.h.meta.dir, f.h.meta, { fs: f.faults.io });
    assert.throws(() => store.open(), (error) => error.code === 'log-write-uncertain' && error.details.phase === 'open-tail-repair');
    f.faults.consumed();
    assert.equal(store.closed, true);
    assert.equal(store.readOnly, true);
    assert.equal(fs.readFileSync(store.commitsFile, 'utf8'), stage === 'rename-after' ? raw + '\n' : raw);
    await f.restart();
    assert.equal((await f.h.command(command)).deduped, true);
    assert.equal((await f.h.command(cmd('project.update', { name: 'After repair failure' }))).committed, true);
    const state = structuredClone(f.h.state);
    logState(f.h);
    await f.restart();
    assert.deepEqual(f.h.state, state);
    logState(f.h);
  });
}
