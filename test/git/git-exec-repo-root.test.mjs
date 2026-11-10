/**
 * 测试职责：保证从子目录或 linked worktree 启动 CLI 时先发现全部禁执行仓库根。
 * 典型流程：临时仓库植入伪 Git 并污染 PATH → 发现根或启动只读 CLI → 检查根集合和执行标记。
 * 覆盖边界：覆盖 gitfile、链接别名、子目录启动及无仓库拒绝；不覆盖真实发布或远程 Git。
 * 外部前置：需要 Git 和平台链接权限；Windows 用 tracked fake-git.exe；CLI 使用已跟踪入口。
 */
// The shipped CLIs locate the repository on disk before their first Git call, so
// a git.exe anywhere in the repository tree stays unused even when they start in
// a subdirectory and PATH carries the repository (or its node_modules/.bin, as
// `npm run` / `npm exec` prepend).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { findRepository, resetGitExecutableCache } from '../../lib/core/git-exec.js';
import { versionInfo } from '../../scripts/test-env/lifecycle.mjs';
import { plant, poisonedRepo, addWorktree, runCli as run, RELEASE, temp, repository, realGit } from '../helpers/git-poison.mjs';

const same = (a, b) => path.relative(a, b) === '';

function outsideAnyRepository(t) {
  const dir = temp(t);
  return findRepository(dir) === null ? dir : null;
}

// 责任：从子目录 findRepository 须直接定位实际根及 realpath，不能先执行仓库伪 Git。
test('findRepository locates the repository from a subdirectory without running Git', (t) => {
  const repo = poisonedRepo(t, { bin: true });
  const found = findRepository(path.join(repo.child));
  assert.ok(found, 'no repository found');
  assert.ok(same(found.root, repo.root), found.root);
  assert.ok(found.roots.some((root) => same(root, fs.realpathSync.native(repo.root))), found.roots.join(';'));
});

// 责任：临时目录确实不在任何仓库中时 findRepository 必须返回 null。
test('findRepository returns null outside any repository', (t) => {
  const dir = outsideAnyRepository(t);
  if (!dir) { t.skip('the temp directory sits inside a repository'); return; }
  assert.equal(findRepository(path.join(dir)), null);
});

// 责任：解析 linked worktree 的 gitfile 后禁用根须同时含 worktree、gitdir 和主树。
test('findRepository resolves a linked worktree gitfile to the worktree, its git dir and main checkout', (t) => {
  const repo = repository(t);
  const tree = path.join(temp(t), 'linked');
  addWorktree(repo.root, tree);
  fs.mkdirSync(path.join(tree, 'child'));
  assert.ok(fs.statSync(path.join(tree, '.git')).isFile(), 'worktree .git is not a gitfile');
  const found = findRepository(path.join(tree, 'child'));
  assert.ok(same(found.root, tree), found.root);
  const real = (dir) => fs.realpathSync.native(dir);
  for (const expected of [real(tree), real(repo.root), real(path.join(repo.root, '.git', 'worktrees', 'linked'))]) {
    assert.ok(found.roots.some((root) => same(root, expected)), expected + ' not in ' + found.roots.join(';'));
  }
});

// 责任：从子目录 release dry-run 须返回正确 sha 且不创建 tag，不得运行 PATH 伪 Git。
test('release-tag dry-run from a subdirectory never runs a repository git.exe reached through PATH', (t) => {
  const repo = poisonedRepo(t, { bin: true });
  const result = run(RELEASE, ['--dry-run', '--skip-gate'], repo.child, repo.marker, [repo.root, repo.bin]);
  assert.equal(fs.existsSync(repo.marker), false, 'release-tag executed the repository git');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp('sha: ' + repo.oid.slice(0, 7)));
  assert.match(result.stdout, /dry run, tag not created/);
});

// 责任：保持原 PATH 的对照启动 release-tag 须成功且不生成伪 Git 标记。
test('with the original PATH a subdirectory start stays clean (control)', (t) => {
  const repo = poisonedRepo(t, { bin: true });
  const release = run(RELEASE, ['--dry-run', '--skip-gate'], repo.child, repo.marker);
  assert.equal(release.status, 0, release.stdout + release.stderr);
  assert.equal(fs.existsSync(repo.marker), false);
});

// 责任：linked worktree 子目录运行 wt 时须同时避开 worktree、主树及其 bin 中的伪 Git。
test('release-tag dry-run from a linked worktree subdirectory skips fakes in the worktree and the main checkout', (t) => {
  const repo = poisonedRepo(t, { bin: true });
  const tree = path.join(temp(t), 'linked');
  addWorktree(repo.root, tree);
  plant(tree);
  fs.mkdirSync(path.join(tree, 'child'));
  const result = run(RELEASE, ['--dry-run', '--skip-gate'], path.join(tree, 'child'), repo.marker, [tree, repo.root, repo.bin]);
  assert.equal(fs.existsSync(repo.marker), false, 'release-tag executed a repository git');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp('sha: ' + repo.oid.slice(0, 7)));
  assert.match(result.stdout, /dry run, tag not created/);
});

