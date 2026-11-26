/**
 * 测试职责：实际 DSH SDK 验证七工具 schema、SDK 渲染及业务 raw output。
 * 典型流程：SDK 重算固定 corpus；注册工具并经 SDK 校验 create/claim/begin 返回。
 * 覆盖边界：覆盖 真实 SDK，无静默 skip；不声称 LLM 或浏览器验收。；不覆盖真实用户数据与 LLM 推理。
 * 外部前置：已安装 DSH tools/PTC peer，缺失必须失败。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { fixture, text } from '../helpers/agent-parity-fixture.mjs';
import { sdkValidationCases } from '../fixtures/sdk-validation-cases.mjs';
import { KNOWLEDGE_JSON } from '../helpers/mcp-fixture.mjs';
import { KNOWLEDGE_TOOLS } from '../../lib/shared/knowledge.js';
const sdkRequire = createRequire(new URL('../../tools/dsh-sdk/package.json', import.meta.url));
const { assertSupportedJsonSchema, validateJsonSchemaValue } = await import(pathToFileURL(sdkRequire.resolve('@deepseek-ai/dsh-tools')).href);
const { renderToolsSdk, renderToolsSdkPy } = await import(pathToFileURL(sdkRequire.resolve('@deepseek-ai/dsh-tool-executor-ptc')).href);

// 责任：真实 SDK 重算 corpus 并生成包含七工具的 TypeScript 与 Python 调用接口。
test('real DSH SDK revalidates the frozen corpus and both generated SDKs', async t => {
  const expected = JSON.parse(fs.readFileSync(new URL('../fixtures/sdk-validation.json', import.meta.url), 'utf8'));
  const actual = sdkValidationCases().map(({ name, schema, value }) => {
    const violations = validateJsonSchemaValue(schema, value);
    return { name, accepted: violations.length === 0, violations };
  });
  assert.deepEqual(actual, expected);
  const f = await fixture(t);
  const schemas = [...f.native.values()].map((tool) => {
    assertSupportedJsonSchema(tool.parameters); assertSupportedJsonSchema(tool.output.schema);
    return { name: tool.name, description: tool.description, parameters: tool.parameters, output: tool.output.schema };
  });
  for (const sdk of [renderToolsSdk(schemas), renderToolsSdkPy(schemas)]) {
    for (const tool of schemas) assert.ok(sdk.includes(tool.name), tool.name);
    assert.ok(sdk.includes('context')); assert.ok(sdk.includes('section'));
  }
});

// 责任：真实 SDK 校验两入口 create、claim、begin 与 task 的原始输出。
test('MCP and native raw outputs pass actual SDK validation before rendering', async t => {
  const f = await fixture(t);
  for (const tool of f.native.values()) {
    const execute = tool.execute;
    tool.execute = async (...args) => {
      const value = await execute(...args);
      assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value), [], tool.name);
      return value;
    };
  }
  const { context } = await f.open();
  const checked = new Set();
  for (const via of ['native', 'mcp']) {
    const call = async (name, args) => {
      checked.add(name);
      if (via === 'native') return f.nativeCall(name, args);
      const mcpArgs = { ...args, context };
      const shown = text(await f.call(name, mcpArgs));
      if (!Object.values(KNOWLEDGE_TOOLS).includes(name)) return shown;
      assert.match(shown, /\[knowledge-text-v1\]/u);
      const raw = JSON.parse(text(await f.post('tools/call', { name, arguments: mcpArgs, _meta: KNOWLEDGE_JSON })));
      assert.deepEqual(validateJsonSchemaValue(f.native.get(name).output.schema, raw), [], name);
      return raw;
    };
    await call('project_task', { op: 'create', title: via, acceptance: [{ text: 'ok' }] });
    const task = Object.values(f.h.state.tasks).find(({ title }) => title === via);
    await call('project_task', { op: 'claim', taskId: task.id, expectedRev: task.rev });
    await call('project_task', { op: 'begin', taskId: task.id, expectedRev: f.h.state.tasks[task.id].rev, fencingToken: f.h.leases.get(task.id).token, summary: 'Check output' });
    await call('project_board', { view: 'task', taskId: task.id });
    await call('project_plan', { op: 'create', title: 'SDK ' + via, goal: 'SDK raw output' });
    fs.writeFileSync(path.join(f.wsDir, via + '.md'), '# SDK fixture\n');
    await call('project_doc', { op: 'register', title: 'SDK ' + via, relPath: via + '.md' });
    await call('project_session', { op: 'checkpoint', note: 'SDK raw output' });
    const found = await call('search_project_knowledge', { query: via, kinds: ['task'], relatedLimit: 0 });
    const value = typeof found === 'string' ? JSON.parse(found) : found;
    assert.ok(value.hits.length > 0);
    await call('read_project_knowledge', { refs: [value.hits[0].ref], relatedLimit: 0 });
  }
  assert.deepEqual([...checked].sort(), [...f.native.keys()].sort());
});
