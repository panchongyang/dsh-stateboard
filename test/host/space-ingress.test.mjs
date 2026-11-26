/**
 * 测试职责：验证真实插件注册的原生与 MCP 入口只操作受信 space 根的完整库。
 * 典型流程：合成 A 写历史并关闭，冷复制为 B，签发凭据，经注册工具读写后关闭冷读。
 * 覆盖边界：覆盖同历史不同物理副本、正文、上下文归属、权限、队列与结果交付前撤权；不覆盖生产、真实宿主或跨机同步。
 * 外部前置：现有 DSH peer、隔离临时目录和仅本用例建立的回环连接；不安装、不探测已有服务。
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer, request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { apply } from '../../lib/index.js';
import { ProjectService } from '../../lib/core/service.js';
import { issueSpaceGrant, spaceGrantFor } from '../../lib/host/mcp-space-grant.js';
import { mcpExecution } from '../../lib/host/agent-context.js';
import { createSpaceRuntime } from '../../lib/host/space-runtime.js';

const HOST = '127.0.0.1';
const human = { kind: 'human', userId: 'synthetic-space-owner' };
const task = title => ({ op: 'create', title, acceptance: [{ text: '核对所属空间的回执和冷读' }] });
const stateDir = root => path.join(root, '.projectboard', 'state');
const logBytes = root => fs.readFileSync(path.join(stateDir(root), 'commits.jsonl'));
const titles = board => Object.values(board.columns).flat().map(row => row.title).sort();

async function copies(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-space-ingress-')));
  const A = path.join(base, 'A'), B = path.join(base, 'B'), W = path.join(base, 'external-workdir');
  fs.mkdirSync(A); fs.mkdirSync(W);
  // 保留合成目录供失败复核；只关闭自己拥有的句柄，不硬删任何目录。
  t.diagnostic('合成 fixture（保留）: ' + base);
  const seed = new ProjectService({ spaceRoot: A, privilegedInlineWrites: true });
  let projectId, docId;
  try {
    await seed.init();
    projectId = (await seed.createProject({ workspacePath: A, actor: human })).id;
    await seed.command(projectId, { ...task('共同历史'), op: 'task.create', actor: human, cmdId: randomUUID() });
    const receipt = await seed.command(projectId, {
      op: 'doc.put', actor: human, cmdId: randomUUID(), title: '复制点正文', kind: 'note', body: '复制之前已留存的正文',
    });
    docId = receipt.events.find(event => event.type.startsWith('doc/') && event.data?.id).data.id;
  } finally { await seed.close(); }
  const ancestor = logBytes(A);
  fs.cpSync(A, B, { recursive: true, errorOnExist: true, force: false });
  assert.deepEqual(logBytes(B), ancestor);
  return { base, A, B, W, projectId, docId, ancestor };
}

function withoutLegacyCredentials(t) {
  for (const key of ['PROJECT_BOARD_MCP_TOKEN', 'PROJECT_BOARD_MCP_WRITE_TOKEN']) {
    const old = process.env[key];
    delete process.env[key];
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  }
}

// 沿用 mcp-lifecycle 的合成 hostCtx 与临时回环预约方式，不查机器上的服务。
async function host(t, roots, grantRows) {
  const reserve = createServer();
  reserve.listen(0, HOST);
  await once(reserve, 'listening', { signal: AbortSignal.timeout(4000) });
  const port = reserve.address().port;
  await new Promise((resolve, reject) => reserve.close(error => error ? reject(error) : resolve()));
  const tools = new Map(), disposers = [], messages = [], resolved = [];
  let timer, stopped = false;
  const started = Promise.withResolvers();
  const log = message => {
    messages.push(message);
    if (message.includes('] MCP ready')) started.resolve();
    else if (message.includes('] MCP disabled')) started.reject(new Error(message));
  };
  const ctx = {
    logger: { info: log, warn: log, error: log },
    tools: { register(tool) { tools.set(tool.name, tool); } },
    agents: { list() { return []; } },
    workspaceRegistry: { resolveByPath(cwd) {
      resolved.push(cwd);
      return roots.includes(cwd) ? { path: cwd } : undefined;
    } },
    on() { return () => {}; },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
    get() { return undefined; },
  };
  const close = async () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    const errors = [];
    while (disposers.length) try { await disposers.pop()(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, '合成宿主关闭失败');
  };
  t.after(close);
  // 在 apply 可能同步记 disabled 之前，先安装失败消费者，避免未处理拒绝。
  timer = setTimeout(() => started.reject(new Error('MCP 启动超时: ' + messages.join('; '))), 5000);
  const ready = started.promise.finally(() => clearTimeout(timer));
  try {
    apply(ctx, { storageLayout: 'space', mcp: { enabled: true, port, spaceGrants: grantRows } });
    await ready;
  } catch (error) { await close(); throw error; }
  const post = (token, method, params) => new Promise((resolve, reject) => {
    const req = request({
      hostname: HOST, port, path: '/mcp', method: 'POST', agent: false,
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json',
        'mcp-protocol-version': '2025-11-25', accept: 'application/json, text/event-stream' },
      signal: AbortSignal.timeout(5000),
    }, async res => {
      try {
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null });
      } catch (error) { reject(error); }
    });
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
  });
  return {
    tools, messages, resolved, close, post,
    call: (token, name, args) => post(token, 'tools/call', { name, arguments: args }),
    native: (root, name, args, workdir) => tools.get(name).execute(args, {
      agent: { id: 'native-' + path.basename(root), session: { header: { cwd: root } } },
      cwd: workdir, workdir, callId: randomUUID(), signal: AbortSignal.timeout(5000),
    }),
  };
}

function modelText(response) {
  assert.equal(response.status, 200, JSON.stringify(response));
  assert.equal(response.body.error, undefined, JSON.stringify(response));
  assert.equal(response.body.result?.isError, undefined, JSON.stringify(response));
  assert.equal(response.body.result.structuredContent, undefined);
  return response.body.result.content[0].text;
}
function value(response) { return JSON.parse(modelText(response)); }

function denied(response, code) {
  assert.equal(response.status, 200, JSON.stringify(response));
  assert.equal(response.body.result?.isError, true, JSON.stringify(response));
  assert.equal(response.body.result.structuredContent, undefined);
  const failure = JSON.parse(response.body.result.content[0].text);
  assert.equal(failure.ok, false);
  assert.equal(failure.code, code);
  return failure;
}

async function cold(root, projectId, docId) {
  const service = new ProjectService({ spaceRoot: root });
  try {
    await service.init();
    assert.equal(service.resolveWorkspace(root)?.projectId, projectId);
    return { board: await service.query(projectId, 'board'), doc: await service.query(projectId, 'doc', { docId }) };
  } finally { await service.close(); }
}

function receipt(result, projectId, title) {
  assert.equal(result.ok, true);
  assert.equal(result.projectId, projectId);
  assert.equal(result.result.committed, true);
  assert.ok(result.result.events.some(event => event.type === 'task/created'), title);
}

// 责任：覆盖完整冷复制后原生注册和 MCP 无 ID open、有 context 请求及各写各的；不覆盖真实宿主或迁移工具。
test('完整副本的原生与 MCP 入口保留同历史 ID、正文且各自落盘', { timeout: 30000 }, async t => {
  withoutLegacyCredentials(t);
  const f = await copies(t);
  const A = issueSpaceGrant(f.A, 'full'), B = issueSpaceGrant(f.B, 'full');
  const h = await host(t, [f.A, f.B], [A.grant, B.grant]);
  const contexts = [];
  for (const [root, credential, label] of [[f.A, A, 'A'], [f.B, B, 'B']]) {
    const opened = value(await h.call(credential.token, 'project_session', { op: 'open' }));
    assert.equal(opened.projectId, f.projectId);
    assert.equal(opened.scope, 'full');
    contexts.push(opened.context);
    const board = modelText(await h.call(credential.token, 'project_board', { view: 'board', context: opened.context }));
    assert.match(board, /"共同历史"/); assert.doesNotMatch(board, /"(?:原生|MCP)只在[AB]"/);
    assert.ok(modelText(await h.call(credential.token, 'project_doc', { op: 'get', docId: f.docId, context: opened.context })).endsWith('复制之前已留存的正文'));
    // A 会话即便把工作目录切进完整副本 B，仍只能给 A 写；B 会话另测外部 worktree。
    receipt(await h.native(root, 'project_task', task('原生只在' + label), label === 'A' ? f.B : f.W), f.projectId, label);
    assert.ok(modelText(await h.call(credential.token, 'project_task', { ...task('MCP只在' + label), context: opened.context })).includes('"MCP只在' + label + '"'));
    if (label === 'A') assert.deepEqual(logBytes(f.B), f.ancestor, 'A 的业务请求不改变 B 的日志');
  }
  assert.notEqual(contexts[0], contexts[1]);
  const readTools = (token, name, args) => h.post(token, 'tools/call', { name, arguments: args, _meta: { 'project-board/knowledge-output': 'json' } });
  const found = value(await readTools(A.token, 'search_project_knowledge', { context: contexts[0], query: 'MCP只在A', kinds: ['task'], relatedLimit: 0 }));
  const ref = found.hits[0].ref;
  const read = await h.native(f.A, 'read_project_knowledge', { refs: [ref], mode: 'source' }, f.B);
  assert.equal(JSON.parse(read.records[0].content).data.title, 'MCP只在A');
  denied(await readTools(B.token, 'read_project_knowledge', { context: contexts[1], refs: [ref] }), 'knowledge-reference-invalid');
  assert.ok(h.resolved.includes(f.A)); assert.ok(h.resolved.includes(f.B));
  assert.ok(!h.resolved.includes(f.W), 'shell/current workdir 不是入口的空间来源');
  assert.deepEqual(fs.readdirSync(f.W), []);
  await h.close();
  for (const [root, label] of [[f.A, 'A'], [f.B, 'B']]) {
    const before = logBytes(root), read = await cold(root, f.projectId, f.docId);
    assert.deepEqual(titles(read.board), ['共同历史', '原生只在' + label, 'MCP只在' + label].sort());
    assert.equal(read.doc.body, '复制之前已留存的正文');
    assert.ok(before.subarray(0, f.ancestor.length).equals(f.ancestor));
    assert.deepEqual(logBytes(root), before, '冷读不追加日志');
    assert.equal(fs.existsSync(path.join(stateDir(root), 'lock.json')), false);
  }
});

// 责任：覆盖跨凭据 context、metadata 限权、撤权、伪根、旧 ID/bearer 与缺失宿主锚点；不覆盖队列内撤权或生产配置。
test('空间授权拒绝跨副本上下文和参数选库，撤权后返回 401', { timeout: 30000 }, async t => {
  withoutLegacyCredentials(t);
  const f = await copies(t);
  const A = issueSpaceGrant(f.A, 'full'), B = issueSpaceGrant(f.B, 'full'), M = issueSpaceGrant(f.A, 'metadata');
  const grantRows = [A.grant, B.grant, M.grant], h = await host(t, [f.A, f.B], grantRows);
  const a = value(await h.call(A.token, 'project_session', { op: 'open' }));
  const b = value(await h.call(B.token, 'project_session', { op: 'open' }));
  const m = value(await h.call(M.token, 'project_session', { op: 'open' }));
  const beforeA = logBytes(f.A), beforeB = logBytes(f.B);
  denied(await h.call(B.token, 'project_board', { view: 'tasks', context: a.context }), 'work-session-invalid');
  denied(await h.call(B.token, 'project_task', { ...task('跨副本禁止'), context: a.context }), 'work-session-invalid');
  assert.equal(m.scope, 'metadata');
  value(await h.call(M.token, 'project_board', { view: 'tasks', context: m.context }));
  for (const [name, args] of [
    ['project_board', { view: 'board' }], ['project_doc', { op: 'get', docId: f.docId }],
    ['project_task', task('metadata禁止写')],
  ]) denied(await h.call(M.token, name, { ...args, context: m.context }), 'forbidden-role');
  const catalogue = await h.post(A.token, 'tools/list', {});
  assert.equal(catalogue.status, 200);
  for (const tool of catalogue.body.result.tools) assert.equal(Object.hasOwn(tool.inputSchema.properties, 'spaceRoot'), false);
  for (const tool of h.tools.values()) assert.equal(Object.hasOwn(tool.parameters.properties, 'spaceRoot'), false);
  for (const [name, args] of [['project_session', { op: 'open' }], ['project_task', { ...task('伪根禁止写'), context: a.context }]]) {
    const failure = denied(await h.call(A.token, name, { ...args, spaceRoot: f.B }), 'invalid-command');
    assert.match(JSON.stringify(failure), /spaceRoot|unknown field|[Ii]dentity|[Aa]rgument/);
    await assert.rejects(h.native(f.A, name, { ...args, spaceRoot: f.B }, f.W), error =>
      ['INVALID_ARGS', 'invalid-command'].includes(error.code));
  }
  assert.equal((await h.post('ac'.repeat(32), 'tools/call', {
    name: 'project_session', arguments: { op: 'open', projectId: f.projectId },
  })).status, 401, '旧 bearer 加同一历史 ID 不构成副本授权');
  const oldId = value(await h.call(A.token, 'project_session', { op: 'open', projectId: f.projectId }));
  assert.match(modelText(await h.call(A.token, 'project_task', { ...task('旧ID仍只在A'), context: oldId.context })), /"旧ID仍只在A"/);
  assert.deepEqual(logBytes(f.B), beforeB, '同历史 ID 不选择 B 的物理副本');
  const afterA = logBytes(f.A);
  await assert.rejects(h.native(f.W, 'project_task', task('无锚点禁止写'), f.A), error => {
    assert.ok(error.code && error.boardFailure, '必须是明确的工具领域拒绝'); return true;
  });
  assert.deepEqual(fs.readdirSync(f.W), []);
  assert.deepEqual(logBytes(f.A), afterA);
  grantRows.splice(grantRows.indexOf(B.grant), 1);
  assert.equal((await h.call(B.token, 'project_board', { view: 'tasks', context: b.context })).status, 401);
  assert.equal((await h.call(B.token, 'project_task', { ...task('撤权禁止写'), context: b.context })).status, 401);
  assert.deepEqual(logBytes(f.B), beforeB);
  assert.ok(afterA.length > beforeA.length);
  await h.close();
  assert.deepEqual(titles((await cold(f.B, f.projectId, f.docId)).board), ['共同历史']);
  assert.deepEqual(titles((await cold(f.A, f.projectId, f.docId)).board), ['共同历史', '旧ID仍只在A'].sort());
});

// 责任：同一 P4 操作由真实原生与 MCP 注册器转发，metadata 被拒且不追加日志。
test('P4 document relations and responsibility metadata use the same owning-space ingress', { timeout: 30000 }, async t => {
  withoutLegacyCredentials(t);
  const f = await copies(t);
  const F = issueSpaceGrant(f.A, 'full'), M = issueSpaceGrant(f.A, 'metadata');
  const h = await host(t, [f.A], [F.grant, M.grant]);
  const full = value(await h.call(F.token, 'project_session', { op: 'open' })).context;
  const metadata = value(await h.call(M.token, 'project_session', { op: 'open' })).context;
  const native = args => h.native(f.A, 'project_doc', args);
  const mcp = args => h.call(F.token, 'project_doc', { ...args, context: full });
  const tool = h.tools.get('project_doc');
  const remote = (await h.post(F.token, 'tools/list', {})).body.result.tools.find(tool => tool.name === 'project_doc');
  assert.deepEqual(remote.inputSchema, tool.parameters);
  assert.equal(remote.description, tool.description);
  for (const op of ['relate', 'unrelate', 'relations']) assert.ok(remote.inputSchema.properties.op.enum.includes(op));

  const commits = logBytes(f.A).toString('utf8').trim().split('\n').map(line => JSON.parse(line));
  const created = commits.find(row => row.events.some(event => event.type === 'task/created'));
  const event = created.events.findIndex(event => event.type === 'task/created');
  const from = { kind: 'task', id: created.events[event].data.id, seq: created.seq, event };
  const inline = { kind: 'inline', docId: f.docId, rev: 1 };
  const addInline = { op: 'relate', from, to: inline, expectedRev: 1 };
  const blocked = logBytes(f.A);
  for (const args of [addInline, { op: 'unrelate', relationId: 'rel_fixture', expectedRev: 1 }, { op: 'relations', from },
    { op: 'register', title: 'Denied', relPath: 'denied.md', purpose: 'Denied' },
    { op: 'update_meta', docId: f.docId, expectedMetaRev: 1, scope: 'Denied' }]) {
    denied(await h.call(M.token, 'project_doc', { ...args, context: metadata }), 'forbidden-role');
  }
  assert.deepEqual(logBytes(f.A), blocked);

  fs.writeFileSync(path.join(f.A, 'responsibility.md'), 'Exact workspace text\n');
  const registered = await native({ op: 'register', title: 'Responsibilities', relPath: 'responsibility.md',
    purpose: 'Implementation', scope: 'Host transport', supersedes: [f.docId] });
  const docId = registered.doc.id;
  assert.equal(registered.doc.purpose, 'Implementation');
  assert.equal(registered.doc.scope, 'Host transport');
  assert.deepEqual(registered.doc.supersedes, [f.docId]);
  const updated = modelText(await mcp({ op: 'update_meta', docId, expectedMetaRev: registered.doc.rev,
    purpose: 'Review', scope: 'Ingress', supersedes: [], status: 'in_review' }));
  assert.match(updated, /purpose: "Review"/);
  const inspected = await native({ op: 'inspect', docId });
  assert.deepEqual([inspected.doc.purpose, inspected.doc.scope, inspected.doc.supersedes, inspected.doc.status], ['Review', 'Ingress', [], 'in_review']);
  assert.equal(inspected.confirmation.baseline, null);
  const presented = modelText(await mcp({ op: 'inspect', docId }));
  for (const line of ['purpose: "Review"', 'scope: "Ingress"', 'supersedes: []', 'baseline: null']) assert.ok(presented.includes(line));

  const first = (await native(addInline)).result;
  assert.equal(first.relationState, 'exact');
  assert.ok(first.relationId);
  const second = value(await mcp({ op: 'relate', from, to: { kind: 'workspace-current', docId }, expectedRev: 1 })).result;
  assert.equal(second.relationState, 'exact');
  const { versionId } = second.toVersionRef;
  assert.ok(versionId);
  fs.writeFileSync(path.join(f.A, 'responsibility.md'), 'New unretained text\n');
  const beforeReads = logBytes(f.A);
  const paged = await native({ op: 'relations', from, limit: 1 });
  assert.equal(paged.relations.length, 1);
  assert.ok(paged.nextCursor);
  const next = value(await mcp({ op: 'relations', from, limit: 1, after: paged.nextCursor }));
  assert.equal(next.relations.length, 1);
  assert.deepEqual([paged.relations[0].relationId, next.relations[0].relationId].sort(), [first.relationId, second.relationId].sort());
  const forward = value(await mcp({ op: 'relations', from }));
  assert.deepEqual(forward, await native({ op: 'relations', from }));
  for (const args of [{ op: 'relations', docId, versionId }, { op: 'relations', to: { kind: 'workspace-body', docId, versionId } }]) {
    const reverse = value(await mcp(args));
    assert.deepEqual(reverse, await native(args));
    assert.equal(reverse.relations[0].relationId, second.relationId);
  }
  const exactArgs = { op: 'relations', relationId: second.relationId, maxBytes: 1024 };
  const exact = value(await mcp(exactArgs));
  assert.deepEqual(exact, await native(exactArgs));
  assert.equal(exact.body, 'Exact workspace text\n');
  assert.deepEqual(logBytes(f.A), beforeReads, 'relation queries never append log records');
  const removed = value(await mcp({ op: 'unrelate', relationId: first.relationId, expectedRev: 1 })).result;
  assert.equal(removed.relationId, first.relationId);
  const retained = await native({ op: 'relations', to: inline });
  assert.equal(retained.relations[0].relationId, first.relationId, 'removal keeps the historical relation');
  const beforeStale = logBytes(f.A);
  const stale = { op: 'relate', from, to: { kind: 'workspace-current', docId }, expectedRev: 999, replacesId: second.relationId };
  await assert.rejects(native(stale), { code: 'stale-revision' });
  denied(await mcp(stale), 'stale-revision');
  assert.deepEqual(logBytes(f.A), beforeStale, 'a rejected replacement does not append capture or relation events');
  const replaced = value(await mcp({ ...stale, expectedRev: 1 })).result;
  assert.notEqual(replaced.relationId, second.relationId);
  assert.equal((await native(exactArgs)).body, 'Exact workspace text\n', 'replacement preserves the old exact bytes');
  assert.equal((await native({ ...exactArgs, relationId: replaced.relationId })).body, 'New unretained text\n');
  assert.deepEqual(logBytes(f.B), f.ancestor, 'the other physical copy was not touched');
});

// 责任：覆盖在已排队的命令和已读取但未交付的结果之间撤权；不覆盖客户端网络中断。
test('替换授权清单后，排队写不追加日志，已读结果也不交付', { timeout: 15000 }, async t => {
  const f = await copies(t), issued = issueSpaceGrant(f.A, 'full');
  let rows = [issued.grant];
  const verified = spaceGrantFor(() => rows, 'Bearer ' + issued.token);
  const exec = mcpExecution(verified), native = { agent: { id: 'owner', session: { header: { cwd: f.A } } } };
  const spaces = createSpaceRuntime({ workspaceRegistry: { resolveByPath: cwd => cwd === f.A ? { path: f.A } : undefined } });
  t.after(() => spaces.close());
  const handle = await spaces.use(native, local => local.service.open(f.projectId));
  const release = Promise.withResolvers(), queued = Promise.withResolvers(), sampled = Promise.withResolvers();
  const hold = handle._exclusive(() => release.promise), before = logBytes(f.A);
  const command = { op: 'task.create', cmdId: randomUUID(), title: '排队后撤权', acceptance: [{ text: '核对拒绝后的日志字节' }], actor: human };
  const write = spaces.use(exec, local => { const waiting = local.service.command(f.projectId, command); queued.resolve(); return waiting; });
  const read = spaces.use(exec, async local => {
    const doc = await local.service.query(f.projectId, 'doc', { docId: f.docId });
    sampled.resolve(doc.body); await release.promise; return doc;
  });
  const deniedWrite = assert.rejects(write, { code: 'project-forbidden' }), deniedRead = assert.rejects(read, { code: 'project-forbidden' });
  try { await queued.promise; assert.equal(await sampled.promise, '复制之前已留存的正文'); rows = []; }
  finally { release.resolve(); }
  await Promise.all([hold, deniedWrite, deniedRead]); assert.deepEqual(logBytes(f.A), before); assert.deepEqual(logBytes(f.B), f.ancestor);
  assert.equal((await spaces.use(native, local => local.service.command(f.projectId, command))).committed, true);
});
