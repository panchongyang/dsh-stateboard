import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { withProject } from './service-fixture.mjs';
import { registerTools } from '../../lib/host/tools/index.js';
import { createMcpHandler } from '../../lib/host/mcp-http.js';
import { createMcpWrite } from '../../lib/host/mcp-write.js';
import { projectReadTools } from '../../lib/host/mcp-tools.js';
import { READ, WRITE, ENV } from './mcp-fixture.mjs';

export { READ, WRITE };
export async function fixture(t, options = {}) {
  let now = Date.parse('2026-01-02T00:00:00Z');
  const base = await withProject(t, { clock: () => new Date(now), ...options });
  const runtime = { service: base.svc, ready: Promise.resolve(), ctx: { logger: {} } };
  const native = new Map();
  registerTools({ tools: { register: (tool) => native.set(tool.name, tool) }, effect: (fn) => t.after(fn()) }, runtime);
  const settings = { enabled: true, projectIds: [base.h.id] };
  const write = createMcpWrite(runtime, settings, ENV, READ);
  const handler = createMcpHandler({ token: READ, tools: projectReadTools(runtime), write });
  const server = createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await write.close(); });
  const post = (method, params, token = WRITE) => new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1', port: server.address().port, path: '/mcp', method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'mcp-protocol-version': '2025-11-25' },
      signal: AbortSignal.timeout(10000),
    }, async (res) => {
      try {
        assert.equal(res.statusCode, 200);
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) { reject(err); }
    });
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
  });
  const call = async (name, args, token = WRITE) => post('tools/call', { name, arguments: args }, token);
  const open = async (token = WRITE, extra = {}) => {
    const result = await call('project_session', { op: 'open', projectId: base.h.id, ...extra }, token);
    return JSON.parse(text(result));
  };
  const exec = { agent: { id: 'native-worker', session: { header: { cwd: base.wsDir } } }, callId: 'same-call-id' };
  const nativeCall = (name, args, execution = exec) => native.get(name).execute(args, execution);
  const render = (name, args, value) => native.get(name).output.render(args, value);
  return { ...base, runtime, native, settings, write, post, call, open, exec, nativeCall, render, advance: (ms) => { now += ms; } };
}

export function text(response) {
  assert.equal(response.error, undefined, JSON.stringify(response));
  assert.equal(response.result?.isError, undefined, JSON.stringify(response));
  assert.equal(response.result?.structuredContent, undefined, 'model output must not duplicate the raw result');
  return response.result.content.map((part) => part.text).join('\n');
}

export function error(response, code) {
  assert.equal(response.result?.isError, true, JSON.stringify(response));
  const failure = JSON.parse(response.result.content[0].text);
  assert.equal(failure.code, code);
  assert.deepEqual(Object.keys(failure).sort(), ['ok', 'code', 'message', 'status', 'details', 'next'].sort());
  return failure;
}
