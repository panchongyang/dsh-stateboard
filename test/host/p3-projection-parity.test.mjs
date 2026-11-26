/**
 * 测试职责：核对工作区投影在原生与 MCP 两端的真实注册、授权代、游标绑定与首次预热。
 * 典型流程：真实 ProjectService（真实扫描 worker）+ 真实注册器 + 真实鉴权分派器；
 * 只在服务方法外层记录并透传调用，确认 host 精确转发的业务参数与授权代。
 * 覆盖边界：覆盖 op 字段白名单、metadata 不可见、scopeKey 推导、restart-required、legacy 不预热与冷读无写；不覆盖 UI 或真实宿主进程。
 * 外部前置：仅 Node 与隔离临时目录。
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
const ledger = root => fs.readFileSync(path.join(root, '.projectboard', 'state', 'commits.jsonl'));
const lockFile = root => path.join(root, '.projectboard', 'state', 'lock.json');
const workspaceFiles = root => Object.fromEntries(fs.readdirSync(root, { recursive: true, withFileTypes: true })
  .filter(entry => !path.relative(root, path.join(entry.parentPath, entry.name)).startsWith('.projectboard'))
  .map(entry => [path.relative(root, path.join(entry.parentPath, entry.name)), entry.isDirectory() ? null : hash(fs.readFileSync(path.join(entry.parentPath, entry.name)))])
  .sort(([a], [b]) => a.localeCompare(b)));

// Record the exact relayed calls while still running the real service method.
function recordServiceCalls(t) {
  const proto = ProjectService.prototype;
  const original = { query: proto.queryWorkspaceProjection, hint: proto.hintWorkspaceProjection };
  const queries = [], hints = [];
  proto.queryWorkspaceProjection = function (projectId, request, authority) {
    queries.push({ projectId, request, authority });
    return original.query.call(this, projectId, request, authority);
  };
  proto.hintWorkspaceProjection = function (projectId, authority) {
    hints.push({ projectId, authority });
    return original.hint.call(this, projectId, authority);
  };
  t.after(() => { proto.queryWorkspaceProjection = original.query; proto.hintWorkspaceProjection = original.hint; });
  return { queries, hints };
}

async function makeSpace(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-p3-projection-')));
  t.diagnostic('Synthetic fixture preserved: ' + base);
  const root = path.join(base, 'space');
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(root, 'notes'));
  fs.writeFileSync(path.join(root, 'notes', 'plan.md'), 'PLAN BODY\r\n');
  fs.writeFileSync(path.join(root, 'decision.md'), 'Decision body\n');
  // Enough supported files to exceed one discovery page (512 entries) so a real
  // cursor is issued by the core worker.
  for (let index = 0; index < 600; index++) fs.writeFileSync(path.join(root, 'bulk-' + String(index).padStart(3, '0') + '.md'), 'x');
  const seed = new ProjectService({ spaceRoot: root });
  let projectId;
  try {
    await seed.init();
    projectId = (await seed.createProject({ workspacePath: root, actor: { kind: 'human' } })).id;
  } finally { await seed.close(); }
  return { root, projectId };
}

function createHost(roots, grants) {
  const tools = new Map(), effects = [], mapping = new Map(roots.map(root => [root, root]));
  let onResolve = null;
  const ctx = {
    tools: { register(definition) { tools.set(definition.name, definition); } },
    workspaceRegistry: {
      resolveByPath(root) {
        const target = mapping.get(root);
        const result = target ? { path: target } : undefined;
        onResolve?.(root);
        return result;
      },
    },
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
  const localExec = { agent: { id: 'p3-native', session: { header: { cwd: roots[0] } } }, cwd: roots[0], workdir: roots[0] };
  const native = (name, args) => tools.get(name).execute(args, localExec);
  const call = (token, name, args) => post(token, 'tools/call', { name, arguments: args });
  return {
    tools, post, close, native, call,
    onResolve(fn) { onResolve = fn; },
    remap(from, to) { mapping.set(from, to); },
  };
}

function mcpResult(reply, expectedCode) {
  assert.equal(reply.status, 200, JSON.stringify(reply));
  assert.equal(reply.body.error, undefined, JSON.stringify(reply));
  const result = reply.body.result;
  assert.equal(Boolean(result.isError), Boolean(expectedCode), JSON.stringify(result));
  if (expectedCode) assert.equal(JSON.parse(result.content[0].text).code, expectedCode);
  return result.content[0].text;
}

// 责任：两端注册同一 op 面；metadata 看不到投影；游标绑定授权代；冷读与预热不写文件。
test('P3 workspace projection: same ops on both ends, trusted scope key, restart-required cursor', { timeout: 60000 }, async t => {
  const { root, projectId } = await makeSpace(t);
  const { queries, hints } = recordServiceCalls(t);
  const full = issueSpaceGrant(root, 'full'), otherFull = issueSpaceGrant(root, 'full'), metadata = issueSpaceGrant(root, 'metadata');
  const grants = [full.grant, otherFull.grant, metadata.grant];
  const live = createHost([root], grants);
  t.after(() => live.close());

  // Both transports publish the same business surface, including the new ops.
  const catalogue = (await live.post(full.token, 'tools/list', {})).body.result.tools.find(tool => tool.name === 'project_doc');
  assert.deepEqual(catalogue.inputSchema, live.tools.get('project_doc').parameters);
  for (const op of ['discover', 'read_current', 'refresh_current']) assert.ok(catalogue.inputSchema.properties.op.enum.includes(op));
  assert.ok(catalogue.inputSchema.properties.cursor);
  assert.equal(Object.hasOwn(catalogue.inputSchema.properties, 'scopeKey'), false);
  assert.equal(Object.hasOwn(catalogue.inputSchema.properties, 'root'), false);

  // Metadata open warms nothing and cannot see the projection.
  const meta = JSON.parse(mcpResult(await live.call(metadata.token, 'project_session', { op: 'open' }))).context;
  assert.equal(hints.length, 0, 'metadata open must not warm the projection');
  mcpResult(await live.call(metadata.token, 'project_doc', { op: 'discover', context: meta }), 'forbidden-role');
  assert.equal(queries.length, 0, 'metadata credentials must be rejected before the projection runs');
  assert.equal(hints.length, 0, 'metadata must never touch the projection hint');
  // The host relays the complete business arguments unchanged; core owns the
  // single field/range validation for both transports (no silent stripping).
  await assert.rejects(live.native('project_doc', { op: 'discover', scopeKey: 'forged' }), { code: 'invalid-command' });
  await assert.rejects(live.native('project_doc', { op: 'discover', root }), { code: 'invalid-command' });
  assert.deepEqual(queries.map(row => row.request), [{ op: 'discover', scopeKey: 'forged' }, { op: 'discover', root }]);

  // Every full owning open schedules an advisory hint with a trusted generation
  // and a re-checkable assertion; host keeps no long-lived de-duplication table.
  const nativeOpen = await live.native('project_session', { op: 'open' });
  assert.equal(nativeOpen.projectId, projectId);
  assert.equal(hints.length, 1);
  assert.equal(hints[0].authority.scopeKey, 'native:p3-native');
  assert.equal(typeof hints[0].authority.assertCurrent, 'function');
  const context = JSON.parse(mcpResult(await live.call(full.token, 'project_session', { op: 'open' }))).context;
  assert.equal(hints.length, 2);
  assert.equal(hints[1].authority.scopeKey, 'mcp:' + full.grant.tokenHash);
  await live.call(full.token, 'project_session', { op: 'open', context });
  assert.equal(hints.length, 3, 'core merges/asynchronously renews hints; host does not dedupe with a table');

  // Discovery parity and the exact relayed request shape.
  const lastOf = op => queries.filter(row => row.request.op === op).at(-1);
  const nativePage = await live.native('project_doc', { op: 'discover' });
  assert.equal(lastOf('discover').projectId, projectId);
  assert.deepEqual(lastOf('discover').request, { op: 'discover' });
  assert.equal(lastOf('discover').authority.scopeKey, 'native:p3-native');
  t.diagnostic('discover page: ' + JSON.stringify({ entries: nativePage.entries.length, partial: nativePage.partial, next: typeof nativePage.nextCursor, counts: nativePage.counts }));
  assert.equal(nativePage.partial, true);
  assert.equal(typeof nativePage.nextCursor, 'string');
  assert.ok(nativePage.entries.length > 0);
  assert.ok(['content-read', 'metadata-only'].includes(nativePage.entries[0].observation));
  const mcpPage = JSON.parse(mcpResult(await live.call(full.token, 'project_doc', { op: 'discover', context })));
  assert.equal(lastOf('discover').authority.scopeKey, 'mcp:' + full.grant.tokenHash);
  const paths = page => page.entries.map(entry => entry.relPath);
  const nativePaths = paths(nativePage), mcpPaths = paths(mcpPage);
  const [shorter, longer] = nativePaths.length <= mcpPaths.length ? [nativePaths, mcpPaths] : [mcpPaths, nativePaths];
  assert.ok(shorter.length > 0);
  assert.deepEqual(longer.slice(0, shorter.length), shorter, 'both transports start from the same ordered discovery stream');

  // A cursor is bound to its authorization generation, project and scan context.
  const otherContext = JSON.parse(mcpResult(await live.call(otherFull.token, 'project_session', { op: 'open' }))).context;
  mcpResult(await live.call(otherFull.token, 'project_doc', { op: 'discover', cursor: nativePage.nextCursor, context: otherContext }), 'restart-required');
  mcpResult(await live.call(full.token, 'project_doc', { op: 'discover', cursor: nativePage.nextCursor, context }), 'restart-required');
  const nativeNext = await live.native('project_doc', { op: 'discover', cursor: nativePage.nextCursor });
  assert.deepEqual(lastOf('discover').request, { op: 'discover', cursor: nativePage.nextCursor });
  assert.ok(nativeNext.entries.length > 0);
  const mcpNext = JSON.parse(mcpResult(await live.call(full.token, 'project_doc', { op: 'discover', cursor: mcpPage.nextCursor, context })));
  assert.ok(mcpNext.entries.length > 0);
  // A fresh, still-valid MCP cursor is accepted only by its own credential.
  const mcpFresh = JSON.parse(mcpResult(await live.call(full.token, 'project_doc', { op: 'discover', context })));
  mcpResult(await live.call(otherFull.token, 'project_doc', { op: 'discover', cursor: mcpFresh.nextCursor, context: otherContext }), 'restart-required');
  mcpResult(await live.call(full.token, 'project_doc', { op: 'discover', cursor: '00000000-0000-4000-8000-000000000000', context }), 'restart-required');

  // In-flight owning-root remap: the pre-scan assertion still passes, then the
  // registry maps the session elsewhere while the scan runs; the post-scan
  // assertion must refuse to return any observed value.
  const movedRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-p3-remap-')));
  t.after(() => fs.rmSync(movedRoot, { recursive: true, force: true }));
  let resolutions = 0;
  live.onResolve(() => {
    resolutions += 1;
    // #1 service root, #2 relay pre-check, #3 core pre-scan; remap only after
    // the pre-scan assertion captured the old root, so the post-scan assertion
    // is the one that must refuse.
    if (resolutions === 3) live.remap(root, movedRoot);
  });
  await assert.rejects(live.native('project_doc', { op: 'discover' }), { code: 'project-forbidden' });
  assert.equal(resolutions, 4, 'foreground authority is re-asserted after the scan');
  // The hint recorded at open shares the same construction and now refuses too.
  await assert.rejects(hints[0].authority.assertCurrent(), { code: 'project-forbidden' });
  live.onResolve(null);
  live.remap(root, root);
  const afterRemap = await live.native('project_doc', { op: 'read_current', relPath: 'notes/plan.md', maxBytes: 5 });
  assert.equal(afterRemap.body, 'PLAN ');

  // Explicit context with a nested owning cwd: prepare rewrites session.cwd to
  // the binding root, but the original nested cwd must be preserved and
  // re-asserted on both sides of the scan, so an in-flight remap of the nested
  // directory (not the binding root) still refuses to return a projection.
  const nested = path.join(root, 'notes');
  live.remap(nested, root);
  const nestedExec = { agent: { id: 'p3-nested', session: { header: { cwd: nested } } }, cwd: nested, workdir: nested };
  const nestedContext = (await live.tools.get('project_session').execute({ op: 'open', projectId }, nestedExec)).context;
  const nestedRead = await live.tools.get('project_doc').execute({ op: 'read_current', relPath: 'notes/plan.md', maxBytes: 5, context: nestedContext }, nestedExec);
  assert.equal(nestedRead.body, 'PLAN ');
  let nestedResolutions = 0;
  live.onResolve(() => {
    nestedResolutions += 1;
    if (nestedResolutions === 3) live.remap(nested, movedRoot);
  });
  await assert.rejects(live.tools.get('project_doc').execute({ op: 'discover', context: nestedContext }, nestedExec), { code: 'project-forbidden' });
  live.onResolve(null);
  assert.equal(nestedResolutions, 4, 'the original nested cwd is re-asserted after the scan');
  live.remap(nested, root);
  const nestedAgain = await live.tools.get('project_doc').execute({ op: 'read_current', relPath: 'notes/plan.md', maxBytes: 5, context: nestedContext }, nestedExec);
  assert.equal(nestedAgain.body, 'PLAN ');


});

// 责任：发现到的路径经 P2 register 原地纳管并带任务链接；当前正文读取有界且无写副作用。
test('P3 discovered path adoption and bounded current reads', { timeout: 60000 }, async t => {
  const { root } = await makeSpace(t);
  const { queries, hints } = recordServiceCalls(t);
  const full = issueSpaceGrant(root, 'full');
  const live = createHost([root], [full.grant]);
  t.after(() => live.close());
  const context = JSON.parse(mcpResult(await live.call(full.token, 'project_session', { op: 'open' }))).context;
  const lastOf = op => queries.filter(row => row.request.op === op).at(-1);
  // A native session that never opens still wakes the projection on ordinary
  // use, and repeated hot-path use is O(1) throttled (no new hint call).
  const hintBase = hints.length;
  const firstList = await live.native('project_doc', { op: 'list' });
  assert.equal(typeof firstList.projectId, 'string');
  assert.equal(hints.length, hintBase + 1, 'native default use wakes the projection without open');
  assert.equal(hints.at(-1).authority.scopeKey, 'native:p3-native');
  await live.native('project_doc', { op: 'list' });
  assert.equal(hints.length, hintBase + 1, 'hot-path touches are throttled');
  // The P3 assertion itself must be asynchronous: instrument sync fs entry
  // points and require none of them during the assertion.
  const syncRealpath = fs.realpathSync, syncStat = fs.statSync;
  let syncCalls = 0;
  fs.realpathSync = (...args) => { syncCalls += 1; return syncRealpath(...args); };
  fs.statSync = (...args) => { syncCalls += 1; return syncStat(...args); };
  try {
    const pending = hints.at(-1).authority.assertCurrent();
    assert.equal(typeof pending?.then, 'function', 'P3 assertion is async');
    await pending;
    assert.equal(syncCalls, 0, 'P3 assertion performs no synchronous realpath/stat');
  } finally {
    fs.realpathSync = syncRealpath;
    fs.statSync = syncStat;
  }
  const discover = await live.native('project_doc', { op: 'discover' });
  const planPath = discover.entries[0].relPath;
  const beforePlan = fs.readFileSync(path.join(root, planPath));
  const beforeRegister = workspaceFiles(root);
  // A discovered path is adopted in place by the P2 register command with links:
  // it gains a docId and task links, while the original file is neither copied
  // nor rewritten (no P4 version relation is involved).
  const createdTask = await live.native('project_task', { op: 'create', title: 'Projection link target', acceptance: [{ text: 'linkable' }] });
  const taskId = createdTask.task?.task?.id ?? createdTask.result?.events?.find(event => event.type === 'task/created')?.taskId;
  assert.equal(typeof taskId, 'string');
  const registered = await live.native('project_doc', { op: 'register', title: 'Plan (discovered)', kind: 'note', relPath: planPath, links: { taskIds: [taskId] } });
  assert.equal(registered.doc.source, 'external');
  assert.equal(registered.doc.locator.relPath, planPath);
  assert.deepEqual(registered.doc.links.taskIds, [taskId]);
  const listed = await live.native('project_doc', { op: 'list_external' });
  assert.ok(listed.docs.some(doc => doc.id === registered.doc.id && doc.links.taskIds.includes(taskId)), 'registration is visible with its task link');
  assert.deepEqual(workspaceFiles(root), beforeRegister, 'register must not copy or rewrite the discovered file');
  assert.deepEqual(fs.readFileSync(path.join(root, planPath)), beforePlan);

  // read_current is exact, bounded and never writes the file or the ledger.
  const before = workspaceFiles(root);
  const lastLedger = ledger(root);
  const lockBefore = fs.existsSync(lockFile(root));
  const read = await live.native('project_doc', { op: 'read_current', relPath: 'notes/plan.md', maxBytes: 5 });
  assert.equal(read.relPath, 'notes/plan.md');
  assert.equal(read.body, 'PLAN ');
  assert.equal(read.truncated, true);
  assert.equal(read.totalBytes, 11);
  assert.equal(read.contentHash, hash(Buffer.from('PLAN BODY\r\n')));
  assert.deepEqual(lastOf('read_current').request, { op: 'read_current', relPath: 'notes/plan.md', maxBytes: 5 });
  const mcpRead = JSON.parse(mcpResult(await live.call(full.token, 'project_doc', { op: 'read_current', relPath: 'notes/plan.md', maxBytes: 5, context })));
  for (const field of ['relPath', 'body', 'truncated', 'totalBytes', 'contentHash', 'size']) assert.deepEqual(mcpRead[field], read[field], field);
  const unbounded = await live.native('project_doc', { op: 'read_current', relPath: 'notes/plan.md', maxBytes: 1048576 });
  assert.equal(unbounded.truncated, false);
  await assert.rejects(live.native('project_doc', { op: 'read_current', relPath: 'notes/plan.md', maxBytes: 0 }), { code: 'invalid-command' });
  await assert.rejects(live.native('project_doc', { op: 'read_current', relPath: 'notes/plan.md', maxBytes: 1048577 }), { code: 'invalid-command' });
  await assert.rejects(live.native('project_doc', { op: 'read_current', relPath: '../escape' }), { code: 'invalid-command' });

  // refresh_current re-observes one path; it accepts no maxBytes.
  const refreshed = await live.native('project_doc', { op: 'refresh_current', relPath: 'decision.md' });
  assert.equal(refreshed.relPath, 'decision.md');
  assert.equal(refreshed.bodyVerified, true);
  assert.deepEqual(lastOf('refresh_current').request, { op: 'refresh_current', relPath: 'decision.md' });
  await assert.rejects(live.native('project_doc', { op: 'refresh_current', relPath: 'decision.md', maxBytes: 5 }), { code: 'invalid-command' });
  assert.deepEqual(workspaceFiles(root), before, 'projection reads must not change workspace bytes');
  assert.deepEqual(ledger(root), lastLedger, 'projection reads must not append events');
  assert.equal(fs.existsSync(lockFile(root)), lockBefore, 'projection reads must not acquire a new durable lock');

  // Legacy consolidated mode (no owning space) never warms and never projects.
  const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-p3-legacy-'));
  const legacy = new ProjectService({ rootDir: legacyRoot });
  await legacy.init();
  t.after(() => legacy.close());
  const legacyTools = new Map(), legacyEffects = [];
  const legacyCtx = {
    tools: { register(definition) { legacyTools.set(definition.name, definition); } },
    effect(fn) { legacyEffects.push(fn()); },
  };
  registerTools(legacyCtx, { service: legacy, ready: Promise.resolve(), ctx: legacyCtx });
  t.after(() => Promise.all(legacyEffects.map(dispose => dispose?.())));
  const hintCount = hints.length, queryCount = queries.length;
  await assert.rejects(legacyTools.get('project_doc').execute({ op: 'discover' },
    { agent: { id: 'p3-legacy', session: { header: { cwd: legacyRoot } } }, cwd: legacyRoot }), { code: 'project-forbidden' });
  assert.equal(queries.length, queryCount, 'legacy mode must not call the projection capability');
  assert.equal(hints.length, hintCount, 'legacy mode must not warm the projection');
});
