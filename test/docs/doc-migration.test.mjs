/**
 * 测试职责：保证内嵌迁移盘点完整枚举历史字节和引用，并保持只读导出。
 * 典型流程：合成历史 store/损坏 blob/冲突目标 → inventory 或 CLI dry-run → 检查映射、诊断和字节树。
 * 覆盖边界：覆盖 历史版本、链接、证据哈希域与读取授权；不覆盖真实生产 store 或迁移落盘。
 * 外部前置：无；CLI 子进程使用当前 Node 和合成目录。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { migrationFixture } from '../../lib/core/documents/migration-fixture.js';
import { inventoryInlineDocuments, exportInlineContent } from '../../lib/core/documents/migration-inventory.js';
import { JsonlStore } from '../../lib/core/store.js';
import { sha256 } from '../../lib/core/util.js';

const inventory = (store, extra = {}) => inventoryInlineDocuments({ state: store.state, commits: store.commits, readBlob: (hash) => store.readBlob(hash), ...extra });
function tree(root, result = {}, base = root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) tree(full, result, base);
    else result[path.relative(base, full)] = { hash: sha256(fs.readFileSync(full)), mtime: fs.statSync(full).mtimeMs };
  }
  return result;
}

function diskFixture(t) {
  const store = migrationFixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-doc-migrate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'blobs'));
  fs.writeFileSync(path.join(dir, 'commits.jsonl'), store.commits.map((c) => JSON.stringify(c)).join('\n')); // unterminated intentionally
  for (const [hash, body] of store.blobs) fs.writeFileSync(path.join(dir, 'blobs', hash), body);
  return { store, dir };
}

// 责任：盘点须列出所有正文/仅链接版本及历史关联，缺 blob 要显式报告而非漏行。
test('inventory enumerates every revision, link-only rev, historical relation and evidence', () => {
  const store = migrationFixture();
  const report = inventory(store, { includeBodies: true });
  assert.equal(report.current.length, 2);
  assert.deepEqual(report.revisions.map((row) => row.ref), ['doc_fixture@1', 'doc_fixture@2', 'doc_fixture@3', 'doc_missing@1']);
  assert.equal(report.revisions[0].blob.body, 'old\r\n');
  assert.equal(report.revisions[1].hash, report.revisions[2].hash);
  assert.deepEqual(report.revisions[2].links.taskIds, ['tsk_fixture', 'tsk_other']);
  assert.deepEqual(report.associations[0].links.planRefs, [{ planId: 'pln_fixture', version: 1 }]);
  assert.equal(report.revisions[0].references.length, 2); // history and current task
  assert.ok(report.missing.some((row) => row.ref === 'doc_missing@1' && row.code === 'missing-blob'));
  assert.equal(JSON.parse(JSON.stringify(report)).schemaVersion, 1);
});

// 责任：导出须验证原始哈希，历史 blob 缺失或损坏时不能以最新正文顶替。
test('export validates original hashes and never substitutes head for missing or corrupt history', () => {
  const store = migrationFixture();
  const old = inventory(store).revisions[0];
  assert.equal(exportInlineContent((hash) => store.readBlob(hash), old.hash).body, 'old\r\n');
  store.blobs.set(old.hash, 'new\n');
  assert.equal(inventory(store).revisions[0].blob.status, 'hash-mismatch');
  assert.equal(exportInlineContent(() => null, old.hash).status, 'missing-blob');
  assert.equal(exportInlineContent(() => 'x', '../bad').status, 'invalid-hash');
});

// 责任：目标路径大小写别名、共享根别名或已登记外置目标冲突均须报告。
test('inventory reports collisions including case aliases and existing external destinations', () => {
  const store = migrationFixture();
  const destinations = ['doc_fixture', 'doc_missing'].map((docId, i) => ({ docId, locator: { bindingId: 'b', relPath: i ? 'DOCS/a.md' : 'docs/a.md' } }));
  assert.equal(inventory(store, { destinations }).conflicts[0].code, 'destination-conflict');
  destinations[1].locator.relPath = '../escape';
  assert.equal(inventory(store, { destinations }).conflicts[0].code, 'invalid-destination');
  const shared = ['one', 'two'].map((bindingId, i) => ({ docId: i ? 'doc_missing' : 'doc_fixture', locator: { bindingId, relPath: 'a.md' } }));
  assert.equal(inventory(store, { destinations: shared, bindingRoots: { one: os.tmpdir(), two: os.tmpdir() } }).conflicts[0].code, 'destination-conflict');
  store.state.docs.doc_external = { id: 'doc_external', source: 'external', rev: 1, title: 'Registered', kind: 'note',
    status: 'draft', locator: { bindingId: 'one', relPath: 'a.md' }, links: { taskIds: [], planRefs: [] },
    baseline: null, baselineInContext: false, unregistered: null };
  assert.equal(inventory(store, { destinations: [shared[0]] }).conflicts[0].first.docId, 'doc_external');
});

// 责任：重复盘点和 CLI 正文导出不得改变 store 字节、mtime、文件集合或创建 lock。
test('dry-run and body JSON export have zero writes: store bytes, mtimes, files and event count unchanged', (t) => {
  const { dir, store } = diskFixture(t);
  const before = tree(dir);
  const reader = new JsonlStore(dir, { project: store.state.project }, { lock: false });
  reader.open();
  const stateBefore = structuredClone(reader.state);
  const commitsBefore = structuredClone(reader.commits);
  for (let i = 0; i < 3; i++) inventory(reader, { includeBodies: true });
  assert.deepEqual(reader.state, stateBefore);
  assert.deepEqual(reader.commits, commitsBefore);
  const output = execFileSync(process.execPath, ['scripts/doc-migration.mjs', '--store', dir, '--authorized-read', '--export-bodies'], { encoding: 'utf8' });
  assert.equal(JSON.parse(output).revisions[0].blob.body, 'old\r\n');
  assert.deepEqual(tree(dir), before);
  assert.equal(fs.existsSync(path.join(dir, 'lock.json')), false);
});

// 责任：裸旧证据须按当时事件位置解析历史版本，不能绑定后来的文档 head。
test('current bare legacy references retain their original event position instead of latest document bytes', () => {
  const store = migrationFixture();
  const first = store.commits[1].events[0];
  const updated = store.commits[2].events[0];
  const task = { id: 'tsk_bare', evidence: [{ id: 'ev_bare', kind: 'doc', ref: 'doc_fixture', hash: first.data.hash }] };
  const report = inventoryInlineDocuments({ state: { project: store.state.project, docs: { doc_fixture: updated.data }, tasks: { tsk_bare: task } },
    commits: [{ seq: 1, events: [first] }, { seq: 2, events: [{ type: 'task/updated', data: task }] }, { seq: 3, events: [updated] }],
    readBlob: (hash) => store.readBlob(hash) });
  assert.equal(report.evidence.find((row) => row.origin.view === 'state').resolvedRef, 'doc_fixture@1');
  assert.equal(report.revisions[0].hash, sha256('old\r\n'));
  assert.equal(report.missing.some((row) => row.code === 'missing-revision'), false);
});

// 责任：独立历史 fixed 行须列为 Git 字节域，禁止从 inline blob store 读取它的哈希。
test('standalone historical fixed content rows are listed without reading them as inline blobs', () => {
  const store = migrationFixture();
  const row = { kind: 'doc', ref: 'doc_fixture', hash: sha256('Git bytes'), fixed: { v: 1, projectId: store.state.project.id,
    commitOid: 'a'.repeat(40), pathAtCommit: 'spec.md', blobOid: 'b'.repeat(40), objectFormat: 'sha1', blobContentHash: sha256('Git bytes') } };
  const report = inventoryInlineDocuments({ state: { ...store.state, fixedContents: { historical: row } },
    commits: [...store.commits, { seq: 7, events: [{ type: 'doc/content-fixed', data: row }] }],
    readBlob: (hash) => { assert.notEqual(hash, row.hash, 'Git identity is never looked up in inline store'); return store.readBlob(hash); } });
  assert.equal(report.fixedContents.length, 2);
  assert.deepEqual(report.fixedContents[0].fixed, row.fixed);
  assert.equal(report.fixedContents[0].domain, 'git-blob-bytes');
});

// 责任：孤立历史证据须保留原 ref/hash，并显式标注找不到版本和 blob。
test('orphan historical evidence keeps its original hash and blob availability visible', () => {
  const store = migrationFixture();
  store.state.tasks.tsk_fixture.evidence.push({ kind: 'doc', ref: 'doc_lost@7', hash: sha256('lost') });
  const report = inventory(store);
  const missing = report.missing.find((row) => row.code === 'missing-revision');
  assert.equal(missing.evidence.ref, 'doc_lost@7');
  assert.equal(missing.evidence.blob.status, 'missing-blob');
  assert.equal(missing.evidence.hash, sha256('lost'));
});

// 责任：迁移读取须限定大小并严格解码，但不得收窄旧内嵌读者兼容范围。
test('migration blob reads are bounded and strict without narrowing the legacy inline reader', (t) => {
  const { dir, store } = diskFixture(t);
  const reader = new JsonlStore(dir, { project: store.state.project }, { lock: false });
  for (const body of ['\uFEFFold\r\n', '\0a\0b']) {
    const hash = sha256(body);
    fs.writeFileSync(path.join(dir, 'blobs', hash), body);
    assert.equal(reader.readBlob(hash), body, 'existing reader API and valid strings remain unchanged');
    assert.equal(reader.readMigrationBlob(hash), body, 'archive read preserves BOM/NUL/raw UTF-8 without preview heuristics');
  }
  const invalid = sha256('invalid');
  fs.writeFileSync(path.join(dir, 'blobs', invalid), Buffer.from([0xff]));
  assert.equal(reader.readMigrationBlob(invalid), null);
  const large = path.join(dir, 'blobs', sha256('large'));
  fs.writeFileSync(large, '');
  fs.truncateSync(large, 16 * 1024 * 1024 + 1);
  assert.equal(reader.readMigrationBlob(sha256('large')), null);
});

// 责任：默认 CLI 只准合成数据，读取真实 store 参数缺显式授权时必须拒绝。
test('default CLI is synthetic only and real-store reading requires explicit authorization', () => {
  const report = JSON.parse(execFileSync(process.execPath, ['scripts/doc-migration.mjs'], { encoding: 'utf8' }));
  assert.equal(report.projectId, 'prj_migration_fixture');
  assert.throws(() => execFileSync(process.execPath, ['scripts/doc-migration.mjs', '--store', 'nonexistent'], { stdio: 'pipe' }), /authorized-read/);
});
