/**
 * 测试职责：保证所有核心 Git 调用复用工作区与运行仓库外的绝对可信可执行路径。
 * 典型流程：临时仓库/PATH 植入可执行陷阱 → 固定读取/观测/发现或解析 Git → 检查标记与路径。
 * 覆盖边界：覆盖 执行文件解析缓存、根排除与无候选拒绝；不覆盖远程命令或所有 Git 参数白名单。
 * 外部前置：需要系统 Git；Windows 陷阱使用 tracked fake-git.exe。
 */
// The Git executable is resolved once to an absolute path outside the workspace
// roots. These tests pin the execution surface: a workspace-local `git.exe`
// must never run, even when it sits in the directory used as `cwd`, and even
// when the workspace is prepended to PATH.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { resetGitExecutableCache, resolveGitExecutable } from '../../lib/core/git-exec.js';
import { observeGit } from '../../lib/core/documents/external-git.js';
import { readGitContent, repositoryAt } from '../../lib/core/documents/fixed-git.js';
import { mainWorktreeOf } from '../../lib/core/identity/discover.js';
import { poison, temp, repository } from '../helpers/git-poison.mjs';
import { git, sha } from '../helpers/fixed-fixture.mjs';

const packageRoot = path.resolve(import.meta.dirname, '../..');

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}


// 责任：直接裸名执行的对照必须真的触发伪 Git 标记，证明陷阱有效。
test('the workspace-local fake is a working executable (control)', (t) => {
  const dir = temp(t);
  const trap = poison(dir);
  try {
    const result = spawnSync('git', ['--version'], { cwd: dir, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0);
    assert.equal(fs.existsSync(trap.marker), true, 'the control fake did not run');
  } finally {
    trap.restore();
  }
});

// 责任：固定内容读取、Git 观测和 worktree 发现均须返回正确结果且不执行工作区陷阱。
test('fixed evidence, Git observation and worktree discovery never run a workspace-local git', (t) => {
  const { root, oid } = repository(t);
  const worktree = path.join(temp(t), 'linked');
  git(root, 'worktree', 'add', '-b', 'fake-git-check', worktree);

  const main = poison(root);
  try {
    const repo = repositoryAt(root);
    assert.equal(repo.objectFormat, 'sha1');
    const content = readGitContent(repo, oid, 'docs/spec.md');
    assert.equal(content.blobContentHash, sha('version one\n'));
    assert.equal(fs.existsSync(main.marker), false, 'fixed evidence executed the workspace git');

    assert.equal(observeGit(root, 'docs/spec.md').state, 'committed');
    assert.equal(fs.existsSync(main.marker), false, 'Git observation executed the workspace git');
  } finally {
    main.restore();
  }

  const linked = poison(worktree);
  try {
    assert.equal(mainWorktreeOf(worktree), fs.realpathSync.native(root));
    assert.equal(fs.existsSync(linked.marker), false, 'worktree discovery executed the workspace git');
  } finally {
    linked.restore();
  }
});

// 责任：首次解析须返回根外绝对路径，之后即使 PATH 空了仍须复用已验证缓存。
test('resolves Git to one absolute path outside the workspace and the running checkout, then reuses it', (t) => {
  resetGitExecutableCache();
  const workspace = temp(t);
  const first = resolveGitExecutable([workspace]);
  assert.ok(path.isAbsolute(first), 'Git path is not absolute: ' + first);
  assert.equal(inside(workspace, first), false, 'Git was resolved inside the workspace');
  assert.equal(inside(packageRoot, first), false, 'Git was resolved inside the running checkout');

  const previousPath = process.env.PATH;
  try {
    // A PATH with no candidate at all would fail a fresh resolution: returning
    // the same path proves the module-level singleton is reused.
    process.env.PATH = temp(t);
    assert.equal(resolveGitExecutable([workspace]), first);
  } finally {
    process.env.PATH = previousPath;
    resetGitExecutableCache();
  }
});

// 责任：PATH 优先放工作区候选时须跳过它，选择工作区外 Git 且无标记。
test('skips a PATH candidate that lives inside a workspace root', (t) => {
  const workspace = temp(t);
  const trap = poison(workspace);
  try {
    const executable = resolveGitExecutable([workspace]);
    assert.equal(inside(workspace, executable), false);
    assert.notEqual(executable, trap.executable);
    assert.equal(fs.existsSync(trap.marker), false);
  } finally {
    trap.restore();
  }
});

// 责任：没有任何合格候选时须明确 git-unavailable，不能退回裸 git 名称。
test('fails clearly instead of falling back to a bare git name when no candidate is acceptable', (t) => {
  const previousPath = process.env.PATH;
  const workspace = temp(t);
  const trap = poison(workspace);
  try {
    process.env.PATH = workspace;
    assert.throws(() => resolveGitExecutable([workspace]), (error) => {
      assert.equal(error.code, 'git-unavailable');
      assert.equal(error.status, 503);
      assert.match(error.message, /outside the workspace roots/);
      return true;
    });
    assert.equal(fs.existsSync(trap.marker), false);
  } finally {
    process.env.PATH = previousPath;
    trap.restore();
  }
});
