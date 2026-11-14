/**
 * 测试职责：保证命令注册、领域枚举、客户端标签和 HTTP 路径共享冻结契约。
 * 典型流程：导入共享表 → 读取命令/host/client 源码 → 比较键集合及固定端点。
 * 覆盖边界：覆盖 表面一致性与原型键拒绝接线；不覆盖命令实际业务结果或浏览器交互。
 * 外部前置：无；需要仓库已生成的客户端产物。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  API_PATHS,
  COMMAND_OPS,
  DOC_KINDS,
  EVIDENCE_KINDS,
  TASK_STATES,
  TOOL_NAMES,
} from '../../lib/shared/contract.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// 分段职责：命令注册键须与共享 COMMAND_OPS 完全相同，且只用 own-key 分派避免原型键被调用。
// 1. The command table is the shared list: every listed op must be dispatchable
//    and nothing else may be. Dispatch is a single registry in
//    lib/core/commands/index.js, so parity is measured over its keys (kept in
//    COMMAND_OPS order) instead of switch cases in service.js.
const { COMMAND_HANDLERS } = await import('../../lib/core/commands/index.js');
assert.deepEqual(Object.keys(COMMAND_HANDLERS), COMMAND_OPS, 'COMMAND_HANDLERS keys and lib/shared COMMAND_OPS diverged');
for (const [op, handler] of Object.entries(COMMAND_HANDLERS)) {
  assert.equal(typeof handler, 'function', 'command op is not a handler: ' + op);
}
// Dispatch must use Object.hasOwn: a prototype key such as `constructor` is not a
// command and must reach the unknown-command path instead of being called.
assert.ok(!Object.hasOwn(COMMAND_HANDLERS, 'constructor'), 'a prototype key became dispatchable');
assert.ok(!Object.hasOwn(COMMAND_HANDLERS, 'toString'), 'a prototype key became dispatchable');
assert.ok(
  read('lib/core/handle.js').includes('Object.hasOwn(COMMAND_HANDLERS, cmd.op)'),
  'ProjectHandle._execute must dispatch via Object.hasOwn(COMMAND_HANDLERS, ...)',
);

// 分段职责：领域 TASK_STATES 必须是共享对象本身，不维护漂移副本。
// 2. The domain layer reads states from the shared contract (identity, not a copy).
const model = await import('../../lib/core/model.js');
assert.equal(model.TASK_STATES, TASK_STATES, 'model must re-export the shared state list');
assert.equal(model.ACTIVE_STATES.length > 0 && model.TERMINAL_STATES.length > 0, true);
for (const state of model.TASK_STATES) {
  assert.ok(TASK_STATES.includes(state), 'model exposed an unknown state: ' + state);
}

// 分段职责：工具枚举须从 shared 导入，公开工具名称必须全部注册。
// 3. The host tools may not keep a second copy of the enums or the tool names.
const tools = read('lib/host/tools.js');
for (const name of ['TASK_OPS', 'EVIDENCE_KINDS', 'DOC_KINDS']) {
  assert.ok(
    !new RegExp('const ' + name + ' = \\[').test(tools),
    name + ' must come from lib/shared/contract.js, not a local array',
  );
}
assert.ok(tools.includes("from '../shared/contract.js'"), 'host tools must import the contract');
for (const name of TOOL_NAMES) {
  assert.ok(tools.includes("name: '" + name + "'"), 'tool registration missing: ' + name);
}

// 分段职责：客户端展示标签键集合须严格等于共享契约的状态/证据/文档类型集合。
// 4. The client still owns presentation labels, but their key sets must match
//    the contract exactly. When the client gets a build step (M2) these labels
//    read the enums directly and this check becomes a set assertion on imports.
const client = read('lib/client.js');

function objectKeys(source, varName) {
  const match = new RegExp('var ' + varName + ' = \\{([\\s\\S]*?)\\};').exec(source);
  assert.ok(match, varName + ' not found in client');
  return [...match[1].matchAll(/'?([A-Za-z][\w-]*)'?\s*:/g)].map((item) => item[1]);
}

const sameSet = (actual, expected, label) => {
  assert.deepEqual([...actual].sort(), [...expected].sort(), label + ' drifted from the shared contract');
};

sameSet(objectKeys(client, 'STATE_LABELS'), TASK_STATES, 'client STATE_LABELS');
sameSet(objectKeys(client, 'EVIDENCE_KIND_LABELS'), EVIDENCE_KINDS, 'client EVIDENCE_KIND_LABELS');
sameSet(objectKeys(client, 'DOC_KIND_LABELS'), DOC_KINDS, 'client DOC_KIND_LABELS');

// 分段职责：客户端不得私藏命令/端点表，残余命令字面量必须可分派。
// 5. The client no longer keeps the command/endpoint tables; its remaining
//    literal ops must all be dispatchable commands.
assert.ok(!/var COMMANDS = \[/.test(client), 'client must not define COMMANDS');
assert.ok(!/var API_PATHS = \{/.test(client), 'client must not define API_PATHS');
for (const match of client.matchAll(/op: '([a-z]+\.[a-z]+)'/g)) {
  assert.ok(COMMAND_OPS.includes(match[1]), 'client sends an unknown command op: ' + match[1]);
}

// 分段职责：端点模板须保持冻结列表，不可在重构中悄悄增删路径。
// 6. Endpoint templates are still the frozen surface.
assert.deepEqual(Object.values(API_PATHS), [
  '/projects',
  '/projects/:id/board',
  '/projects/:id/tasks/:taskId',
  '/projects/:id/plans',
  '/projects/:id/plans/current',
  '/projects/:id/plans/:planId',
  '/projects/:id/docs',
  '/projects/:id/docs/:docId',
  '/projects/:id/docs/external',
  '/projects/:id/docs/external/:docId',
  '/projects/:id/docs/external/:docId/assets',
  '/projects/:id/health',
  '/projects/:id/commands',
]);

console.log('PASS contract-parity: command table / states / enums / endpoints agree with lib/shared/contract.js');
