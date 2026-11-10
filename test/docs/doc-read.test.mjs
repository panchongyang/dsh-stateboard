/**
 * 测试职责：约束工作区文档安全定位、原始字节哈希、严格解码与有界预览。
 * 典型流程：临时文件和 fs 故障钩子 → locate/readDocument → 比较可用性分类、哈希、预览及关闭行为。
 * 覆盖边界：覆盖 路径逃逸、文件替换、读中竞态、大小/格式上限；不覆盖真实网络盘权限或视觉。
 * 外部前置：junction/symlink 用例需要平台链接权限，不能创建时跳过；其余无外部依赖。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { locateDocument, validateRelPath } from '../../lib/core/documents/locate.js';
import { AVAILABILITY_CODES, MAX_DOC_BYTES, MAX_PREVIEW_BYTES, previewOf, readDocument } from '../../lib/core/documents/read.js';
import { hashFileSync } from '../../lib/core/evidence.js';

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'doc-read-'));
}

function put(root, rel, body) {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

function digest(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Directory listing with sizes: proves a read created or rewrote nothing. */
function tree(root, base = root, out = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    out.push(rel + (entry.isDirectory() ? '/' : ':' + fs.statSync(full).size));
    if (entry.isDirectory()) tree(full, base, out);
  }
  return out.sort();
}

// 责任：文档读取和预览的默认上限必须分别冻结为 16 MiB 与 256 KiB。
test('contract constants stay at the frozen caps', () => {
  assert.equal(MAX_DOC_BYTES, 16 * 1024 * 1024);
  assert.equal(MAX_PREVIEW_BYTES, 256 * 1024);
});

// 责任：可用性分类须与命令错误码同表，只有 readable 可对应空错误码。
test('availability names and command codes are one table', () => {
  const expected = [
    'readable', 'missing', 'root_unavailable', 'missing_binding', 'permission_denied',
    'outside_root', 'not_regular', 'oversize', 'unsupported_format', 'undecodable',
    'unstable', 'security_rejected',
  ];
  assert.deepEqual(Object.keys(AVAILABILITY_CODES).sort(), expected.sort());
  assert.equal(AVAILABILITY_CODES.readable, null);
  for (const [availability, code] of Object.entries(AVAILABILITY_CODES)) {
    if (availability === 'readable') continue;
    assert.equal(typeof code, 'string', availability + ' has no command code');
  }
});

// 责任：读取短 markdown 须返回原始字节哈希、完整文本和未截断预览。
test('reads markdown with the raw-byte hash and an untruncated preview', () => {
  const root = workspace();
  const body = '# Title\n\nbody line\n';
  const file = put(root, 'docs/guide.md', body);
  const result = readDocument(root, 'docs/guide.md');
  assert.equal(result.ok, true);
  assert.equal(result.availability, 'readable');
  assert.equal(result.previewable, true);
  assert.equal(result.hash, digest(fs.readFileSync(file)));
  assert.equal(result.size, Buffer.byteLength(body));
  assert.equal(result.text, body);
  assert.deepEqual(result.preview, { text: body, truncated: false, totalBytes: Buffer.byteLength(body) });
});

// 责任：UTF-8 BOM 只从显示文本去除，哈希及 size 仍须按含 BOM 原始字节计算。
test('strips the BOM from display text but hashes the raw bytes', () => {
  const root = workspace();
  const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# bom\n')]);
  put(root, 'bom.md', body);
  const result = readDocument(root, 'bom.md');
  assert.equal(result.ok, true);
  assert.equal(result.text, '# bom\n');
  assert.equal(result.hash, digest(body));
  assert.equal(result.size, body.length);
});

// 责任：绝对/越界/设备名/ADS 等危险路径须在触盘前分类为 security_rejected。
test('lexical gate refuses host paths before the disk is consulted', () => {
  const cases = [
    ['', 'empty-path'],
    ['/etc/passwd', 'absolute-path'],
    ['C:/windows/win.ini', 'drive-prefix'],
    ['a\\b.md', 'backslash'],
    ['../escape.md', 'dot-segment'],
    ['./same.md', 'dot-segment'],
    ['a//b.md', 'empty-segment'],
    ['a/', 'empty-segment'],
    ['con', 'device-name'],
    ['notes.md ', 'trailing-space-or-dot'],
    ['notes.md.', 'trailing-space-or-dot'],
    ['file.md:stream', 'ads-stream'],
    ['bad\u0000name', 'control-character'],
  ];
  for (const [input, detail] of cases) {
    const result = validateRelPath(input);
    assert.equal(result.ok, false, 'accepted: ' + JSON.stringify(input));
    assert.equal(result.availability, 'security_rejected');
    assert.equal(result.code, 'security-rejected');
    assert.equal(result.detail, detail);
  }
});

