/**
 * 测试职责：验证留存正文采集时的空间归属及完整字节身份。
 * 典型流程：建立合成空间和文件，变更路径或原文后验证结果。
 * 覆盖边界：覆盖授权定位、复制与读取失败；不覆盖宿主工具和日志提交。
 * 外部前置：仅使用 Node 和隔离的临时工作区文件。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openSpaceDirectory } from '../../lib/core/store/space-home.js';
import { ProjectService } from '../../lib/core/service.js';
import { legacyBindingId } from '../../lib/core/identity/registry.js';
import { readDocument } from '../../lib/core/documents/read.js';
import { assertWorkspaceSourceLocator, observeWorkspaceSource, workspaceLocatorKey } from '../../lib/core/documents/workspace-source.js';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-p2-source-')));
  const A = path.join(base, 'A'), B = path.join(base, 'B');
  fs.mkdirSync(A); fs.mkdirSync(B);
  const project = { id: 'prj_0123456789abcdef', workspacePath: A };
  const state = path.join(B, '.projectboard', 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'meta.json'), JSON.stringify({ projectId: project.id, project }));
  // This suite tests the source port, not event replay. The home requires a
  // non-empty ledger; no test opens this synthetic sentinel as an event store.
  fs.writeFileSync(path.join(state, 'commits.jsonl'), 'source-port-fixture\n');
  const home = openSpaceDirectory(B); home.readMeta();
  const locator = relPath => ({ bindingId: legacyBindingId(project.id, A), relPath });
  const doc = relPath => ({ source: 'external', locator: locator(relPath) });
  return { A, B, home, project, locator, doc };
}
const code = expected => error => error?.name === 'BoardError' && error.code === expected;

// 责任：读取完整副本的字节，不能向旧空间取正文。
test('copied space reads B complete raw bytes, preserves BOM/CRLF/empty, never A', t => {
  const f = fixture();
  const native = fs.realpathSync.native;
  t.mock.method(fs.realpathSync, 'native', (input, ...args) => {
    assert.notEqual(path.resolve(String(input)), f.A, 'historical root must not even be realpathed');
    return native(input, ...args);
  });
  // IDs were formed before the spy; source authorization reproduces old IDs lexically.
  const oldId = 'bnd_legacy_' + hash(f.project.id + '\n' + (process.platform === 'win32' ? f.A.toLowerCase() : f.A)).slice(0, 16);
  for (const [name, bytes] of [['bom.md', Buffer.from('\ufeffB 中文\r\n')], ['empty.txt', Buffer.alloc(0)], ['long.md', Buffer.alloc(300 * 1024, 65)]]) {
    fs.writeFileSync(path.join(f.A, name), 'A must not leak');
    fs.writeFileSync(path.join(f.B, name), bytes);
    const doc = { source: 'external', locator: { bindingId: oldId, relPath: name } };
    const before = fs.readFileSync(path.join(f.B, '.projectboard/state/commits.jsonl'));
    const result = observeWorkspaceSource(f.home, f.project, doc);
    assert.deepEqual(result, { bytes, contentHash: hash(bytes), size: bytes.length });
    assert.deepEqual(fs.readFileSync(path.join(f.B, '.projectboard/state/commits.jsonl')), before);
    assert.deepEqual(fs.readFileSync(path.join(f.B, name)), bytes);
  }
});

// 责任：仅承认当前物理空间及已知主绑定。
test('only logged legacy main/current space main authorize; missing current stays missing', () => {
  const f = fixture(); fs.writeFileSync(path.join(f.A, 'a.md'), 'A');
  assert.throws(() => observeWorkspaceSource(f.home, f.project, f.doc('a.md')), code('file-missing'));
  assert.doesNotThrow(() => assertWorkspaceSourceLocator(f.home, f.project, f.locator('a.md')));
  const current = { bindingId: legacyBindingId(f.project.id, f.B), relPath: 'a.md' };
  assert.doesNotThrow(() => assertWorkspaceSourceLocator(f.home, f.project, current));
  for (const bindingId of ['bnd_anything', legacyBindingId('prj_ffffffffffffffff', f.A), legacyBindingId(f.project.id, path.dirname(f.B))]) {
    assert.throws(() => assertWorkspaceSourceLocator(f.home, f.project, { ...current, bindingId }), code('missing-binding'));
  }
  assert.throws(() => assertWorkspaceSourceLocator(f.home, { ...f.project, id: 'prj_ffffffffffffffff' }, current), code('missing-binding'));
});

// 责任：拒绝保留路径、目录联接和多硬链接。
test('reserved names, lexical traversal, junctions and multiply linked files are rejected', () => {
  const f = fixture();
  for (const name of ['.projectboard/state/meta.json', '.GIT/config', 'docs/.ENV.local', 'secrets/a.md', 'docs/id_rsa.md', 'credentials.txt', 'a.key']) {
    assert.throws(() => assertWorkspaceSourceLocator(f.home, f.project, f.locator(name)), {code:'reserved-path',status:403});
  }
  for (const name of ['../outside.md', '/absolute.md', 'a\\b.md', 'a.md:stream']) {
    assert.throws(() => assertWorkspaceSourceLocator(f.home, f.project, f.locator(name)), code('security-rejected'));
  }
  fs.writeFileSync(path.join(f.B, 'single.md'), 'one');
  fs.linkSync(path.join(f.B, 'single.md'), path.join(f.B, 'alias.md'));
  assert.throws(() => workspaceLocatorKey(f.home, f.project, f.locator('single.md')), code('security-rejected'));
  fs.mkdirSync(path.join(f.A, 'outside')); fs.writeFileSync(path.join(f.A, 'outside', 'a.md'), 'outside');
  fs.symlinkSync(path.join(f.A, 'outside'), path.join(f.B, 'jump'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => observeWorkspaceSource(f.home, f.project, f.doc('jump/a.md')), code('outside-root'));
});

// 责任：按物理文件身份处理路径别名。
test('locator keys use physical dev:ino, including Windows case aliases', () => {
  const f = fixture(); fs.writeFileSync(path.join(f.B, 'Case.md'), 'one'); fs.writeFileSync(path.join(f.B, 'other.md'), 'one');
  const key = workspaceLocatorKey(f.home, f.project, f.locator('Case.md'));
  assert.match(key, /^\d+:\d+\/\d+:\d+$/);
  assert.notEqual(key, workspaceLocatorKey(f.home, f.project, f.locator('other.md')));
  if (process.platform === 'win32') assert.equal(key, workspaceLocatorKey(f.home, f.project, f.locator('case.MD')));
});

// 责任：验证格式和字节大小限制。
test('strict format and byte cap classify invalid UTF-8, binary and oversize', () => {
  const f = fixture();
  for (const [name, bytes, expected] of [['bad.md', Buffer.from([0xff]), 'undecodable'], ['binary.md', Buffer.from([65, 0]), 'unsupported-format'], ['utf16.md', Buffer.from([0xff, 0xfe, 65, 0]), 'unsupported-format']]) {
    fs.writeFileSync(path.join(f.B, name), bytes);
    assert.throws(() => observeWorkspaceSource(f.home, f.project, f.doc(name)), {code:expected,status:400});
  }
  fs.writeFileSync(path.join(f.B, 'limit.md'), Buffer.alloc(16 * 1024 * 1024, 65));
  assert.equal(observeWorkspaceSource(f.home, f.project, f.doc('limit.md')).size, 16 * 1024 * 1024);
  fs.appendFileSync(path.join(f.B, 'limit.md'), 'B');
  assert.throws(() => observeWorkspaceSource(f.home, f.project, f.doc('limit.md')), {code:'oversize',status:413});
});

// 责任：复制后新登记的身份能随下一份副本携带。
test('space main IDs stay portable for new B registrations copied again to C', async t => {
  const f = fixture();
  const C = path.join(path.dirname(f.B), 'C');
  const b = new ProjectService({ spaceRoot: f.B }); await b.init(); t.after(() => b.close());
  const mainB = b.bindings().mainOf(f.project.id);
  assert.equal(mainB.root, f.B);
  assert.equal(mainB.bindingId, f.locator('new.md').bindingId, 'B uses original main identity, not physical B identity');
  assert.equal(b.bindings().byRoot(f.B)[0], mainB);
  fs.writeFileSync(path.join(f.B, 'new.md'), 'newly registered on B');
  const registeredOnB = { source: 'external', locator: { bindingId: mainB.bindingId, relPath: 'new.md' } };
  assert.equal(observeWorkspaceSource(b.spaceHome, f.project, registeredOnB).bytes.toString(), 'newly registered on B');
  // The previous P1 physical B ID remains a read-only source alias on B.
  assert.doesNotThrow(() => assertWorkspaceSourceLocator(b.spaceHome, f.project, { ...registeredOnB.locator, bindingId: legacyBindingId(f.project.id, f.B) }));
  fs.cpSync(f.B, C, { recursive: true, errorOnExist: true, force: false });
  fs.writeFileSync(path.join(C, 'new.md'), 'current C, never B');
  const c = new ProjectService({ spaceRoot: C }); await c.init(); t.after(() => c.close());
  const mainC = c.bindings().mainOf(f.project.id);
  assert.equal(mainC.root, C); assert.equal(mainC.bindingId, mainB.bindingId);
  assert.equal(c.bindings().byRoot(C)[0], mainC);
  assert.doesNotThrow(() => assertWorkspaceSourceLocator(c.spaceHome, f.project, registeredOnB.locator));
  assert.equal(observeWorkspaceSource(c.spaceHome, f.project, registeredOnB).bytes.toString(), 'current C, never B');
  assert.throws(() => assertWorkspaceSourceLocator(c.spaceHome, f.project, { ...registeredOnB.locator, bindingId: legacyBindingId(f.project.id, f.B) }), code('missing-binding'), 'unrecorded intermediate root does not grant authority on C');
});

// 责任：读取不稳定时拒绝交付部分字节。
test('existing strict reader classifies an unstable read without returning partial bytes', () => {
  const f = fixture(); fs.writeFileSync(path.join(f.B, 'unstable.md'), 'A');
  const io = Object.create(fs);
  io.readSync = (...args) => { const n = fs.readSync(...args); fs.appendFileSync(path.join(f.B, 'unstable.md'), 'B'); return n; };
  const result = readDocument(f.B, 'unstable.md', { io, includeBytes: true });
  assert.equal(result.ok, false); assert.equal(result.code, 'unstable'); assert.equal(result.bytes, undefined);
});
