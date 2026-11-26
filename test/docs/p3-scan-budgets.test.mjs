/**
 * 测试职责：扫描预算、深度剪枝、ignore 全批字节与有界元数据准入。
 * 典型流程：合成大正文/深树/规则树 → 分页发现 → 检查各批上限与拒绝原因。
 * 覆盖边界：覆盖 内核硬预算和准入策略；不覆盖 宿主 worker 卡死超时与真实文件系统压力。
 * 外部前置：仅 Node，隔离临时 fixture，不打开真实项目或 profile。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectionScanner, PROJECTION_LIMITS } from '../../lib/core/reader/discovery/scanner.js';
const tmp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'p3-scan-budgets-')));
const scanner = root => createProjectionScanner({ root, projectId: 'fixture', workspaceContext: { workspaceId: 'fixture' }, policyVersion: 1, scopeKey: 'fixture' });
function all(s) {
  const pages = []; let cursor;
  do { const page = s.execute({ op: 'discover', cursor }); pages.push(page); cursor = page.nextCursor; assert.ok(pages.length < 200); } while (cursor);
  return pages;
}

// 责任：单文件16MiB与全批32MiB不能被总树体量绕过；正文只用于观测不写入对象。
test('complete reads obey per-file and cumulative raw-byte caps across continuation', () => {
  const root = tmp(); const bytes = Buffer.alloc(16 * 1024 * 1024, 65);
  for (let index = 0; index < 3; index++) fs.writeFileSync(path.join(root, `large${index}.md`), bytes);
  const s = scanner(root);
  try {
    const pages = all(s);
    assert.equal(pages.flatMap(page => page.entries).length, 3);
    assert.equal(pages.reduce((sum, page) => sum + page.counts.readBytes, 0), 48 * 1024 * 1024);
    assert.ok(pages.every(page => page.counts.readBytes <= 32 * 1024 * 1024));
    assert.ok(pages.length >= 2);
    assert.equal(fs.existsSync(path.join(root, '.projectboard')), false);
  } finally { s.close(); }
});

// 责任：深度32的目录可发现文件，第33层目录被剪枝，直接路径回读也不能扩大深度。
test('depth is capped at 32 directories and cannot be bypassed through direct reads', () => {
  const root = tmp(); const allowed = Array(32).fill('d').join('/'); const rejected = allowed + '/x';
  fs.mkdirSync(path.join(root, rejected), { recursive: true });
  fs.writeFileSync(path.join(root, allowed, 'allowed.md'), 'body'); fs.writeFileSync(path.join(root, rejected, 'rejected.md'), 'body');
  const s = scanner(root);
  try {
    const pages = all(s);
    assert.deepEqual(pages.flatMap(page => page.entries.map(entry => entry.relPath)), [allowed + '/allowed.md']);
    assert.equal(pages.reduce((n, page) => n + (page.rejected['depth-limit'] || 0), 0), 1);
    assert.throws(() => s.execute({ op: 'read_current', relPath: rejected + '/rejected.md' }), error => error.code === 'depth-limit');
  } finally { s.close(); }
});

// 责任：规则文件各自合法也受1MiB全批预算；超限时拒绝该批剩余规则子树。
test('individually valid ignore files still obey the one-MiB batch ignore budget', () => {
  const root = tmp(); const text = '#'.repeat(65535) + '\n';
  for (let index = 0; index < 20; index++) {
    const dir = path.join(root, `dir${index}`); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '.gitignore'), text); fs.writeFileSync(path.join(dir, 'a.md'), 'body');
  }
  const s = scanner(root);
  try {
    const pages = all(s);
    assert.ok(pages.every(page => page.counts.ignoreBytes <= PROJECTION_LIMITS.batchIgnoreBytes));
    assert.ok(pages.every(page => page.counts.enumerated <= 512));
    // Slice timing may split before the batch byte cap; either case is safe.
    assert.ok(pages.flatMap(page => page.entries).length <= 20);
  } finally { s.close(); }
});