// 责任：根内多级相对文档路径须定位到真实目标且标记成功。
test('locator resolves a nested document inside the root', () => {
  const root = workspace();
  const file = put(root, 'docs/deep/a.md', 'x');
  const located = locateDocument(root, 'docs/deep/a.md');
  assert.equal(located.ok, true);
  assert.equal(located.absolute, fs.realpathSync(file));
  assert.deepEqual(located.segments, ['docs', 'deep', 'a.md']);
});

// 责任：通过 junction 指向根外文件时须 outside_root，不能读取外部正文。
test('a junction that leaves the root is outside-root', (t) => {
  const root = workspace();
  const outside = workspace();
  put(outside, 'secret.md', '# secret');
  try {
    fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
  } catch (err) {
    t.skip('junction not permitted on this host: ' + err.code);
    return;
  }
  const result = readDocument(root, 'link/secret.md');
  assert.equal(result.ok, false);
  assert.equal(result.availability, 'outside_root');
  assert.equal(result.code, 'outside-root');
});

// 责任：缺文件与根目录不可用须给不同 availability，不能混为 missing。
test('a missing document and a missing root are classified apart', () => {
  const root = workspace();
  const missing = readDocument(root, 'nope.md');
  assert.equal(missing.availability, 'missing');
  assert.equal(missing.code, 'file-missing');
  const noRoot = readDocument(path.join(root, 'gone'), 'nope.md');
  assert.equal(noRoot.availability, 'root_unavailable');
  assert.equal(noRoot.code, 'root-unavailable');
});

// 责任：目标为目录时须 not_regular，不得当正文读出。
test('a directory is not a regular file', () => {
  const root = workspace();
  put(root, 'docs/a.md', 'x');
  const result = readDocument(root, 'docs');
  assert.equal(result.ok, false);
  assert.ok(['not_regular', 'permission_denied'].includes(result.availability), 'got ' + result.availability);
  if (result.availability === 'permission_denied') assert.equal(result.code, 'permission-denied');
});

// 责任：超过文档上限时须 oversize 且不得返回正文或内容哈希。
test('a document above the cap is refused without content or hash', () => {
  const root = workspace();
  put(root, 'big.txt', 'x'.repeat(64));
  const result = readDocument(root, 'big.txt', { maxBytes: 16 });
  assert.equal(result.ok, false);
  assert.equal(result.availability, 'oversize');
  assert.equal(result.code, 'oversize');
  assert.equal(result.hash, undefined);
  assert.equal(result.text, undefined);
});

// 责任：非法 UTF-8 须 undecodable，不能用替换字符伪装成功文本。
test('invalid UTF-8 is undecodable, never replacement characters', () => {
  const root = workspace();
  put(root, 'broken.md', Buffer.from([0x68, 0xff, 0xfe, 0x0a]));
  const result = readDocument(root, 'broken.md');
  assert.equal(result.ok, false);
  assert.equal(result.availability, 'undecodable');
  assert.equal(result.code, 'undecodable');
});

// 责任：预览须在完整字符边界截断，同时仍报告全文字节数。
test('preview truncates on a character boundary and reports the full size', () => {
  const root = workspace();
  const body = '中'.repeat(200);
  put(root, 'wide.md', body);
  const result = readDocument(root, 'wide.md', { previewBytes: 7 });
  assert.equal(result.ok, true);
  assert.equal(result.preview.truncated, true);
  assert.equal(result.preview.totalBytes, 600);
  assert.equal(result.preview.text, '中中');
  assert.ok(Buffer.byteLength(result.preview.text, 'utf8') <= 7);
  assert.equal(result.text, body);
});

// 责任：以代理对字符临界位置截断时，不得切出半个 Unicode 字符。
test('previewOf never splits a surrogate pair', () => {
  const preview = previewOf('a😀b', 4);
  assert.equal(preview.text, 'a');
  assert.equal(preview.truncated, true);
  assert.equal(preview.totalBytes, 6);
});

// 责任：两次 stat 之间文件改变须判 unstable，不能返回过期正文。
test('a file that changes between the two stats reads as unstable', () => {
  const root = workspace();
  put(root, 'racing.md', '# stable\n');
  let calls = 0;
  const io = {
    ...fs,
    fstatSync(fd) {
      calls += 1;
      const stat = fs.fstatSync(fd);
      if (calls === 1) return stat;
      return { ...stat, isFile: () => stat.isFile(), size: stat.size + 1, mtimeMs: stat.mtimeMs + 1 };
    },
  };
  const single = readDocument(root, 'racing.md', { io, attempts: 1 });
  assert.equal(single.ok, false);
  assert.equal(single.availability, 'unstable');
  assert.equal(single.code, 'unstable');
  assert.equal(single.hash, undefined);
  const retried = readDocument(root, 'racing.md', { io, attempts: 2 });
  assert.equal(retried.availability, 'unstable');
  assert.ok(calls >= 4, 'a retry must take a second look, saw ' + calls + ' stats');
});

