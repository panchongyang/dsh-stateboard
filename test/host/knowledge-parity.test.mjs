/**
 * 测试职责：保证 DSH/MCP 同名知识工具的业务契约、引用互读和原文交付一致。
 * 典型流程：实际插件注册 → 两侧交换引用 → 冷读/拒绝/关闭 → 核对权威数据。
 * 覆盖边界：覆盖合成项目与回环 MCP；不覆盖模型调用或真实 profile。
 * 外部前置：DSH peer 与可用回环端口。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { apply } from '../../lib/index.js';
import { ProjectService } from '../../lib/core/service.js';
import { writeMarker } from '../../lib/core/identity/discover.js';
import { knowledgeFixture, addTask, cmd, tree, registerFile } from '../helpers/knowledge-fixture.mjs';
import { listener, success, WRITE } from '../helpers/mcp-fixture.mjs';

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
  let ptc;
  try { ptc = await import('@deepseek-ai/dsh-tool-executor-ptc'); }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes('@deepseek-ai/dsh-tool-executor-ptc')) return t.skip('optional DSH PTC executor is not installed');
    throw error;
  }
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

// 责任：真正的 apply 注册必须覆盖两个入口；引用可跨入口使用，schema 不手工复制。
test('native and MCP expose the same business schemas and exchange history references', async t => {
  const f = await knowledgeFixture(t);
  const taskId = await addTask(f.h, '双端知识对齐', { description: '旧记录，部署验证。' });
  await f.h.command(cmd('task.update', { taskId, expected: { entityRev: 1 }, description: '新记录，部署验证，未主动重启。' }));
  const native = host(t, f.stateDir);
  const mcp = await listener(t, f.svc, { enabled: true, projectIds: [f.projectId] });
  const { sessionToken } = await success(mcp, 'open_work_session', { projectId: f.projectId });
  const scope = { projectId: f.projectId, sessionToken };
  const catalog = (await mcp.post(WRITE, 'tools/list', {})).result.tools;
  for (const name of [SEARCH, READ]) {
    const tool = catalog.find(entry => entry.name === name);
    const schema = structuredClone(tool.inputSchema);
    delete schema.properties.projectId;
    delete schema.properties.sessionToken;
    schema.required = schema.required.filter(key => !['projectId', 'sessionToken'].includes(key));
    // DSH PTC 不支持范围关键字，允许只把范围转入 description；结构/枚举/必填必须相同。
    assert.deepEqual(structuralSchema(native.tools.get(name).parameters), structuralSchema(schema));
    assert.equal(native.tools.get(name).description, tool.description);
  }
  const before = tree(f.h.meta.dir);
  const found = await call(native, SEARCH, { query: '双端知识对齐', relatedLimit: 0 }, execAt(f.wsDir));
  assert.equal(found.hits[0].entity, 'task:' + taskId);
  const other = await success(mcp, SEARCH, { ...scope, query: '双端知识对齐', relatedLimit: 0 });
  assert.deepEqual(other.hits, found.hits);
  assert.equal(found.hits[0].historyCount, 2);
  assert.match(found.hits[0].fragment, /未主动重启/);
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

// 责任：原文大于旧工具的 4k 文本摘要时仍是完整 JSON，分页可无损拼回并保留来源。
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
    assert.deepEqual(JSON.parse(rendered[0].text), read);
    if (!cursor) assert.ok(rendered[0].text.length > 4000);
    assert.ok(read.coverage);
    restored += read.records[0].content;
    cursor = read.records[0].nextCursor;
  } while (cursor);
  assert.equal(restored, body);
  assert.deepEqual(JSON.parse(native.tools.get(SEARCH).output.render({}, found)[0].text), found);
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
  await reject(SEARCH, { query: 'x', projectId: foreign.projectId }, exec, 'invalid-command');
  await reject(SEARCH, { query: 'x', sessionToken: 'forged' }, exec, 'invalid-command');
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
  const { sessionToken } = await success(mcp, 'open_work_session', { projectId: f.projectId });
  const scope = { projectId: f.projectId, sessionToken };
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
  const { sessionToken } = await success(mcp, 'open_work_session', { projectId: f.projectId });
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
    const scope = { projectId: f.projectId, sessionToken };
    assert.ok((await success(mcp, SEARCH, { ...scope, query: '请求取消' })).hits.length > 0);
    assert.ok((await call(native, READ, { refs: [ref] }, exec)).records[0].content);
  }
});