// 责任：仓库外运行 wt/release 必须在任何 Git 执行前拒绝。
test('outside any repository release-tag refuses before running Git', (t) => {
  const dir = outsideAnyRepository(t);
  if (!dir) { t.skip('the temp directory sits inside a repository'); return; }
  plant(dir);
  const marker = path.join(temp(t), 'marker.txt');
  const release = run(RELEASE, ['--dry-run', '--skip-gate'], dir, marker, [dir]);
  assert.equal(release.status, 1, release.stdout + release.stderr);
  assert.match(release.stderr, /REFUSED: not inside a git repository/);
  assert.equal(fs.existsSync(marker), false, 'a git ran outside any repository');
});

// 责任：从子目录采集 test-env 版本须读取正确 HEAD，不得用仓库污染的 PATH Git。
test('test-env version metadata from a subdirectory skips a repository git on PATH', (t) => {
  const repo = poisonedRepo(t, { bin: true });
  const cli = temp(t);
  fs.mkdirSync(path.join(cli, 'bin'));
  fs.writeFileSync(path.join(cli, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  const home = temp(t);
  const env = { repoRoot: repo.child, cliPath: path.join(cli, 'bin', 'dsh.js'), userHome: home, temp: home, home, agents: home };
  const previous = process.env.PATH;
  process.env.PATH = [repo.root, repo.bin, previous].join(path.delimiter);
  resetGitExecutableCache();
  try {
    assert.equal(versionInfo(env).commit, repo.oid, 'HEAD was not read by the real Git');
  } finally {
    process.env.PATH = previous;
    resetGitExecutableCache();
  }
});

// Git for Windows marks a gitfile hidden, and writing a hidden file fails with
// EPERM, so it is replaced rather than overwritten.
function replaceFile(file, text) {
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, text);
}

function link(t, target, alias, type) {
  try {
    fs.symlinkSync(target, alias, type);
  } catch (error) {
    t.skip(type + ' links are unavailable here: ' + error.code);
    return false;
  }
  t.after(() => { try { fs.unlinkSync(alias); } catch { /* already gone */ } });
  return true;
}

function cleanUp(t, ...dirs) {
  // rmSync removes a junction or symlink without following it, so hook order is irrelevant.
  t.after(() => { for (const dir of dirs) { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ } } });
}

// A real linked worktree L of a poisoned R, with a fake in L, started from L/child.
function linkedPoisoned(t) {
  const repo = poisonedRepo(t, { bin: true });
  const base = temp(t);
  const tree = path.join(base, 'linked');
  addWorktree(repo.root, tree);
  plant(tree);
  fs.mkdirSync(path.join(tree, 'child'));
  cleanUp(t, base, repo.root, path.dirname(repo.marker));
  return { ...repo, base, tree, start: path.join(tree, 'child') };
}

function assertCliSafe(repo) {
  const entries = [repo.tree, repo.root, repo.bin];
  const release = run(RELEASE, ['--dry-run', '--skip-gate'], repo.start, repo.marker, entries);
  assert.equal(fs.existsSync(repo.marker), false, 'release-tag executed a repository git');
  assert.equal(release.status, 0, release.stdout + release.stderr);
  assert.match(release.stdout, new RegExp('sha: ' + repo.oid.slice(0, 7)));
}

function assertOwnsMain(repo) {
  const found = findRepository(repo.start);
  const main = fs.realpathSync.native(repo.root);
  assert.ok(found.roots.some((root) => same(root, main)), main + ' not in ' + found.roots.join(';'));
}

// 责任：gitdir 经 junction 指向主树 .git 时，根发现仍须封禁物理主树。
test('a gitfile whose gitdir is spelled through a junction to R/.git still forbids the main checkout', (t) => {
  const repo = linkedPoisoned(t);
  const alias = path.join(repo.base, 'metadata-junction');
  if (!link(t, path.join(repo.root, '.git'), alias, 'junction')) return;
  replaceFile(path.join(repo.tree, '.git'), 'gitdir: ' + path.join(alias, 'worktrees', 'linked') + '\n');
  assert.equal(realGit(repo.start, 'rev-parse', 'HEAD'), repo.oid);
  assertOwnsMain(repo);
  assertCliSafe(repo);
});

// 责任：.git 自身是到 gitfile 的 symlink 时仍须追踪主树，不能遗漏禁执行根。
test('a .git that is a symlink to a normal gitfile still forbids the main checkout', (t) => {
  const repo = linkedPoisoned(t);
  const marker = path.join(repo.tree, '.git');
  const target = path.join(repo.base, 'linked.gitfile');
  fs.writeFileSync(target, fs.readFileSync(marker));
  fs.rmSync(marker, { force: true });
  if (!link(t, target, marker, 'file')) return;
  assert.equal(realGit(repo.start, 'rev-parse', 'HEAD'), repo.oid);
  assertOwnsMain(repo);
  assertCliSafe(repo);
});
