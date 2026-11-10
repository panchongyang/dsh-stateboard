/**
 * 测试职责：保证 Git blob 身份与工作区洁净判断只读且不执行用户内容转换程序。
 * 典型流程：创建 SHA-1/SHA-256 仓库 → 修改属性、全局配置或文件 → 读取对象和检查 clean path。
 * 覆盖边界：覆盖 对象类型、路径、行尾和过滤器/LFS 安全边界；不覆盖远程 Git、真实全局配置或大仓压力。
 * 外部前置：需要支持 SHA-256 对象格式的 Git；全局配置测试使用临时 HOME。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { objectBytes, pathEntry, readGitContent, repositoryAt } from '../../lib/core/documents/fixed-git.js';
import { assertCleanPath, checkedCommitAttributes } from '../../lib/core/documents/fixed-worktree.js';
import { git, put, repository, sha, temp } from '../helpers/fixed-fixture.mjs';

function withGlobalConfig(root, config, work, files = {}) {
  try { git(root, 'config', '--unset', 'core.autocrlf'); } catch { /* already unset by an earlier call */ }
  const home = temp();
  for (const [name, text] of Object.entries(files)) put(home, name, text);
  put(home, '.gitconfig', config.replaceAll('<HOME>', home.replaceAll('\\', '/')));
  const names = ['HOME', 'USERPROFILE', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  for (const name of names.slice(2)) delete process.env[name];
  try { return work(home); }
  finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    }
  }
}

for (const format of ['sha1', 'sha256']) {
  // 责任：在两种对象格式中读取文档须匹配 blob oid/hash，错对象类型须拒绝。
  test('Git blob bytes and object identity are verified for ' + format, () => {
    const { root, oid } = repository(format);
    const repo = repositoryAt(root);
    const content = readGitContent(repo, oid, 'docs/spec.md');
    assert.equal(repo.objectFormat, format);
    assert.equal(content.blobContentHash, sha('version one\n'));
    assert.equal(content.oid, git(root, 'rev-parse', oid + ':docs/spec.md'));
    assert.equal(assertCleanPath(repo, 'docs/spec.md', oid).eolTransformed, false);
    assert.throws(() => objectBytes(root, content.oid, 'commit', format), { code: 'fixed-object-mismatch' });
    assert.throws(() => readGitContent(repo, content.oid, 'docs/spec.md'), { code: 'fixed-object-mismatch', status: 409 });
  });
}

// 责任：未知 commit、缺失路径和越界路径须分别返回对象缺失、路径缺失和非法引用。
test('missing objects and missing paths are distinct', () => {
  const { root, oid } = repository();
  const repo = repositoryAt(root);
  assert.throws(() => readGitContent(repo, 'a'.repeat(40), 'docs/spec.md'), { code: 'fixed-object-missing', status: 404 });
  assert.throws(() => readGitContent(repo, oid, 'docs/absent.md'), { code: 'fixed-path-missing', status: 404 });
  assert.throws(() => pathEntry(root, oid, '../spec.md', 'sha1'), { code: 'invalid-fixed-reference' });
});

// 责任：分别制造未暂存与已暂存编辑，两种情况下 clean 检查均须报 dirty-worktree。
test('staged and unstaged changes are rejected independently', () => {
  const { root, oid } = repository();
  const repo = repositoryAt(root);
  put(root, 'docs/spec.md', 'unstaged\n');
  assert.throws(() => assertCleanPath(repo, 'docs/spec.md', oid), { code: 'dirty-worktree', status: 409 });
  git(root, 'add', 'docs/spec.md');
  assert.throws(() => assertCleanPath(repo, 'docs/spec.md', oid), { code: 'dirty-worktree' });
});

// 责任：本地 autocrlf 或 eol=crlf 允许等价 CRLF 文件，返回原始工作区字节哈希。
test('local core.autocrlf permits clean CRLF worktrees', () => {
  const { root, oid } = repository();
  git(root, 'config', 'core.autocrlf', 'true');
  put(root, 'docs/spec.md', 'version one\r\n');
  const result = assertCleanPath(repositoryAt(root), 'docs/spec.md', oid);
  assert.equal(result.eolTransformed, true);
  assert.equal(result.workspaceContentHash, sha('version one\r\n'));
  put(root, '.gitattributes', '*.md text eol=crlf\n');
  assert.equal(assertCleanPath(repositoryAt(root), 'docs/spec.md', oid).eolTransformed, true);
});

