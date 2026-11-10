/**
 * 测试职责：确保可选 MCP 监听只按插件配置启动，读取和卸载符合运行边界。
 * 典型流程：注入合成 DSH 上下文和临时存储 → 配置开关与本机请求 → 比较锁、日志和端口。
 * 覆盖边界：覆盖 默认关闭、显式开启、凭据隔离、只读数据和退出释放；不覆盖真实 DSH profile。
 * 外部前置：需要现有 DSH peer、本机回环临时端口；数据和凭据均为合成 fixture。
 */
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot';
import { apply } from '../../lib/index.js';
import { mountProjectMcp } from '../../lib/host/mcp.js';
import { withProject, command } from '../helpers/service-fixture.mjs';

const TOKEN = 'ac'.repeat(32);
const TOKEN_ENV = 'PROJECT_BOARD_MCP_TOKEN';
const HOST = '127.0.0.1';
const HUMAN = { kind: 'human', via: 'test' };

async function reservePort() {
  const server = createServer();
  server.listen(0, HOST);
  await once(server, 'listening');
  return {
    port: server.address().port,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function hostContext() {
  const mcp = new EventEmitter();
  const disposers = [];
  const tools = new Map();
  const messages = [];
  let inject;
  const log = (message) => {
    messages.push(message);
    if (message.includes('] MCP ')) mcp.emit('message', message);
  };
  const ctx = {
    logger: { info: log, warn: log, error: log },
    tools: { register(tool) { tools.set(tool.name, tool); } },
    agents: { list() { return []; } },
    on(event, handler) { if (event === 'webserver/index-inject') inject = handler; return () => {}; },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
    get(key) { return key === 'webServer' ? { register() { return () => {}; } } : undefined; },
  };
  return {
    ctx, tools, messages,
    nextMcpLog: () => once(mcp, 'message', { signal: AbortSignal.timeout(4000) }).then(([message]) => message),
    webToken() { const table = []; inject(table); return table[0].value.token; },
    async close() {
      while (disposers.length) await disposers.pop()();
    },
  };
}

function setToken(t, token) {
  const old = process.env[TOKEN_ENV];
  if (token === undefined) delete process.env[TOKEN_ENV];
  else process.env[TOKEN_ENV] = token;
  t.after(() => {
    if (old === undefined) delete process.env[TOKEN_ENV];
    else process.env[TOKEN_ENV] = old;
  });
}

async function post(port, method, params, token = TOKEN) {
  const res = await fetch('http://' + HOST + ':' + port + '/mcp', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + token,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-11-25',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(5000),
  });
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
}

// 责任：只有配置自身的布尔 true 能启用 MCP，关闭时不执行取值器或读取凭据。
test('MCP switch is off unless the config explicitly contains boolean true', async (t) => {
  const { stateDir } = await withProject(t);
  const readForbidden = new Proxy({}, { get() { assert.fail('disabled MCP must not read environment'); } });
  const accessor = { get enabled() { assert.fail('MCP must not evaluate an enabled getter'); } };
  const variants = [undefined, {}, { enabled: false }, { enabled: 'true' }, { enabled: 1 },
    Object.create({ enabled: true }), Object.create(accessor), accessor];
  const configs = variants.map((mcp) => mcp === undefined ? { rootDir: stateDir } : { rootDir: stateDir, mcp });
  configs.push({ rootDir: stateDir, get mcp() { assert.fail('MCP must not evaluate a config getter'); } });
  for (const mcp of variants) assert.equal(mountProjectMcp({}, mcp, readForbidden), null);
  for (const config of configs) {
    const host = hostContext();
    apply(host.ctx, config);
    await Promise.resolve();
    assert.equal(host.messages.some((message) => message.includes('] MCP ')), false);
    assert.ok(host.tools.has('project_board'));
    await host.close();
  }
});

// 责任：开启后 MCP 使用专属凭据，只读冷项目，插件卸载释放端口。
test('configured plugin serves bounded MCP reads and closes its listener on unload', async (t) => {
  setToken(t, TOKEN);
  const { svc, h, stateDir } = await withProject(t);
  const made = await h.command(command('task.create', { actor: HUMAN, title: 'Synthetic task', acceptance: [{ text: 'check result' }] }));
  const taskId = made.events[0].taskId;
  await h.command(command('task.claim', { actor: HUMAN, taskId, expected: { entityRev: 1 } }));
  const projectId = h.id;
  const logFile = h.store.commitsFile;
  const lockFile = h.store.lockFile;
  await svc.close();
  const before = fs.readFileSync(logFile);
  const held = await reservePort();
  await held.close();
  const host = hostContext();
  t.after(() => host.close());
  const started = host.nextMcpLog();
  const bundle = loadOverlayPatches('mcp-fixture', fileURLToPath(new URL('../../lib/cordis.patch.yml', import.meta.url)));
  const override = [{ id: 'project-board', config: { rootDir: stateDir, mcp: { enabled: true, port: held.port } } }];
  const entry = composeEntries([bundle, override]).find(({ id }) => id === 'project-board');
  apply(host.ctx, entry.config);
  assert.match(await started, /MCP ready at http:\/\/127\.0\.0\.1:/);
  assert.equal((await post(held.port, 'tools/list', {}, host.webToken())).status, 401);

  const catalogue = await post(held.port, 'tools/list', {});
  assert.equal(catalogue.status, 200);
  assert.deepEqual(catalogue.body.result.tools.map(({ name }) => name), ['list_projects', 'list_tasks', 'get_task', 'get_work_context']);
  assert.ok(catalogue.body.result.tools.every((tool) => tool.annotations.readOnlyHint === true));
  const contextTool = catalogue.body.result.tools.find(({ name }) => name === 'get_work_context');
  assert.match(contextTool.description, /resuming known project work/);
  const projects = await post(held.port, 'tools/call', { name: 'list_projects', arguments: {} });
  assert.equal(projects.body.result.structuredContent.projects[0].id, projectId);
  const listed = await post(held.port, 'tools/call', { name: 'list_tasks', arguments: { projectId, state: 'in_progress' } });
  assert.equal(listed.body.result.structuredContent.tasks[0].id, taskId);
  const detail = await post(held.port, 'tools/call', { name: 'get_task', arguments: { projectId, taskId } });
  const row = detail.body.result.structuredContent.task;
  assert.equal(row.state, 'in_progress');
  assert.equal(row.acceptance[0].text, 'check result');
  assert.equal(Object.hasOwn(row, 'owner'), false);
  const work = (args) => post(held.port, 'tools/call', { name: 'get_work_context', arguments: args });
  const candidates = (await work({ projectId })).body.result.structuredContent;
  assert.equal(candidates.task, null);
  assert.equal(candidates.candidates[0].id, taskId);
  const selected = (await work({ projectId, taskId })).body.result.structuredContent;
  assert.equal(selected.task.acceptance[0].text, 'check result');
  assert.equal(selected.nextAction, 'check_work_session');
  assert.equal((await work({ projectId, taskId: 'tsk_missing' })).body.result.structuredContent.code, 'not-found');
  const invalid = await post(held.port, 'tools/call', { name: 'get_task', arguments: { projectId, taskId, actor: { kind: 'human' } } });
  assert.equal(invalid.body.result.isError, true);
  assert.deepEqual(fs.readFileSync(logFile), before);
  assert.equal(fs.existsSync(lockFile), false);
  assert.deepEqual(fs.readdirSync(path.dirname(logFile)).filter((name) => name.startsWith('lock.json')), []);

  await host.close();
  await assert.rejects(post(held.port, 'tools/list', {}), /fetch failed/);

  const disabledHost = hostContext();
  const disabled = composeEntries([bundle, override, [{ id: 'project-board', config: { mcp: { enabled: false } } }]])
    .find(({ id }) => id === 'project-board');
  try {
    apply(disabledHost.ctx, disabled.config);
    assert.equal(disabled.config.mcp.enabled, false);
    await assert.rejects(post(held.port, 'tools/list', {}), /fetch failed/);
    assert.ok(disabledHost.tools.has('project_board'));
  } finally {
    await disabledHost.close();
  }
});

// 责任：凭据缺失和端口冲突会安全拒绝 MCP，DSH 工具依然可以注册。
test('invalid credentials and occupied loopback ports leave the DSH tools available', async (t) => {
  const { stateDir } = await withProject(t);
  setToken(t, undefined);
  const occupied = await reservePort();
  t.after(() => occupied.close());
  for (const [token, reason] of [[undefined, /PROJECT_BOARD_MCP_TOKEN/], [TOKEN, /local port already in use/]]) {
    if (token) process.env[TOKEN_ENV] = token;
    const host = hostContext();
    const log = host.nextMcpLog();
    try {
      apply(host.ctx, { rootDir: stateDir, mcp: { enabled: true, port: occupied.port } });
      assert.match(await log, reason);
      assert.ok(host.tools.has('project_board'));
      assert.equal(host.messages.some((message) => message.includes(TOKEN)), false);
    } finally {
      await host.close();
    }
  }
});

// 责任：卸载发生在 store 就绪前时，旧实例不得迟到开启 MCP 端口。
test('disposing while initialization is pending prevents a late listener', async (t) => {
  const { svc } = await withProject(t);
  const held = await reservePort();
  t.after(() => held.close());
  const host = hostContext();
  const ready = Promise.withResolvers();
  const dispose = mountProjectMcp({ ctx: host.ctx, service: svc, ready: ready.promise },
    { enabled: true, port: held.port }, { [TOKEN_ENV]: TOKEN });
  await dispose();
  ready.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.messages.some((message) => message.includes('] MCP ')), false);
});
