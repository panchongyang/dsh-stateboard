/**
 * 测试职责：封住点前缀目录、junction 与 Windows 短路径别名绕过 Git 执行根限制的漏洞。
 * 典型流程：临时根植入伪 Git/路径别名 → resolve 或 CLI dry-run → 比较解析结果与执行标记。
 * 覆盖边界：覆盖 根别名、缓存复核和 CLI 接线；不覆盖真实发布、宿主服务或远程 Git。
 * 外部前置：需要 Git；链接权限和 Windows 8.3 别名不足时相应用例跳过；CLI 使用已跟踪入口。
 */
// Execution-surface regressions for the Git resolver: root aliases (junction,
// 8.3 short name), dot-prefixed child directories, and the tracked release-tag CLI
// that must not run a git.exe found through their working directory.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveGitExecutable } from '../../lib/core/git-exec.js';
import { isInside } from '../../lib/core/util.js';
import { versionInfo } from '../../scripts/test-env/lifecycle.mjs';
import { plant, withPath, runsMarker, poisonedRepo, runCli, RELEASE, temp } from '../helpers/git-poison.mjs';
import { git } from '../helpers/fixed-fixture.mjs';

function junctionTo(t, target) {
  const alias = path.join(temp(t), 'alias');
  fs.symlinkSync(target, alias, 'junction');
  return alias;
}

function shortAlias(t) {
  // os.tmpdir() may be an 8.3 spelling; mkdtemp under it
  // keeps that spelling while realpath expands it.
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-short-'));
  t.after(() => fs.rmSync(raw, { recursive: true, force: true, maxRetries: 3 }));
  const real = fs.realpathSync.native(raw);
  return raw.toLowerCase() === real.toLowerCase() ? null : { raw, real };
}

// 责任：..cache 等点前缀是根内子目录，只有完整父段才应判越界。
test('isInside treats dot-prefixed child names as inside and only whole `..` segments as outside', (t) => {
  const root = path.resolve(temp(t));
  for (const child of ['..cache', '..cache/git.exe', '...', '..x/y', '.git', 'a/..b']) {
    assert.equal(isInside(root, path.join(root, child)), true, child);
  }
  assert.equal(isInside(root, root), true);
  assert.equal(isInside(root, path.dirname(root)), false);
  assert.equal(isInside(root, path.join(path.dirname(root), 'sibling')), false);
  assert.equal(isInside(root, path.join(root, '..', path.basename(root) + 'x')), false);
});

// 责任：PATH 中 ..cache 的伪 Git 须跳过，存在可信 Git 时返回外部可执行文件。
test('a git inside a `..cache` child of a workspace root is skipped', (t) => {
  const root = temp(t);
  const cache = path.join(root, '..cache');
  fs.mkdirSync(cache);
  const fake = plant(cache);
  withPath([cache], () => {
    assert.throws(() => resolveGitExecutable([root]), (error) => error.code === 'git-unavailable' && error.details.reason === 'git-exec-not-found');
  });
  withPath([cache, process.env.PATH], () => {
    const found = resolveGitExecutable([root]);
    assert.notEqual(found, fs.realpathSync.native(fake));
    assert.equal(runsMarker(found), false);
  });
});

// 责任：声明 junction 别名根也必须封禁其物理根中的伪 Git。
test('a junction alias of a workspace root still forbids the physical root', (t) => {
  const root = temp(t);
  plant(root);
  const alias = junctionTo(t, root);
  withPath([root], () => {
    assert.throws(() => resolveGitExecutable([alias]), (error) => error.code === 'git-unavailable');
  });
  withPath([root, process.env.PATH], () => {
    const found = resolveGitExecutable([alias]);
    assert.equal(isInside(root, found), false, 'resolved inside the aliased root: ' + found);
    assert.equal(runsMarker(found), false);
  });
});

// 责任：声明 8.3 短名根也必须封禁同一物理长路径下的伪 Git。
test('an 8.3 short-name alias of a workspace root still forbids the physical root', (t) => {
  const alias = shortAlias(t);
  if (!alias) { t.skip('no 8.3 spelling available for the temp directory'); return; }
  plant(alias.real);
  withPath([alias.real], () => {
    assert.throws(() => resolveGitExecutable([alias.raw]), (error) => error.code === 'git-unavailable');
  });
  withPath([alias.real, process.env.PATH], () => {
    const found = resolveGitExecutable([alias.raw]);
    assert.equal(isInside(alias.real, found), false, 'resolved inside the aliased root: ' + found);
  });
});

// 责任：缓存的可执行文件后来被新根别名覆盖时须拒绝复用。
test('a cached executable is refused when a later root alias covers it', (t) => {
  const root = temp(t);
  const fake = plant(root);
  const alias = junctionTo(t, root);
  withPath([root], () => {
    assert.equal(resolveGitExecutable([]), fs.realpathSync.native(fake));
    assert.throws(() => resolveGitExecutable([alias]), (error) => error.code === 'git-unavailable' && error.details.reason === 'git-exec-not-found');
  });
});

// 责任：声明根无法 realpath 时须明确拒绝，不能因解析失败取消根保护。
test('a declared root whose real path cannot be resolved is refused explicitly', (t) => {
  const missing = path.join(temp(t), 'does-not-exist');
  assert.throws(() => resolveGitExecutable([missing]), (error) => {
    assert.equal(error.code, 'git-unavailable');
    assert.equal(error.status, 503);
    assert.equal(error.details.reason, 'git-root-unresolvable');
    return true;
  });
});


// 责任：从仓库运行 release dry-run 须避开 cwd 伪 Git，不得实际打 tag。
test('release-tag dry-run never runs a git.exe from the repository it is started in', (t) => {
  const repo = poisonedRepo(t);
  const result = runCli(RELEASE, ['--dry-run', '--skip-gate'], repo.root, repo.marker);
  assert.equal(fs.existsSync(repo.marker), false, 'release-tag executed the repository git');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp('sha: ' + repo.oid.slice(0, 7)));
  assert.match(result.stdout, /dry run, tag not created/);
  assert.equal(git(repo.root, 'tag', '--list'), '');
});

// 责任：采集 test-env HEAD 必须用解析后的可信 Git，不得执行 checkout 内 git.exe。
test('test-env version metadata reads HEAD with the resolved Git, not the checkout git.exe', (t) => {
  const repo = poisonedRepo(t);
  const cli = temp(t);
  fs.mkdirSync(path.join(cli, 'bin'));
  fs.writeFileSync(path.join(cli, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  const home = temp(t);
  const env = { repoRoot: repo.root, cliPath: path.join(cli, 'bin', 'dsh.js'), userHome: home, temp: home, home, agents: home };
  const previous = process.env.PB_GIT_MARKER;
  process.env.PB_GIT_MARKER = repo.marker;
  try {
    const info = versionInfo(env);
    assert.equal(info.dshVersion, '9.9.9');
    assert.equal(info.commit, repo.oid);
  } finally {
    if (previous === undefined) delete process.env.PB_GIT_MARKER; else process.env.PB_GIT_MARKER = previous;
  }
  assert.equal(fs.existsSync(repo.marker), false, 'version metadata executed the checkout git');
});