// 责任：临时全局 autocrlf=true 须允许 CRLF，显式 false 则须判脏且不被系统设置遮蔽。
test('global-only core.autocrlf is read: true permits CRLF worktrees, false makes them dirty', () => {
  const { root, oid } = repository();
  withGlobalConfig(root, '[core]\n\tautocrlf = true\n', () => {
    put(root, 'docs/spec.md', 'version one\r\n');
    git(root, 'add', '--renormalize', 'docs/spec.md');
    assert.equal(git(root, 'status', '--porcelain', '--', 'docs/spec.md'), '');
    assert.equal(assertCleanPath(repositoryAt(root), 'docs/spec.md', oid).eolTransformed, true);
  });
  // A system-level autocrlf=true must not mask an explicit global false.
  withGlobalConfig(root, '[core]\n\tautocrlf = false\n', () => {
    put(root, 'docs/spec.md', 'version one\r\n');
    assert.throws(() => assertCleanPath(repositoryAt(root), 'docs/spec.md', oid), { code: 'dirty-worktree', status: 409 });
  });
});

// 责任：全局 autocrlf 不能放宽本地 filter 屏障，须报 422 且不生成驱动标记。
test('global autocrlf plus a local filter is rejected without driver execution', () => {
  const { root, oid } = repository();
  withGlobalConfig(root, '[core]\n\tautocrlf = true\n', () => {
    put(root, 'docs/spec.md', 'version one\r\n');
    put(root, '.gitattributes', '*.md filter=danger\n');
    git(root, 'config', 'filter.danger.clean', 'echo unsafe > FILTER-RAN');
    assert.throws(() => assertCleanPath(repositoryAt(root), 'docs/spec.md', oid), { code: 'unsupported-content-transform', status: 422 });
    assert.equal(fs.existsSync(path.join(root, 'FILTER-RAN')), false);
  });
});

// 责任：CRLF 文件内容实际改变时仍须判 dirty-worktree，不能当成纯换行归一化。
test('actual unstaged edits in a CRLF worktree are dirty', () => {
  const { root, oid } = repository();
  git(root, 'config', 'core.autocrlf', 'true');
  put(root, 'docs/spec.md', 'actually changed\r\n');
  assert.throws(() => assertCleanPath(repositoryAt(root), 'docs/spec.md', oid), { code: 'dirty-worktree', status: 409 });
});

// 责任：filter clean/process 或 LFS 命中路径时须拒绝，任何驱动标记不得出现。
test('filter/process and LFS are refused without executing a driver', () => {
  const { root, oid } = repository();
  const marker = path.join(root, 'FILTER-RAN');
  git(root, 'config', 'filter.danger.clean', 'echo unsafe > FILTER-RAN');
  git(root, 'config', 'filter.danger.process', 'echo unsafe > FILTER-RAN');
  put(root, '.gitattributes', '*.md filter=danger\n');
  assert.throws(() => assertCleanPath(repositoryAt(root), 'docs/spec.md', oid), { code: 'unsupported-content-transform', status: 422 });
  assert.equal(fs.existsSync(marker), false);
  git(root, 'config', '--remove-section', 'filter.danger');
  put(root, '.gitattributes', '*.md filter=lfs\n');
  assert.throws(() => assertCleanPath(repositoryAt(root), 'docs/spec.md', oid), { code: 'unsupported-content-transform' });
  assert.equal(fs.existsSync(marker), false);
});

// 责任：diff/textconv 配置不得阻止普通字节读取，也不得执行外部转换。
test('diff attributes and textconv config are allowed and never executed', () => {
  const { root, oid } = repository();
  const marker = path.join(root, 'FILTER-RAN');
  put(root, '.gitattributes', '*.md diff=danger\n');
  git(root, 'config', 'diff.danger.textconv', 'echo unsafe > FILTER-RAN');
  const result = assertCleanPath(repositoryAt(root), 'docs/spec.md', oid);
  assert.equal(result.eolTransformed, false);
  assert.equal(result.workspaceContentHash, sha('version one\n'));
  assert.equal(fs.existsSync(marker), false);
});

// 责任：全局 textconv 可忽略而全局 filter 须拒绝，两者均不得执行。
test('global textconv is allowed and global filter is refused, neither executed', () => {
  const { root, oid } = repository();
  const files = (driver) => ({ attributes: '*.md ' + driver + '=danger\n' });
  const config = (section, key) => '[core]\n\tattributesFile = <HOME>/attributes\n[' + section + ' "danger"]\n\t' + key + ' = echo unsafe > FILTER-RAN\n';
  withGlobalConfig(root, config('diff', 'textconv'), (home) => {
    assert.equal(assertCleanPath(repositoryAt(root), 'docs/spec.md', oid).eolTransformed, false);
    assert.equal(fs.existsSync(path.join(root, 'FILTER-RAN')), false);
    assert.equal(fs.existsSync(path.join(home, 'FILTER-RAN')), false);
  }, files('diff'));
  withGlobalConfig(root, config('filter', 'clean'), (home) => {
    assert.throws(() => assertCleanPath(repositoryAt(root), 'docs/spec.md', oid), { code: 'unsupported-content-transform', status: 422 });
    assert.equal(fs.existsSync(path.join(root, 'FILTER-RAN')), false);
    assert.equal(fs.existsSync(path.join(home, 'FILTER-RAN')), false);
  }, files('filter'));
});

