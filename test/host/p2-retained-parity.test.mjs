/**
 * 测试职责：核对原生和 MCP 登记、采集、回读与比较的协议一致性。
 * 典型流程：使用真实注册器及鉴权分派器在合成空间内读取版本。
 * 覆盖边界：覆盖双端权限和无写副作用；不覆盖生产服务或真实用户数据。
 * 外部前置：仅使用 Node 和隔离的临时文件，不连接现有服务。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { ProjectService } from '../../lib/core/service.js';
import { createSpaceRuntime } from '../../lib/host/space-runtime.js';
import { registerTools } from '../../lib/host/tools/index.js';
import { createMcpHandler } from '../../lib/host/mcp-http.js';
import { issueSpaceGrant, spaceGrantFor } from '../../lib/host/mcp-space-grant.js';
import { projectTools } from '../../lib/host/mcp-tools.js';

const hash = input => createHash('sha256').update(input).digest('hex');
const stateDir = root => path.join(root, '.projectboard', 'state');
const lockFile = root => path.join(stateDir(root), 'lock.json');
const ledger = root => fs.readFileSync(path.join(stateDir(root), 'commits.jsonl'));
const mediumSnapshot = root => Object.fromEntries(fs.readdirSync(root, { recursive: true, withFileTypes: true })
  .map(entry => [path.relative(root, path.join(entry.parentPath, entry.name)), entry.isDirectory() ? null : hash(fs.readFileSync(path.join(entry.parentPath, entry.name)))])
  .sort(([a], [b]) => a.localeCompare(b)));

async function makeSpaces(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-p2-retained-tools-')));
  t.diagnostic('Synthetic fixture preserved: ' + base);
  const a = path.join(base, 'A'), b = path.join(base, 'B');
  fs.mkdirSync(a);
  const seed = new ProjectService({ spaceRoot: a, privilegedInlineWrites: true });
  let projectId, inlineId;
  try {
    await seed.init();
    projectId = (await seed.createProject({ workspacePath: a, actor: { kind: 'human' } })).id;
    const receipt = await seed.command(projectId, { op: 'doc.put', cmdId: 'seed-inline', actor: { kind: 'human' }, title: 'Inline archive', kind: 'note', body: 'Legacy inline body' });
    inlineId = receipt.events.find(event => event.type === 'doc/created').docId;
  } finally { await seed.close(); }
  fs.cpSync(a, b, { recursive: true, errorOnExist: true, force: false });
  return { a, b, projectId, inlineId };
}

function createHost(roots, grants) {
  const tools = new Map(), effects = [];
  const ctx = {
    tools: { register(definition) { tools.set(definition.name, definition); } },
    workspaceRegistry: { resolveByPath(root) { return roots.includes(root) ? { path: root } : undefined; } },
    effect(fn) { effects.push(fn()); },
  };
  const spaces = createSpaceRuntime(ctx);
  const runtime = { ctx, spaces };
  registerTools(ctx, runtime);
  const dispatch = createMcpHandler({ tools: projectTools(runtime), authorize(bearer) {
    const grant = spaceGrantFor(() => grants, bearer);
    return grant ? { ...grant, key: 'mcp:' + grant.tokenHash, allows: () => { grant.assertCurrent(); return true; } } : null;
  } });
  const post = async (token, method, params) => {
    const req = Readable.from([Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }))]);
    Object.assign(req, { url: '/mcp', method: 'POST', headers: { host: '127.0.0.1:54321', 'content-type': 'application/json', authorization: 'Bearer ' + token },
      socket: { localAddress: '127.0.0.1', remoteAddress: '127.0.0.1', localPort: 54321 } });
    const res = new EventEmitter();
    res.writeHead = status => { res.status = status; res.headersSent = true; };
    res.end = body => { res.body = body ? JSON.parse(body) : undefined; };
    await dispatch(req, res);
    return { status: res.status, body: res.body };
  };
  const close = () => spaces.close().finally(() => Promise.all(effects.map(dispose => dispose?.())));
  const localExec = { agent: { id: 'p2-synthetic-native', session: { header: { cwd: roots[1] } } }, cwd: roots[0], workdir: roots[0] };
  const native = (name, args) => tools.get(name).execute(args, localExec);
  const call = (token, name, args) => post(token, 'tools/call', { name, arguments: args });
  return { tools, post, close, native, call };
}

function mcpResult(reply, expectedCode) {
  assert.equal(reply.status, 200, JSON.stringify(reply));
  assert.equal(reply.body.error, undefined, JSON.stringify(reply));
  const result = reply.body.result;
  assert.equal(Boolean(result.isError), Boolean(expectedCode), JSON.stringify(result));
  if (expectedCode) assert.equal(JSON.parse(result.content[0].text).code, expectedCode);
  return result.content[0].text;
}

// Register through DSH, reject an MCP duplicate, then alternate native and MCP
// capture/read. Neither a spoofed workdir nor a credential for A can address B.
// 责任：在两端核对同一版本、所属根、凭据权限与冷读无副作用。
test('P2 native and MCP retain bytes from authorized B; all queries stay lock-free', { timeout: 20000 }, async t => {
  const { a, b, projectId, inlineId } = await makeSpaces(t);
  const file = root => path.join(root, 'decision.md');
  const initial = '\uFEFF甲😀\r\n';
  fs.writeFileSync(file(a), 'Decoy A');
  fs.writeFileSync(file(b), initial);
  const origA = mediumSnapshot(a);
  const full = issueSpaceGrant(b, 'full'), metadata = issueSpaceGrant(b, 'metadata'), other = issueSpaceGrant(a, 'full');
  const grants = [full.grant, metadata.grant, other.grant];
  const live = createHost([a, b], grants);
  t.after(() => live.close());
  const catalogue = (await live.post(full.token, 'tools/list', {})).body.result.tools.find(tool => tool.name === 'project_doc');
  const docTool = live.tools.get('project_doc');
  assert.deepEqual(catalogue.inputSchema, docTool.parameters);
  for (const op of ['register', 'capture', 'history', 'read_version', 'compare']) assert.ok(docTool.parameters.properties.op.enum.includes(op));
  for (const unavailable of ['recover', 'operation', 'read']) assert.ok(!docTool.parameters.properties.op.enum.includes(unavailable));
  assert.equal(Object.hasOwn(docTool.parameters.properties, 'format'), false);

  const { context, projectId: selected } = JSON.parse(mcpResult(await live.call(full.token, 'project_session', { op: 'open' })));
  assert.equal(selected, projectId);
  const meta = JSON.parse(mcpResult(await live.call(metadata.token, 'project_session', { op: 'open' }))).context;
  const reg = { op: 'register', title: 'Decision', kind: 'decision', relPath: 'decision.md' };
  const docId = (await live.native('project_doc', reg)).doc.id;
  mcpResult(await live.call(full.token, 'project_doc', { ...reg, context }), 'locator-already-registered');
  const capture = { op: 'capture', docId };
  const first = JSON.parse(mcpResult(await live.call(full.token, 'project_doc', { ...capture, context }))).result;
  assert.equal(first.retained, true);
  assert.equal(first.versionRef.contentHash, hash(initial));
  const v1 = first.versionRef.versionId;
  const last = ledger(b);
  const same = (await live.native('project_doc', capture)).result;
  assert.equal(same.retained, false);
  assert.equal(same.versionRef.versionId, v1);
  assert.deepEqual(ledger(b), last);
  assert.equal(fs.readFileSync(file(b), 'utf8'), initial);
  await assert.rejects(live.native('project_doc', { ...capture, body: 'must not write' }), { code: 'invalid-command' });
  mcpResult(await live.call(full.token, 'project_doc', { op: 'put', format: 'workspace-v1', docId, body: 'must not write', context }), 'invalid-command');
  for (const args of [capture, { op: 'history', docId }, ...['read_version', 'compare'].map(op => ({ op, docId, versionId: v1 }))]) {
    mcpResult(await live.call(metadata.token, 'project_doc', { ...args, context: meta }), 'forbidden-role');
  }
  mcpResult(await live.call(other.token, 'project_doc', { op: 'history', docId, context }), 'work-session-invalid');
  const contextA = JSON.parse(mcpResult(await live.call(other.token, 'project_session', { op: 'open' }))).context;
  mcpResult(await live.call(other.token, 'project_doc', { op: 'read_version', docId, versionId: v1, context: contextA }), 'not-found');
  assert.deepEqual(ledger(b), last);

  // Synthetic external edit: capture and compare must never write this path.
  fs.writeFileSync(file(b), 'Measured B\r\n');
  const compare = { op: 'compare', docId, versionId: v1 };
  assert.equal((await live.native('project_doc', compare)).state, 'changed');
  const v2 = (await live.native('project_doc', capture)).result.versionRef.versionId;
  fs.writeFileSync(file(b), initial);
  assert.equal(JSON.parse(mcpResult(await live.call(full.token, 'project_doc', { ...compare, context }))).state, 'unchanged');
  const v3 = (await live.native('project_doc', capture)).result.versionRef.versionId;
  assert.notEqual(v1, v3);
  assert.match(mcpResult(await live.call(full.token, 'project_doc', { op: 'get', docId: inlineId, context })), /Legacy inline body$/);
  mcpResult(await live.call(full.token, 'project_doc', { op: 'put', title: 'no inline work', body: 'no', context }), 'inline-write-disabled');
  await live.close();

  // Fresh registries and service: both full read paths must not obtain a writer.
  const cold = createHost([a, b], grants);
  t.after(() => cold.close());
  const coldContext = JSON.parse(mcpResult(await cold.call(full.token, 'project_session', { op: 'open' }))).context;
  assert.equal(fs.existsSync(lockFile(b)), false);
  const before = mediumSnapshot(b);
  const history = { op: 'history', docId, limit: 2 };
  const page = await cold.native('project_doc', history);
  assert.deepEqual(page.versions.map(version => version.versionRef.versionId), [v3, v2]);
  assert.deepEqual(JSON.parse(mcpResult(await cold.call(full.token, 'project_doc', { ...history, context: coldContext }))), page);
  const page2 = await cold.native('project_doc', { ...history, after: page.nextCursor });
  assert.equal(page2.versions[0].versionRef.versionId, v1);
  const retained = { op: 'read_version', docId, versionId: v1 };
  const old = JSON.parse(mcpResult(await cold.call(full.token, 'project_doc', { ...retained, context: coldContext })));
  assert.equal(old.body, initial);
  assert.equal(old.truncated, false);
  assert.equal((await cold.native('project_doc', { ...retained, maxBytes: 7 })).body, '\uFEFF甲');
  assert.equal((await cold.native('project_doc', { ...retained, versionId: v2 })).body, 'Measured B\r\n');
  assert.deepEqual(mediumSnapshot(b), before, 'query cannot append an event, create an object, edit bytes or acquire a durable lock');
  assert.deepEqual(mediumSnapshot(a), origA, 'B did not read, save or alter the decoy A');
  assert.equal(fs.existsSync(lockFile(b)), false);

  fs.renameSync(file(b), path.join(b, 'preserved.md'));
  const afterRename = mediumSnapshot(b);
  const gone = JSON.parse(mcpResult(await cold.call(full.token, 'project_doc', { ...compare, context: coldContext })));
  assert.equal(gone.state, 'unavailable');
  assert.equal(gone.reason, 'file-missing');
  assert.equal((await cold.native('project_doc', retained)).body, initial);
  assert.deepEqual(mediumSnapshot(b), afterRename);
});
