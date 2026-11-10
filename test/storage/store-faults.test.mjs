/**
 * 测试职责：确保 R3 存储故障与 framing 测试在最小隔离子进程运行。
 * 典型流程：创建隔离 fixture 根 → 启动 store-faults/framing worker → 输出诊断并检查退出。
 * 覆盖边界：覆盖 故障 worker 调度与环境隔离；不覆盖真实 store 或生产故障恢复。
 * 外部前置：无；需要能启动 Node 子进程。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { isolatedEnvironment } from '../helpers/fault-isolation.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
// 责任：两个故障 worker 必须在隔离环境内运行并 exit 0，启动错误或超时不可吞掉。
test('R3 store faults run with a minimal isolated environment', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-store-faults-'));
  console.log('R3 fixture: ' + fixture);
  const result = spawnSync(process.execPath, ['--test', 'test/faults/store-faults.mjs', 'test/faults/framing.mjs'], {
    cwd: repo, env: isolatedEnvironment(fixture), encoding: 'utf8', timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  console.log(result.stdout || '');
  if (result.stderr) console.error(result.stderr);
  assert.ifError(result.error);
  assert.equal(result.status, 0, 'isolated fault worker failed');
});