// 责任：对象内容是 LFS 指针时须拒绝，不能把指针哈希当文档内容哈希。
test('LFS pointer blobs are never returned as target document content', () => {
  const { root } = repository();
  put(root, 'docs/spec.md', 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 123\n');
  git(root, 'add', 'docs/spec.md');
  git(root, 'commit', '-m', '测试 LFS 指针');
  assert.throws(() => readGitContent(repositoryAt(root), git(root, 'rev-parse', 'HEAD'), 'docs/spec.md'), { code: 'unsupported-content-transform' });
});

// 责任：嵌套仓库和 submodule 不得成为当前文档固定来源。
test('nested repositories and submodules cannot become content sources', () => {
  const { root, oid } = repository();
  fs.mkdirSync(path.join(root, 'docs/.git'));
  assert.throws(() => assertCleanPath(repositoryAt(root), 'docs/spec.md', oid), { code: 'unsupported-repository' });
});

// 责任：无法证明文本转换等价时须 fail closed，不能把模糊转换认成干净。
test('ambiguous text conversions fail closed', () => {
  const { root, oid } = repository();
  put(root, '.gitattributes', '*.md working-tree-encoding=UTF-16\n');
  assert.throws(() => assertCleanPath(repositoryAt(root), 'docs/spec.md', oid), { code: 'unsupported-content-transform' });
  put(root, '.gitattributes', '*.md text=unknown\n');
  assert.throws(() => assertCleanPath(repositoryAt(root), 'docs/spec.md', oid), { code: 'unsupported-content-transform' });
});

function lfsConfig(root) {
  for (const key of ['clean', 'smudge', 'process']) git(root, 'config', 'filter.lfs.' + key, 'echo unsafe > MARK');
  git(root, 'config', 'filter.lfs.required', 'true');
}

// 责任：仓库配置 LFS 但普通文档路径未命中时，仍须允许只读该文档。
test('a repository with LFS configured still serves plain documents', () => {
  const { root } = repository();
  lfsConfig(root);
  put(root, 'docs/plain.md', 'plain text\n');
  git(root, 'add', 'docs/plain.md');
  git(root, 'commit', '-m', '测试普通文档');
  const oid = git(root, 'rev-parse', 'HEAD');
  const repo = repositoryAt(root);
  assert.equal(readGitContent(repo, oid, 'docs/plain.md').blobContentHash, sha('plain text\n'));
  checkedCommitAttributes(repo, 'docs/plain.md', oid);
  assert.equal(assertCleanPath(repo, 'docs/plain.md', oid).eolTransformed, false);
  assert.equal(fs.existsSync(path.join(root, 'MARK')), false);
});

// 责任：只有命中 filter 的路径须拒绝，其他安全路径不能被连带封禁。
test('a path that matches a filter attribute is refused even when other paths are fine', () => {
  const { root } = repository();
  put(root, '.gitattributes', '*.bin filter=lfs\n');
  put(root, 'docs/big.bin', 'binary payload\n');
  git(root, 'add', '.gitattributes', 'docs/big.bin');
  git(root, 'commit', '-m', '测试 bin 属性');
  lfsConfig(root);
  const oid = git(root, 'rev-parse', 'HEAD');
  const repo = repositoryAt(root);
  assert.throws(() => checkedCommitAttributes(repo, 'docs/big.bin', oid), { code: 'unsupported-content-transform', status: 422 });
  assert.throws(() => assertCleanPath(repo, 'docs/big.bin', oid), { code: 'unsupported-content-transform', status: 422 });
  assert.equal(checkedCommitAttributes(repo, 'docs/spec.md', oid), undefined);
  assert.equal(fs.existsSync(path.join(root, 'MARK')), false);
});

// 责任：即使没有 LFS 属性，内容识别出 LFS 指针仍须拒绝。
test('an LFS pointer is refused by content even when the attribute is missing', () => {
  const { root } = repository();
  const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'b'.repeat(64) + '\nsize 9\n';
  put(root, 'docs/pointer.md', pointer);
  git(root, 'add', 'docs/pointer.md');
  git(root, 'commit', '-m', '测试无属性指针');
  const oid = git(root, 'rev-parse', 'HEAD');
  const repo = repositoryAt(root);
  assert.throws(() => readGitContent(repo, oid, 'docs/pointer.md'), { code: 'unsupported-content-transform', status: 422 });
  assert.throws(() => assertCleanPath(repo, 'docs/pointer.md', oid), { code: 'unsupported-content-transform', status: 422 });
});
