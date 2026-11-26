/**
 * 测试职责：有界流式文档发现、元数据复用、逐路径安全核验与 fresh 回读。
 * 典型流程：合成工作区 → 冷/热扫描与续接 → 外部改动/撤权限 → 检查真实观测。
 * 覆盖边界：覆盖 扫描内核、ignore/deny/嵌套/链接/预算；不覆盖 host 授权或 worker 超时传输。
 * 外部前置：仅 Node 与隔离临时 fixture，无 Git/真实 store；链接能力不足显式跳过。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectionScanner, PROJECTION_LIMITS } from '../../lib/core/reader/discovery/scanner.js';

const tmp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'p3-scan-')));
function put(root, rel, body = 'body') {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
}
function scanner(root, options = {}) {
  return createProjectionScanner({ root, projectId: 'project-fixture', workspaceContext: { workspaceId: 'workspace-fixture', storeId: 'store-fixture' }, policyVersion: 1, scopeKey: 'authorized-fixture-scope', ...options });
}
function all(s) {
  const pages = [];
  let cursor;
  do {
    const page = s.execute({ op: 'discover', cursor });
    pages.push(page); cursor = page.nextCursor;
    assert.ok(pages.length < 1000, 'bounded continuation eventually finishes');
  } while (cursor);
  return pages;
}
const names = pages => pages.flatMap(page => page.entries.map(entry => entry.relPath)).sort();
const code = expected => error => { assert.equal(error.code, expected, error.message); return true; };
const summed = (pages, group, reason) => pages.reduce((sum, page) => sum + (page.counts[group][reason] || 0), 0);

// 责任：未登记来源可发现，来源上下文与实际读取计数明确，查询不修改任何 fixture 正文。
test('cold discovers only supported text, reports distinct counts and performs no writes', () => {
  const root = tmp();
  put(root, 'docs/a.MD', '# A'); put(root, 'b.markdown', 'B'); put(root, 'c.txt', 'C');
  put(root, 'source.js'); put(root, 'README'); put(root, 'image.pdf');
  const before = fs.readFileSync(path.join(root, 'docs/a.MD'));
  const s = scanner(root);
  try {
    const pages = all(s);
    assert.deepEqual(names(pages), ['b.markdown', 'c.txt', 'docs/a.MD']);
    assert.equal(pages.reduce((n, page) => n + page.counts.read, 0), 3);
    assert.equal(pages.reduce((n, page) => n + page.counts.indexed, 0), 0);
    assert.equal(pages[0].workspaceContext.workspaceId, 'workspace-fixture');
    assert.equal(pages[0].policyVersion, 1);
    assert.ok(pages[0].scanGeneration);
    assert.ok(pages.flatMap(p => p.entries).every(e => e.bodyVerified && !('body' in e)));
    assert.deepEqual(fs.readFileSync(path.join(root, 'docs/a.MD')), before);
    assert.equal(fs.existsSync(path.join(root, '.projectboard')), false);
  } finally { s.close(); }
});

// 责任：热扫描只复用元数据，重新证明读权限但不读正文、不计算 hash、不声称缓存为当前字节。
test('hot scan has zero document reads and hashes and never presents cached content as current', () => {
  const root = tmp(); put(root, 'a.md', 'A');
  const s = scanner(root); all(s);
  const originalRead = fs.readSync;
  const originalHash = crypto.createHash;
  fs.readSync = () => { throw Error('hot path must not read body'); };
  crypto.createHash = () => { throw Error('hot path must not hash'); };
  try {
    const pages = all(s);
    assert.equal(pages[0].counts.read, 0); assert.equal(pages[0].counts.reused, 1);
    assert.equal(pages[0].entries[0].observation, 'metadata-only');
    assert.equal(pages[0].entries[0].bodyVerified, false);
    assert.equal('contentHash' in pages[0].entries[0], false);
  } finally { fs.readSync = originalRead; crypto.createHash = originalHash; s.close(); }
});

// 责任：显式 read/refresh 永远重新读取真实文件，按 UTF-8 边界截断，不创建留存历史。
test('read_current and refresh_current fresh-read edited bytes with bounded Unicode display', () => {
  const root = tmp(); put(root, 'a.md', 'A');
  const s = scanner(root);
  try {
    all(s);
    put(root, 'a.md', '新🙂内容');
    const a = s.execute({ op: 'read_current', relPath: 'a.md', maxBytes: 6 });
    assert.equal(a.body, '新'); assert.equal(a.truncated, true); assert.equal(a.retained, false);
    put(root, 'a.md', 'B');
    const b = s.execute({ op: 'refresh_current', relPath: 'a.md' });
    assert.equal('body' in b, false); assert.equal(b.contentHash, crypto.createHash('sha256').update('B').digest('hex')); assert.notEqual(a.contentHash, b.contentHash);
    assert.equal(b.counts.read, 1);
    assert.equal(fs.existsSync(path.join(root, '.projectboard')), false);
  } finally { s.close(); }
});

// 责任：硬排除、deny 与嵌套仓库先于忽略否定，回读也不能绕开扫描拒绝。
test('reserved and denied paths plus nested Git workspaces cannot be scanned or read', () => {
  const root = tmp();
  for (const rel of ['private/a.md', 'x/secrets/a.txt', 'node_modules/a.md', '.evidence/a.md', 'x/.env.md', 'credentials.md', 'id_rsa.md', 'ok.md', 'deny/a.md', 'nested/a.md']) put(root, rel);
  put(root, '.gitignore', '!**/*.md\n'); put(root, 'nested/.git', 'gitdir: somewhere');
  const s = scanner(root, { denyPrefixes: ['deny'] });
  try {
    const pages = all(s); assert.deepEqual(names(pages), ['ok.md']);
    assert.ok(summed(pages, 'excluded', 'reserved-path') >= 6);
    assert.equal(summed(pages, 'excluded', 'nested-workspace'), 1);
    assert.throws(() => s.execute({ op: 'read_current', relPath: 'private/a.md' }), code('reserved-path'));
    assert.throws(() => s.execute({ op: 'read_current', relPath: 'DENY/a.md' }), code('policy-denied'));
    assert.throws(() => s.execute({ op: 'read_current', relPath: 'nested/a.md' }), code('nested-workspace'));
  } finally { s.close(); }
});

