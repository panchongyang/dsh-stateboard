/**
 * 测试职责：验证 P2 只读正文对象的不可变留存——完整字节 hash、0 字节与 16 MiB 边界、1 GiB 预算、对象损坏/缺失与不可覆盖、链接与根限制。
 * 典型流程：隔离临时 space 中写入并读回对象、制造 0 字节/损坏/硬链接/符号链接/超预算、拒绝未初始化或已变化的 home。
 * 覆盖边界：覆盖独占发布、去重、容量拒绝不删对象、读校验；不覆盖写回、journal、项目 writer 串行化、断电或平台适配器。
 * 外部前置：Node 与可写临时目录；只使用合成 fixture，不接触真实 profile、store 或看板。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openSpaceDirectory } from '../../lib/core/store/space-home.js';
import {
  WORKSPACE_OBJECT_BUDGET_BYTES, WORKSPACE_OBJECT_MAX_BYTES, putWorkspaceObject, readWorkspaceObject,
} from '../../lib/core/store/workspace-objects.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const EMPTY_HASH = sha256(Buffer.alloc(0));

function fixture(t, name = 'home') {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-p2-objects-')));
  const root = path.join(tmp, name);
  fs.mkdirSync(root);
  const home = openSpaceDirectory(root);
  home.reserve();
  // Synthetic fixture is deliberately kept on disk for post-failure inspection.
  return { tmp, root, home, objects: path.join(home.namespace, 'objects', 'workspace-bytes') };
}

const objectPath = (f, contentHash) => path.join(f.objects, contentHash.slice(0, 2), contentHash);

// 责任：对象按完整字节 SHA-256 存储，读回原字节；重复 put 核验后复用且不重写。
test('objects round-trip full bytes and deduplicate without rewriting', t => {
  const f = fixture(t);
  const bytes = Buffer.from([0, 1, 2, 0xef, 0xbb, 0xbf, 0x0d, 0x0a, 0xff, 0x00, 0x7f]);
  const stored = putWorkspaceObject(f.home, bytes);
  assert.deepEqual(stored, { contentHash: sha256(bytes), size: bytes.length });
  assert.deepEqual(readWorkspaceObject(f.home, stored.contentHash), bytes);
  const file = objectPath(f, stored.contentHash);
  assert.equal(fs.lstatSync(file).nlink, 1);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [stored.contentHash], 'publication leaves no temp file');
  const before = fs.statSync(file);
  assert.deepEqual(putWorkspaceObject(f.home, bytes), stored);
  const after = fs.statSync(file);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

// 责任：0 字节正文是合法对象（空 SHA-256），可写可读且不产生临时文件。
test('zero-byte objects are stored, verified and read back', t => {
  const f = fixture(t);
  const stored = putWorkspaceObject(f.home, Buffer.alloc(0));
  assert.deepEqual(stored, { contentHash: EMPTY_HASH, size: 0 });
  assert.deepEqual(readWorkspaceObject(f.home, EMPTY_HASH), Buffer.alloc(0));
  const file = objectPath(f, EMPTY_HASH);
  assert.equal(fs.statSync(file).size, 0);
  assert.equal(fs.lstatSync(file).nlink, 1);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [EMPTY_HASH]);
  assert.deepEqual(putWorkspaceObject(f.home, Buffer.alloc(0)), stored);
  assert.deepEqual(readWorkspaceObject(f.home, EMPTY_HASH), Buffer.alloc(0));
});

// 责任：单对象上限 16 MiB，边界值成功、超出拒绝；读取只接受小写完整 hash，缺失为明确错误。
test('object and hash bounds are enforced before touching the medium', t => {
  const f = fixture(t);
  const exact = Buffer.alloc(WORKSPACE_OBJECT_MAX_BYTES, 0x61);
  const stored = putWorkspaceObject(f.home, exact);
  assert.equal(stored.size, WORKSPACE_OBJECT_MAX_BYTES);
  assert.equal(readWorkspaceObject(f.home, stored.contentHash).length, WORKSPACE_OBJECT_MAX_BYTES);
  assert.throws(() => putWorkspaceObject(f.home, Buffer.alloc(WORKSPACE_OBJECT_MAX_BYTES + 1)), { code: 'oversize' });
  assert.throws(() => readWorkspaceObject(f.home, stored.contentHash.toUpperCase()), { code: 'invalid-command' });
  assert.throws(() => readWorkspaceObject(f.home, '../' + stored.contentHash), { code: 'invalid-command' });
  assert.throws(() => putWorkspaceObject(f.home, 'text'), { code: 'invalid-command' });
  assert.throws(() => readWorkspaceObject(f.home, sha256('absent')), { code: 'content-object-missing' });
});

// 责任：同 hash 的既有对象必须逐字节核验；损坏或长度不符拒绝覆盖并保留现场。
test('existing object corruption is detected and never overwritten', t => {
  const f = fixture(t);
  const bytes = Buffer.from('original workspace body\n');
  const stored = putWorkspaceObject(f.home, bytes);
  const file = objectPath(f, stored.contentHash);
  const damaged = Buffer.alloc(bytes.length, 0x62);
  fs.writeFileSync(file, damaged);
  assert.throws(() => putWorkspaceObject(f.home, bytes), { code: 'content-object-corrupt' });
  assert.deepEqual(fs.readFileSync(file), damaged, 'corrupt object is preserved');
  assert.throws(() => readWorkspaceObject(f.home, stored.contentHash), { code: 'content-object-corrupt' });
  fs.truncateSync(file, 3);
  assert.throws(() => putWorkspaceObject(f.home, bytes), { code: 'content-object-corrupt' });
  assert.equal(fs.statSync(file).size, 3);
});

// 责任：目标为符号链接、硬链接或指向根外时必须失败关闭，且不向链接目标写入。
test('linked or escaping object paths are rejected without writes', t => {
  const f = fixture(t);
  const bytes = Buffer.from('linked body');
  const hash = sha256(bytes);
  const outside = path.join(f.tmp, 'outside');
  fs.mkdirSync(outside);
  const bytesRoot = path.join(f.home.namespace, 'objects', 'workspace-bytes');
  fs.mkdirSync(path.dirname(bytesRoot), { recursive: true });
  try { fs.symlinkSync(outside, bytesRoot, 'junction'); } catch (error) { t.skip('cannot create directory link: ' + error.code); return; }
  assert.throws(() => putWorkspaceObject(f.home, bytes), { code: 'security-rejected' });
  assert.deepEqual(fs.readdirSync(outside), [], 'no bytes escape through the link');
  assert.throws(() => readWorkspaceObject(f.home, hash), { code: 'security-rejected' });

  const g = fixture(t, 'second');
  const stored = putWorkspaceObject(g.home, bytes);
  const file = objectPath(g, stored.contentHash);
  const extra = path.join(g.tmp, 'extra-link');
  try {
    fs.linkSync(file, extra);
  } catch (error) {
    t.skip('cannot create hard link: ' + error.code);
    return;
  }
  assert.equal(fs.lstatSync(file).nlink, 2);
  assert.throws(() => readWorkspaceObject(g.home, stored.contentHash), { code: 'security-rejected' });
  assert.throws(() => putWorkspaceObject(g.home, bytes), { code: 'security-rejected' });

  const h = fixture(t, 'third');
  fs.mkdirSync(h.objects, { recursive: true });
  const bucket = path.join(h.objects, hash.slice(0, 2));
  fs.mkdirSync(bucket);
  const target = path.join(h.tmp, 'outside.txt');
  fs.writeFileSync(target, bytes);
  try { fs.symlinkSync(target, path.join(bucket, hash), 'file'); } catch (error) { t.skip('cannot create file link: ' + error.code); return; }
  assert.throws(() => readWorkspaceObject(h.home, hash), { code: 'security-rejected' });
  assert.throws(() => putWorkspaceObject(h.home, bytes), { code: 'security-rejected' });
});

// 责任：发布后、删除临时名之前中断留下的同 inode 双链接，仅可由持 writer 的重试按协议名安全解除；纯读不改，外链不删。
test('a crash between publish and temp removal is recoverable without losing history', t => {
  const f = fixture(t);
  const bytes = Buffer.from('crashed publish');
  const stored = putWorkspaceObject(f.home, bytes);
  const file = objectPath(f, stored.contentHash);
  const alias = path.join(path.dirname(file), '.pending-' + process.pid + '-' + '0123456789abcdef');
  fs.linkSync(file, alias);
  assert.equal(fs.lstatSync(file).nlink, 2);
  assert.throws(() => readWorkspaceObject(f.home, stored.contentHash), { code: 'security-rejected' });
  assert.equal(fs.lstatSync(alias).nlink, 2, 'pure read must not modify the crash state');
  const otherBytes = Buffer.from('another object collected while the alias exists');
  const other = putWorkspaceObject(f.home, otherBytes);
  assert.deepEqual(readWorkspaceObject(f.home, other.contentHash), otherBytes);
  assert.deepEqual(putWorkspaceObject(f.home, bytes), stored);
  assert.equal(fs.existsSync(alias), false, 'only the protocol temp name is removed');
  assert.equal(fs.lstatSync(file).nlink, 1);
  assert.deepEqual(readWorkspaceObject(f.home, stored.contentHash), bytes);

  const g = fixture(t, 'external');
  const held = putWorkspaceObject(g.home, bytes);
  const target = objectPath(g, held.contentHash);
  const outside = path.join(g.tmp, 'outside-link');
  fs.linkSync(target, outside);
  assert.throws(() => putWorkspaceObject(g.home, bytes), { code: 'security-rejected' });
  assert.equal(fs.lstatSync(outside).nlink, 2, 'external hard link is never removed');
  assert.equal(fs.lstatSync(target).nlink, 2);
});

// 责任：1 GiB 预算在写入前拒绝新对象，不自动删除已有对象；已存在对象仍可去重复用。
test('history budget rejects new bytes before the write without deleting history', t => {
  const f = fixture(t);
  const small = Buffer.from('kept object');
  const kept = putWorkspaceObject(f.home, small);
  const bucket = path.join(f.objects, 'bb');
  fs.mkdirSync(bucket);
  const ballast = path.join(bucket, 'b'.repeat(64));
  fs.writeFileSync(ballast, 'x');
  fs.truncateSync(ballast, WORKSPACE_OBJECT_BUDGET_BYTES);
  assert.throws(() => putWorkspaceObject(f.home, Buffer.from('new bytes')), { code: 'history-capacity' });
  assert.equal(fs.statSync(ballast).size, WORKSPACE_OBJECT_BUDGET_BYTES, 'existing objects are not deleted');
  assert.deepEqual(putWorkspaceObject(f.home, small), kept, 'deduplication does not consume budget');
  assert.deepEqual(readWorkspaceObject(f.home, kept.contentHash), small);
});

// 责任：未初始化、身份变化或伪造的 spaceHome 一律拒绝，且不建目录、不写对象；纯读不建介质目录。
test('untrusted or changed space homes are refused before any medium access', t => {
  const f = fixture(t);
  assert.equal(fs.existsSync(f.objects), false);
  assert.throws(() => readWorkspaceObject(f.home, EMPTY_HASH), { code: 'content-object-missing' });
  assert.equal(fs.existsSync(f.objects), false, 'pure reads never create the object directory');

  const empty = path.join(f.tmp, 'empty');
  fs.mkdirSync(empty);
  const bare = openSpaceDirectory(empty);
  assert.throws(() => putWorkspaceObject(bare, Buffer.from('x')), { code: 'space-home-unavailable' });
  assert.throws(() => readWorkspaceObject(bare, EMPTY_HASH), { code: 'space-home-unavailable' });
  assert.equal(fs.existsSync(path.join(empty, '.projectboard')), false);

  const g = fixture(t, 'moved');
  fs.renameSync(path.join(g.home.namespace, 'state'), path.join(g.tmp, 'state-moved'));
  assert.throws(() => putWorkspaceObject(g.home, Buffer.from('x')), { code: 'space-home-unavailable' });
  assert.equal(fs.existsSync(path.join(g.home.namespace, 'objects')), false);
});
