/**
 * 测试职责：保证仓库文本在 autocrlf 主机检出后仍具有固定 LF 原始字节。
 * 典型流程：把仓库属性放入临时 Git 仓库 → 提交 LF 后修改再 checkout → 比较字节、哈希与属性。
 * 覆盖边界：覆盖 LF 强制规则、无规则反例和二进制豁免；不覆盖全部文件格式或真实工作树恢复。
 * 外部前置：需要 Git；只改临时仓库配置。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Workspace bytes are the identity of external documents, so a checkout must
// reproduce the committed LF bytes on every host -- not the bytes implied by the
// local core.autocrlf setting. These tests use throwaway repositories only.
const root = path.resolve(import.meta.dirname, '../..');
const attributes = fs.readFileSync(path.join(root, '.gitattributes'), 'utf8');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'core.hooksPath=', ...args], {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function repository(t, rules) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-eol-'));
  // Windows may briefly hold a handle on the just-written index; cleanup must
  // not turn a passing assertion into an EBUSY test failure.
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    catch { /* the OS temp dir is disposable */ }
  });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'EOL Test');
  git(dir, 'config', 'user.email', 'eol@example.invalid');
  git(dir, 'config', 'core.autocrlf', 'true');
  if (rules !== undefined) fs.writeFileSync(path.join(dir, '.gitattributes'), rules);
  return dir;
}

function commitLfDocument(dir, relative, body) {
  fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
  fs.writeFileSync(path.join(dir, relative), body);
  git(dir, 'add', relative);
  git(dir, 'commit', '-qm', 'fixture');
}

// 责任：在 autocrlf=true 下恢复 markdown 后须与已提交 LF 字节和哈希一致，不能混入 CR。
test('restoring a document keeps the committed LF bytes with core.autocrlf=true', (t) => {
  const dir = repository(t, attributes);
  const relative = 'docs/decisions/sample.md';
  const committed = '# 标题\n\n正文一行\n正文两行\n';
  commitLfDocument(dir, relative, committed);

  // Simulate an edited workspace file, then the board-facing restore path.
  fs.writeFileSync(path.join(dir, relative), '# 本地编辑\n');
  git(dir, 'checkout', '--', relative);

  const restored = fs.readFileSync(path.join(dir, relative));
  assert.equal(restored.toString('utf8'), committed);
  assert.equal(sha256(restored), sha256(Buffer.from(committed, 'utf8')));
  assert.equal(restored.includes(0x0d), false, 'restored bytes must not gain CR');
  assert.match(git(dir, 'ls-files', '--eol', '--', relative), /i\/lf\s+w\/lf/);
});

// 责任：去掉属性规则的对照恢复须产生 CRLF 且哈希不同，证明回归场景真实存在。
test('without the rule the same restore writes CRLF (the regression is real)', (t) => {
  const dir = repository(t);
  const relative = 'docs/decisions/sample.md';
  const committed = 'line one\nline two\n';
  commitLfDocument(dir, relative, committed);

  fs.writeFileSync(path.join(dir, relative), 'local edit\n');
  git(dir, 'checkout', '--', relative);

  const restored = fs.readFileSync(path.join(dir, relative));
  assert.equal(restored.toString('utf8'), committed.replaceAll('\n', '\r\n'));
  assert.notEqual(sha256(restored), sha256(Buffer.from(committed, 'utf8')));
});

// 责任：属性查询须让文本为 auto/lf、PNG 为非文本，避免二进制换行转换。
test('the repository rule pins LF for text and exempts binary assets', (t) => {
  assert.match(attributes, /^\* text=auto eol=lf$/m);
  const dir = repository(t, attributes);
  const fields = git(dir, 'check-attr', '-z', 'text', 'eol', '--', 'docs/spec.md', 'docs/image.png').split('\0');
  const attrs = {};
  for (let i = 0; i + 2 < fields.length; i += 3) attrs[fields[i] + ':' + fields[i + 1]] = fields[i + 2];
  assert.equal(attrs['docs/spec.md:text'], 'auto');
  assert.equal(attrs['docs/spec.md:eol'], 'lf');
  assert.equal(attrs['docs/image.png:text'], 'unset');
});
