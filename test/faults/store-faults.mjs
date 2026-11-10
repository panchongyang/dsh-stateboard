/**
 * 测试职责：约束 JSONL/blob/meta/快照故障中的提交确定性、回滚边界和冷恢复幂等。
 * 典型流程：隔离合成 store 的实例 fs adapter 注入故障 → 命令/重试/冷重放 → 比较字节、状态与只读屏障。
 * 覆盖边界：覆盖 写前/写后错误、失锁/换文件回滚拒绝及提交后警告；不覆盖真实硬件断电或宿主数据。
 * 外部前置：必须由 store-faults launcher 提供最小隔离环境；不修改全局 fs。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { makeCommit } from '../../lib/core/store.js';
import { sha256 } from '../../lib/core/util.js';
import { ioError, partialWrite } from '../helpers/fault-fs.mjs';
import { setup, logState, retryAndReplay } from '../helpers/fault-fixture.mjs';
const command = (op, extra = {}) => ({ cmdId: 'cmd_' + crypto.randomUUID(), actor: { kind: 'human' }, op, ...extra });
const isLog = (file) => file.endsWith('commits.jsonl');
const isSnapshot = (file) => file.includes('snapshot.json.tmp-');
const isBlob = (file) => file.includes(path.sep + 'blobs' + path.sep);

// 责任：只给一个 store 的 adapter 注入故障时，独立 peer store 提交和冷重放必须完全不受影响。
test('an armed store adapter cannot affect a separate synthetic project store', async (t) => {
  const f = await setup(t);
  const peer = await setup(t);
  const cmd = command('task.create', { title: 'Fault target only', acceptance: [{ text: 'x' }] });
  const peerCmd = command('task.create', { title: 'Unaffected peer fixture', acceptance: [{ text: 'x' }] });
  f.faults.arm('writeFileSync', isLog, partialWrite);
  assert.equal((await peer.h.command(peerCmd)).committed, true);
  const peerBytes = logState(peer.h).bytes;
  await assert.rejects(f.h.command(cmd), { code: 'EIO' });
  f.faults.consumed();
  assert.equal(logState(peer.h).bytes, peerBytes);
  assert.equal((await peer.h.command(peerCmd)).deduped, true);
  await peer.restart();
  assert.equal(logState(peer.h).bytes, peerBytes);
  assert.equal((await peer.h.command(peerCmd)).deduped, true);
  await retryAndReplay(f, cmd);
});

const appendFaults = [
  ['appendLine write fails before bytes', 'writeFileSync', () => { throw ioError(); }],
  ['partial append followed by write failure', 'writeFileSync', partialWrite],
  ['fsync fails before syncing a complete line', 'fsyncSync', () => { throw ioError(); }],
  ['fsync reports failure after real sync', 'fsyncSync', (_args, real) => { real(); throw ioError(); }],
];
for (const [title, method, inject] of appendFaults) {
  // 责任：写入或 fsync 故障回滚成功后须恢复旧字节/状态，同 cmdId 重试冷开只提交一次。
  test(title + ': rollback, same cmdId retry, cold replay', async (t) => {
    const f = await setup(t);
    const cmd = command('task.create', { title, acceptance: [{ text: 'synthetic' }] });
    const before = structuredClone(f.h.state);
    const bytes = logState(f.h).bytes;
    f.faults.arm(method, isLog, inject);
    await assert.rejects(f.h.command(cmd), (error) => {
      assert.equal(error.code, 'EIO', JSON.stringify(error.details));
      return true;
    });
    f.faults.consumed();
    assert.deepEqual(f.h.state, before, 'no event applied and no committed result on failure');
    assert.equal(logState(f.h).bytes, bytes, 'failed append leaves exactly the old complete log');
    assert.equal(f.h.cmdIds.has(cmd.cmdId), false);
    await retryAndReplay(f, cmd);
  });
}

// 责任：blob 已物理落盘但后续提交部分写失败时不得公开文档，重试后才出现一条记录。
test('doc blob is physical but not public when the following partial commit fails', async (t) => {
  const f = await setup(t);
  const cmd = command('doc.put', { title: 'Uncommitted body', body: 'physical synthetic orphan', kind: 'note' });
  const hash = sha256(cmd.body);
  const bytes = logState(f.h).bytes;
  f.faults.arm('writeFileSync', isLog, partialWrite);
  await assert.rejects(f.h.command(cmd), { code: 'EIO' });
  f.faults.consumed();
  assert.equal(fs.readFileSync(path.join(f.h.store.blobsDir, hash), 'utf8'), cmd.body, 'physical blob was written first');
  assert.deepEqual(f.h.query('docs').docs, [], 'no public orphan document');
  assert.equal(logState(f.h).bytes, bytes, 'no doc event');
  assert.equal(f.h.health().ok, true, 'health checks state, not unreferenced disk blobs');
  await f.restart();
  assert.deepEqual(f.h.query('docs').docs, []);
  assert.equal(f.h.cmdIds.has(cmd.cmdId), false);
  await retryAndReplay(f, cmd);
  assert.equal(Object.values(f.h.state.docs).length, 1);
  const doc = Object.values(f.h.state.docs)[0];
  assert.equal(f.h.query('doc', { docId: doc.id }).body, cmd.body);
});

for (const partial of [false, true]) {
  // 责任：回滚 truncate 失败须 log-write-uncertain 并立即只读，冷开按实际完整/部分尾恢复。
  test('rollback truncate failure is fail-closed; cold replay of ' + (partial ? 'partial' : 'complete') + ' append', async (t) => {
    const f = await setup(t);
    const cmd = command('doc.put', { title: 'Uncertain', body: 'uncertain body' });
    const before = structuredClone(f.h.state);
    f.faults.arm(partial ? 'writeFileSync' : 'fsyncSync', isLog, (args) => {
      f.faults.arm('ftruncateSync', isLog, () => { throw ioError(); });
      if (partial) partialWrite(args);
      throw ioError();
    });
    await assert.rejects(f.h.command(cmd), (error) => {
      assert.equal(error.code, 'log-write-uncertain');
      assert.equal(error.details.outcome, 'unknown');
      assert.equal(error.details.original.code, 'EIO');
      assert.equal(error.details.recovery.code, 'EIO');
      return true;
    });
    f.faults.consumed();
    assert.deepEqual(f.h.state, before);
    assert.equal(f.h.readOnly, true);
    assert.equal(f.h.store.readOnly, true);
    const disk = fs.readFileSync(f.h.store.commitsFile, 'utf8');
    await assert.rejects(f.h.command(cmd), { code: 'read-only' });
    const blobs = fs.readdirSync(f.h.store.blobsDir);
    await assert.rejects(f.h.command(command('doc.put', { title: 'Blocked', body: 'must never be written' })), { code: 'read-only' });
    assert.deepEqual(fs.readdirSync(f.h.store.blobsDir), blobs, 'fail-closed rejects before blob staging');
    assert.equal(fs.readFileSync(f.h.store.commitsFile, 'utf8'), disk);
    await f.restart();
    if (partial) {
      assert.deepEqual(f.h.state, before, 'cold open truncates incomplete tail');
      await retryAndReplay(f, cmd);
    } else {
      assert.equal((await f.h.command(cmd)).deduped, true, 'complete uncertain line is authoritative on cold replay');
      assert.equal(logState(f.h).bytes, disk);
      assert.equal(Object.values(f.h.state.docs).length, 1);
      const state = structuredClone(f.h.state);
      await f.restart();
      assert.deepEqual(f.h.state, state);
      assert.equal((await f.h.command(cmd)).deduped, true);
    }
  });
}

// 责任：truncate 虽恢复可见大小但回滚 fsync 失败仍须 outcome unknown，不能断言未提交。
test('rollback fsync failure is uncertain even after truncate restored the visible size', async (t) => {
  const f = await setup(t);
  const cmd = command('task.create', { title: 'Rollback sync', acceptance: [{ text: 'x' }] });
  const bytes = logState(f.h).bytes;
  f.faults.arm('writeFileSync', isLog, (args) => {
    f.faults.arm('fsyncSync', isLog, () => { throw ioError(); });
    partialWrite(args);
  });
  await assert.rejects(f.h.command(cmd), { code: 'log-write-uncertain' });
  f.faults.consumed();
  assert.equal(f.h.readOnly, true);
  assert.equal(logState(f.h).bytes, bytes);
  await assert.rejects(f.h.command(cmd), { code: 'read-only' });
  await f.restart();
  await retryAndReplay(f, cmd);
});

// 责任：成功 fsync 后 close 失败不能谎称确定未提交，必须按不确定边界保护重试。
test('close failure after successful fsync does not claim definite non-commit', async (t) => {
  const f = await setup(t);
  const cmd = command('task.create', { title: 'Close uncertainty', acceptance: [{ text: 'x' }] });
  f.faults.arm('closeSync', isLog, (_args, real) => { real(); throw ioError(); });
  await assert.rejects(f.h.command(cmd), (error) => error.code === 'log-write-uncertain' && error.details.phase === 'close');
  f.faults.consumed();
  assert.equal(f.h.readOnly, true);
  await assert.rejects(f.h.command(cmd), { code: 'read-only' });
  await f.restart();
  const bytes = logState(f.h).bytes;
  assert.equal((await f.h.command(cmd)).deduped, true);
  const state = structuredClone(f.h.state);
  await f.restart();
  assert.deepEqual(f.h.state, state);
  assert.equal((await f.h.command(cmd)).deduped, true);
  assert.equal(logState(f.h).bytes, bytes);
});

for (const oversized of [false, true]) {
  // 责任：发现另一个 writer 的有效尾部，无论长度是否超过本次字节范围，回滚都不得截掉它。
  test('rollback refuses another writer valid tail ' + (oversized ? 'beyond' : 'within') + ' our byte range', async (t) => {
    const f = await setup(t);
    const cmd = command('task.create', { title: 'large own command '.repeat(200), acceptance: [{ text: 'x' }] });
    const foreignName = oversized ? 'foreign name '.repeat(1000) : 'Foreign committed writer';
    const event = { type: 'project/updated', data: { ...f.h.state.project, name: foreignName } };
    const foreign = makeCommit(f.h.rev + 1, f.h.lastHash, { kind: 'human' }, 'cmd_foreign', f.h.rev, [event]);
    const foreignLine = JSON.stringify(foreign) + '\n';
    const beforeBytes = logState(f.h).bytes;
    f.faults.arm('writeFileSync', isLog, ([fd]) => {
      fs.writeFileSync(fd, foreignLine);
      fs.fsyncSync(fd);
      throw ioError();
    });
    await assert.rejects(f.h.command(cmd), { code: 'log-write-uncertain' });
    f.faults.consumed();
    assert.equal(f.h.readOnly, true);
    assert.equal(fs.readFileSync(f.h.store.commitsFile, 'utf8'), beforeBytes + foreignLine, 'never truncate foreign bytes');
    await assert.rejects(f.h.command(cmd), { code: 'read-only' });
    await f.restart();
    assert.equal(f.h.name, foreignName);
    assert.equal(f.h.cmdIds.has('cmd_foreign'), true);
    assert.equal(f.h.cmdIds.has(cmd.cmdId), false);
    await retryAndReplay(f, cmd);
  });
}

// 责任：日志文件被替换后即使字节等于本次完整追加，回滚也须拒绝破坏新文件。
test('rollback refuses a replaced log even when its bytes match our complete append', async (t) => {
  const f = await setup(t);
  const cmd = command('task.create', { title: 'Replaced identity', acceptance: [{ text: 'x' }] });
  const logFile = f.h.store.commitsFile;
  let replacedBytes;
  f.faults.arm('fsyncSync', isLog, (_args, real) => {
    real();
    replacedBytes = fs.readFileSync(logFile, 'utf8');
    fs.renameSync(logFile, logFile + '.synthetic-original');
    fs.writeFileSync(logFile, replacedBytes);
    throw ioError();
  });
  await assert.rejects(f.h.command(cmd), { code: 'log-write-uncertain' });
  f.faults.consumed();
  assert.equal(f.h.readOnly, true);
  assert.equal(fs.readFileSync(logFile, 'utf8'), replacedBytes, 'identity mismatch must not truncate replacement');
  await assert.rejects(f.h.command(cmd), { code: 'read-only' });
  await f.restart();
  assert.equal((await f.h.command(cmd)).deduped, true);
  assert.equal(logState(f.h).bytes, replacedBytes);
  const state = structuredClone(f.h.state);
  await f.restart();
  assert.deepEqual(f.h.state, state);
  assert.equal((await f.h.command(cmd)).deduped, true);
});

// 责任：锁已换 successor owner 时回滚不得动不确定部分尾，旧 writer 必须 fail closed。
test('rollback refuses a successor lock owner and preserves the uncertain partial tail', async (t) => {
  const f = await setup(t);
  const cmd = command('task.create', { title: 'Lock takeover', acceptance: [{ text: 'x' }] });
  const lockFile = f.h.store.lockFile;
  const lockBytes = fs.readFileSync(lockFile, 'utf8');
  const logBytes = logState(f.h).bytes;
  f.faults.arm('writeFileSync', isLog, ([fd, bytes]) => {
    fs.writeSync(fd, bytes.subarray(0, 20));
    fs.writeFileSync(lockFile, JSON.stringify({ ...JSON.parse(lockBytes), nonce: 'synthetic-successor' }));
    throw ioError();
  });
  await assert.rejects(f.h.command(cmd), { code: 'log-write-uncertain' });
  f.faults.consumed();
  assert.equal(f.h.readOnly, true);
  assert.equal(fs.statSync(f.h.store.commitsFile).size, Buffer.byteLength(logBytes) + 20);
  assert.equal(JSON.parse(fs.readFileSync(lockFile)).nonce, 'synthetic-successor');
  await assert.rejects(f.h.command(cmd), { code: 'read-only' });
  // Synthetic fixture only: restore the known owner to allow ordinary close/open;
  // production recovery never deletes or guesses at a successor's lock.
  fs.writeFileSync(lockFile, lockBytes);
  await f.restart();
  assert.equal(logState(f.h).bytes, logBytes);
  await retryAndReplay(f, cmd);
});

async function atSnapshotBoundary(f) {
  while (f.h.rev < 199) await f.h.command(command('project.update', { name: 'At ' + f.h.rev }));
  assert.equal(f.h.rev, 199);
}

// 责任：文档提交已成功但自动快照部分写失败时，业务结果仍须成功且冷开可重放。
test('doc commit succeeds when its automatic snapshot write partially fails', async (t) => {
  const f = await setup(t);
  await atSnapshotBoundary(f);
  const cmd = command('doc.put', { title: 'Snapshot is optional', body: 'referenced after commit' });
  f.faults.arm('writeFileSync', isSnapshot, partialWrite);
  const result = await f.h.command(cmd);
  f.faults.consumed();
  assert.equal(result.committed, true);
  assert.equal(result.warnings, undefined, 'snapshot failure is silent by contract');
  assert.equal(f.h.rev, 200);
  const state = structuredClone(f.h.state);
  const bytes = logState(f.h).bytes;
  assert.equal(fs.existsSync(f.h.store.snapshotFile), false);
  assert.equal((await f.h.command(cmd)).deduped, true);
  await f.restart();
  assert.deepEqual(f.h.state, state);
  assert.equal((await f.h.command(cmd)).deduped, true);
  assert.equal(logState(f.h).bytes, bytes);
  const doc = Object.values(f.h.state.docs)[0];
  assert.equal(f.h.query('doc', { docId: doc.id }).body, cmd.body, 'post-commit failure leaves a referenced, public blob');
  assert.equal(f.h.health().ok, true);
});

// 责任：提交后 meta rename 失败须返回 warning，重试去重且冷发现能自愈元数据。
test('post-commit meta rename failure returns warning; retry dedupes and cold discovery heals', async (t) => {
  const f = await setup(t);
  const target = path.join(f.dir, 'relocated');
  fs.mkdirSync(target);
  const metaFile = path.join(f.h.meta.dir, 'meta.json');
  const beforeMeta = fs.readFileSync(metaFile, 'utf8');
  const cmd = command('project.relocate', { workspacePath: target });
  f.faults.arm('renameSync', (file) => file.includes('meta.json.tmp-'), () => { throw ioError(); });
  const result = await f.h.command(cmd);
  f.faults.consumed();
  assert.equal(result.committed, true);
  assert.equal(result.warnings[0].code, 'relocate-meta-failed');
  assert.equal(fs.readFileSync(metaFile, 'utf8'), beforeMeta);
  const state = structuredClone(f.h.state);
  const bytes = logState(f.h).bytes;
  assert.equal((await f.h.command(cmd)).deduped, true);
  await f.restart();
  assert.deepEqual(f.h.state, state);
  assert.equal((await f.h.command(cmd)).deduped, true);
  assert.equal(logState(f.h).bytes, bytes);
  assert.equal(JSON.parse(fs.readFileSync(metaFile)).project.workspacePath, fs.realpathSync.native(target));
});

for (const afterRename of [false, true]) {
  // 责任：blob 临时部分写或 rename 后故障不得追加 doc 事件，重试后正文只公开一次。
  test('blob write failure ' + (afterRename ? 'after rename' : 'during partial temp write') + ' has no doc event', async (t) => {
    const f = await setup(t);
    const cmd = command('doc.put', { title: 'Blob boundary', body: 'synthetic blob fault ' + afterRename });
    const hash = sha256(cmd.body);
    const bytes = logState(f.h).bytes;
    f.faults.arm(afterRename ? 'renameSync' : 'writeFileSync', isBlob,
      afterRename ? (_args, real) => { real(); throw ioError(); } : partialWrite);
    await assert.rejects(f.h.command(cmd), { code: 'EIO' });
    f.faults.consumed();
    assert.equal(logState(f.h).bytes, bytes);
    assert.equal(fs.existsSync(path.join(f.h.store.blobsDir, hash)), afterRename, 'distinguish tmp bytes from published hash blob');
    if (!afterRename) {
      const tmp = fs.readdirSync(f.h.store.blobsDir).find((name) => name.startsWith(hash + '.tmp-'));
      assert.ok(tmp, 'failed write leaves actual physical temp bytes');
      const size = fs.statSync(path.join(f.h.store.blobsDir, tmp)).size;
      assert.ok(size > 0 && size < Buffer.byteLength(cmd.body));
    }
    assert.deepEqual(f.h.query('docs').docs, []);
    assert.equal(f.h.health().ok, true, 'health does not enumerate physical orphans');
    await f.restart();
    assert.deepEqual(f.h.query('docs').docs, []);
    await retryAndReplay(f, cmd);
  });
}
