/**
 * 测试职责：冻结客户端 loader、依赖、公共 API 与插槽接线。
 * 典型流程：读取真实 bundle → 构造独立离线替身 → 逐段断言契约。
 * 覆盖边界：覆盖 出货产物的离线契约；不覆盖真实 DOM、浏览器视觉、网络或宿主会话。
 * 外部前置：需要仓库现有客户端构建产物；不启动浏览器。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { API_PATHS, COMMAND_OPS } from '../../lib/shared/contract.js';
import { loadClientBundle } from '../helpers/client-bundle-fixture.mjs';

// 责任：先检查计划编辑器传入 projectId，避免请求落到 undefined 项目。（原 L17-20）
test("plan editor project identity", () => {
  const { source } = loadClientBundle();

  // 分段职责：先检查计划编辑器传入 projectId，避免请求落到 undefined 项目。
  // The plan editor hydrates task fields with getTask(projectId, ...): a missing
  // projectId turned every request into /projects/undefined/tasks/... (400).
  assert.ok(source.includes('projectId: props.projectId'), 'plans view must pass projectId into the plan editor');
});

// 责任：用最小 React 替身校验 loader 身份及公开导出。（原 L49-53、L55-57）
test("loader identity and public exports", () => {
  const { here, captured, exportsValue } = loadClientBundle();

  assert.ok(captured, 'bundle called __ModuleLoader__.load');
  const manifest = JSON.parse(fs.readFileSync(path.join(here, '../..', 'package.json'), 'utf8'));
  assert.equal(captured.id, manifest.name, 'loaded factory identity matches the package manifest');
  assert.equal(typeof captured.factory, 'function');

  assert.deepEqual(exportsValue.inject, ['slots', 'layout']);
  assert.equal(typeof exportsValue.apply, 'function');
  assert.equal(exportsValue.PANEL_ID, 'project-board');
});

// 责任：注册主面板、侧栏、工具卡和会话跳转入口，重复 apply 不得抛错。（原 L59-99）
test("slot wiring and reentrant apply", () => {
  const { exportsValue } = loadClientBundle();

  // 分段职责：注册主面板、侧栏、工具卡和会话跳转入口，重复 apply 不得抛错。
  // ------------------------------------------------------------- slot wiring

  const registrations = [];
  const ctx = {
    layout: { selectPanel() {} },
    slots: {
      inject(name, callback) { callback(); },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
    },
  };
  exportsValue.apply(ctx);
  const names = registrations.map((entry) => entry.options.name);
  assert.ok(names.includes('main'));
  assert.ok(names.includes('sidebar.panellist'));
  assert.ok(names.includes('tool.call.toolview'));
  const main = registrations.find((entry) => entry.options.name === 'main');
  assert.equal(main.options.key, 'project-board');
  const sidebar = registrations.find((entry) => entry.options.name === 'sidebar.panellist');
  assert.equal(sidebar.options.id, 'project-board');
  assert.equal(sidebar.options.label, '项目板');
  const toolview = registrations.find((entry) => entry.options.name === 'tool.call.toolview');
  assert.equal(toolview.options.key, 'project_board');
  assert.equal(typeof toolview.options.inject, 'function');
  const injected = toolview.options.inject();
  assert.equal(typeof injected.openPanel, 'function');
  const sessionJump = registrations.find((entry) => entry.options.name === 'conversation.session.header.utilities');
  assert.ok(sessionJump, 'session header entry is registered');
  assert.equal(sessionJump.options.id, 'project-board-jump');
  assert.equal(typeof sessionJump.options.inject, 'function');
  const jumpInjected = sessionJump.options.inject();
  assert.equal(typeof jumpInjected.onOpen, 'function');
  for (const entry of registrations) assert.equal(typeof entry.component, 'function');

  // applying twice must not throw (stylesheet injection is idempotent)
  const before = registrations.length;
  exportsValue.apply(ctx);
  assert.equal(registrations.length, before * 2, 'apply is re-entrant per mount');
});

// 责任：比较共享命令/端点集合，拒绝客户端私藏副本、危险 HTML 与额外 require。（原 L101-142）
test("shared API and external dependency contract", () => {
  const { source, exportsValue } = loadClientBundle();

  // 分段职责：比较共享命令/端点集合，拒绝客户端私藏副本、危险 HTML 与额外 require。
  // ------------------------------------------------------------- api contract

  const EXPECTED_COMMANDS = [
    'task.create',
    'task.claim', 'task.begin', 'task.submit', 'task.verify', 'task.reject', 'task.block',
    'task.unblock', 'task.release', 'task.reconcile', 'task.cancel', 'task.reopen',
    'task.gate', 'doc.put',
    'plan.create', 'plan.revise', 'plan.publish', 'plan.archive', 'plan.unarchive', 'plan.focus',
  ];
  assert.equal(exportsValue.COMMANDS, undefined, 'the command list now lives in lib/shared/contract.js');
  for (const op of EXPECTED_COMMANDS) {
    assert.ok(COMMAND_OPS.includes(op), 'UI command is missing from the shared contract: ' + op);
  }

  const EXPECTED_PATHS = [
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
    '/projects/:id/health',
    '/projects/:id/commands',
  ];
  assert.equal(exportsValue.API_PATHS, undefined, 'the endpoint table now lives in lib/shared/contract.js');
  assert.deepEqual(Object.values(API_PATHS).sort(), EXPECTED_PATHS.slice().sort(), 'endpoint surface is frozen');
  assert.ok(!/var COMMANDS = \[/.test(source), 'client must not keep a second command list');
  assert.ok(!/var API_PATHS = \{/.test(source), 'client must not keep a second endpoint table');

  const literalPaths = [...source.matchAll(/api\('([^']+)'/g)].map((match) => match[1]);
  for (const literal of literalPaths) {
    assert.ok(literal.startsWith('/projects') || literal.startsWith('/ping'), 'unexpected API path: ' + literal);
  }
  assert.ok(!source.includes('dangerouslySetInnerHTML'), 'no raw HTML injection');
  assert.ok(!source.includes('innerHTML'), 'no innerHTML assignment');
  const requires = [...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(requires)], ['react'], 'client bundle only requires react');
});