// 责任：注入权限错误后须分类 permission_denied，而非泄漏原生异常。
test('permission failures classify as permission_denied', () => {
  const root = workspace();
  put(root, 'locked.md', 'x');
  const io = {
    ...fs,
    openSync() {
      const err = new Error('denied');
      err.code = 'EACCES';
      throw err;
    },
  };
  const result = readDocument(root, 'locked.md', { io });
  assert.equal(result.availability, 'permission_denied');
  assert.equal(result.code, 'permission-denied');
});

// 责任：二进制格式可登记但不可预览，不能当 markdown 文本呈现。
test('binary formats stay registrable but are not previewed', () => {
  const root = workspace();
  put(root, 'assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  const result = readDocument(root, 'assets/logo.png');
  assert.equal(result.ok, true);
  assert.equal(result.availability, 'unsupported_format');
  assert.equal(result.previewable, false);
  assert.equal(result.reason, 'unsupported-format');
  assert.equal(result.detail, 'extension');
  assert.equal(result.text, null);
  assert.equal(result.hash, digest(fs.readFileSync(path.join(root, 'assets/logo.png'))));
});

// 责任：成功读取与拒绝读取前后文件树均须不变，不得在根内写缓存或临时产物。
test('a successful read writes nothing and a refused read reads nothing into the tree', () => {
  const root = workspace();
  put(root, 'docs/a.md', '# a\n');
  put(root, 'big.txt', 'x'.repeat(64));
  const before = tree(root);
  readDocument(root, 'docs/a.md');
  readDocument(root, 'big.txt', { maxBytes: 8 });
  readDocument(root, '../escape.md');
  assert.deepEqual(tree(root), before);
});

// 责任：文档读取与文件证据对同一文件必须计算相同原始字节哈希。
test('workspace documents and file evidence hash the same bytes', () => {
  const root = workspace();
  const file = put(root, 'docs/same.md', '# same bytes\n');
  const document = readDocument(root, 'docs/same.md');
  assert.equal(document.hash, hashFileSync(file));
  assert.equal(document.hash, digest(fs.readFileSync(file)));
});

// 责任：读取期间原路径被替换时须拒绝，不得返回旧句柄的陈旧内容。
test('a file replaced at the same path is refused instead of served stale', () => {
  const root = workspace();
  put(root, 'swap.md', '# old\n');
  // The realpath string is identical; only the object behind it changed, which
  // is exactly the case a string comparison cannot see.
  const io = {
    ...fs,
    statSync(target, ...rest) {
      const stat = fs.statSync(target, ...rest);
      return { ...stat, dev: stat.dev + 1, ino: stat.ino + 1 };
    },
  };
  const result = readDocument(root, 'swap.md', { io, attempts: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.availability, 'unstable');
  assert.equal(result.detail, 'path-replaced');
  assert.equal(result.text, undefined);
});

// 责任：绑定根在读取期间改变时须拒绝，防止跨根内容混配。
test('a binding root that moves during the read is refused', () => {
  const root = workspace();
  put(root, 'a.md', 'x');
  const realRoot = fs.realpathSync(root);
  let rootReads = 0;
  const io = {
    ...fs,
    realpathSync(target, ...rest) {
      const real = fs.realpathSync(target, ...rest);
      if (real !== realRoot) return real;
      rootReads += 1;
      return rootReads > 1 ? real + '-moved' : real;
    },
  };
  const result = readDocument(root, 'a.md', { io, attempts: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.availability, 'unstable');
  assert.equal(result.detail, 'root-changed');
});

// 责任：调用者只能缩紧默认上限，异常选项也不能得到空结果逃过分类。
test('options may only tighten the caps and never yield null', () => {
  const root = workspace();
  put(root, 'a.md', 'x');
  const rejected = [
    { maxBytes: MAX_DOC_BYTES + 1 },
    { maxBytes: 0 },
    { maxBytes: 1.5 },
    { maxBytes: '16' },
    { previewBytes: MAX_PREVIEW_BYTES + 1 },
    { previewBytes: 0 },
    { attempts: 0 },
    { attempts: 3 },
    { attempts: 1.5 },
  ];
  for (const options of rejected) {
    assert.throws(() => readDocument(root, 'a.md', options), RangeError, JSON.stringify(options));
  }
  const tightened = readDocument(root, 'a.md', { maxBytes: 8, previewBytes: 4 });
  assert.equal(tightened.ok, true);
});

// 责任：读取阶段异常须转分类结果，打开的句柄必须关闭。
test('read-stage failures are classified, not thrown, and the handle is closed', () => {
  const root = workspace();
  put(root, 'a.md', 'hello');
  let closed = 0;
  const io = {
    ...fs,
    readSync() {
      const err = new Error('io');
      err.code = 'EIO';
      throw err;
    },
    closeSync(fd) {
      closed += 1;
      return fs.closeSync(fd);
    },
  };
  const result = readDocument(root, 'a.md', { io, attempts: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.availability, 'unstable');
  assert.equal(result.detail, 'EIO');
  assert.equal(closed, 1, 'the handle must be closed exactly once');
  assert.equal(result.text, undefined);
  assert.equal(result.hash, undefined);
});

// 责任：句柄 stat 失败也须转分类并关闭句柄，不能泄漏描述符。
test('a failing stat is classified and still closes the handle', () => {
  const root = workspace();
  put(root, 'a.md', 'hello');
  let closed = 0;
  const io = {
    ...fs,
    fstatSync() {
      const err = new Error('denied');
      err.code = 'EACCES';
      throw err;
    },
    closeSync(fd) {
      closed += 1;
      return fs.closeSync(fd);
    },
  };
  const result = readDocument(root, 'a.md', { io, attempts: 1 });
  assert.equal(result.availability, 'permission_denied');
  assert.equal(result.code, 'permission-denied');
  assert.equal(closed, 1);
});

// 责任：markdown 含 NUL 时不得进入可显示预览，避免二进制伪装。
test('a markdown file carrying NUL bytes never reaches the preview', () => {
  const root = workspace();
  const body = Buffer.concat([Buffer.from('# head\n'), Buffer.from([0, 0, 0]), Buffer.from('binary')]);
  put(root, 'sneaky.md', body);
  const result = readDocument(root, 'sneaky.md');
  assert.equal(result.ok, true);
  assert.equal(result.availability, 'unsupported_format');
  assert.equal(result.previewable, false);
  assert.equal(result.detail, 'nul-byte');
  assert.equal(result.text, null);
  assert.equal(result.hash, digest(body));
});

// 责任：UTF-16 无论带不带 BOM 都不得预览，须分别标记编码或 NUL 诊断。
test('UTF-16 content is refused whether or not it carries a BOM', () => {
  const root = workspace();
  put(root, 'with-bom.md', Buffer.from('\ufeff# hello', 'utf16le'));
  const bom = readDocument(root, 'with-bom.md');
  assert.equal(bom.ok, true);
  assert.equal(bom.previewable, false);
  assert.equal(bom.detail, 'utf-16le');
  // BOM-less ASCII is the same payload with its zero bytes doing the talking.
  put(root, 'no-bom.md', Buffer.from('# hello', 'utf16le'));
  const bare = readDocument(root, 'no-bom.md');
  assert.equal(bare.ok, true);
  assert.equal(bare.previewable, false);
  assert.equal(bare.detail, 'nul-byte');
});

// 责任：UTF-8 BOM 不计入预览正文长度，但文件 size 必须仍包含 BOM 字节。
test('a UTF-8 BOM shortens the preview length but not the reported file size', () => {
  const root = workspace();
  const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('中'.repeat(10))]);
  put(root, 'bom-preview.md', body);
  const result = readDocument(root, 'bom-preview.md', { previewBytes: 7 });
  assert.equal(result.ok, true);
  assert.equal(result.bomStripped, true);
  assert.equal(result.size, body.length);
  assert.equal(result.preview.totalBytes, 30);
  assert.equal(result.preview.truncated, true);
  assert.equal(result.preview.text, '中中');
});

// 责任：即使 junction 最终仍在根内，路径含链接组件也须 security_rejected。
test('a junction that stays inside the root is still refused as a link component', (t) => {
  const root = workspace();
  put(root, 'inner/a.md', 'x');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  try {
    fs.symlinkSync(path.join(root, 'inner'), path.join(root, 'sub', 'link'), 'junction');
  } catch (err) {
    t.skip('junction not permitted on this host: ' + err.code);
    return;
  }
  const result = readDocument(root, 'sub/link/a.md');
  assert.equal(result.ok, false);
  assert.equal(result.availability, 'security_rejected');
  assert.equal(result.detail, 'link-component');
});
