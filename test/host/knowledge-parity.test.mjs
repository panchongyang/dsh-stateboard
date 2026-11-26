/**
 * 测试职责：保证 DSH/MCP 同名知识工具的业务契约、引用互读和原文交付一致。
 * 典型流程：实际插件注册 → 两侧交换引用 → 冷读/拒绝/关闭 → 核对权威数据。
 * 覆盖边界：覆盖合成项目与回环 MCP；不覆盖模型调用或真实 profile。
 * 外部前置：DSH peer 与可用回环端口。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { apply } from '../../lib/index.js';
import { ProjectService } from '../../lib/core/service.js';
import { writeMarker } from '../../lib/core/identity/discover.js';
import { knowledgeFixture, addTask, cmd, tree, registerFile } from '../helpers/knowledge-fixture.mjs';
import { KNOWLEDGE_JSON, listener, success, WRITE } from '../helpers/mcp-fixture.mjs';
import { createKnowledgeReader } from '../../lib/core/knowledge/reader.js';
import { encodeReference } from '../../lib/core/knowledge/reference.js';
import { LEGACY_GIT_RECORD } from '../../lib/shared/contract.js';
import { agentTools } from '../../lib/host/tools/index.js';
import { mcpExecution } from '../../lib/host/agent-context.js';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { projectTools } from '../../lib/host/mcp-tools.js';
import { createMcpHandler } from '../../lib/host/mcp-http.js';
import { bootstrapPin, git } from '../helpers/fixed-fixture.mjs';

// Authorization-only fixture: owning space and all data remain synthetic.
async function scopedKnowledge(t) {
  const f = await knowledgeFixture(t);
  const root = path.join(f.base, 'scoped-space');
  fs.mkdirSync(root);
  const svc = new ProjectService({ spaceRoot: root, assertAccess() {} });
  t.after(() => svc.close());
  await svc.init();
  const h = await svc.createProject({ workspacePath: root, actor: { kind: 'human' } });
  await addTask(h, '可信权限通道');
  return { svc, h, root, projectId: h.id };
}

function scopedKnowledgePorts(t, svc, root) {
  const runtime = { service: svc, ready: Promise.resolve(), ctx: { workspaceRegistry: { resolveByPath: () => ({ path: root }) } } };
  const tools = new Map(agentTools(runtime).map(tool => [tool.name, tool]));
  t.after(() => runtime.closeAgentTools());
  const authority = { key: 'synthetic-workspace-mcp', scope: 'full', allows: () => true, assertCurrent() {} };
  const dispatch = createMcpHandler({ tools: projectTools(runtime), authorize: () => authority });
  const remote = async (name, args) => {
    const req = Readable.from([Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: KNOWLEDGE_JSON } }))]);
    Object.assign(req, { url: '/mcp', method: 'POST', headers: { host: '127.0.0.1:54321', 'content-type': 'application/json', authorization: 'Bearer synthetic' },
      socket: { localAddress: '127.0.0.1', remoteAddress: '127.0.0.1', localPort: 54321 } });
    const res = new EventEmitter();
    res.writeHead = status => { res.status = status; res.headersSent = true; };
    res.end = body => { res.body = body ? JSON.parse(body) : undefined; };
    await dispatch(req, res);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.error, undefined, JSON.stringify(res.body));
    assert.equal(res.body.result.structuredContent, undefined);
    const value = JSON.parse(res.body.result.content[0].text);
    if (res.body.result.isError) throw Object.assign(new Error(JSON.stringify(value)), { code: value.code });
    return value;
  };
  const rawRemote = async (name, args) => {
    const req = Readable.from([Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }))]);
    Object.assign(req, { url: '/mcp', method: 'POST', headers: { host: '127.0.0.1:54321', 'content-type': 'application/json', authorization: 'Bearer synthetic' },
      socket: { localAddress: '127.0.0.1', remoteAddress: '127.0.0.1', localPort: 54321 } });
    const res = new EventEmitter();
    res.writeHead = status => { res.status = status; res.headersSent = true; };
    res.end = body => { res.body = body ? JSON.parse(body) : undefined; };
    await dispatch(req, res);
    return res.body;
  };
  const native = (name, args) => tools.get(name).execute(args, execAt(root));
  return { native, remote, rawRemote };
}

const SEARCH = 'search_project_knowledge';
const READ = 'read_project_knowledge';

function host(t, rootDir) {
  const tools = new Map();
  const disposers = [];
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool); } },
    agents: { list: () => [] },
    logger: { info() {}, warn() {} },
    on() {}, get() {},
    effect(fn) { disposers.push(fn()); },
  };
  const close = async () => { for (const dispose of disposers.splice(0).reverse()) await dispose(); };
  t.after(close);
  apply(ctx, { rootDir, mcp: { enabled: false } });
  for (const name of [SEARCH, READ]) assert.ok(tools.has(name), 'missing DSH tool ' + name);
  return { tools, close };
}

const execAt = cwd => ({ agent: { id: 'synthetic-agent', session: { header: { cwd } } }, callId: 'synthetic-call' });
const call = (native, name, args, exec) => native.tools.get(name).execute(args, exec);

function structuralSchema(value) {
  const bounds = ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'];
  return JSON.parse(JSON.stringify(value, (key, entry) => bounds.includes(key) || key === 'description' ? undefined : entry));
}

// 责任：真实 PTC 渲染必须保留参数类型；注册成功不能代替模型可见的 SDK 检查。
test('DSH PTC TypeScript and Python SDKs expose knowledge arguments and their limits', async t => {
  const ptc = await import('@deepseek-ai/dsh-tool-executor-ptc');
  const f = await knowledgeFixture(t);
  const native = host(t, f.stateDir);
  const schemas = [SEARCH, READ].map(name => {
    const tool = native.tools.get(name);
    return { name, description: tool.description, parameters: tool.parameters, output: tool.output.schema };
  });
  for (const schema of schemas) {
    assert.notEqual(ptc.jsonSchemaToTs(schema.parameters), 'unknown');
    assert.notEqual(ptc.jsonSchemaToPy(schema.parameters), 'Any');
  }
  const ts = ptc.renderToolsSdk(schemas);
  const py = ptc.renderToolsSdkPy(schemas);
  assert.match(ts, /query: string/);
  assert.match(ts, /refs: string\[\]/);
  assert.match(py, /query: str/);
  assert.match(py, /refs: list\[str\]/);
  assert.match(ts, /Maximum length: 500/);
  assert.match(ts, /Maximum items: 8/);
  assert.match(py, /Maximum length: 500/);
  assert.match(py, /Maximum items: 8/);
});

// 责任：scoped 两端复用可信授权代，读取不触发扫描，撤权不能复用旧引用。
test('scoped knowledge reuses native and MCP authority without public authorization fields', async t => {
  const { svc, root } = await scopedKnowledge(t);
  const runtime = { service: svc, ready: Promise.resolve(), ctx: { workspaceRegistry: { resolveByPath: () => ({ path: root }) } } };
  const tools = new Map(agentTools(runtime).map(tool => [tool.name, tool]));
  t.after(() => runtime.closeAgentTools());
  const invoke = (name, args, exec) => tools.get(name).execute(args, exec);
  const queries = [];
  const original = svc.queryWorkspaceProjection.bind(svc);
  t.mock.method(svc, 'queryWorkspaceProjection', (id, request, authority) => {
    queries.push({ request, authority });
    return original(id, request, authority);
  });
  let allowed = true;
  const remote = mcpExecution({ key: 'synthetic-full-grant', scope: 'full', allows: () => true,
    assertCurrent() { if (!allowed) throw Object.assign(new Error('revoked'), { code: 'project-forbidden' }); } });
  const { context } = await invoke('project_session', { op: 'open' }, remote);
  const native = await invoke(SEARCH, { query: '可信权限通道' }, execAt(root));
  const found = await invoke(SEARCH, { query: '可信权限通道', context }, remote);
  // 分数依赖各授权索引代的语料覆盖；来源身份、内容、状态、命中顺序须相同。
  const evidenceHits = rows => rows.map(({ score, ...row }) => { assert.ok(Number.isFinite(score)); return row; });
  assert.deepEqual(evidenceHits(found.hits), evidenceHits(native.hits));
  assert.ok(queries.some(row => row.authority.scopeKey === 'native:synthetic-agent'));
  assert.ok(queries.some(row => row.authority.scopeKey === 'synthetic-full-grant'));
  const count = queries.length;
  await invoke(READ, { refs: [found.hits[0].ref], context }, remote);
  assert.equal(queries.length, count, 'read must not initiate discovery');
  t.mock.method(svc, 'queryWorkspaceProjection', async () => {
    throw Object.assign(new Error('synthetic busy'), { code: 'projection-busy' });
  });
  assert.ok((await invoke(SEARCH, { query: '可信权限通道', context }, remote)).hits.length);
  assert.equal(Object.hasOwn(tools.get(SEARCH).parameters.properties, 'authority'), false);
  allowed = false;
  await assert.rejects(invoke(READ, { refs: [found.hits[0].ref], context }, remote), { code: 'project-forbidden' });
});

// 责任：reader 在缺授权时拒绝，并在返回前重新验证撤权与策略代变化。
test('scoped core rejects absent authority and rechecks revocation or scope drift before return', async t => {
  const { svc, projectId } = await scopedKnowledge(t);
  const reader = createKnowledgeReader(svc);
  t.after(() => reader.close());
  const args = { projectId, query: '可信权限通道' };
  await assert.rejects(reader.search(args), { code: 'project-forbidden' });
  let allowed = true;
  const authority = { scopeKey: 'synthetic-reader', assertCurrent() {
    if (!allowed) throw Object.assign(new Error('revoked'), { code: 'project-forbidden' });
  } };
  const published = svc.publishedState.bind(svc);
  t.mock.method(svc, 'publishedState', id => { allowed = false; return published(id); });
  await assert.rejects(reader.search(args, { authority }), { code: 'project-forbidden' });
  allowed = true;
  let rules = [];
  t.mock.method(svc, 'publishedState', id => { rules = ['private']; return published(id); });
  svc.projectionDenyPrefixes = () => rules;
  await assert.rejects(reader.search(args, { authority }), { code: 'restart-required' });
});

// 责任：未登记工作区文件经真实发现与两端注册链路可检索；ref可交换，分页凭据不可交换。
test('scoped DSH and MCP discover unregistered Markdown, exchange kb2 chunks and reject foreign body cursors', async t => {
  const { svc, root, projectId } = await scopedKnowledge(t);
  const text = 'workspaceSignal 柚子接口🙂\n'.repeat(600);
  const file = path.join(root, 'unregistered.md');
  fs.writeFileSync(file, text);
  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.md\n');
  fs.writeFileSync(path.join(root, 'ignored.md'), 'workspaceSignal ignoreSecretMarker');
  const before = svc.publishedRevision(projectId);
  const { native, remote } = scopedKnowledgePorts(t, svc, root);
  const { context } = await remote('project_session', { op: 'open' });
  const nativeDiscovery = await native('project_doc', { op: 'discover' });
  const remoteDiscovery = await remote('project_doc', { op: 'discover', context });
  for (const discovery of [nativeDiscovery, remoteDiscovery]) {
    assert.ok(discovery.entries.some(entry => entry.relPath === 'unregistered.md'));
    assert.ok(!discovery.entries.some(entry => entry.relPath === 'ignored.md'));
  }
  const query = { query: 'workspaceSignal', kinds: ['content'], relatedLimit: 0, limit: 20 };
  const found = await native(SEARCH, query);
  const remoteFound = await remote(SEARCH, { ...query, context });
  const nativeHit = found.hits.find(hit => hit.ref.startsWith('kb2.'));
  const remoteHit = remoteFound.hits.find(hit => hit.ref === nativeHit?.ref);
  assert.ok(nativeHit, JSON.stringify(found));
  assert.ok(remoteHit, JSON.stringify(remoteFound));
  const decoded = JSON.parse(Buffer.from(nativeHit.ref.slice(4), 'base64url').toString('utf8'));
  assert.equal(decoded.part, 'workspace-current');
  assert.equal(decoded.relPath, 'unregistered.md');
  assert.equal(decoded.projectId, projectId);
  assert.equal(decoded.chunkerVersion, 1);
  assert.ok(decoded.end > decoded.start && decoded.end - decoded.start <= 4096);
  const expectedChunk = Buffer.from(text).subarray(decoded.start, decoded.end).toString('utf8');
  const nativeRead = await native(READ, { refs: [remoteHit.ref], relatedLimit: 0 });
  const remoteRead = await remote(READ, { refs: [nativeHit.ref], relatedLimit: 0, context });
  for (const read of [nativeRead, remoteRead]) {
    assert.equal(read.records[0].availability, 'available');
    assert.equal(read.records[0].content, expectedChunk);
    assert.deepEqual(read.records[0].sourceRange, { start: decoded.start, end: decoded.end, chunkerVersion: 1 });
  }
  const wholeRef = remoteRead.records[0].sourceRef;
  assert.match(wholeRef, /^kb2\./);
  assert.notEqual(wholeRef, nativeHit.ref, 'chunk and whole-source identities are distinct');
  const whole = await native(READ, { refs: [wholeRef], relatedLimit: 0 });
  assert.equal(whole.records[0].content, text);
  const paged = await native(READ, { refs: [nativeHit.ref], maxBytes: 256, relatedLimit: 0 });
  assert.ok(paged.records[0].nextCursor);
  await assert.rejects(remote(READ, { refs: [nativeHit.ref], cursor: paged.records[0].nextCursor, maxBytes: 256, context }), { code: 'knowledge-cursor-stale' });
  const ownPage = await native(READ, { refs: [nativeHit.ref], cursor: paged.records[0].nextCursor, maxBytes: 256, relatedLimit: 0 });
  assert.equal(ownPage.records[0].range.offset, paged.records[0].range.end);
  const ignored = await remote(SEARCH, { query: 'ignoreSecretMarker', kinds: ['content'], relatedLimit: 0, context });
  assert.deepEqual(ignored.hits, []);
  fs.writeFileSync(file, 'workspaceSignal changed current body');
  const changed = await remote(READ, { refs: [nativeHit.ref], relatedLimit: 0, context });
  assert.equal(changed.records[0].availability, 'source-changed');
  assert.equal(changed.records[0].content, null, 'old reference must not return replacement bytes');
  assert.deepEqual(svc.publishedRevision(projectId), before, 'discovery and knowledge reads never register the file or write the ledger');
});

// 责任：复制空间中的 kb1 引用不借旧主绑定读取另一物理根，也不能绕过 scoped policy。
test('scoped kb1 external, file and fixed sources use only the verified owning medium', async t => {
  const original = await scopedKnowledge(t);
  const originalReader = createKnowledgeReader(original.svc);
  t.after(() => originalReader.close());
  const f = { ...original, wsDir: original.root, base: path.dirname(original.root),
    search: (query, extra) => originalReader.search({ projectId: original.projectId, query, relatedLimit: 0, ...extra },
      { authority: { scopeKey: 'synthetic-original-medium', assertCurrent() {} } }) };
  const document = await registerFile(f, 'docs/scoped.md', '\uFEFFowningkb1marker original content\r\n');
  fs.writeFileSync(path.join(f.wsDir, 'docs', 'evidence.txt'), '\uFEFFowningfilemarker original evidence\r\n');
  git(f.wsDir, 'init');
  git(f.wsDir, 'config', 'user.name', 'Synthetic');
  git(f.wsDir, 'config', 'user.email', 'fixture@example.invalid');
  git(f.wsDir, 'add', 'docs');
  git(f.wsDir, 'commit', '-m', 'synthetic scoped kb1 sources');
  const fixed = await bootstrapPin(f.h, document.docId);
  assert.ok(fixed.fixed);
  const taskId = await addTask(f.h, 'Scoped file evidence');
  const expected = () => ({ entityRev: f.h.state.tasks[taskId].rev });
  await f.h.command(cmd('task.claim', { taskId, expected: expected() }));
  const fencingToken = f.h.leases.get(taskId).token;
  await f.h.command(cmd('task.begin', { taskId, expected: expected(), fencingToken, summary: 'synthetic file source' }));
  await f.h.command(cmd('task.submit', { taskId, expected: expected(), fencingToken,
    evidence: [{ kind: 'file', ref: 'docs/evidence.txt', acceptanceId: f.h.state.tasks[taskId].acceptance[0].id }] }));
  const hits = [...(await f.search('owningkb1marker', { kinds: ['content'] })).hits,
    ...(await f.search('owningfilemarker', { kinds: ['content'] })).hits];
  const refs = new Map(hits.filter(hit => hit.ref.startsWith('kb1.')).map(hit => [JSON.parse(Buffer.from(hit.ref.slice(4), 'base64url').toString('utf8')).part, hit.ref]));
  for (const part of ['external', 'file']) assert.ok(refs.has(part), part);
  assert.ok(!refs.has('fixed'), 'legacy Git bytes do not enter the search index');
  const fixedCommit = f.h.store.commits.findLast(row => row.events.some(event => event.type === 'doc/content-fixed'));
  refs.set('fixed', encodeReference({ projectId: original.projectId, seq: fixedCommit.seq, commitHash: fixedCommit.hash,
    event: fixedCommit.events.findIndex(event => event.type === 'doc/content-fixed'), part: 'fixed', contentHash: fixed.hash }));
  const stateDir = f.h.meta.dir;
  await f.svc.close();
  const root = path.join(f.base, 'portable-owning-space');
  fs.cpSync(f.wsDir, root, { recursive: true });
  fs.mkdirSync(path.join(root, '.projectboard'), { recursive: true });
  fs.cpSync(stateDir, path.join(root, '.projectboard', 'state'), { recursive: true });
  fs.writeFileSync(document.file, 'foreignRootOnlyMarker must not be read');
  fs.renameSync(path.join(f.wsDir, '.git'), path.join(f.wsDir, '.git.saved'));
  let deny = [];
  const svc = new ProjectService({ spaceRoot: root, projectionDenyPrefixes: () => deny });
  t.after(() => svc.close());
  await svc.init();
  const { native, remote } = scopedKnowledgePorts(t, svc, root);
  const { context } = await remote('project_session', { op: 'open' });
  for (const [part, ref] of refs) {
    const result = await remote(READ, { refs: [ref], relatedLimit: 0, context });
    const row = result.records[0];
    if (part === 'fixed') {
      for (const [key, value] of Object.entries(LEGACY_GIT_RECORD)) assert.equal(row[key], value, key);
      assert.deepEqual(row.fixed, fixed.fixed);
      assert.equal(row.content, null);
    } else {
      assert.equal(row.availability, 'available', part);
      assert.equal(row.content, part === 'file' ? 'owningfilemarker original evidence\r\n' : 'owningkb1marker original content\r\n', 'kb1 strips one BOM but preserves CRLF');
    }
    assert.ok(!JSON.stringify(result).includes('foreignRootOnlyMarker'));
  }
  deny = ['docs'];
  for (const [part, ref] of refs) {
    const result = await native(READ, { refs: [ref], relatedLimit: 0 });
    assert.equal(result.records[0].availability, 'policy-denied', part);
    assert.equal(result.records[0].content, null, part);
  }
  deny = [];
  fs.renameSync(path.join(root, '.git'), path.join(root, '.git.saved'));
  fs.writeFileSync(path.join(root, '.git'), 'gitdir: ' + path.join(f.wsDir, '.git.saved').replaceAll('\\', '/') + '\n');
  const refused = await native(READ, { refs: [refs.get('fixed')], relatedLimit: 0 });
  assert.equal(refused.records[0].availability, 'legacy-git-record-only');
  assert.equal(refused.records[0].reverified, false);
  assert.equal(refused.records[0].content, null);
  assert.equal((await native(READ, { refs: [refs.get('external')], relatedLimit: 0 })).records[0].availability, 'available');
});

// 责任：真正的 apply 注册必须覆盖两个入口；引用可跨入口使用，schema 不手工复制。
test('native and MCP expose the same business schemas and exchange history references', async t => {
  const f = await knowledgeFixture(t);
  const taskId = await addTask(f.h, '双端知识对齐', { description: '旧记录，部署验证。' });
  await f.h.command(cmd('task.update', { taskId, expected: { entityRev: 1 }, description: '新记录，部署验证，未主动重启。' }));
  const native = host(t, f.stateDir);
  const mcp = await listener(t, f.svc, { enabled: true, projectIds: [f.projectId] });
  const { context } = await success(mcp, 'project_session', { op: 'open', projectId: f.projectId });
  const scope = { context };
  const catalog = (await mcp.post(WRITE, 'tools/list', {})).result.tools;
  for (const name of [SEARCH, READ]) {
    const tool = catalog.find(entry => entry.name === name);
    assert.deepEqual(native.tools.get(name).parameters, tool.inputSchema);
    assert.equal(native.tools.get(name).description, tool.description);
  }
  const before = tree(f.h.meta.dir);
  const found = await call(native, SEARCH, { query: '双端知识对齐', relatedLimit: 0 }, execAt(f.wsDir));
  assert.equal(found.hits[0].entity, 'task:' + taskId);
  const other = await success(mcp, SEARCH, { ...scope, query: '双端知识对齐', relatedLimit: 0 });
  assert.deepEqual(other.hits, found.hits);
  assert.equal(found.hits[0].historyCount, 2);
  assert.match(found.hits[0].fragment, /未主动重启/);
  assert.match(native.tools.get(SEARCH).output.render({ query: '双端知识对齐' }, found)[0].text, /未主动重启/);
  const query = { query: '双端知识对齐 部署验证 不存在', relatedLimit: 0 };
  const loose = await call(native, SEARCH, query, execAt(f.wsDir));
  const looseOther = await success(mcp, SEARCH, { ...scope, ...query });
  assert.equal(loose.queryMatch, 'relaxed');
  assert.deepEqual(looseOther.hits, loose.hits);
  const history = { query: '双端知识对齐', historyRef: other.hits[0].ref, limit: 1, relatedLimit: 0 };
  const firstPage = await call(native, SEARCH, history, execAt(f.wsDir));
  const olderPage = await success(mcp, SEARCH, { ...scope, ...history, cursor: firstPage.nextCursor });
  assert.notEqual(olderPage.hits[0].ref, firstPage.hits[0].ref);
  const older = await call(native, READ, { refs: [olderPage.hits[0].ref] }, execAt(f.wsDir));
  assert.equal(older.records[0].availability, 'available');
  const args = { refs: [found.hits[0].ref], mode: 'context' };
  const read = await call(native, READ, args, execAt(f.wsDir));
  const remote = await success(mcp, READ, { ...scope, ...args, refs: [other.hits[0].ref] });
  assert.deepEqual(read.records, remote.records);
  assert.equal(JSON.parse(read.records[0].content).data.title, '双端知识对齐');
  assert.equal(f.h.leases.size, 0);
  assert.deepEqual(tree(f.h.meta.dir), before);
});

// 责任：程序页可以无损拼回原文，模型文本独立限额且保留来源。
test('native output preserves full bounded originals, references, coverage and cursors', async t => {
  const f = await knowledgeFixture(t);
  const body = '分页原文与引用🙂'.repeat(3000);
  await registerFile(f, 'parity.md', body);
  const native = host(t, f.stateDir);
  const exec = execAt(f.wsDir);
  const found = await call(native, SEARCH, { query: '分页原文', kinds: ['content'] }, exec);
  const ref = found.hits[0].ref;
  let cursor;
  let restored = '';
  do {
    const args = { refs: [ref], maxBytes: 12000, ...(cursor ? { cursor } : {}) };
    const read = await call(native, READ, args, exec);
    const rendered = native.tools.get(READ).output.render(args, read);
    assert.ok(rendered[0].text.includes(ref));
    assert.ok([...rendered[0].text].length <= 6000);
    assert.throws(() => JSON.parse(rendered[0].text));
    assert.ok(read.coverage);
    restored += read.records[0].content;
    cursor = read.records[0].nextCursor;
  } while (cursor);
  assert.equal(restored, body);
  assert.ok(native.tools.get(SEARCH).output.render({}, found)[0].text.includes(ref));
});

// 责任：原生纯读只使用受信 cwd，不创建项目/绑定/锁或续租，卸载后不能继续读。
test('native cold reads and identity refusals do not open a writer or alter retained data', async t => {
  const f = await knowledgeFixture(t);
  await addTask(f.h, '冷读权限测试');
  const foreign = await knowledgeFixture(t);
  await addTask(foreign.h, '其他项目');
  const foreignRef = (await foreign.search('其他项目')).hits[0].ref;
  await f.svc.close();
  for (const method of ['open', 'openByWorkspace', '_openSync', 'createProject']) {
    t.mock.method(ProjectService.prototype, method, () => assert.fail('knowledge read invoked writer entry ' + method));
  }
  const before = tree(f.stateDir);
  const native = host(t, f.stateDir);
  const exec = execAt(f.wsDir);
  const ownRef = (await call(native, SEARCH, { query: '冷读权限测试' }, exec)).hits[0].ref;
  const reject = (name, args, who, code) => assert.rejects(call(native, name, args, who), error => error.code === code);
  await reject(SEARCH, { query: 'x' }, {}, 'forbidden-role');
  await reject(SEARCH, { query: 'x' }, execAt(''), 'invalid-command');
  await reject(SEARCH, { query: 'x', projectId: foreign.projectId }, exec, 'INVALID_ARGS');
  await reject(SEARCH, { query: 'x', sessionToken: 'forged' }, exec, 'INVALID_ARGS');
  await reject(SEARCH, { query: 'x', limit: 51 }, exec, 'invalid-command');
  await reject(SEARCH, { query: 'x'.repeat(501) }, exec, 'invalid-command');
  await reject(READ, { refs: Array(9).fill(ownRef) }, exec, 'invalid-command');
  await reject(READ, { refs: [ownRef], maxBytes: 24577 }, exec, 'invalid-command');
  await reject(READ, { refs: [foreignRef] }, exec, 'knowledge-reference-invalid');
  const unknown = path.join(f.base, 'unknown');
  fs.mkdirSync(unknown);
  await reject(SEARCH, { query: 'x' }, execAt(unknown), 'not-found');
  assert.deepEqual(fs.readdirSync(unknown), []);
  writeMarker(unknown, f.projectId);
  await reject(SEARCH, { query: 'x' }, execAt(unknown), 'binding-required');
  const after = tree(f.stateDir).filter(([file]) => !file.startsWith('knowledge-cache' + path.sep));
  assert.deepEqual(after, before);
  await native.close();
  await reject(SEARCH, { query: 'x' }, exec, 'closed');
});

// 责任：两侧共用同一 worker 名额；原生卸载取消自己的请求，不关闭 MCP 读取器。
test('native disposal cancels its worker and releases the shared MCP concurrency slot', async t => {
  const f = await knowledgeFixture(t);
  await addTask(f.h, '共享读取名额');
  const native = host(t, f.stateDir);
  const mcp = await listener(t, f.svc, { enabled: true, projectIds: [f.projectId] });
  const { context } = await success(mcp, 'project_session', { op: 'open', projectId: f.projectId });
  const scope = { context };
  const started = Promise.withResolvers();
  const lookup = ProjectService.prototype.lookupLiveWriter;
  t.mock.method(ProjectService.prototype, 'lookupLiveWriter', function (projectId) {
    if (this !== f.svc) started.resolve();
    return lookup.call(this, projectId);
  });
  const pending = call(native, SEARCH, { query: '共享读取名额' }, execAt(f.wsDir));
  const cancelled = assert.rejects(pending, error => error.code === 'closed');
  await started.promise;
  // core 在 lookup 返回后同步占用名额，避免依赖 worker 运行速度或人为延时。
  await assert.rejects(f.search('共享读取名额'), error => error.code === 'knowledge-busy');
  await native.close();
  await cancelled;
  const found = await success(mcp, SEARCH, { ...scope, query: '共享读取名额' });
  assert.ok(found.hits.length > 0);
});

// 责任：预先取消不启动读取；执行中取消只终止该次请求，两个入口都能继续使用。
test('native search and read honor execution cancellation without closing their reader', async t => {
  const f = await knowledgeFixture(t);
  await addTask(f.h, '请求取消后继续');
  const native = host(t, f.stateDir);
  const exec = execAt(f.wsDir);
  const reason = new Error('synthetic cancellation');
  const before = tree(f.stateDir);
  const aborted = AbortSignal.abort(reason);
  await assert.rejects(call(native, SEARCH, { query: '请求取消' }, { ...exec, signal: aborted }), error => error === reason);
  assert.deepEqual(tree(f.stateDir), before);
  const ref = (await call(native, SEARCH, { query: '请求取消' }, exec)).hits[0].ref;
  const mcp = await listener(t, f.svc, { enabled: true, projectIds: [f.projectId] });
  const { context } = await success(mcp, 'project_session', { op: 'open', projectId: f.projectId });
  const lookup = ProjectService.prototype.lookupLiveWriter;
  let started;
  t.mock.method(ProjectService.prototype, 'lookupLiveWriter', function (projectId) {
    if (this !== f.svc) started?.resolve();
    return lookup.call(this, projectId);
  });
  for (const [name, args] of [[SEARCH, { query: '请求取消' }], [READ, { refs: [ref] }]]) {
    started = Promise.withResolvers();
    const controller = new AbortController();
    const pending = call(native, name, args, { ...exec, signal: controller.signal });
    const cancelled = assert.rejects(pending, error => error === reason);
    await started.promise;
    controller.abort(reason);
    await cancelled;
    const scope = { context };
    assert.ok((await success(mcp, SEARCH, { ...scope, query: '请求取消' })).hits.length > 0);
    assert.ok((await call(native, READ, { refs: [ref] }, exec)).records[0].content);
  }
});

// 责任：scoped owning 空间无 Git 时，DSH 与 MCP full 都能真实注册并确认外置文档，A/B 留存版本可双向读取；baseline 只带 workspaceVersion，无权限的操作仍拒。
test('scoped owning space confirms without Git and both transports read retained A/B versions', async t => {
  const { svc, root } = await scopedKnowledge(t);
  const NL = String.fromCharCode(10);
  const A = 'version A 留存标记' + NL;
  const B = 'version B 留存标记' + NL;
  const sha = text => crypto.createHash('sha256').update(text).digest('hex');
  const rel = 'docs/versioned.md';
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, rel), A);
  const { native, remote, rawRemote } = scopedKnowledgePorts(t, svc, root);
  const { context } = await remote('project_session', { op: 'open' });

  const reg = await native('project_doc', { op: 'register', title: 'versioned', relPath: rel });
  const docId = reg.doc.id;
  const first = await native('project_doc', { op: 'inspect', docId, fresh: true });
  assert.equal(first.availability, 'readable');
  assert.equal(first.git, null, 'the scoped owning space runs no Git observation');

  const confirmedA = await native('project_doc', { op: 'confirm', docId, expectedMetaRev: first.metaRev, expectedContentHash: sha(A) });
  assert.equal(confirmedA.ok, true);
  const inspectA = await native('project_doc', { op: 'inspect', docId, fresh: true });
  const versionA = inspectA.doc.baseline.workspaceVersion;
  assert.ok(versionA && versionA.versionId, 'confirmation retains the workspace version');
  assert.equal(inspectA.doc.baseline.contentHash, sha(A));
  assert.equal(Object.hasOwn(inspectA.doc.baseline, 'gitHeadOid'), false, 'legacy gitHeadOid never enters a new baseline');

  fs.writeFileSync(path.join(root, rel), B);
  const confirmedB = await rawRemote('project_doc', { op: 'confirm', docId, expectedMetaRev: inspectA.metaRev, expectedContentHash: sha(B), context });
  assert.equal(confirmedB.result.isError, undefined, JSON.stringify(confirmedB));
  const inspectB = await native('project_doc', { op: 'inspect', docId, fresh: true });
  const versionB = inspectB.doc.baseline.workspaceVersion;
  assert.ok(versionB && versionB.versionId);
  assert.notEqual(versionB.versionId, versionA.versionId);
  assert.equal(inspectB.doc.baseline.contentHash, sha(B));
  assert.equal(Object.hasOwn(inspectB.doc.baseline, 'gitHeadOid'), false);

  const aFromRemote = await remote('project_doc', { op: 'read_version', docId, versionId: versionA.versionId, context });
  assert.equal(aFromRemote.body, A, 'MCP reads the version confirmed through DSH');
  const bFromNative = await native('project_doc', { op: 'read_version', docId, versionId: versionB.versionId });
  assert.equal(bFromNative.body, B, 'DSH reads the version confirmed through MCP');
  const aFromNative = await native('project_doc', { op: 'read_version', docId, versionId: versionA.versionId });
  assert.equal(aFromNative.body, A);
  const bFromRemote = await remote('project_doc', { op: 'read_version', docId, versionId: versionB.versionId, context });
  assert.equal(bFromRemote.body, B);
  for (const read of [aFromNative, bFromNative]) {
    assert.ok(read.size > 0);
    assert.equal(read.truncated, false);
    assert.equal(read.versionRef.docId, docId);
  }
  const history = await remote('project_doc', { op: 'history', docId, context });
  assert.deepEqual(history.versions.map(row => row.versionRef.versionId).sort(), [versionA.versionId, versionB.versionId].sort(), 'both retained versions stay listed');

  // A metadata-only MCP credential never reaches the full-authority retained reads.
  const runtime = { service: svc, ready: Promise.resolve(), ctx: { workspaceRegistry: { resolveByPath: () => ({ path: root }) } } };
  t.after(() => runtime.closeAgentTools());
  const denied = createMcpHandler({ tools: projectTools(runtime), authorize: () => ({ key: 'synthetic-metadata', scope: 'metadata', allows: () => true, assertCurrent() {} }) });
  const deniedBody = async args => {
    const req = Readable.from([Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'project_doc', arguments: args } }))]);
    Object.assign(req, { url: '/mcp', method: 'POST', headers: { host: '127.0.0.1:54321', 'content-type': 'application/json', authorization: 'Bearer synthetic' },
      socket: { localAddress: '127.0.0.1', remoteAddress: '127.0.0.1', localPort: 54321 } });
    const res = new EventEmitter();
    res.writeHead = status => { res.status = status; res.headersSent = true; };
    res.end = body => { res.body = body ? JSON.parse(body) : undefined; };
    await denied(req, res);
    return res.body;
  };
  for (const args of [{ op: 'read_version', docId, versionId: versionA.versionId, context }, { op: 'confirm', docId, expectedMetaRev: inspectB.metaRev, expectedContentHash: sha(B), context }]) {
    const body = await deniedBody(args);
    assert.ok(body.error || body.result?.isError, 'a metadata-only MCP credential must not reach ' + args.op);
  }
});

// 责任：模型得到更完整的主文和关联原文；原机器对象、引用与兼容 MCP 读法不变。
test('actual native and MCP rendering present authorized main and related paragraphs, leaving machine JSON unchanged', async t => {
  const f = await knowledgeFixture(t);
  const long = '这段限制说明必须连同条件和例外一起阅读。'.repeat(22);
  const requirement = '确认依据必须包含实测报告的原始采样区间。';
  const exception = '若原始数据未留存，不得把当前采样替代已归档证据。';
  const linked = await addTask(f.h, '关联复核要求', { description: long + requirement });
  await addTask(f.h, '精确入口规约', { description: '调用 disclosure_context 时检查精确来源。' + long + exception, deps: [linked] });
  const native = host(t, f.stateDir);
  const mcp = await listener(t, f.svc, { enabled: true, projectIds: [f.projectId] });
  const { context } = await success(mcp, 'project_session', { op: 'open', projectId: f.projectId });
  const args = { query: 'disclosure_context', kinds: ['task'], limit: 5, relatedLimit: 2 };
  const result = await call(native, SEARCH, args, execAt(f.wsDir));
  assert.equal(result.hits.length, 1);
  assert.equal(result.related.length, 1);
  assert.ok(!result.related[0].fragment.includes(requirement), 'old fragment does not include the late precondition');
  const model = native.tools.get(SEARCH).output.render(args, result)[0].text;
  const wire = (await mcp.call(SEARCH, { ...args, context })).result;
  assert.deepEqual(wire, { content: [{ type: 'text', text: model }] });
  assert.throws(() => JSON.parse(model));
  assert.match(model, /不得把当前采样替代已归档证据/);
  assert.ok(model.includes(requirement), model);
  assert.ok(model.includes(result.hits[0].ref));
  assert.ok(model.includes(result.related[0].ref));
  assert.ok([...model].length <= 6000);
  assert.deepEqual((await mcp.callJson(SEARCH, { ...args, context })).result,
    { content: [{ type: 'text', text: JSON.stringify(result) }] });
  const readArgs = { refs: [result.hits[0].ref], maxBytes: 32 };
  const page = await call(native, READ, readArgs, execAt(f.wsDir));
  assert.equal(page.records[0].format, 'public-record-json');
  assert.ok(page.records[0].range.truncated && page.records[0].nextCursor);
  const modelPage = native.tools.get(READ).output.render(readArgs, page)[0].text;
  assert.ok(modelPage.includes(page.records[0].nextCursor));
  assert.ok(!modelPage.includes(page.records[0].content), 'do not display an incomplete JSON envelope as original prose');
});
