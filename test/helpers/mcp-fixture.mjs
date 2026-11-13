import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { mountProjectMcp } from '../../lib/host/mcp.js';

export const READ = 'ac'.repeat(32);
export const WRITE = 'bc'.repeat(32);
const HOST = '127.0.0.1';
export const ENV = { PROJECT_BOARD_MCP_TOKEN: READ, PROJECT_BOARD_MCP_WRITE_TOKEN: WRITE };

export async function listener(t, service, write, env = ENV) {
  const reserve = createServer().listen(0, HOST);
  await once(reserve, 'listening');
  const { port } = reserve.address();
  await new Promise((resolve) => reserve.close(resolve));
  const started = Promise.withResolvers();
  const logger = { info: started.resolve };
  const close = mountProjectMcp({ service, ready: Promise.resolve(), ctx: { logger } }, { enabled: true, port, write }, env);
  t.after(close);
  await started.promise;
  const post = (token, method, params) => new Promise((resolve, reject) => {
    const req = request({
      hostname: HOST, port, path: '/mcp',
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-11-25',
      },
      signal: AbortSignal.timeout(5000),
    }, async (res) => {
      try {
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        if (res.statusCode === 200 || res.statusCode === 500) {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } else {
          resolve({ status: res.statusCode });
        }
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
  });
  const call = (name, args, token = WRITE) => post(token, 'tools/call', { name, arguments: args });
  return { post, call, close };
}

export async function success(mcp, name, args, token) {
  const body = await mcp.call(name, args, token);
  assert.equal(body.result?.isError, undefined, JSON.stringify(body));
  assert.ok(body.result?.structuredContent, JSON.stringify(body));
  return body.result.structuredContent;
}

export function denied(body, code) {
  assert.equal(body.result?.isError, true, JSON.stringify(body));
  assert.deepEqual(Object.keys(body.result.structuredContent).sort(), ['code', 'message']);
  assert.equal(body.result.structuredContent.code, code);
}
