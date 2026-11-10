/**
 * 测试职责：保证测试侧 TypeScript 入口能检查 helpers/fixtures，并对类型错误失败关闭。
 * 典型流程：跑 typecheck:test 正例 → 临时写入类型错误负例 → 断言编译器退出码变红。
 * 覆盖边界：覆盖 test/helpers、test/fixtures 与 typecheck:test 接线；不覆盖全量测试或产品 strict。
 * 外部前置：需要 Node 与 tools/typescript 依赖；不需要根目录 npm install 或网络。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const tsc = path.join(repoRoot, 'tools', 'typescript', 'node_modules', 'typescript', 'bin', 'tsc');

// 责任：当前 helpers/fixtures 的正例必须通过 typecheck:test。
test('the test-side typecheck passes for helpers and fixtures', () => {
  const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'typecheck-test.mjs')], {
    cwd: repoRoot, encoding: 'utf8', windowsHide: true, timeout: 120000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

// 责任：显式类型错误的负例必须让同一个编译器非零退出，证明门禁仍有牙齿。
test('a deliberate type error in a checked file makes the compiler fail', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'typecheck-test-negative-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bad = path.join(dir, 'bad.mjs');
  fs.writeFileSync(bad, '// @ts-check\nconst count = 1;\ncount.toUpperCase();\n');
  const result = spawnSync(process.execPath, [
    tsc, '--noEmit', '--allowJs', '--checkJs', '--target', 'ES2022',
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext', bad,
  ], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.notEqual(result.status, 0, 'a type error must not pass');
  assert.match(result.stdout + result.stderr, /toUpperCase|Property|number/, 'the compiler reports the type error');
});
