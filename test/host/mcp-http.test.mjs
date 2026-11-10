/**
 * 测试职责：验证本机 MCP HTTP 协议和访问控制。
 * 典型流程：启动合成回环服务 → 发送 MCP 请求 → 检查状态、工具调用和响应。
 * 覆盖边界：覆盖 认证、来源、消息和请求体上限；不覆盖 真实 DSH 或 Codex 会话。
 * 外部前置：可监听回环临时端口。
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { BoardError } from '../../lib/core/errors.js';
import { createMcpHandler } from '../../lib/host/mcp-http.js';
import { MAX_BODY_BYTES } from '../../lib/host/util.js';

const TOKEN = 'synthetic-mcp-token';
const VERSION = '2025-11-25';
const INIT = {
  protocolVersion: VERSION,
  capabilities: {},
  clientInfo: { name: 'fixture', version: '1' },
};

async function serve(t, run = async () => ({ tasks: [] }), logger) {
  const tools = [{
    name: 'list_tasks',
    description: 'Read tasks',
    inputSchema: { type: 'object' },
    annotations: { readOnlyHint: true },
    run,
  }];
  const server = http.createServer(createMcpHandler({ token: TOKEN, tools, logger }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();

  function send(body, { method = 'POST', path = '/mcp', headers, auth = true } = {}) {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port, method, path, agent: false,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(auth ? { authorization: 'Bearer ' + TOKEN } : {}),
          ...(method === 'POST' ? { 'content-length': bytes.length } : {}),
          ...headers,
        },
      }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, headers: res.headers, text, json: text ? JSON.parse(text) : null });
        });
      });
      req.on('error', reject);
      req.end(method === 'POST' ? bytes : undefined);
    });
  }
  return { send, port };
}

function rpc(method, params, id = 1) {
  return { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
}

// 责任：握手协商协议版本并发布可发现的只读工具。
test('MCP HTTP negotiates legacy revisions and exposes a deterministic read catalogue', async t => {
  const { send } = await serve(t);
  for (const protocolVersion of ['2025-06-18', VERSION, 'unknown']) {
    const { status, headers, json } = await send(rpc('initialize', { ...INIT, protocolVersion }, 'init'));
    assert.equal(status, 200);
    assert.equal(headers['mcp-session-id'], undefined);
    assert.equal(json.id, 'init');
    assert.equal(json.result.protocolVersion, protocolVersion === 'unknown' ? VERSION : protocolVersion);
    assert.deepEqual(json.result.capabilities, { tools: {} });
  }
  const initialized = await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(initialized.status, 202);
  assert.equal(initialized.text, '');
  assert.deepEqual((await send(rpc('ping'))).json.result, {});
  const list = await send(rpc('tools/list'), { headers: { 'mcp-protocol-version': VERSION } });
  assert.deepEqual(list.json.result.tools, [{
    name: 'list_tasks',
    description: 'Read tasks',
    inputSchema: { type: 'object' },
    annotations: { readOnlyHint: true },
  }]);
  const noStream = await send(rpc('ping'), { method: 'GET' });
  assert.equal(noStream.status, 405);
  assert.equal(noStream.headers.allow, 'POST');
});

// 责任：每个方法均须使用独立凭据，并检查回环地址、端口和来源。
test('MCP HTTP authenticates each method and checks the actual loopback origin and port', async t => {
  const { send, port } = await serve(t);
  const ping = rpc('ping');
  for (const method of ['POST', 'GET']) {
    const response = await send(ping, { method, auth: false, headers: { 'x-project-board-token': TOKEN } });
    assert.equal(response.status, 401);
    assert.equal(response.headers['www-authenticate'], 'Bearer');
    assert.equal(response.text, '');
  }
  assert.equal((await send(ping, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  for (const headers of [
    { host: 'example.test:' + port },
    { host: '127.0.0.1:' + (port === 1 ? 2 : 1) },
    { origin: 'https://127.0.0.1:' + port },
    { origin: 'null' },
    { 'sec-fetch-site': 'cross-site' },
  ]) {
    assert.equal((await send(ping, { headers })).status, 403);
  }
  assert.equal((await send(ping, { headers: { origin: 'http://127.0.0.1:' + port } })).status, 200);
  assert.equal((await send(ping, { path: '/mcp/anything' })).status, 404);
});

// 责任：畸形消息和不支持的版本得到对应协议错误。
test('MCP HTTP rejects malformed requests, IDs and unsupported negotiation headers', async t => {
  const { send } = await serve(t);
  for (const data of [Buffer.from(''), Buffer.from('{'), Buffer.from([0x22, 0xff, 0x22])]) {
    const response = await send(data);
    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, -32700);
  }
  for (const data of [[rpc('ping')], rpc('ping', undefined, null), rpc('ping', undefined, 1.5)]) {
    const response = await send(data);
    assert.equal(response.status, 400);
    assert.equal(response.json.id, null);
    assert.equal(response.json.error.code, -32600);
  }
  assert.equal((await send(rpc('tools/list'), { headers: { 'mcp-protocol-version': 'unsupported' } })).status, 400);
  assert.equal((await send(rpc('ping'), { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await send({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'list_tasks' } })).status, 400);
  assert.equal((await send(rpc('unknown'))).json.error.code, -32601);
});

// 责任：工具结果可机器读取，错误只公开安全的诊断。
test('MCP HTTP serves structured results and keeps error internals private', async t => {
  const calls = [];
  const logs = [];
  const { send } = await serve(t, async args => {
    calls.push(args);
    if (args.mode === 'controlled') throw new BoardError('not-found', 'private/workspace', { details: { token: TOKEN } });
    if (args.mode === 'unexpected') throw new Error('private/workspace ' + TOKEN);
    return { tasks: [{ id: 'fixture' }] };
  }, { error: line => logs.push(line) });
  const call = (args, version = VERSION) => send(rpc('tools/call', { name: 'list_tasks', arguments: args }, 17), {
    headers: { 'mcp-protocol-version': version },
  });
  assert.equal((await send(rpc('tools/call', { name: '__proto__' }))).json.error.code, -32602);
  assert.equal((await call(['fixture'])).json.error.code, -32602);
  assert.equal(calls.length, 0);
  const success = await call({ projectId: 'fixture' });
  assert.deepEqual(calls, [{ projectId: 'fixture' }]);
  assert.equal(success.json.id, 17);
  assert.deepEqual(success.json.result.structuredContent, { tasks: [{ id: 'fixture' }] });
  assert.deepEqual(JSON.parse(success.json.result.content[0].text), success.json.result.structuredContent);
  const legacy = await call({ projectId: 'fixture' }, '2025-03-26');
  assert.equal(legacy.json.result.structuredContent, undefined);
  assert.deepEqual(JSON.parse(legacy.json.result.content[0].text), success.json.result.structuredContent);
  const rejected = await call({ mode: 'controlled' });
  assert.equal(rejected.json.result.isError, true);
  assert.equal(rejected.json.result.structuredContent.code, 'not-found');
  const failed = await call({ mode: 'unexpected' });
  assert.equal(failed.json.error.code, -32603);
  assert.equal(failed.json.id, 17);
  for (const text of [rejected.text, failed.text, ...logs]) {
    assert.equal(text.includes(TOKEN) || text.includes('private/workspace'), false);
  }
});

// 责任：超限请求在工具调度之前被拒绝。
test('MCP HTTP bounds request body size before dispatch', async t => {
  const { send } = await serve(t, () => assert.fail('Tool dispatch should not run'));
  const response = await send(rpc('tools/call', { name: 'list_tasks', arguments: { text: 'x'.repeat(MAX_BODY_BYTES) } }));
  assert.equal(response.status, 413);
  assert.equal(response.json.error.message, 'Request body too large');
});

// 责任：过多并行读取得到暂时拒绝，已有读取可以完成。
test('MCP HTTP bounds concurrent authenticated requests', async t => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  let active = 0;
  const { send } = await serve(t, async () => {
    active += 1;
    if (active === 8) started.resolve();
    await release.promise;
    return { tasks: [] };
  });
  const request = rpc('tools/call', { name: 'list_tasks' });
  const pending = Promise.all(Array.from({ length: 8 }, () => send(request)));
  try {
    await started.promise;
    const busy = await send(request);
    assert.equal(busy.status, 503);
    assert.equal(busy.headers['retry-after'], '1');
  } finally {
    release.resolve();
    assert.ok((await pending).every(response => response.status === 200));
  }
  assert.equal((await send(request)).status, 200);
});