// 责任：根及逐级 ignore 遵守继承/否定/父目录剪枝，不依赖外部 Git。
test('root and nested gitignore rules apply to discover and direct reads', () => {
  const root = tmp();
  put(root, '.gitignore', '*.txt\n!keep.txt\nblocked/\n');
  put(root, 'a.txt'); put(root, 'keep.txt'); put(root, 'blocked/.gitignore', '!a.md\n'); put(root, 'blocked/a.md');
  put(root, 'docs/.gitignore', '*.md\n!keep.md\n'); put(root, 'docs/drop.md'); put(root, 'docs/keep.md');
  const s = scanner(root);
  try {
    assert.deepEqual(names(all(s)), ['docs/keep.md', 'keep.txt']);
    assert.throws(() => s.execute({ op: 'read_current', relPath: 'docs/drop.md' }), code('gitignored'));
    assert.throws(() => s.execute({ op: 'read_current', relPath: 'blocked/a.md' }), code('gitignored'));
    assert.equal(s.execute({ op: 'read_current', relPath: 'docs/keep.md' }).body, 'body');
  } finally { s.close(); }
});

// 责任：超限/非法 ignore 对相应子树 fail-closed，不把规则失败当作无限制读取。
test('oversized and invalid ignore files fail closed only for their subtree', () => {
  const root = tmp(); put(root, 'ok.md');
  put(root, 'bad/.gitignore', 'x'.repeat(65537)); put(root, 'bad/a.md');
  put(root, 'utf/.gitignore', Buffer.from([0xff])); put(root, 'utf/a.md');
  const s = scanner(root);
  try {
    const pages = all(s); assert.deepEqual(names(pages), ['ok.md']);
    assert.equal(summed(pages, 'rejected', 'ignore-oversize'), 1);
    assert.equal(summed(pages, 'rejected', 'ignore-invalid'), 1);
    assert.throws(() => s.execute({ op: 'read_current', relPath: 'bad/a.md' }), code('ignore-oversize'));
  } finally { s.close(); }
});

// 责任：目录流式枚举，每批计数<=512，续接不遗漏/重复且不先完整 readdir。
test('large trees use streaming DFS with bounded pages and exact continuation', () => {
  const root = tmp(); for (let n = 0; n < 1100; n++) put(root, `dir/f${String(n).padStart(4, '0')}.md`);
  const s = scanner(root); const original = fs.readdirSync;
  fs.readdirSync = () => { throw Error('unbounded readdir forbidden'); };
  try {
    const pages = all(s); const found = names(pages);
    assert.equal(found.length, 1100); assert.equal(new Set(found).size, 1100);
    assert.ok(pages.length > 2);
    for (const page of pages) {
      assert.ok(page.counts.enumerated <= 512); assert.ok(page.counts.readBytes <= 32 * 1024 * 1024);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 1024 * 1024);
    }
  } finally { fs.readdirSync = original; s.close(); }
});

// 责任：并存扫描代有界，cursor 是一次性、实例/上下文隔离，不是读取能力。
test('four cursor generations coexist, oldest is evicted and cross-scope/replay is rejected', () => {
  const root = tmp(); for (let n = 0; n < 530; n++) put(root, `f${n}.md`);
  const s = scanner(root); const other = scanner(root, { scopeKey: 'different-permission-generation' });
  try {
    const pages = Array.from({ length: 5 }, () => s.execute({ op: 'discover' }));
    assert.ok(pages.every(page => page.partial && page.nextCursor));
    assert.throws(() => s.execute({ op: 'discover', cursor: pages[0].nextCursor }), code('restart-required'));
    assert.throws(() => other.execute({ op: 'discover', cursor: pages[4].nextCursor }), code('restart-required'));
    const next = s.execute({ op: 'discover', cursor: pages[4].nextCursor });
    assert.ok(next.entries.length > 0);
    assert.throws(() => s.execute({ op: 'discover', cursor: pages[4].nextCursor }), code('restart-required'));
  } finally { s.close(); other.close(); }
});

