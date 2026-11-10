/**
 * 测试职责：冻结模型可见工具名称、描述、参数 schema 与声明 manifest 的一致性。
 * 典型流程：动态加载宿主 peer → 合成 ctx 注册工具 → 排序后比较 JSON fixture 与 manifest。
 * 覆盖边界：覆盖 公开工具 schema 字节结构；不覆盖工具执行行为或真实宿主会话。
 * 外部前置：需要 DSH peer；缺 peer 时打印明确 SKIP 并 exit 0。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The tool surface is a public contract: name, description and the JSON schema
// of the parameters must not change across refactors. The fixture was captured
// from the pre-split lib/host/tools.js; this test compares the registered
// surface (what the model actually sees) against it.
//
// This is the one test that needs the DSH host runtime. CI intentionally runs
// without the unpublished @deepseek-ai peers, so a missing peer is an explicit
// skip (visible in the log), not a silent gap; local `npm test` runs it.
// 分段职责：动态加载宿主 API；只对确实缺少 DSH peer 明确跳过，其他导入错误必须抛出。
let apply;
let TOOL_MANIFEST;
try {
  ({ apply } = await import('../../lib/index.js'));
  ({ TOOL_MANIFEST } = await import('../../lib/host/tools.js'));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error?.code === 'ERR_MODULE_NOT_FOUND' && message.includes('@deepseek-ai/')) {
    console.log('SKIP tool-schema-snapshot: DSH host runtime is not installed (' + message.split('\n')[0] + ')');
    process.exit(0);
  }
  throw error;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/tool-schema.json'), 'utf8'));

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-schema-state-'));
const tools = new Map();
const disposers = [];
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  tools: { register(tool) { tools.set(tool.name, tool); } },
  systemPrompt: { section() { return () => {}; }, getSectionOrder() { return 9000; } },
  agents: { list() { return []; } },
  on() { return () => {}; },
  effect(fn) { const disposer = fn(); if (typeof disposer === 'function') disposers.push(disposer); return () => {}; },
  get() { return undefined; },
};

try {
  apply(ctx, { rootDir: stateDir });
  await new Promise((resolve) => setTimeout(resolve, 30));

  // 分段职责：从实际注册结果采集名称/描述/schema，排序后与 fixture 及 manifest 双向比较。
  const surface = [...tools.values()]
    .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
    .sort((a, b) => a.name.localeCompare(b.name));

  assert.deepEqual(surface, fixture, 'registered tool surface drifted from test/fixtures/tool-schema.json');
  assert.deepEqual(surface.map((tool) => tool.name), fixture.map((tool) => tool.name), 'tool names/order changed');
  assert.deepEqual(TOOL_MANIFEST.map((entry) => entry.name).sort(), surface.map((tool) => tool.name), 'tools.js manifest drifted from the registered surface');
  console.log('PASS tool-schema-snapshot: ' + surface.map((tool) => tool.name).join(', '));
} finally {
  for (const dispose of disposers) { try { dispose(); } catch { /* ignore */ } }
  fs.rmSync(stateDir, { recursive: true, force: true });
}
