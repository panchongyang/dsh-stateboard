/**
 * 测试职责：保证公开 Git 安全回归在只有 HEAD 已跟踪文件的干净树中仍可执行。
 * 典型流程：创建临时 detached worktree → 检查私有工具缺席 → 启动三个 Git 测试 → 清理导出。
 * 覆盖边界：覆盖 干净源码的 Git 回归与退出状态；不覆盖私有开发工具或真实发布。
 * 外部前置：需要 Git 与 Node；不需要依赖目录、真实用户配置或宿主服务。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const git = (...args) => spawnSync('git', args, {
  cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000,
});
const output = (result) => [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n');

// 责任：HEAD 干净导出不得含私有工具，三个 Git 回归须独立通过，成功或失败均回收临时树。
test('public Git safety tests pass in a clean detached HEAD worktree', { timeout: 120000 }, () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-clean-')));
  const cleanDir = path.join(base, 'checkout');
  try {
    const added = git('worktree', 'add', '--detach', cleanDir, 'HEAD');
    assert.equal(added.status, 0, output(added));
    assert.equal(fs.existsSync(path.join(cleanDir, 'bin/wt.mjs')), false, 'private CLI leaked into HEAD');
    const result = spawnSync(process.execPath, ['--test',
      'test/git/git-config-parse.test.mjs',
      'test/git/git-exec-repo-root.test.mjs',
      'test/git/git-exec-surface.test.mjs',
    ], { cwd: cleanDir, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, output(result));
  } finally {
    const removed = git('worktree', 'remove', '--force', cleanDir);
    if (removed.status !== 0) {
      fs.rmSync(cleanDir, { recursive: true, force: true, maxRetries: 3 });
      const pruned = git('worktree', 'prune');
      assert.equal(pruned.status, 0, output(pruned));
    }
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 });
  }
});