// 责任：ignore 策略变更令游标重启，不能用旧代继续返回新策略排除的路径。
test('changed ignore policy invalidates an active cursor and fresh reads follow it immediately', () => {
  const root = tmp(); for (let n = 0; n < 530; n++) put(root, `f${n}.md`);
  const s = scanner(root);
  try {
    const page = s.execute({ op: 'discover' }); assert.ok(page.nextCursor);
    put(root, '.gitignore', '*.md\n');
    assert.throws(() => s.execute({ op: 'discover', cursor: page.nextCursor }), code('restart-required'));
    assert.throws(() => s.execute({ op: 'read_current', relPath: 'f0.md' }), code('gitignored'));
    assert.deepEqual(names(all(s)), []);
  } finally { s.close(); }
});

// 责任：权限撤销时即使缓存命中也不返回路径；读权限验证使用真实 open 而非只 access。
test('revoked read permission never survives metadata reuse', () => {
  const root = tmp(); put(root, 'a.md'); const s = scanner(root); all(s);
  const original = fs.openSync;
  fs.openSync = (file, ...args) => {
    if (path.resolve(String(file)) === path.join(root, 'a.md')) throw Object.assign(Error('denied'), { code: 'EACCES' });
    return original(file, ...args);
  };
  try {
    const pages = all(s); assert.deepEqual(names(pages), []);
    assert.equal(summed(pages, 'errors', 'permission-denied'), 1);
    assert.throws(() => s.execute({ op: 'read_current', relPath: 'a.md' }), code('permission-denied'));
  } finally { fs.openSync = original; s.close(); }
});

// 责任：正文格式错误与超大文件分别报告；不存在的当前文件绝不回退缓存。
test('invalid UTF-8, binary, UTF-16 and oversize sources are classified without historical fallback', () => {
  const root = tmp(); put(root, 'bad.md', Buffer.from([0xff])); put(root, 'bin.txt', Buffer.from([65, 0, 66]));
  put(root, 'utf.md', Buffer.from([0xff, 0xfe, 65, 0])); put(root, 'large.md', Buffer.alloc(MAX_DOC_BYTES_FOR_TEST + 1));
  const s = scanner(root);
  try {
    const pages = all(s); assert.deepEqual(names(pages), []);
    assert.equal(summed(pages, 'rejected', 'undecodable'), 1);
    assert.equal(summed(pages, 'rejected', 'unsupported-format'), 2);
    assert.equal(summed(pages, 'rejected', 'oversize'), 1);
    assert.throws(() => s.execute({ op: 'read_current', relPath: 'missing.md' }), code('file-missing'));
    assert.throws(() => s.execute({ op: 'read_current', relPath: '../escape.md' }));
  } finally { s.close(); }
});
const MAX_DOC_BYTES_FOR_TEST = 16 * 1024 * 1024;

// 责任：目录链接、文件链接与硬链接均拒绝，不越出 fixture 根读取。
test('links and multi-entry hardlinked files are refused', t => {
  const root = tmp(); const outside = tmp(); put(outside, 'secret.md'); put(root, 'original.md');
  try {
    fs.symlinkSync(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'linked.md'), 'file');
    fs.linkSync(path.join(root, 'original.md'), path.join(root, 'hard.md'));
  } catch (error) { t.skip('link creation unavailable: ' + error.code); return; }
  const s = scanner(root);
  try {
    assert.deepEqual(names(all(s)), []);
    assert.throws(() => s.execute({ op: 'read_current', relPath: 'link/secret.md' }));
    assert.throws(() => s.execute({ op: 'read_current', relPath: 'hard.md' }), code('security-rejected'));
  } finally { s.close(); }
});

// 责任：原始正文读取<=16MiB/批32MiB，JSON转义后结果也不突破1MiB输出。
test('body and JSON-escaped output limits cannot be widened by request', () => {
  const root = tmp(); put(root, 'escaped.md', '\u0001'.repeat(1024 * 1024));
  const s = scanner(root);
  try {
    const current = s.execute({ op: 'read_current', relPath: 'escaped.md', maxBytes: 1024 * 1024 });
    assert.equal(current.truncated, true); assert.ok(Buffer.byteLength(JSON.stringify(current)) <= 1024 * 1024);
    assert.throws(() => s.execute({ op: 'read_current', relPath: 'escaped.md', maxBytes: 16 * 1024 * 1024 }), code('invalid-path'));
    s.close(); assert.throws(() => s.execute({ op: 'discover' }), code('restart-required'));
    assert.equal(PROJECTION_LIMITS.metadataEntries, 16384); assert.equal(PROJECTION_LIMITS.metadataBytes, 4 * 1024 * 1024); assert.equal(PROJECTION_LIMITS.generations, 4);
  } finally { s.close(); }
});
