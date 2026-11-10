/**
 * 测试职责：保证插件在宿主冷启动时完整注册工具，并等待 webServer 后补挂路由和 token。
 * 典型流程：合成 ctx 先不提供 webServer → apply → 注入延迟 webCtx → 检查五工具 schema、路由及全局 token。
 * 覆盖边界：覆盖 注册契约和延迟依赖装配；不覆盖真实 DSH 服务启动或实际 HTTP 请求。
 * 外部前置：需要 DSH peer 可导入；只使用临时 store 和合成宿主对象。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../../lib/index.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-host-'));
const tools = new Map();
const disposers = [];
let deferredMount = null;
let registeredRoute = null;
let injectionListener = null;
// 分段职责：构造无 webServer 的宿主替身，记录工具注册与延迟依赖注入。
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  tools: {
    register(tool) {
      assert.equal(typeof tool.name, 'string');
      tools.set(tool.name, tool);
    },
  },
  systemPrompt: {
    section() { return () => {}; },
    getSectionOrder() { return 9000; },
  },
  agents: { list() { return []; } },
  on() { return () => {}; },
  inject(deps, callback) {
    assert.deepEqual(deps, ['webServer']);
    deferredMount = callback;
  },
  effect(fn) {
    const disposer = fn();
    if (typeof disposer === 'function') disposers.push(disposer);
    return () => {};
  },
  get() { return undefined; },
};

try {
  apply(ctx, { rootDir: root });
  await new Promise((resolve) => setTimeout(resolve, 50));

  // 分段职责：apply 后必须恰注册五个工具，并保留 board/task 必要参数与输出函数。
  const expected = ['project_board', 'project_plan', 'project_task', 'project_doc', 'project_session'];
  for (const name of expected) {
    assert.ok(tools.has(name), 'missing tool ' + name);
  }
  assert.equal(tools.size, expected.length);

  const board = tools.get('project_board');
  assert.ok(board.parameters && board.parameters.properties && board.parameters.properties.view, 'project_board.view parameter');
  assert.ok(Array.isArray(board.parameters.required) && board.parameters.required.includes('view'));
  assert.deepEqual(board.parameters.properties.view.enum, ['brief', 'board', 'task', 'plan', 'plans', 'docs', 'doc', 'events', 'health']);
  assert.equal(typeof board.execute, 'function');
  assert.equal(typeof board.output.render, 'function');

  const task = tools.get('project_task');
  assert.ok(task.parameters.properties.op.enum.includes('submit'));
  assert.ok(task.parameters.properties.op.enum.includes('reconcile'));

  // 分段职责：补注入 webServer 后须挂路由并提供 48 字符全局 token，不得冷启时静默漏挂。
  // Cold start: webServer is not present during apply; the plugin must wait
  // via ctx.inject instead of silently skipping routes + token injection.
  assert.equal(typeof deferredMount, 'function', 'project-board did not defer webServer mount');
  const web = {
    register(route) {
      registeredRoute = route;
      return () => {};
    },
  };
  const webCtx = {
    logger: ctx.logger,
    get(name) { return name === 'webServer' ? web : undefined; },
    on(event, listener) {
      if (event === 'webserver/index-inject') injectionListener = listener;
      return () => {};
    },
    effect(fn) { fn(); return () => {}; },
  };
  deferredMount(webCtx);
  assert.ok(registeredRoute, 'routes were not registered after webServer mounted');
  assert.equal(registeredRoute.kind, 'prefix');
  assert.equal(registeredRoute.path, '/project-board/api');
  assert.equal(typeof injectionListener, 'function');
  const table = [];
  injectionListener(table);
  const row = table.find((item) => item.name === '__PROJECT_BOARD__');
  assert.ok(row, 'token injection row missing');
  assert.equal(row.kind, 'global');
  assert.equal(row.value.base, '/project-board/api');
  assert.equal(typeof row.value.token, 'string');
  assert.equal(row.value.token.length, 48);

  console.log('PASS host-preflight: ' + [...tools.keys()].join(', '));
} finally {
  for (const dispose of disposers) {
    try { dispose(); } catch { /* ignore */ }
  }
  fs.rmSync(root, { recursive: true, force: true });
}
