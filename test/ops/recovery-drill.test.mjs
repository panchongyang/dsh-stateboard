/**
 * 测试职责：证明有界合成恢复演练覆盖备份、冷恢复和后续业务继续，禁止真实根参数。
 * 典型流程：最小隔离环境子进程 → recovery-drill → 解析报告并检查十一场景、备份与退出码。
 * 覆盖边界：覆盖 演练入口及报告完整性；不覆盖真实用户 store 或无限故障 fuzz。
 * 外部前置：无；需要能启动 Node 子进程，报告位于临时演练目录。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { isolatedEnvironment } from '../helpers/fault-isolation.mjs';

const repo = fs.realpathSync.native(path.resolve(import.meta.dirname, '../..'));
const entry = path.join(repo, 'scripts/recovery-drill.mjs');
const wrapperRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-recovery-wrapper-')));
const env = isolatedEnvironment(wrapperRoot);
// 责任：演练须在时限内十一场景全部通过且无 skip，每场景保留原始/损坏备份与恢复耗时。
test('bounded synthetic recovery drill: finite cases, backups, cold business continuation', { timeout: 155_000 }, () => {
  const result = spawnSync(process.execPath, [entry], {
    cwd: repo, env, encoding: 'utf8', timeout: 150_000, maxBuffer: 8 * 1024 * 1024,
  });
  console.log(result.stdout || '');
  if (result.stderr) console.error(result.stderr);
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  const summary = JSON.parse(result.stdout.trim().split('\n').at(-1));
  const report = JSON.parse(fs.readFileSync(summary.report, 'utf8'));
  assert.equal(report.syntheticOnly, true);
  assert.equal(report.pass, 11);
  assert.equal(report.fail, 0);
  assert.equal(report.skip, 0);
  assert.equal(report.results.length, 11);
  for (const row of report.results) {
    assert.equal(row.status, 'pass', row.name);
    assert.ok(Number.isInteger(row.recoveryMs));
    assert.ok(fs.existsSync(row.pristine.dir), row.name + ' pristine backup');
    assert.ok(fs.existsSync(row.damaged.dir), row.name + ' damaged backup');
  }
});

// 责任：传 --root 指向真实仓库的请求必须先报错退出，不得开始创建演练 fixture。
test('public drill entry refuses real-root arguments before creating fixtures', () => {
  const result = spawnSync(process.execPath, [entry, '--root', repo], { cwd: repo, env, encoding: 'utf8', timeout: 5_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /accepts no arguments or real root/);
  assert.doesNotMatch(result.stdout, /synthetic recovery root/);
});
