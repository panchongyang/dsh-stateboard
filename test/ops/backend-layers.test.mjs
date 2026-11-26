/**
 * 测试职责：验证后端六层门禁的 import 方向、状态写、提交旁路、host/查询能力、已发布对象与维护脚本分类，并用临时 fixture 注入反例。
 * 典型流程：构造合成 lib/scripts 树 → checkBackendLayers → 断言规则、行号与通过/失败边界。
 * 覆盖边界：覆盖 AST 解析与每类规则；不覆盖真实业务行为、真实 store 或运行时服务。
 * 外部前置：仅 Node 与仓库内 tools/typescript；不访问网络、真实 home 或看板。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  RULES, SCRIPT_MODULES, SCRIPT_POLICY, checkBackendLayers, layerOf,
} from '../../scripts/check-backend-layers.mjs';
import { withProject } from '../helpers/service-fixture.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-layers-'));
  for (const [relative, body] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return root;
}

function withFixture(t, files) {
  const root = fixture(files);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function rules(result) {
  return result.violations.map((violation) => violation.rule);
}

function find(result, rule) {
  return result.violations.filter((violation) => violation.rule === rule);
}

function cleanTree() {
  return {
    'lib/shared/contract.js': "export const STATES = Object.freeze(['ready', 'done']);\n",
    'lib/core/model.js': "import { STATES } from '../shared/contract.js';\nexport function enter(task) { task.state = STATES[0]; return task; }\n",
    'lib/core/domain/task.js': "export function advanceState(task, next) { task.state = next; return task; }\n",
    'lib/core/business/policy.js': "import { STATES } from '../../shared/contract.js';\nexport const isState = (value) => STATES.includes(value);\n",
    'lib/core/store.js': "import { enter } from './model.js';\nexport function read(store) { return store.state; }\n",
    'lib/core/store/format.js': "export function validate(commit) { return Boolean(commit); }\n",
    'lib/core/projection/views.js': "export function card(state) { return { name: state.project.name }; }\n",
    'lib/core/reader/query.js': "import { read } from '../store.js';\nexport function query(store) { return read(store); }\n",
    'lib/core/commands/task.js': "export function handler(read) { return { operations: [] }; }\n",
    'lib/core/application/index.js': "import { handler } from '../commands/task.js';\nimport { query } from '../reader/query.js';\nexport const app = { handler, query };\n",
    'lib/host/tools.js': "import { app } from '../core/application/index.js';\nexport function read() { return app.query; }\n",
    'scripts/read.mjs': "export const ok = 1;\n",
  };
}

const cleanPolicy = { 'scripts/read.mjs': { modes: ['read'] } };

// 责任：合法的六层方向应通过，且脚本与 lib 都被实际扫描。
test('a clean six-layer tree passes', (t) => {
  const root = withFixture(t, cleanTree());
  const result = checkBackendLayers({ root, scriptPolicy: cleanPolicy });
  assert.equal(result.ok, true, JSON.stringify(result.violations));
  assert.equal(result.files.lib, 11);
  assert.equal(result.files.scripts, 1);
  assert.equal(result.scripts.classified, 1);
});

// 责任：内层不得 import 外层；model 与 command 的向上依赖都要被拒绝。
test('inner layers must not import outer layers', (t) => {
  const files = cleanTree();
  files['lib/core/model.js'] += "import { read } from '../host/tools.js';\n";
  files['lib/core/commands/task.js'] += "import { app } from '../application/index.js';\n";
  const root = withFixture(t, files);
  const result = checkBackendLayers({ root, scriptPolicy: cleanPolicy });
  assert.equal(result.ok, false);
  const found = find(result, RULES.forbiddenImport);
  assert.equal(found.length, 2);
  assert.ok(found.some((violation) => violation.file.endsWith('lib/core/model.js')));
  assert.ok(found.some((violation) => violation.file.endsWith('lib/core/commands/task.js')));
});

// 责任：实体状态只能在 model 层赋值；命令直改 next.state 必须报红。
test('state assignment outside the model layer is rejected', (t) => {
  const files = cleanTree();
  files['lib/core/commands/task.js'] = "export function handler(task) { task.state = 'review'; return task; }\n";
  files['lib/core/projection/views.js'] = "export function card(state, next) { next.state = 'done'; return next; }\n";
  const root = withFixture(t, files);
  const result = checkBackendLayers({ root, scriptPolicy: cleanPolicy });
  const state = find(result, RULES.stateWrite);
  assert.equal(state.length, 2);
  assert.deepEqual(state.map((violation) => violation.line).sort(), [1, 1]);
});

// 责任：model/domain 内赋值合法，不能被误报。
test('the model layer may assign state', (t) => {
  const files = cleanTree();
  files['lib/core/model.js'] = "export function enter(task) { task.state = 'ready'; return task; }\n";
  files['lib/core/domain/task.js'] = "export function leave(task) { task.state = 'done'; }\n";
  const root = withFixture(t, files);
  const result = checkBackendLayers({ root, scriptPolicy: cleanPolicy });
  assert.equal(find(result, RULES.stateWrite).length, 0);
});

// 责任：直接改已发布的 handle.state 要报红；structuredClone 的私有草稿不报。
test('published values are immutable outside the model; clones are private drafts', (t) => {
  const files = cleanTree();
  files['lib/core/commands/direct.js'] = "export function mutate(handle) { handle.state.project.name = 'x'; }\n";
  files['lib/core/commands/clone.js'] = "export function mutate(handle) { const next = structuredClone(handle.state.tasks.a); next.title = 'x'; return next; }\n";
  const root = withFixture(t, files);
  const result = checkBackendLayers({ root, scriptPolicy: cleanPolicy });
  const mutation = find(result, RULES.publishedMutation);
  assert.equal(mutation.length, 1);
  assert.equal(mutation[0].file, 'lib/core/commands/direct.js');
});

// 责任：普通 host 不得 resolve/open/touch/command handle；lifecycle 只放行装配动作。
test('ordinary host ingress cannot acquire or command a writer', (t) => {
  const files = cleanTree();
  files['lib/host/tools.js'] = [
    "import { resolveHandle } from './shared.js';",
    'export async function read(runtime, exec) {',
    '  const handle = await resolveHandle(runtime, exec);',
    '  handle.touch(exec.agent.id);',
    '  return handle.command({ op: "task.verify" });',
    '}',
  ].join('\n') + '\n';
  files['lib/host/shared.js'] = "export async function resolveHandle(runtime) { return runtime.service.openByWorkspace('/x'); }\n";
  files['lib/host/lifecycle.js'] = [
    'export async function attach(service) {',
    '  const handle = await service.openByWorkspace("/x");',
    '  await handle.attach("s");',
    '  await handle.command({ op: "x" });',
    '}',
  ].join('\n') + '\n';
  const root = withFixture(t, files);
  const result = checkBackendLayers({ root, scriptPolicy: cleanPolicy });
  const host = find(result, RULES.hostCapability);
  assert.ok(host.some((violation) => violation.file === 'lib/host/tools.js' && violation.line === 3));
  assert.ok(host.some((violation) => violation.file === 'lib/host/tools.js' && violation.line === 4));
  assert.ok(host.some((violation) => violation.file === 'lib/host/tools.js' && violation.line === 5));
  assert.ok(host.some((violation) => violation.file === 'lib/host/shared.js' && violation.line === 1));
  assert.equal(host.filter((violation) => violation.file === 'lib/host/lifecycle.js').length, 1);
});

// 责任：app.command / application.command / source.command 合法；service/handle 取 writer 或 command 非法；按接收者而不是方法名判断。
test('capability checks distinguish application facade from service/handle', (t) => {
  const files = cleanTree();
  files['lib/host/tools.js'] = [
    'export async function read(app, application, source, service, handle, runtime) {',
    '  app.command("p", {});',
    '  application.command("p", {});',
    '  source.command({ op: "x" });',
    '  runtime.application.command("p", {});',
    '  app.capabilities.createProject({ workspacePath: "/x" });',
    '  service.command("p", {});',
    '  handle.command({ op: "x" });',
    '  runtime.service.openByWorkspace("/x");',
    '  handle.touch("s");',
    '  service.createProject({ workspacePath: "/x" });',
    '}',
  ].join('\n') + '\n';
  const root = withFixture(t, files);
  const result = checkBackendLayers({ root, scriptPolicy: cleanPolicy });
  const host = find(result, RULES.hostCapability);
  assert.deepEqual(host.map((violation) => violation.line).sort((a, b) => a - b), [7, 8, 9, 10, 11]);
  assert.ok(host.every((violation) => violation.file === 'lib/host/tools.js'));
});

// 责任：能力引用来自导入、构造、绑定、解构与实参时仍要识别，不能靠变量名猜。
test('capability refs from imports, bindings and parameters are rejected', (t) => {
  const files = cleanTree();
  files['lib/host/tools.js'] = [
    "import { ProjectService } from '../core/service.js';",
    'export async function read(runtime, handle) {',
    '  const svc = new ProjectService({ rootDir: "/x" });',
    '  const { service } = runtime;',
    '  const opened = await runtime.service.openByWorkspace("/x");',
    '  svc.open("p");',
    '  service.command("p", {});',
    '  opened.touch("s");',
    '  handle.attach("s");',
    '}',
  ].join('\n') + '\n';
  const root = withFixture(t, files);
  const result = checkBackendLayers({ root, scriptPolicy: cleanPolicy });
  const host = find(result, RULES.hostCapability);
  assert.deepEqual(host.map((violation) => violation.line).sort((a, b) => a - b), [5, 6, 7, 8, 9]);
});

// 责任：别名不能绕过；safe facade 别名不应误报。
test('capability aliases are followed', (t) => {
  const files = cleanTree();
  files['lib/host/tools.js'] = [
    'export function read(app, handle) {',
    '  const safe = app.command;',
    '  const unsafe = handle.command;',
    '  safe("p", {});',
    '  unsafe({ op: "x" });',
    '}',
  ].join('\n') + '\n';
  const root = withFixture(t, files);
  const result = checkBackendLayers({ root, scriptPolicy: cleanPolicy });
  assert.equal(find(result, RULES.capabilityAlias).length, 1);
  assert.equal(find(result, RULES.capabilityAlias)[0].line, 5);
});

// 责任：命令处理器只交 operations/结果，不生成/返回 events，不导入模型实现，不接可写 handle。
test('command handlers cannot assemble events or accept a writer', (t) => {
  const files = cleanTree();
  files['lib/core/commands/task.js'] = [
    "import { makeCommit } from '../store.js';",
    'export function taskBad(read, cmd) {',
    "  const events = makeCommit(1, 'x', {}, 'c', 0, []);",
    '  return { operations: [], events };',
    '}',
    'export function taskAlias(read, cmd) {',
    '  const out = { operations: [] };',
    '  out.events = [];',
    '  return out;',
    '}',
    'export function taskAlias2(read) { const events = []; const ev = events; return { operations: [], ev }; }',
    'export function taskRaw(handle, cmd) { return { operations: [] }; }',
    'export function taskGood(read, cmd) { return { operations: [{ kind: "task.noop", args: {} }] }; }',
  ].join('\n') + '\n';
  const root = withFixture(t, files);
  const result = checkBackendLayers({ root, scriptPolicy: cleanPolicy });
  assert.ok(find(result, RULES.eventAssembly).length >= 3);
  assert.ok(find(result, RULES.commandImport).length >= 1);
  assert.ok(find(result, RULES.commandSurface).length >= 1);
  assert.equal(find(result, RULES.eventAssembly).filter((v) => v.line === 14).length, 0);
});

// 责任：命令层不得导出任意写函数；直接调 raw append/makeCommit 要报。
test('command layer cannot export arbitrary write functions or call raw writes', (t) => {
  const files = cleanTree();
  files['lib/core/commands/task.js'] = [
    'export function publishTask(read, cmd) { return { operations: [] }; }',
    "export function taskCommit(read) { return makeCommit(1, 'x', {}, 'c', 0, []); }",
  ].join('\n') + '\n';
  const root = withFixture(t, files);
  const result = checkBackendLayers({ root, scriptPolicy: cleanPolicy });
  assert.equal(find(result, RULES.commandWriteFunction).length, 1);
  assert.ok(find(result, RULES.rawWrite).length >= 1);
});

// 责任：runtime 不得定义任意 raw append；直接调用或简单别名都要拒绝；具名事务/回放/维护例外才放行。
test('runtime raw append functions are named and aliases are rejected', (t) => {
  const files = cleanTree();
  files['lib/core/handle.js'] = [
    'export class Handle {',
    '  writeEvents(events) { return events; }',
    '}',
    'export function useAlias(handle) {',
    '  const append = handle.writeEvents;',
    '  return append([]);',
    '}',
  ].join('\n') + '\n';
  files['lib/core/transaction/repair-acceptance.js'] = [
    "import { makeCommit } from '../domain/commit-envelope.js';",
    'export function repair(handle, events) { return makeCommit(1, "x", {}, "c", 0, events); }',
  ].join('\n') + '\n';
  const root = withFixture(t, files);
  const result = checkBackendLayers({ root, scriptPolicy: cleanPolicy });
  assert.equal(find(result, RULES.rawWrite).length, 2);
  assert.ok(find(result, RULES.rawWriteAlias).length >= 1);
  assert.equal(find(result, RULES.rawWrite).filter((v) => v.file.endsWith('repair-acceptance.js')).length, 1);
});

// 责任：动态调用和非字面量 import 不能被证明安全；business 的 node:fs 在目标解析前就要报。
test('dynamic calls, dynamic imports and business builtins fail closed', (t) => {
  const files = cleanTree();
  files['lib/core/business/policy.js'] = "import fs from 'node:fs';\nexport const x = fs;\n";
  files['lib/host/tools.js'] = [
    'export function read(handle, key) {',
    '  eval("1");',
    '  handle[key]();',
    '  return import(key);',
    '}',
  ].join('\n') + '\n';
  const root = withFixture(t, files);
  const result = checkBackendLayers({ root, scriptPolicy: cleanPolicy });
  assert.ok(find(result, RULES.layerIo).some((violation) => violation.file === 'lib/core/business/policy.js'));
  assert.ok(find(result, RULES.dynamicCall).length >= 2);
  assert.ok(find(result, RULES.dynamicImport).length >= 1);
});

// 责任：read/query 层不得 append/commit 或写文件。
test('read and projection layers cannot write or commit', (t) => {
  const files = cleanTree();
  files['lib/core/reader/query.js'] = [
    "import fs from 'node:fs';",
    'export function query(handle) {',
    '  fs.writeFileSync("/tmp/x", "y");',
    '  handle._appendEvents([]);',
    '  return handle.store.append({});',
    '}',
  ].join('\n') + '\n';
  files['lib/core/projection/views.js'] = "export function at() { return Date.now(); }\n";
  const root = withFixture(t, files);
  const result = checkBackendLayers({ root, scriptPolicy: cleanPolicy });
  assert.ok(find(result, RULES.queryWrite).length >= 1);
  assert.equal(find(result, RULES.writeBypass).length, 2);
  assert.equal(find(result, RULES.ambientTime).length, 1);
});

// 责任：未知核心目录不能静默跳过，新增脚本必须显式登记。
test('unclassified paths fail closed', (t) => {
  const files = cleanTree();
  files['lib/core/newlayer/x.js'] = 'export const x = 1;\n';
  files['scripts/unlisted.mjs'] = 'export const x = 1;\n';
  const root = withFixture(t, files);
  const result = checkBackendLayers({ root, scriptPolicy: cleanPolicy });
  assert.equal(find(result, RULES.unknownLayer).length, 1);
  assert.equal(find(result, RULES.unclassifiedScript).length, 1);
  assert.deepEqual(result.scripts.unclassified, ['scripts/unlisted.mjs']);
});

// 责任：策略中已删除脚本的条目必须报 stale，避免幽灵豁免。
test('stale script policy entries are reported', (t) => {
  const files = cleanTree();
  const policy = { ...cleanPolicy, 'scripts/removed.mjs': { modes: ['apply'], gate: ['--apply'] } };
  const root = withFixture(t, files);
  const result = checkBackendLayers({ root, scriptPolicy: policy });
  assert.equal(find(result, RULES.staleScriptEntry).length, 1);
});

// 责任：read 模式取 writer 或写文件都要拒绝；temp-copy inventory 只放行 open。
test('read-mode scripts cannot take a writer or write files', (t) => {
  const files = cleanTree();
  files['scripts/read.mjs'] = "import fs from 'node:fs';\nexport async function main(service) { fs.writeFileSync('/tmp/x', 'y'); await service.open('p'); }\n";
  const root = withFixture(t, files);
  const result = checkBackendLayers({ root, scriptPolicy: cleanPolicy });
  assert.equal(find(result, RULES.scriptReadWriter).length, 1);
  assert.equal(find(result, RULES.scriptFsWrite).length, 1);

  files['scripts/read.mjs'] = 'export const ok = 1;\n';
  files['scripts/inventory.mjs'] = "export async function main(svc) { await svc.open('p'); }\n";
  const inventoryRoot = withFixture(t, files);
  const inventory = checkBackendLayers({
    root: inventoryRoot,
    scriptPolicy: { ...cleanPolicy, 'scripts/inventory.mjs': { modes: ['inventory'], isolation: 'temp-copy' } },
  });
  assert.equal(find(inventory, RULES.scriptReadWriter).length, 0);
});

// 责任：dry-run 在 apply 门之前取 writer 必须失败；门后取 writer 应通过。
test('dry-run never reaches a writer before its gate', (t) => {
  const files = cleanTree();
  files['scripts/unsafe.mjs'] = [
    'const apply = process.argv.includes("--apply");',
    'await service.open("p");',
    'if (!apply) process.exit(0);',
  ].join('\n') + '\n';
  const root = withFixture(t, files);
  const unsafe = checkBackendLayers({ root, scriptPolicy: { 'scripts/unsafe.mjs': { modes: ['dry-run'] } } });
  assert.equal(find(unsafe, RULES.scriptDryRunWriter).length, 1);

  files['scripts/safe.mjs'] = [
    'const apply = process.argv.includes("--apply");',
    'if (!apply) process.exit(0);',
    'await service.open("p");',
  ].join('\n') + '\n';
  const safeRoot = withFixture(t, files);
  const safe = checkBackendLayers({ root: safeRoot, scriptPolicy: { 'scripts/safe.mjs': { modes: ['dry-run'] } } });
  assert.equal(find(safe, RULES.scriptDryRunWriter).length, 0);
});

// 责任：apply/ops 必须带门禁，且不得调用私有 append/state 或 commit。
test('apply scripts require a gate and cannot use private writes', (t) => {
  const files = cleanTree();
  files['scripts/apply.mjs'] = "export async function main(handle) { await handle.saveSnapshot(); }\n";
  const root = withFixture(t, files);
  const result = checkBackendLayers({
    root,
    scriptPolicy: { 'scripts/apply.mjs': { modes: ['ops'], gate: ['--apply'] } },
  });
  assert.equal(find(result, RULES.scriptPrivateWrite).length, 1);
  assert.equal(find(result, RULES.scriptMissingGate).length, 1);
});

// 责任：字符串/注释不能伪造或隐藏能力；计算属性仍须识别。
test('AST scanning ignores strings and comments but sees computed access', (t) => {
  const files = cleanTree();
  files['lib/host/tools.js'] = [
    'const text = "handle.command()";',
    '// service.openByWorkspace("x")',
    'const fake = "resolveHandle";',
    'export function read(service) { return service["command"]({}); }',
  ].join('\n') + '\n';
  const root = withFixture(t, files);
  const result = checkBackendLayers({ root, scriptPolicy: cleanPolicy });
  const host = find(result, RULES.hostCapability);
  assert.equal(host.length, 1);
  assert.equal(host[0].line, 4);
});

// 责任：每个规则都能由 fixture 反例触发，避免只验证几个字符串。
test('each rule is exercised by an injected fixture', (t) => {
  const cases = {
    forbiddenImport: { 'lib/core/model.js': "import { app } from '../host/tools.js';\n", 'lib/host/tools.js': 'export const app = 1;\n' },
    stateWrite: { 'lib/core/commands/x.js': "export function x(task) { task.state = 'done'; }\n" },
    publishedMutation: { 'lib/core/commands/x.js': "export function x(handle) { handle.state.project.name = 'y'; }\n" },
    writeBypass: { 'lib/core/lease.js': 'export function x(handle) { handle.saveSnapshot(); }\n' },
    hostCapability: { 'lib/host/x.js': 'export function x(service) { return service.open("p"); }\n' },
    queryWrite: { 'lib/core/reader/x.js': "import fs from 'node:fs';\nexport function x() { fs.writeFileSync('a', 'b'); }\n" },
    ambientTime: { 'lib/core/projection/x.js': 'export function x() { return Date.now(); }\n' },
    unknownLayer: { 'lib/core/newlayer/x.js': 'export const x = 1;\n' },
    scriptReadWriter: { 'scripts/x.mjs': "export async function x(service) { await service.open('p'); }\n" },
    scriptDryRunWriter: { 'scripts/x.mjs': 'const apply = true;\nawait service.open("p");\nif (!apply) process.exit(0);\n' },
    scriptMissingGate: { 'scripts/x.mjs': "export const x = 1;\n" },
    scriptPrivateWrite: { 'scripts/x.mjs': 'export function x(handle) { handle._appendEvents([]); }\n' },
    scriptFsWrite: { 'scripts/x.mjs': "import fs from 'node:fs';\nexport const x = () => fs.writeFileSync('a', 'b');\n" },
    eventAssembly: { 'lib/core/commands/x.js': "export function taskX(read) { return { operations: [], events: [] }; }\n" },
    rawWrite: { 'lib/core/handle.js': 'export function writeEvents() {}\n' },
    rawWriteAlias: { 'lib/core/handle.js': 'export function x(h) { const a = h.writeEvents; return a([]); }\n' },
    commandImport: { 'lib/core/commands/x.js': "import { makeCommit } from '../store.js';\nexport function taskX(read) { return { operations: [] }; }\n" },
    commandSurface: { 'lib/core/commands/x.js': 'export function taskX(handle) { return { operations: [] }; }\n' },
    commandWriteFunction: { 'lib/core/commands/x.js': 'export function publishTask(read) { return { operations: [] }; }\n' },
    commandPlanCallback: { 'lib/core/commands/transaction.js': 'export function assembleCommand(cmd) { return { operations: [], admit: () => true }; }\n' },
    modelCommandCallback: { 'lib/core/transaction/operations.js': 'export function x(plan) { return plan.expand({}); }\n' },
    preCommandActivity: { 'lib/host/tools/shared.js': 'export function x(application) { return application.capabilities.ensureAgentProject({}); }\n' },
    commandName: { 'lib/core/domain/operations/tasks.js': "export function x(cmd) { return cmd.op === 'task.claim'; }\n" },
  };
  const policies = {
    scriptReadWriter: { 'scripts/x.mjs': { modes: ['read'] } },
    scriptDryRunWriter: { 'scripts/x.mjs': { modes: ['dry-run'] } },
    scriptMissingGate: { 'scripts/x.mjs': { modes: ['ops'], gate: ['--apply'] } },
    scriptPrivateWrite: { 'scripts/x.mjs': { modes: ['ops'], gate: ['--apply'], isolation: '' } },
    scriptFsWrite: { 'scripts/x.mjs': { modes: ['read'] } },
  };
  const expected = {
    forbiddenImport: RULES.forbiddenImport,
    stateWrite: RULES.stateWrite,
    publishedMutation: RULES.publishedMutation,
    writeBypass: RULES.writeBypass,
    hostCapability: RULES.hostCapability,
    queryWrite: RULES.queryWrite,
    ambientTime: RULES.ambientTime,
    unknownLayer: RULES.unknownLayer,
    scriptReadWriter: RULES.scriptReadWriter,
    scriptDryRunWriter: RULES.scriptDryRunWriter,
    scriptMissingGate: RULES.scriptMissingGate,
    scriptPrivateWrite: RULES.scriptPrivateWrite,
    scriptFsWrite: RULES.scriptFsWrite,
    eventAssembly: RULES.eventAssembly,
    rawWrite: RULES.rawWrite,
    rawWriteAlias: RULES.rawWriteAlias,
    commandImport: RULES.commandImport,
    commandSurface: RULES.commandSurface,
    commandWriteFunction: RULES.commandWriteFunction,
    commandPlanCallback: RULES.commandPlanCallback,
    modelCommandCallback: RULES.modelCommandCallback,
    preCommandActivity: RULES.preCommandActivity,
    commandName: RULES.operationsCommandName,
  };
  for (const [name, extra] of Object.entries(cases)) {
    const root = withFixture(t, { ...cleanTree(), ...extra });
    const policy = policies[name] || cleanPolicy;
    const result = checkBackendLayers({ root, scriptPolicy: policy });
    assert.ok(rules(result).includes(expected[name]), name + ': ' + JSON.stringify(result.violations));
  }
});

// 责任：relocate-project 的 dry-run 走锁外回放，不建 writer、不拿锁、不改日志。
test('relocate-project dry-run never opens a writer', async (t) => {
  const fixture = await withProject(t, { name: 'Synthetic relocate' });
  const projectId = fixture.h.id;
  const projectDir = path.join(fixture.stateDir, 'projects', projectId);
  const commitsPath = path.join(projectDir, 'commits.jsonl');
  const before = fs.readFileSync(commitsPath, 'utf8');
  const target = path.join(fixture.base, 'target-workspace');
  fs.mkdirSync(target, { recursive: true });
  fixture.h.close();
  const result = spawnSync(process.execPath, [
    path.join(repoRoot, 'scripts/relocate-project.mjs'),
    '--root', fixture.stateDir,
    '--project', projectId,
    '--to', target,
    '--dry-run',
  ], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.dryRun, true);
  assert.equal(report.writerOpened, false);
  assert.equal(report.current.projectId, projectId);
  assert.equal(fs.existsSync(path.join(projectDir, 'lock.json')), false);
  assert.equal(fs.readFileSync(commitsPath, 'utf8'), before);
});

// 责任：restore-acceptance 只在 --apply 分支构造 offline-maintenance service，并只交任务 ID 与盘点水位。
test('restore-acceptance uses the named offline command, not a generic append', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'scripts/restore-acceptance.mjs'), 'utf8');
  assert.match(source, /offlineMaintenance:\s*true/);
  assert.match(source, /restoreHistoricalAcceptance\(project,\s*\{/);
  assert.match(source, /taskIds:\s*targets\.map/);
  assert.match(source, /expectedRev/);
  assert.match(source, /expectedHash/);
  assert.doesNotMatch(source, /_appendEvents|saveSnapshot|structuredClone\(task\)/);
});

// 责任：命令计划只能是值；模型/事务不得回调 admit/expand；host 业务 helper 不得先 attach/touch 再命令。
test('command plans are value-only and model never calls command callbacks', (t) => {
  const files = cleanTree();
  files['lib/core/commands/transaction.js'] = 'export function assembleCommand(cmd) { return { request: cmd, admit: () => true, expand(read) { return { operations: [] }; } }; }\n';
  files['lib/core/transaction/operations.js'] = 'export function stage(plan) { const other = plan.handler; plan.admit({}); return plan.expand({}); }\n';
  files['lib/host/tools/shared.js'] = 'export async function resolve(application) { await application.capabilities.ensureAgentProject({ projectId: "p" }); await application.capabilities.recordActivity({ projectId: "p" }); }\n';
  files['lib/core/domain/operations/tasks.js'] = "export function x(cmd, request) { const op = cmd.op; const alias = request; alias?.op; const { op: renamed } = alias; const bracket = cmd['op']; const name = 'task.claim'; return requireCommand(cmd, 'task.claim'); }\n";
  files['lib/host/lifecycle.js'] = 'export async function attach(application) { return application.capabilities.ensureAgentProject({ projectId: "p" }); }\n';
  files['lib/core/transaction/model.js'] = 'export class Model { admit(cmd) { return Boolean(cmd); } run(ctx) { this.admit(ctx.cmd); ctx.clock(); ctx.idgen("x"); return ctx.medium; } }\n';
  const root = withFixture(t, files);
  const result = checkBackendLayers({ root, scriptPolicy: cleanPolicy });
  assert.equal(find(result, RULES.commandPlanCallback).length, 2);
  assert.equal(find(result, RULES.modelCommandCallback).length, 3);
  assert.equal(find(result, RULES.preCommandActivity).length, 2);
  assert.equal(find(result, RULES.preCommandActivity).filter((v) => v.file.endsWith('lifecycle.js')).length, 0);
  assert.equal(find(result, RULES.modelCommandCallback).filter((v) => v.file.endsWith('transaction/model.js')).length, 0);
  assert.ok(find(result, RULES.operationsCommandName).length >= 5);
  const valueFiles = cleanTree(); valueFiles['lib/core/commands/transaction.js'] = 'export function assembleCommand(cmd) { return { request: cmd, operations: [] }; }\n'; valueFiles['lib/host/lifecycle.js'] = files['lib/host/lifecycle.js']; valueFiles['lib/host/tools/session.js'] = 'export function init(application) { return application.capabilities.ensureProjectForSession({}); }\n'; valueFiles['lib/core/domain/operations/tasks.js'] = "export function x(task, request) { if (task.state === 'ready' && request.actor.kind === 'human' && request.cas === 1) return { kind: 'task.force', op: 'task.force' }; }\n";
  const valueRoot = withFixture(t, valueFiles);
  const value = checkBackendLayers({ root: valueRoot, scriptPolicy: cleanPolicy });
  assert.equal(find(value, RULES.commandPlanCallback).length, 0);
  assert.equal(find(value, RULES.preCommandActivity).length, 0);
  assert.equal(find(value, RULES.operationsCommandName).length, 0);
});

// 责任：真实仓库能被解析并产生结构化红项；结构迁移期允许红，但不允许 parse-error。
test('the real repository is scanned without parse errors', () => {
  const result = checkBackendLayers({ root: repoRoot });
  assert.ok(result.files.lib > 100);
  assert.ok(result.files.scripts >= 39);
  assert.equal(result.scripts.classified, result.files.scripts);
  assert.equal(result.scripts.modules.length, result.files.modules);
  assert.equal(find(result, RULES.unclassifiedModule).length, 0);
  assert.equal(find(result, RULES.parseError).length, 0);
  for (const violation of result.violations) {
    assert.equal(typeof violation.file, 'string');
    assert.ok(Number.isInteger(violation.line) && violation.line >= 1);
    assert.ok(Object.values(RULES).includes(violation.rule));
    assert.equal(typeof violation.message, 'string');
  }
});

// 责任：真实 scripts 目录与策略逐项对齐，新增脚本必须显式分类。
test('every real maintenance script is classified', () => {
  const scripts = fs.readdirSync(path.join(repoRoot, 'scripts'))
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => 'scripts/' + name)
    .sort();
  assert.deepEqual(scripts.filter((file) => !SCRIPT_POLICY[file]), []);
  for (const file of scripts) {
    assert.ok(Array.isArray(SCRIPT_POLICY[file].modes), file + ' modes');
    assert.ok(SCRIPT_POLICY[file].modes.length > 0, file + ' mode is declared');
  }
});

// 责任：scripts/backend-layers 支持模块必须真实分类，未知模块 fail-closed。
test('backend-layers support modules are classified', (t) => {
  const files = {
    'lib/shared/contract.js': 'export const x = 1;\n',
    'scripts/backend-layers/evil.mjs': 'export const x = 1;\n',
  };
  const root = withFixture(t, files);
  const result = checkBackendLayers({ root });
  assert.ok(find(result, RULES.unclassifiedModule).some((violation) => violation.file === 'scripts/backend-layers/evil.mjs'));

  const real = checkBackendLayers({ root: repoRoot });
  const moduleFiles = fs.readdirSync(path.join(repoRoot, 'scripts', 'backend-layers'))
    .filter((name) => name.endsWith('.mjs')).map((name) => 'scripts/backend-layers/' + name).sort();
  assert.deepEqual(moduleFiles.filter((file) => !SCRIPT_MODULES[file]), []);
  assert.equal(real.files.modules, moduleFiles.length);
  assert.equal(real.scripts.modules.length, moduleFiles.length);
  assert.equal(find(real, RULES.unclassifiedModule).length, 0);
});

// 责任：layerOf 是单一分类事实源，未知目录返回 null。
test('layerOf maps known paths and rejects unknown ones', () => {
  assert.equal(layerOf('lib/shared/contract.js'), 'shared');
  assert.equal(layerOf('lib/core/business/policy.js'), 'business');
  assert.equal(layerOf('lib/core/application/dto.js'), 'dto');
  assert.equal(layerOf('lib/core/commands/task.js'), 'command');
  assert.equal(layerOf('lib/core/domain/task.js'), 'model');
  assert.equal(layerOf('lib/core/model.js'), 'model');
  assert.equal(layerOf('lib/core/store.js'), 'persistence');
  assert.equal(layerOf('lib/core/projection/views.js'), 'projection');
  assert.equal(layerOf('lib/core/reader/query.js'), 'reader');
  assert.equal(layerOf('lib/host/tools.js'), 'host');
  assert.equal(layerOf('lib/core/newlayer/x.js'), null);
});
