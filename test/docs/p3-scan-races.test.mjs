/**
 * 测试职责：扫描代的目录/根对象与读取期间策略变更隔离。
 * 典型流程：临时 fixture 扫描或回读 → 注入对象/策略变更 → 验证拒绝而非旧缓存。
 * 覆盖边界：覆盖 内核竞态与负缓存复用；不覆盖 host 授权代或真实 OS 权限迁移。
 * 外部前置：仅 Node，全部使用合成隔离目录，无 Git 与真实 store。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectionScanner } from '../../lib/core/reader/discovery/scanner.js';
const tmp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'p3-scan-races-')));
const scanner = root => createProjectionScanner({ root, projectId: 'fixture', workspaceContext: { workspaceId: 'fixture' }, policyVersion: 1, scopeKey: 'fixture' });
const isCode = code => error => { assert.equal(error.code, code, error.message); return true; };
function populate(root) {
  fs.mkdirSync(path.join(root, 'docs'));
  for (let n = 0; n < 520; n++) fs.writeFileSync(path.join(root, 'docs', `f${n}.md`), 'body');
}

// 责任：根对象替换会撤销全部缓存/游标，不能只比较根路径字符串。
test('root object replacement invalidates the cursor', () => {
  const root = tmp(); populate(root); const s = scanner(root);
  const page = s.execute({ op: 'discover' }); assert.ok(page.nextCursor);
  const original = fs.lstatSync;
  fs.lstatSync = (file, options) => {
    const stat = original(file, options);
    if (path.resolve(String(file)) === root && options?.bigint) stat.ino += 1n;
    return stat;
  };
  try { assert.throws(() => s.execute({ op: 'discover', cursor: page.nextCursor }), isCode('restart-required')); }
  finally { fs.lstatSync = original; s.close(); }
});

// 责任：保留中的目录流若路径所指对象已换，不能继续枚举旧句柄。
test('retained directory stream is invalid after a directory object replacement', () => {
  const root = tmp(); populate(root); const s = scanner(root);
  const page = s.execute({ op: 'discover' }); assert.ok(page.nextCursor);
  const original = fs.lstatSync;
  fs.lstatSync = (file, options) => {
    const stat = original(file, options);
    if (path.resolve(String(file)) === path.join(root, 'docs') && options?.bigint) stat.ino += 1n;
    return stat;
  };
  try { assert.throws(() => s.execute({ op: 'discover', cursor: page.nextCursor }), isCode('restart-required')); }
  finally { fs.lstatSync = original; s.close(); }
});

// 责任：扫描中创建 ignore 后，本批尚未返回的旧规则结果不能外泄。
test('a policy changed during content reading rejects the whole unpublished batch', () => {
  const root = tmp(); fs.writeFileSync(path.join(root, 'a.md'), 'body'); const s = scanner(root);
  const original = fs.readSync; let injected = false;
  fs.readSync = (...args) => {
    const amount = original(...args);
    if (amount > 0 && !injected) { injected = true; fs.writeFileSync(path.join(root, '.gitignore'), '*.md\n'); }
    return amount;
  };
  try { assert.throws(() => s.execute({ op: 'discover' }), isCode('restart-required')); }
  finally { fs.readSync = original; s.close(); }
});

// 责任：按路径显式读取也在读取后重核策略，不能返回途中已撤范围的正文。
test('direct read rechecks ignore policy after reading bytes', () => {
  const root = tmp(); fs.writeFileSync(path.join(root, 'a.md'), 'body'); const s = scanner(root);
  const original = fs.readSync; let injected = false;
  fs.readSync = (...args) => {
    const amount = original(...args);
    if (amount > 0 && !injected) { injected = true; fs.writeFileSync(path.join(root, '.gitignore'), '*.md\n'); }
    return amount;
  };
  try { assert.throws(() => s.execute({ op: 'read_current', relPath: 'a.md' }), isCode('gitignored')); }
  finally { fs.readSync = original; s.close(); }
});

// 责任：稳定的二进制/解码失败只作负候选缓存，热扫描不为已拒绝内容重新读正文。
test('stable unsupported text candidates reuse bounded negative metadata', () => {
  const root = tmp(); fs.writeFileSync(path.join(root, 'binary.md'), Buffer.from([0, 1, 2]));
  const s = scanner(root);
  const first = s.execute({ op: 'discover' }); assert.equal(first.counts.read, 1);
  const original = fs.readSync;
  fs.readSync = () => { throw Error('negative cache must not read body'); };
  try {
    const hot = s.execute({ op: 'discover' });
    assert.equal(hot.counts.read, 0); assert.equal(hot.counts.reused, 1); assert.deepEqual(hot.entries, []);
    assert.equal(hot.rejected['unsupported-format'], 1);
  } finally { fs.readSync = original; s.close(); }
});

// 责任：旧目录句柄不能保留已撤销的列目录权限；拒绝时关闭所有旧流。
test('revoked list-directory permission rejects continuation and closes retained streams', () => {
  const root = tmp(); populate(root); const s = scanner(root);
  const original = fs.opendirSync; const live = new Set(); let denied = false;
  fs.opendirSync = (file, ...args) => {
    if (denied) throw Object.assign(Error('listing revoked'), { code: 'EACCES' });
    const dir = original(file, ...args); const wrapper = {
      readSync: () => dir.readSync(),
      closeSync: () => { live.delete(wrapper); return dir.closeSync(); },
    };
    live.add(wrapper); return wrapper;
  };
  try {
    const page = s.execute({ op: 'discover' }); assert.ok(page.nextCursor); assert.ok(live.size > 0);
    denied = true;
    assert.throws(() => s.execute({ op: 'discover', cursor: page.nextCursor }), isCode('permission-denied'));
    assert.equal(live.size, 0);
  } finally { fs.opendirSync = original; s.close(); }
});

// 责任：本批读正文之后撤销目录列权，发布前须开新句柄拒绝而非泄露条目。
test('list permission revoked during a batch rejects unpublished entries', () => {
  const root = tmp(); fs.writeFileSync(path.join(root, 'a.md'), 'body'); const s = scanner(root);
  const originalOpen = fs.opendirSync; const originalRead = fs.readSync; let denied = false;
  fs.opendirSync = (...args) => {
    if (denied) throw Object.assign(Error('listing revoked'), { code: 'EACCES' });
    return originalOpen(...args);
  };
  fs.readSync = (...args) => { const amount = originalRead(...args); if (amount > 0) denied = true; return amount; };
  try { assert.throws(() => s.execute({ op: 'discover' }), isCode('permission-denied')); }
  finally { fs.opendirSync = originalOpen; fs.readSync = originalRead; s.close(); }
});

// 责任：opendir成功后路径身份核验抛错也不能遗留目录句柄。
test('directory identity failure after opendir always closes the new handle', () => {
  const root = tmp(); fs.writeFileSync(path.join(root, 'a.md'), 'body'); const s = scanner(root);
  const originalOpen = fs.opendirSync; const originalStat = fs.lstatSync; let opened = false; let closed = false;
  fs.opendirSync = (...args) => {
    const dir = originalOpen(...args); opened = true;
    return { readSync: () => dir.readSync(), closeSync: () => { closed = true; return dir.closeSync(); } };
  };
  fs.lstatSync = (...args) => {
    if (opened) throw Object.assign(Error('identity denied'), { code: 'EACCES' });
    return originalStat(...args);
  };
  try {
    const page = s.execute({ op: 'discover' });
    assert.equal(page.entries.length, 0); assert.equal(page.errors['permission-denied'], 1); assert.equal(closed, true);
  } finally { fs.opendirSync = originalOpen; fs.lstatSync = originalStat; s.close(); }
});

// 责任：完整补扫回收已离开候选工作集的派生元数据，新工作集连续两遍唯一且热扫不读正文。
test('completed compensation scan retires stale metadata and admits the replacement working set', () => {
  const root = tmp(); fs.writeFileSync(path.join(root, 'a.md'), 'body'); const s = scanner(root);
  try {
    assert.equal(s.execute({ op: 'discover' }).cache.entries, 1);
    // Both absolute paths are fixture-owned; rotate, never delete source bytes.
    fs.renameSync(path.join(root, 'a.md'), path.join(root, 'a.js'));
    assert.equal(s.execute({ op: 'discover' }).cache.entries, 0);
    fs.writeFileSync(path.join(root, 'b.md'), 'replacement');
    const cold = s.execute({ op: 'discover' }); const hot = s.execute({ op: 'discover' });
    assert.deepEqual(cold.entries.map(entry => entry.relPath), ['b.md']);
    assert.deepEqual(hot.entries.map(entry => entry.relPath), ['b.md']);
    assert.equal(hot.counts.read, 0); assert.equal(hot.counts.reused, 1); assert.equal(hot.cache.entries, 1);
  } finally { s.close(); }
});

// 责任：原生Dir.readSync的I/O/权限错误归入errors，且跨续页保留整代不可恢复缺口。
test('native directory read failures remain errors and partial through the final continuation', () => {
  for (const nativeCode of ['EIO', 'EACCES']) {
    const root = tmp(); fs.mkdirSync(path.join(root, 'bad')); fs.writeFileSync(path.join(root, 'bad', 'lost.md'), 'body');
    for (let index = 0; index < 530; index++) fs.writeFileSync(path.join(root, `z${index}.md`), 'body');
    const s = scanner(root); const original = fs.opendirSync; let injected = false;
    fs.opendirSync = (file, ...args) => {
      const dir = original(file, ...args);
      if (path.resolve(String(file)) !== path.join(root, 'bad') || injected) return dir;
      injected = true;
      return { readSync: () => { throw Object.assign(Error('native enumeration failed'), { code: nativeCode }); }, closeSync: () => dir.closeSync() };
    };
    try {
      const pages = []; let cursor;
      do { const page = s.execute({ op: 'discover', cursor }); pages.push(page); cursor = page.nextCursor; assert.ok(pages.length < 200); } while (cursor);
      const reason = nativeCode === 'EACCES' ? 'permission-denied' : 'unstable';
      assert.equal(injected, true); assert.equal(pages.at(-1).partial, true);
      assert.equal(pages.at(-1).errors[reason], 1);
      assert.equal(pages.some(page => nativeCode in page.rejected), false);
      assert.equal(pages.flatMap(page => page.entries).some(entry => entry.relPath === 'bad/lost.md'), false);
    } finally { fs.opendirSync = original; s.close(); }
  }
});

// 责任：早页因忽略规则非法而剪去子树，末页无新错误仍需返回同一代的缺口。
test('a rejected subtree remains a coverage gap after a clean continuation', () => {
  const root = tmp(); fs.mkdirSync(path.join(root,'one')); fs.mkdirSync(path.join(root,'two'));
  const order = fs.opendirSync(root); let first, second;
  try { first = order.readSync().name; second = order.readSync().name; } finally { order.closeSync(); }
  fs.writeFileSync(path.join(root,first,'.gitignore'),'[unterminated');
  for (let i=0;i<535;i++) fs.writeFileSync(path.join(root,second,`file-${i}.js`),'');
  const s = scanner(root);
  try {
    let page = s.execute({op:'discover'}); assert.ok(page.nextCursor); assert.equal(page.counts.rejected['ignore-invalid'],1);
    for (let n=0; page.nextCursor && n<32; n++) page = s.execute({op:'discover',cursor:page.nextCursor});
    assert.equal(page.nextCursor,null); assert.equal(page.counts.rejected['ignore-invalid'],undefined);
    assert.equal(page.partial,true); assert.equal(page.coverageGaps.rejected['ignore-invalid'],1);
  } finally { s.close(); }
});

// 责任：NTFS 大小写别名不允许绕开实际磁盘路径上的 ignore 规则。
test('case aliases cannot bypass ignore policy on case-insensitive filesystems', t => {
  const root = tmp(); fs.writeFileSync(path.join(root, 'Secret.md'), 'body'); fs.writeFileSync(path.join(root, '.gitignore'), 'Secret.md\n');
  if (!fs.existsSync(path.join(root, 'secret.md'))) { t.skip('case-sensitive filesystem has no alias'); return; }
  const s = scanner(root);
  try { assert.throws(() => s.execute({ op: 'read_current', relPath: 'secret.md' }), isCode('gitignored')); }
  finally { s.close(); }
});
