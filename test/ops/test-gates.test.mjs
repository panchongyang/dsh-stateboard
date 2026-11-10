/**
 * 测试职责：证明测试规模硬门禁和 wall-clock 预算会拒绝超限，而非仅输出统计。
 * 典型流程：构造合成源码 → AST 计量 → 比较上限；启动只等待的独立子进程 → 超时回收。
 * 覆盖边界：覆盖 新文件、既有 baseline、箭头/方法/回调及计时退出；不覆盖产品行为或真实数据。
 * 外部前置：需要隔离的 tools/typescript 解析器；只终止本用例自己创建的子进程。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { baseline, limits, measureSource, violations } from '../../scripts/check-test-size.mjs';
import { runCommand } from '../../scripts/run-suite.mjs';

// 责任：600 行通过而 601 行新文件失败，任何一个既有 baseline 增长一行也失败。
test('test file size ceilings reject new overflow and growth in every baseline', () => {
  assert.deepEqual(violations(measureSource('// synthetic\n'.repeat(600))), []);
  assert.match(violations(measureSource('// synthetic\n'.repeat(601))).join(), /601 file lines > 600/);
  for (const [file, ceiling] of Object.entries(baseline)) {
    const text = fs.readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
    assert.equal(measureSource(text, file).lines, ceiling, 'baseline must match the candidate exactly');
    assert.deepEqual(violations(measureSource(text, file)), []);
    assert.match(violations(measureSource(text + '\n', file)).join(), /file lines >/);
    assert.match(violations(measureSource('// shrunk\n', file)).join(), /stale baseline/);
  }
});

// 责任：AST 计算多行箭头、方法、回调且不把字符串里的花括号当代码；151 行函数必须失败。
test('AST function ceiling covers multiline arrows, methods and callbacks', () => {
  assert.equal(limits.function, 150);
  const body = '  // padding with } => {\n'.repeat(149);
  for (const text of [
    `function sample() {\n${body}}\n`,
    `const sample = (\narg\n) => {\n${body}};\n`,
    `const sample = { method() {\n${body}} };\n`,
    `test('sample', () => {\n${body}});\n`,
  ]) assert.match(violations(measureSource(text)).join(), /function lines > 150/);
  const safe = measureSource('const sample = () => "} => {";\n');
  assert.equal(safe.functions[0].lines, 1);
  assert.deepEqual(violations(safe), []);
});

// 责任：超过 wall-clock 预算的等待进程必须被回收并返回 124，正常进程则保持成功。
test('suite wall-clock timeout is an executable nonzero gate', async () => {
  assert.equal(await runCommand(['-e', 'setInterval(() => {}, 1000)'], { name: 'synthetic-timeout', budgetMs: 150 }), 124);
  assert.equal(await runCommand(['-e', 'process.exit(0)'], { name: 'synthetic-pass', budgetMs: 10000 }), 0);
});
