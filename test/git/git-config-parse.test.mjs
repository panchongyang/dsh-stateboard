/**
 * 测试职责：确保分离 git-dir 的 worktree 所有权取自完整 Git 配置且未知时拒绝执行。
 * 典型流程：临时仓库和伪 Git → 改写 common config → findRepository/CLI dry-run → 检查禁用根与标记。
 * 覆盖边界：覆盖 配置语法、最后值、长配置及所有权 fail-closed；不覆盖真实用户配置或发布。
 * 外部前置：需要 Git；Windows 使用 tracked fake-git.exe；CLI 使用已跟踪入口。
 */
// Ownership of a separate-git-dir linked worktree comes from a real `git config`
// reading of the common directory, and an owner that cannot be determined is
// refused rather than guessed. An ordinary `.git` common directory never has
// its config consulted.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { findRepository, parseGitConfig } from '../../lib/core/git-exec.js';
import { plant, runCli as run, RELEASE, FAKE_NAME, markerPath, realGit, temp, repository } from '../helpers/git-poison.mjs';

const same = (a, b) => path.relative(a, b) === '';

// `git init --separate-git-dir <base>/store R`, one commit, a linked worktree L
// started from L/child, and fakes planted in R, R/node_modules/.bin and L.
// Git writes no core.worktree here; each test sets the config it needs.
function separateLinked(t) {
  const base = temp(t);
  t.after(() => { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ } });
  const root = path.join(base, 'R');
  const store = path.join(base, 'store');
  const tree = path.join(base, 'L');
  realGit(base, 'init', '-q', '--separate-git-dir', store, root);
  realGit(root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'one');
  realGit(root, 'worktree', 'add', '-q', '-b', 'linked', tree);
  const oid = realGit(root, 'rev-parse', 'HEAD');
  fs.appendFileSync(path.join(store, 'info', 'exclude'), '\n/' + FAKE_NAME + '\n/node_modules/\n');
  for (const dir of [root, path.join(root, 'node_modules', '.bin'), tree]) plant(dir);
  fs.mkdirSync(path.join(tree, 'child'));
  return { base, root, store, tree, oid, start: path.join(tree, 'child'), marker: markerPath(t), entries: [tree, root, path.join(root, 'node_modules', '.bin')] };
}

// The main checkout Git itself derives from the common directory's config.
function gitTopLevel(repo) {
  return realGit(repo.base, '--git-dir=' + repo.store, 'rev-parse', '--show-toplevel');
}

function appendConfig(repo, text) {
  fs.appendFileSync(path.join(repo.store, 'config'), text);
}

function assertForbidsMain(repo) {
  const main = fs.realpathSync.native(repo.root);
  const found = findRepository(repo.start);
  assert.ok(found.roots.some((root) => same(root, main)), main + ' not in ' + found.roots.join(';'));
}

function assertCliSafe(repo) {
  const release = run(RELEASE, ['--dry-run', '--skip-gate'], repo.start, repo.marker, repo.entries);
  assert.equal(fs.existsSync(repo.marker), false, 'release-tag executed a repository git');
  assert.equal(release.status, 0, release.stdout + release.stderr);
  assert.match(release.stdout, new RegExp('sha: ' + repo.oid.slice(0, 7)));
}

// 责任：解析混合大小写、引号、转义、注释和续行后须保留正确值，重复键最后一项胜出。
test('parseGitConfig reads sections, quotes, escapes, comments, continuations and keeps the last value', () => {
  const config = parseGitConfig([
    '[core]',
    '\tWorkTree = ../R # comment',
    '[Core "Sub"]',
    '\tkey = "a \\"b\\" ; c" ; trailing',
    '[review]',
    '\tworktree = C:/',
    '[core]',
    '\tbare',
    '\tlong = one \\',
    'two\\tthree',
    '\tworktree = ../S ; later wins',
  ].join('\r\n') + '\r\n');
  assert.equal(config.get('core.worktree'), '../S');
  assert.equal(config.get('core.Sub.key'), 'a "b" ; c');
  assert.equal(config.get('review.worktree'), 'C:/');
  assert.equal(config.get('core.bare'), true);
  assert.equal(config.get('core.long'), 'one two\tthree');
  assert.throws(() => parseGitConfig('[core]\n\tworktree = "open\n'), /unterminated quote/);
  assert.throws(() => parseGitConfig('worktree = x\n'), /bad config line/);
});

