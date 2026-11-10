/**
 * 测试职责：确保默认门禁在最小隔离环境的子进程中运行 R3 核心矩阵。
 * 典型流程：创建临时隔离根 → 启动三个 matrix worker → 收集诊断并断言退出状态。
 * 覆盖边界：覆盖 矩阵调度和子进程隔离接线；不覆盖本进程直接操作真实 profile。
 * 外部前置：无；需要能启动当前 Node 可执行文件。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { isolatedEnv } from '../helpers/core-matrix-fixture.mjs';

// Keep the default/CI gate safe even when its caller has a real DSH environment.
// This file never constructs a service or fixture in the caller's process.
// 责任：以最小环境启动三个 worker，子进程不得报错、被信号终止或非零退出。
test('R3 core matrix runs in a minimal-environment child', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-matrix-isolation-'));
  try {
    const child = spawnSync(process.execPath, ['--test', 'test/matrix/core-matrix.mjs', 'test/matrix/core-boundaries.mjs', 'test/matrix/core-lifecycle.mjs'], {
      cwd: path.resolve(import.meta.dirname, '../..'), env: isolatedEnv(root), encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
    });
    t.diagnostic('isolated run root: ' + root + ' (removed after completion)');
    for (const line of (child.stdout || '').trimEnd().split('\n')) t.diagnostic(line);
    for (const line of (child.stderr || '').trimEnd().split('\n').filter(Boolean)) t.diagnostic(line);
    assert.ifError(child.error);
    assert.equal(child.signal, null);
    assert.equal(child.status, 0, 'isolated matrix worker failed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
