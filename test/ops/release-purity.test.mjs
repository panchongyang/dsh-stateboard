/**
 * 测试职责：校验公开源码及 npm 包边界不夹带维护 CLI、私密文本或不可信客户端产物。
 * 典型流程：读取本地可信产物/元数据并合成恶意条目 → purity 校验 → 对照拒绝及零代码执行。
 * 覆盖边界：覆盖 包白名单、README 链接、身份字节和 Git 只读参数；不覆盖实际发布授权或 npm 远端。
 * 外部前置：无；需要仓库现有客户端产物。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { assertClientIdentity, assertPackedReadmeLinks, assertPureText, assertShippedText, checkGitSurface, checkMetadata, checkPackageEntries, checkPublicSource } from '../../scripts/check-release-purity.mjs';
import { assertReadOnlyGitArgs } from '../../lib/core/git-exec.js';

const root = path.resolve(import.meta.dirname, '../..');
const base = ['package/package.json', 'package/README.md', 'package/docs/CONTRACT.md', 'package/LICENSE', 'package/lib/index.js', 'package/src/client/index.ts'];
const license = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// 责任：合法包元数据须通过，旧门命名、错误身份/许可证或扩大 whitelist 必须拒绝。
test('purity checks runtime trees, metadata and legacy gate names', () => {
  assert.deepEqual(checkPackageEntries(base), base);
  assert.equal(checkMetadata(packageJson, license), true);
  assert.deepEqual(assertPureText('requiresAudit gate:audit 审计门'), { matches: 0 });
  for (const value of ['requiresHumanReview', 'gate:human']) assert.throws(() => assertPureText('runtime text: ' + value), /legacy gate names/);
  assert.equal(checkMetadata({ ...packageJson, private: true }, license), true);
  assert.equal(checkMetadata({ ...packageJson, private: false }, license), true);
  for (const mutation of [{ name: 'fake' }, { version: '0.1.0' }, { private: 'false' }, { license: 'MIT' }, { bin: 'bin/wt.mjs' }, { files: [...packageJson.files, 'scripts'] }]) {
    assert.throws(() => checkMetadata({ ...packageJson, ...mutation }, license), /metadata|whitelist/);
  }
  assert.throws(() => checkMetadata({ ...packageJson, repository: 'https://example.com/fake' }, license), /repository/);
  assert.throws(() => checkMetadata(packageJson, license.replace('Copyright (c) 2026 潘重阳', 'Copyright (c) 2026 Someone else')), /LICENSE/);
});

// 责任：客户端身份须比较完整可信产物字节，伪 id 字符串、重复 bundle 或非法字节都不能冒充。
test('client identity matches complete trusted artifact bytes without executing packed code', () => {
  const source = fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8');
  const expected = { id: packageJson.name, verification: 'trusted-local-byte-match' };
  assert.deepEqual(assertClientIdentity(packageJson, source), expected);
  assert.deepEqual(assertClientIdentity(packageJson, Buffer.from(source), { root }), expected);
  assert.throws(() => assertClientIdentity(packageJson, Buffer.concat([Buffer.from(source), Buffer.from([0xff])])), /does not match trusted local artifact bytes/);
  assert.throws(() => assertClientIdentity(packageJson, source, { root: path.join(root, 'package.json') }), /ENOTDIR|ENOENT/);
  const stale = source.replace(/(\bid:\s*)["']dsh-stateboard["']/, "$1'dsh-project-board'");
  assert.notEqual(stale, source, 'fixture replaces the real factory id');
  // Even a correct-looking string in the stale bundle cannot satisfy the gate.
  assert.throws(() => assertClientIdentity(packageJson, stale + '\n// dsh-stateboard'), /does not match trusted local artifact bytes/);
  assert.throws(() => assertClientIdentity({ ...packageJson, name: 'another-package' }, source), /manifest name does not match/);
  for (const invalid of ['// dsh-stateboard', source + '\n' + source, 'window.__ModuleLoader__.load({ id: "dsh-stateboard" });']) {
    assert.throws(() => assertClientIdentity(packageJson, invalid), /does not match trusted local artifact bytes/);
  }
});

// 责任：构造 constructor 逃逸 PoC 扫描时必须拒绝，且不能读取宿主 process.version。
test('untrusted constructor escape PoC cannot read host process during identity scanning', () => {
  const poc = 'window.__ModuleLoader__.load.constructor("return process")().version; window.__ModuleLoader__.load({id:"x",factory(){}})';
  const source = fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8');
  const descriptor = Object.getOwnPropertyDescriptor(process, 'version');
  let hostProcessReads = 0;
  Object.defineProperty(process, 'version', { configurable: true, get() { hostProcessReads++; return descriptor.value; } });
  try {
    for (const untrusted of [poc, source + '\n' + poc]) {
      assert.throws(() => assertClientIdentity(packageJson, untrusted), /does not match trusted local artifact bytes/);
    }
    assert.equal(hostProcessReads, 0, 'neither standalone nor appended PoC accessed host process.version');
  } finally {
    Object.defineProperty(process, 'version', descriptor);
  }
});

// 责任：打包 README 缺失/越界/不支持链接须被 readiness 解析器拒绝，private:true 不能替代技术门禁。
test('purity uses the readiness parser to block packaged README regressions, not the private gate', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.equal(assertPackedReadmeLinks(readme, base).relativeMissing, 0);
  assert.equal(checkMetadata({ ...packageJson, private: true }, license), true);
  for (const link of ['[source](<docs/INSTALL.md>)', '[source][s]\n\n[s]: docs/INSTALL.md', '[escape](../outside.md)', '[encoded](%2e%2e/outside.md)']) {
    assert.throws(() => assertPackedReadmeLinks(readme + '\n' + link, base), /missing or unsafe/, link);
  }
  assert.throws(() => assertPackedReadmeLinks(readme + '\n<a href="docs/x.md">source</a>', base), /unsupported link syntax/);
  const valid = '[contract](<./docs/CONTRACT.md>) [top](#top) [site](https://example.com/)\n`[ignored](docs/no.md)`';
  assert.equal(assertPackedReadmeLinks(valid, base).relativeMissing, 0);
});

// 责任：npm 条目含维护目录、证据、测试、重复或危险路径时须拒绝，必需文件缺失也须失败。
test('npm whitelist excludes every product-external directory and symlink candidate', () => {
  for (const entry of ['package/bin/wt.mjs', 'package/lib/scripts/guards.js', 'package/scripts/check-release-purity.mjs', 'package/test/a.test.mjs', 'package/tests/a.mjs', 'package/docs/RELEASE.md', 'package/evidence/x.md', 'package/.evidence/x.txt', 'package/.env', 'package/private/docs/x.md']) {
    assert.throws(() => checkPackageEntries([...base, entry]), /must not ship/, entry);
  }
  for (const entry of ['/package/lib/a.js', 'package/../escape', 'package/lib/../../escape', 'package\\lib\\a.js', 'package/./a.js', 'package/lib/index.js']) {
    assert.throws(() => checkPackageEntries([...base, entry]), /Unsafe or duplicate/);
  }
  assert.throws(() => checkPackageEntries(base.filter((entry) => entry !== 'package/LICENSE')), /Required package entry missing/);
  assert.throws(() => checkPackageEntries([]), /empty/);
});

// 责任：公共源码 tracked 列表不得含内部 CLI、档案或 evidence，普通产品源文件可通过。
test('public source excludes archived delivery records and maintainer CLI', () => {
  assert.equal(checkPublicSource(['lib/index.js', 'scripts/install.mjs', 'test/ops/release-purity.test.mjs']), true);
  for (const name of ['bin/wt.mjs', 'scripts/worktree.mjs', 'lib/scripts/guards.js', 'test/wt.test.mjs', 'docs/archive/internal.md', 'evidence/internal.md']) {
    assert.throws(() => checkPublicSource([name]), /tracked in public source/, name);
  }
});

// 责任：待发布文本含开发者绝对路径、opaque ids 或私网地址时必须拒绝。
test('packed text rejects synthetic examples of developer paths, opaque ids and private addresses', () => {
  assert.equal(assertShippedText('Example: ./demo; loopback 127.0.0.1'), true);
  for (const content of ['D:\\Users\\SampleUser\\demo', 'C:\\Users\\SampleUser\\secret', '/home/alice/config', '/Users/alice/config', 'tsk_synthetic0000001', 'sess_123456789012345', '192.168.1.2', '10.0.0.1', '172.20.1.2']) {
    assert.throws(() => assertShippedText(content), /contains/, content);
  }
});

// 责任：所有出货 Git 调用点须满足受限表面，运行时对变更型命令必须拒绝。
test('shipped Git callsites stay constrained and runtime refuses mutating commands', () => {
  const callers = ['lib/core/documents/fixed-git.js', 'lib/core/documents/external-git.js', 'lib/core/identity/discover.js'];
  const files = Object.fromEntries(callers.map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
  assert.equal(checkGitSurface(files), true);
  assert.throws(() => checkGitSurface({ ...files, 'lib/core/surprise.js': "spawnSync('git', ['commit'], {})" }), /Unapproved/);
  assert.throws(() => checkGitSurface({ ...files, [callers[0]]: files[callers[0]].replace('assertReadOnlyGitArgs(args)', 'args') }), /Git/);
  for (const args of [['rev-parse', '--show-toplevel'], ['config', '-z', '--get-regexp', '^filter\\.'], ['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=all', '--no-renames', '--', ':(literal)file.txt'], ['cat-file', '-t', 'a'.repeat(40)], ['rev-parse', '--verify', '--end-of-options', 'a'.repeat(40) + '^{commit}']]) {
    assert.deepEqual(assertReadOnlyGitArgs(args), args);
  }
  for (const args of [['commit', '-am', 'oops'], ['worktree', 'remove', '../repo'], ['push', 'origin'], ['status', '--porcelain=v1', '--', 'file'], ['cat-file', '-t', '--batch-command'], ['-c', 'alias.status=!echo', 'status']]) {
    assert.throws(() => assertReadOnlyGitArgs(args), /read-only allowlist/);
  }
});