// 责任：分离 git-dir 的 core.worktree 带引号或尾注释时仍须识别主树并禁止其伪 Git。
test('separate-git-dir linked worktree: core.worktree with a trailing comment or quotes forbids the main checkout', (t) => {
  const repo = separateLinked(t);
  appendConfig(repo, '[core]\n\tworktree = ../R # the main checkout\n');
  assert.ok(same(gitTopLevel(repo), repo.root), 'Git did not read the commented core.worktree');
  assertForbidsMain(repo);
  assertCliSafe(repo);
  appendConfig(repo, '[core]\n\tworktree = "../R" ; quoted\n');
  assert.ok(same(gitTopLevel(repo), repo.root), 'Git did not read the quoted core.worktree');
  assertForbidsMain(repo);
  assertCliSafe(repo);
});

// 责任：重复 core.worktree 配置须按最后有效值认定根，CLI 不得执行任何仓库伪 Git。
test('separate-git-dir linked worktree: the last of repeated core.worktree values wins', (t) => {
  const repo = separateLinked(t);
  const decoy = path.join(repo.base, 'decoy');
  fs.mkdirSync(decoy);
  appendConfig(repo, '[core]\n\tworktree = ../decoy\n[core]\n\tworktree = ../R\n');
  assert.equal(realGit(repo.store, 'config', 'core.worktree'), '../R');
  assert.ok(same(gitTopLevel(repo), repo.root));
  assertForbidsMain(repo);
  assertCliSafe(repo);
});

// 责任：core.worktree 位于 4096 字节后也必须读取，不能因截断漏掉主树禁用根。
test('separate-git-dir linked worktree: core.worktree past the first 4096 bytes is still read', (t) => {
  const repo = separateLinked(t);
  appendConfig(repo, '[pad]\n' + Array.from({ length: 200 }, (_, i) => '\tkey' + i + ' = ' + 'x'.repeat(40) + '\n').join('') + '[core]\n\tworktree = ../R\n');
  assert.ok(fs.statSync(path.join(repo.store, 'config')).size > 8192);
  assert.ok(same(gitTopLevel(repo), repo.root), 'Git did not read the late core.worktree');
  assertForbidsMain(repo);
  assertCliSafe(repo);
});

// 责任：普通仓库中无关 worktree 键不得被误认为所有权配置而封禁额外目录。
test('an unrelated worktree key in an ordinary repository does not forbid anything else', (t) => {
  const repo = repository(t);
  const tree = path.join(temp(t), 'linked');
  realGit(repo.root, 'worktree', 'add', '-q', '-b', 'linked', tree);
  const system = path.parse(fs.realpathSync.native(repo.root)).root;
  fs.appendFileSync(path.join(repo.root, '.git', 'config'), '[review]\n\tworktree = ' + system.replace(/\\/g, '/') + '\n');
  t.after(() => { try { fs.rmSync(tree, { recursive: true, force: true }); } catch { /* best effort */ } });
  const marker = path.join(temp(t), 'marker.txt');
  for (const start of [repo.root, tree]) {
    assert.ok(!findRepository(start).roots.some((root) => same(root, system)), 'the drive root became a safety root');
    const release = run(RELEASE, ['--dry-run', '--skip-gate'], start, marker, []);
    assert.equal(release.status, 0, release.stdout + release.stderr);
  }
});

// 责任：分离 git-dir 缺 core.worktree 无法证明所有权时，必须在运行 Git 前拒绝。
test('separate-git-dir linked worktree without core.worktree is refused before any Git runs', (t) => {
  const repo = separateLinked(t);
  assert.equal(realGit(repo.start, 'rev-parse', 'HEAD'), repo.oid, 'the linked worktree is not valid for Git');
  assert.throws(() => findRepository(repo.start), (error) => error.code === 'git-unavailable' && error.details.reason === 'git-owner-unresolvable');
  const release = run(RELEASE, ['--dry-run', '--skip-gate'], repo.start, repo.marker, repo.entries);
  assert.equal(release.status, 1, release.stdout + release.stderr);
  assert.match(release.stderr, /REFUSED: .*\(git-owner-unresolvable\)/);
  assert.equal(fs.existsSync(repo.marker), false, 'a repository git ran');
  appendConfig(repo, '[core]\n\tworktree = "../R # not a comment"\n');
  assert.throws(() => findRepository(repo.start), (error) => error.details?.cause === 'core.worktree does not exist');
});
