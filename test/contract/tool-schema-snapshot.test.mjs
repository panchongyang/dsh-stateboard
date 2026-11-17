/**
 * 测试职责：冻结模型可见工具名称、描述、参数 schema 与声明 manifest 的一致性。
 * 典型流程：加载唯一注册目录 → 合成 ctx 注册工具 → 排序后比较 JSON fixture 与 manifest。
 * 覆盖边界：覆盖 公开工具 schema 字节结构；不覆盖工具执行行为或真实宿主会话。
 * 外部前置：仅 Node；实际注册目录不依赖 DSH peer，禁止 skip。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerTools } from '../../lib/host/tools/index.js';
import { TOOL_MANIFEST } from '../../lib/host/tools.js';
import { ProjectService } from '../../lib/core/service.js';

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
  const service = new ProjectService({ rootDir: stateDir });
  await service.init();
  disposers.push(() => service.close());
  registerTools(ctx, { service, ready: Promise.resolve(), ctx });

  // 分段职责：从实际注册结果采集名称/描述/schema，排序后与 fixture 及 manifest 双向比较。
  const surface = [...tools.values()]
    .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
    .sort((a, b) => a.name.localeCompare(b.name));

  assert.deepEqual(surface, fixture, 'registered tool surface drifted from test/fixtures/tool-schema.json');
  assert.deepEqual(surface.map((tool) => tool.name), fixture.map((tool) => tool.name), 'tool names/order changed');
  assert.deepEqual(TOOL_MANIFEST.map((entry) => entry.name).sort(), surface.map((tool) => tool.name), 'tools.js manifest drifted from the registered surface');
  console.log('PASS tool-schema-snapshot: ' + surface.map((tool) => tool.name).join(', '));
} finally {
  for (const dispose of disposers) { try { await dispose(); } catch { /* ignore */ } }
  fs.rmSync(stateDir, { recursive: true, force: true });
}
