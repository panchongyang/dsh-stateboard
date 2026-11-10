/**
 * 测试职责：确保日志抢救和显式修复 worker 只在合成隔离环境执行。
 * 典型流程：新建隔离根 → 最小环境启动 salvage/prefix 子测试 → 透传诊断并检查退出。
 * 覆盖边界：覆盖 worker 调度与隔离接线；不覆盖调用者真实 store 或具体修复算法分支。
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
// 责任：以隔离 HOME/DSH/TEMP 启动抢救 worker，执行不得超时或报错且必须 exit 0。
test('R3 salvage and explicit repair run only in an isolated synthetic store', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-salvage-'));
  console.log('salvage fixture: ' + fixture);
  const result = spawnSync(process.execPath, ['--test', path.join(repo, 'test/salvage/prefix.mjs')], {
    cwd: repo, env: isolatedEnvironment(fixture), encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  });
  console.log(result.stdout || '');
  if (result.stderr) console.error(result.stderr);
  assert.ifError(result.error);
  assert.equal(result.status, 0, 'isolated salvage worker failed');
});
