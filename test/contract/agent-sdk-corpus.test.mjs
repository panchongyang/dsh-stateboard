/**
 * 测试职责：离线校验器与真实 DSH SDK 生成的固定样本接受集合一致。
 * 典型流程：重建特殊 JS 值并对照已提交 corpus；期望值不能由本地实现生成。
 * 覆盖边界：覆盖 参数 lossless JSON/type/enum/oneOf；宿主门禁重新核验 SDK。；不覆盖真实用户数据与 LLM 推理。
 * 外部前置：Node；不依赖未发布 DSH 包，不允许 skip。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sdkValidationCases } from '../fixtures/sdk-validation-cases.mjs';
import { validateInput } from '../../lib/host/tools/definition.js';

// 责任：对照真实 SDK 固定样本检验离线参数接受集合。
test('offline validation matches the real DSH SDK corpus', () => {
  const expected = JSON.parse(fs.readFileSync(new URL('../fixtures/sdk-validation.json', import.meta.url), 'utf8'));
  const cases = sdkValidationCases();
  assert.deepEqual(cases.map(({ name }) => name), expected.map(({ name }) => name));
  for (const [index, entry] of cases.entries()) {
    let accepted = true;
    try { validateInput(entry.schema, entry.value); } catch (error) { accepted = false; assert.equal(error.code, 'INVALID_ARGS'); }
    assert.equal(accepted, expected[index].accepted, entry.name);
  }
});
