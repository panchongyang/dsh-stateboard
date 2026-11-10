/**
 * 测试职责：让所有公开测试入口持续满足中文说明结构，并证明检查器会拒绝缺项而非空扫通过。
 * 典型流程：扫描 tracked 清单 → 检查实际源码；再构造缺头字段/缺用例注释反例 → 对照错误位置与原因。
 * 覆盖边界：覆盖 四字段、责任行、skip/todo、词法忽略及 Git/遍历发现；不覆盖 中文说明的事实准确性和人工可读性评审。
 * 外部前置：优先需要 Git 获取 tracked 入口，缺少时遍历 test；反例全部是内存源码或临时目录。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkAll, checkSource, findEntrypoints, selfTest } from '../../scripts/check-test-docs.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const header = [
  '/**',
  ' * 测试职责：固定输入产生可比对的返回结果。',
  ' * 典型流程：准备输入 → 调用目标 → 比较结果。',
  ' * 覆盖边界：覆盖 合成函数行为；不覆盖 外部网络。',
  ' * 外部前置：无',
  ' */',
  '',
].join('\n');
const note = '// 责任：传入确定输入后只返回预期结果，不能改变外部状态。\n';
const call = "test('synthetic', () => {});\n";

// 责任：扫描全部公开入口必须零错误，临时反例的遍历须排除 helpers/fixtures 且不会空扫成功。
test('all tracked test entrypoints satisfy the Chinese documentation contract', () => {
  const result = checkAll(root);
  assert.equal(result.ok, true, result.errors.map((error) => `${error.file}:${error.line}: ${error.message}`).join('\n'));
  assert.ok(result.fileCount > 0);
  assert.ok(result.testCount > 0);
  assert.equal(result.files.some((file) => /^test\/(helpers|fixtures)\//.test(file)), false);
  assert.match(selfTest(), /^PASS/);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-test-docs-discovery-'));
  try {
    for (const directory of ['test/helpers', 'test/fixtures', 'test/unit/client']) fs.mkdirSync(path.join(temporary, directory), { recursive: true });
    for (const file of ['test/a.mjs', 'test/unit/client/b.mjs', 'test/helpers/ignored.mjs', 'test/fixtures/ignored.mjs']) {
      fs.writeFileSync(path.join(temporary, file), header + note + call);
    }
    const noGit = { git: path.join(temporary, 'no-git-executable') };
    assert.deepEqual(findEntrypoints(temporary, noGit), ['test/a.mjs', 'test/unit/client/b.mjs']);
    assert.equal(checkAll(temporary, noGit).ok, true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

// 责任：逐个删掉或清空四字段必须点名缺项，放在 import 之后的假头也不能蒙混通过。
test('synthetic missing or empty header fields are rejected with the filename', () => {
  for (const field of ['测试职责', '典型流程', '覆盖边界', '外部前置']) {
    for (const replacement of ['', ` * ${field}：\n`]) {
      const source = header.replace(new RegExp(' \\* ' + field + '：[^\\n]*\\n'), replacement) + note + call;
      const result = checkSource(source, { file: 'test/synthetic.mjs' });
      assert.equal(result.ok, false);
      assert.ok(result.errors.some((error) => error.file === 'test/synthetic.mjs' && error.message.includes(field)));
    }
  }
  assert.equal(checkSource("import test from 'node:test';\n" + header + note + call).ok, false);
  assert.equal(checkSource('#!/usr/bin/env node\n' + header + note + call).ok, true);
  assert.equal(checkSource(header.replace('；不覆盖 外部网络。', '。') + note + call).ok, false);
});

// 责任：普通/skip/todo 用例缺近邻责任行均须报行号，字符串、注释和正则里的假调用不得被计为测试。
test('synthetic missing case notes fail while quoted calls are ignored', () => {
  for (const name of ['test', 'test.skip', 'test.todo']) {
    const source = header + call.replace('test(', name + '(');
    const result = checkSource(source, { file: 'test/missing-note.mjs' });
    assert.equal(result.ok, false);
    assert.equal(result.testCount, 1);
    assert.ok(result.errors.some((error) => error.file === 'test/missing-note.mjs' && error.line === 7 && error.message.includes('责任')));
    assert.equal(checkSource(header + note + '\n\n' + call.replace('test(', name + '(')).ok, true);
    assert.equal(checkSource(header + note + '\n\n\n' + call.replace('test(', name + '(')).ok, false);
  }
  const ignored = [
    '// test("not a registration", () => {});',
    '/* test.skip("also comment"); */',
    'const quoted = "test( no note )";',
    'const template = `test.todo( no note )`;',
    'const pattern = /test\\(fake\\)/;',
    'pattern.test(quoted);',
  ].join('\n');
  const result = checkSource(header + ignored + '\n' + note + call);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.testCount, 1);
  assert.equal(checkSource(header + note + "for (const n of [1]) test('loop', () => {});\n").ok, true);
  assert.equal(checkSource(header + '// 分段职责：直接断言脚本的步骤应有中文职责。\nassert.equal(1, 1);\n').ok, true);
});
