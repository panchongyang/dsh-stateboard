/**
 * 测试职责：后端统一入口——HTTP 与原生/MCP 读走同一 reader.query，冷读不产生任何写入；
 * 写只经 application.command；授权 scope 在业务判定前收口。
 * 典型流程：合成项目 → 关闭 writer → 冷启动 service/runtime → HTTP GET 与原生读 → 比较日志/锁/meta。
 * 覆盖边界：覆盖读路径入口收口、冷读零写、冷 review 资格与 verify 反证、Web 全量项目列表、原生取消、scope→业务共用；不覆盖真实 DSH 宿主或部署。
 * 外部前置：仅临时目录与合成 fixture，不接触真实 profile。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ProjectService } from '../../lib/core/service.js';
import { registerTools } from '../../lib/host/tools/index.js';
import { registerRoutes } from '../../lib/host/routes.js';
import { projectTools } from '../../lib/host/mcp-tools.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-ingress-state-'));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-ingress-ws-'));
const extraWorkspaces = [];
const disposers = [];
let server = null;
let coldService = null;

function fakeCtx(web) {
  return {
    logger: { info() {}, warn() {}, error() {} },
    tools: { register(tool) { this.map.set(tool.name, tool); }, map: new Map() },
    systemPrompt: { section() { return () => {}; }, getSectionOrder() { return 9000; } },
    agents: { list() { return []; } },
    on() { return () => {}; },
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return () => {}; },
    get(name) { return name === 'webServer' ? web : undefined; },
  };
}

function fileState(dir) {
  const log = path.join(dir, 'commits.jsonl');
  const meta = path.join(dir, 'meta.json');
  return {
    log: fs.readFileSync(log),
    meta: fs.readFileSync(meta),
    lock: fs.existsSync(path.join(dir, 'lock.json')),
  };
}

function sameFile(a, b) {
  return a.log.equals(b.log) && a.meta.equals(b.meta);
}

function exec0(id = 'agent-ingress') {
  return { agent: { id, session: { header: { cwd: ws } } }, signal: new AbortController().signal };
}

try {
  // 分段职责：先用写入口造出合成状态，再关闭 writer，确保后续只可能是冷读。
  const seeded = new ProjectService({ rootDir: root });
  await seeded.init();
  const handle = await seeded.createProject({ workspacePath: ws, name: 'Ingress fixture', actor: { kind: 'system' } });
  const projectId = handle.id;
  await seeded.command(projectId, {
    op: 'plan.publish', cmdId: 'cmd-ingress-plan', actor: { kind: 'human', via: 'web' },
    title: 'Ingress plan', steps: [{ id: 's1', title: 'one', tasks: [
      { key: 't1', title: 'Ingress task', acceptance: [{ text: 'ok' }] },
      { key: 't2', title: 'Cold review task', acceptance: [{ text: 'ok' }] },
      { key: 't3', title: 'Cold in-flight task', acceptance: [{ text: 'ok' }] },
    ] }],
  });
  const seedLive = seeded.lookupLiveWriter(projectId);
  const seedBoard = seedLive.query('board');
  const taskId = seedBoard.columns.ready.find((card) => card.title === 'Ingress task').id;
  const reviewTaskId = seedBoard.columns.ready.find((card) => card.title === 'Cold review task').id;
  const humanSeed = { kind: 'human', via: 'web' };
  const inFlightId = seedBoard.columns.ready.find(card => card.title === 'Cold in-flight task').id;
  await seeded.command(projectId, { op: 'task.claim', cmdId: 'cmd-seed-flight-claim', actor: humanSeed, taskId: inFlightId,
    expected: { entityRev: seedLive.state.tasks[inFlightId].rev } });
  await seeded.command(projectId, { op: 'task.begin', cmdId: 'cmd-seed-flight-begin', actor: humanSeed, taskId: inFlightId,
    expected: { entityRev: seedLive.state.tasks[inFlightId].rev }, fencingToken: seedLive.leases.get(inFlightId).token,
    summary: 'restart must retain this intent' });
  // Put one task in review while the writer is open; after close it is a cold
  // review read whose eligibility must still offer the human verify action.
  await seeded.command(projectId, {
    op: 'task.claim', cmdId: 'cmd-seed-review-claim', actor: humanSeed, taskId: reviewTaskId,
    expected: { entityRev: seedLive.state.tasks[reviewTaskId].rev },
  });
  const seedLease = seedLive.leases.get(reviewTaskId);
  await seeded.command(projectId, {
    op: 'task.begin', cmdId: 'cmd-seed-review-begin', actor: humanSeed, taskId: reviewTaskId,
    fencingToken: seedLease.token, expected: { entityRev: seedLive.state.tasks[reviewTaskId].rev }, summary: 'cold review',
  });
  await seeded.command(projectId, {
    op: 'task.submit', cmdId: 'cmd-seed-review-submit', actor: humanSeed, taskId: reviewTaskId,
    fencingToken: seedLease.token, expected: { entityRev: seedLive.state.tasks[reviewTaskId].rev },
    evidence: [{ kind: 'note', ref: 'cold-review-note', acceptanceId: seedLive.state.tasks[reviewTaskId].acceptance[0].id }],
  });
  assert.equal(seedLive.state.tasks[reviewTaskId].state, 'review');
  // The web project list must show all 31 projects (the metadata page is 30).
  for (let index = 0; index < 30; index += 1) {
    const extraWs = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-ingress-extra-'));
    extraWorkspaces.push(extraWs);
    await seeded.createProject({ workspacePath: extraWs, name: 'Ingress extra ' + index, actor: { kind: 'system' } });
  }
  await seeded.close();

  const dir = path.join(root, 'projects', projectId);
  const before = fileState(dir);
  assert.equal(before.lock, false, 'writer closed');

  // 分段职责：冷启动 service + runtime，HTTP 与原生读均只能走 reader.query。
  const service = coldService = new ProjectService({ rootDir: root });
  await service.init();
  let route = null;
  const web = { register(options) { route = options; return () => {}; } };
  const ctx = fakeCtx(web);
  const runtime = {
    ctx, rootDir: root, service, ready: service.init(), token: 'a'.repeat(48),
    sessionProjects: new Map(), promptFibers: new Map(),
  };
  await runtime.ready;
  registerTools(ctx, runtime);
  registerRoutes(ctx, runtime);
  assert.ok(route, 'HTTP routes registered');

  server = http.createServer((req, res) => route.handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/project-board/api';
  async function get(pathname) {
    const response = await fetch(base + pathname, { headers: { 'x-project-board-token': runtime.token } });
    return { status: response.status, value: await response.json() };
  }

  // 分段职责：逐个 HTTP 读视图成功，且冷读前后日志/meta 完全不变、未创建锁。
  const board = await get('/projects/' + projectId + '/board');
  assert.equal(board.status, 200, JSON.stringify(board.value));
  assert.equal(board.value.columns.ready.length, 1, 'the published task is ready');
  assert.equal(board.value.ok, true);
  // The value DTO keeps its protocol envelope; adapters must not swallow it.
  assert.equal(board.value.projectId, projectId);
  assert.equal(board.value.view, 'board');
  assert.equal(typeof board.value.projectRev, 'number');
  assert.equal(board.value.rev, board.value.projectRev);

  const task = await get('/projects/' + projectId + '/tasks/' + taskId);
  assert.equal(task.status, 200);
  assert.equal(task.value.task.id, taskId);

  const events = await get('/projects/' + projectId + '/events');
  assert.equal(events.status, 200);
  // A cold replay is expected to contain the committed timeline: an empty
  // array here would mask data loss, so the fixture asserts real events.
  assert.ok(events.value.events.some((event) => event.type === 'plan/published'), 'cold events lost committed history');
  assert.ok(events.value.events.every((event) => Number.isInteger(event.seq)));

  const plans = await get('/projects/' + projectId + '/plans');
  assert.equal(plans.status, 200);
  assert.equal(plans.value.plans.length, 1);

  const plansCurrent = await get('/projects/' + projectId + '/plans/current');
  assert.equal(plansCurrent.status, 200);

  const docs = await get('/projects/' + projectId + '/docs');
  assert.equal(docs.status, 200);

  const health = await get('/projects/' + projectId + '/health');
  assert.equal(health.status, 200);
  assert.equal(health.value.ok, true);
  assert.equal(health.value.health.evidenceAudit.status, 'complete');

  const summary = await get('/projects/' + projectId);
  assert.equal(summary.status, 200);
  assert.equal(summary.value.project.id, projectId);
  assert.equal(summary.value.project.rev, board.value.rev);
  // readOnly is probed from the real lock file, never hardcoded: no writer and
  // no foreign lock means writable.
  assert.equal(summary.value.project.readOnly, false);
  assert.equal(fs.existsSync(path.join(dir, 'lock.json')), false);

  const unknown = await get('/projects/prj_0000000000000000');
  assert.equal(unknown.status, 404);

  // 分段职责：Web 项目列表必须是完整读值（31 个项目、workspace/counts/readOnly/lastAt），
  // 而不是 metadata 凭据的 30 项窄分页；项目列表本身也在冷读下完成。
  const projects = await get('/projects');
  assert.equal(projects.status, 200);
  assert.equal(projects.value.projects.length, 31, 'the web project list is not truncated to the metadata page');
  const listed = projects.value.projects.find((row) => row.id === projectId);
  assert.ok(listed, 'the fixture project is listed');
  const canonicalPath = (value) => {
    try { return fs.realpathSync.native(value).toLowerCase(); } catch { return path.resolve(value).toLowerCase(); }
  };
  assert.equal(canonicalPath(listed.workspacePath), canonicalPath(ws), 'the row keeps its workspace path');
  assert.equal(listed.phase, 'active');
  assert.equal(listed.readOnly, false);
  assert.equal(typeof listed.lastAt, 'string');
  assert.equal(listed.counts.review, 1, 'the row keeps progress counts');
  assert.ok(projects.value.projects.every((row) => typeof row.workspacePath === 'string' && row.counts));

  const tools = ctx.tools.map;
  // 分段职责：冷 review 的 HTTP task 读仍用同一可信 actor 计算纯资格；human verify
  // 必须可点，非本人不会拿到 lease/token，且冷读不打开 writer。
  const coldReview = await get('/projects/' + projectId + '/tasks/' + reviewTaskId);
  assert.equal(coldReview.status, 200, JSON.stringify(coldReview.value));
  assert.ok(Array.isArray(coldReview.value.allowedOps), 'a cold review read still carries allowedOps');
  const coldVerify = coldReview.value.allowedOps.find((entry) => entry.op === 'verify');
  assert.equal(coldVerify.enabled, true, 'the human verify action is enabled on a cold review read');
  assert.equal(coldVerify.reason, null);
  assert.equal(coldReview.value.lease, null, 'a cold replay has no runtime lease');
  assert.equal(JSON.stringify(coldReview.value).includes('"token"'), false, 'a cold read leaks no fencing token');
  assert.equal(fs.existsSync(path.join(dir, 'lock.json')), false, 'the cold review read did not open a writer');
  assert.equal(service.handles.size, 0, 'the cold review read did not create a handle');
  const nativeColdReview = await tools.get('project_board').execute({ view: 'task', taskId: reviewTaskId, fresh: true }, exec0('cold-review-agent'));
  assert.ok(Array.isArray(nativeColdReview.allowedOps), 'the native cold task read carries the same hints');
  assert.equal(nativeColdReview.allowedOps.find((entry) => entry.op === 'verify').enabled, true);
  assert.equal(nativeColdReview.lease, null);
  assert.equal(JSON.stringify(nativeColdReview).includes('"token"'), false);

  // 分段职责：原生 task/task_detail 的在途 cancellation 必须贯穿只读上下文：
  // 一个调用被取消只收起自己的 worker，不能波及另一笔独立读。
  function cancellingSignal() {
    return {
      aborted: false,
      throwIfAborted() {},
      addEventListener(type, listener) { if (type === 'abort') listener(); },
      removeEventListener() {},
    };
  }
  const cancelExec = { agent: { id: 'agent-cancel', session: { header: { cwd: ws } } }, signal: cancellingSignal() };
  await assert.rejects(
    tools.get('project_board').execute({ view: 'task_detail', taskId, section: 'description' }, cancelExec),
    (error) => { assert.equal(JSON.parse(error.message).code, 'read-cancelled'); return true; },
    'an in-flight native task_detail read honours exec.signal',
  );
  const survivor = await tools.get('project_board').execute({ view: 'task_detail', taskId, section: 'description' }, exec0());
  assert.equal(survivor.view, 'task_detail');
  const afterCancellation = fileState(dir);
  assert.ok(sameFile(before, afterCancellation), 'cancelled reads must not write');
  assert.equal(afterCancellation.lock, false);

  const afterHttp = fileState(dir);
  assert.ok(sameFile(before, afterHttp), 'HTTP cold reads must not append or rewrite meta');
  assert.equal(afterHttp.lock, false, 'HTTP cold reads must not take the project lock');

  // 分段职责：原生 project_board 全部视图同样冷读，且不 attach/touch/写。
  const exec = exec0();
  for (const [view, extra] of [['brief', {}], ['board', {}], ['task', { taskId }], ['plans', {}], ['plan', {}], ['docs', {}], ['events', {}], ['health', {}], ['task_detail', { taskId, section: 'description' }]]) {
    const result = await tools.get('project_board').execute({ view, ...extra }, exec);
    assert.ok(result, 'native view ' + view);
  }
  const nativeBoard = await tools.get('project_board').execute({ view: 'board' }, exec);
  assert.equal(nativeBoard.view, 'board');
  assert.equal(nativeBoard.projectId, projectId);
  assert.equal(nativeBoard.projectRev, board.value.projectRev);
  assert.equal(nativeBoard.boardRev, board.value.rev);
  assert.equal(nativeBoard.columns.ready.length, board.value.columns.ready.length);

  const afterNative = fileState(dir);
  assert.ok(sameFile(before, afterNative), 'native cold reads must not append or rewrite meta');
  assert.equal(afterNative.lock, false, 'native cold reads must not take the project lock');
  assert.equal(Object.hasOwn(service.metas.get(projectId) ? (service.handles.get(projectId)?.state.bindings ?? {}) : {}, 'agent-ingress'), false,
    'a read must not create a session binding');

  // 分段职责：scope 在同一业务定义前收口——metadata 只允许 metadata 视图，写/普通读被拒。
  const metadataTools = projectTools(runtime, { key: Symbol('mcp:metadata'), scope: 'metadata', allows: () => true });
  const metadata = metadataTools.find((tool) => tool.name === 'project_board');
  // Metadata scope opens a discovery context; opening records no session binding.
  const opened = await metadataTools.find((tool) => tool.name === 'project_session').run({ op: 'open', projectId }, {});
  const context = JSON.parse(opened.content[0].text).context;
  const metaTasks = await metadata.run({ view: 'tasks', context }, {});
  assert.equal(metaTasks.content[0].type, 'text');
  await assert.rejects(metadata.run({ view: 'board', context }, {}), (error) => {
    assert.equal(error.code, 'forbidden-role');
    return true;
  }, 'metadata scope cannot read a full board');

  // 分段职责：HTTP/原生/MCP 首次写拒绝不能恢复冷任务，也不能留下绑定或推进读水位。
  const coldPath = '/projects/' + projectId + '/tasks/' + inFlightId;
  const coldWork = (await get(coldPath)).value;
  assert.equal(coldWork.task.state, 'in_progress');
  const rejectedHttp = await fetch(base + '/projects/' + projectId + '/commands', {
    method: 'POST', headers: { 'x-project-board-token': runtime.token, 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'task.update', taskId: inFlightId, expected: { projectRev: 0, entityRev: 0 }, title: 'rejected' }),
  });
  assert.equal(rejectedHttp.status, 409);
  assert.equal((await rejectedHttp.json()).error.code, 'stale-revision');
  const update = { op: 'update', taskId: inFlightId, projectRev: coldWork.projectRev, expectedRev: 0, title: 'rejected' };
  await assert.rejects(tools.get('project_task').execute(update, exec), { code: 'stale-revision' });
  const fullTools = projectTools(runtime, { key: Symbol('mcp:full'), scope: 'full', allows: () => true });
  const openedContext = await fullTools.find(tool => tool.name === 'project_session').run({ op: 'open', projectId }, {});
  const hotContext = JSON.parse(openedContext.content[0].text).context;
  await assert.rejects(fullTools.find(tool => tool.name === 'project_task').run({ ...update, context: hotContext }, {}), { code: 'stale-revision' });
  const afterDenied = (await get(coldPath)).value;
  assert.equal(afterDenied.projectRev, coldWork.projectRev);
  assert.deepEqual(afterDenied.task, coldWork.task);
  assert.equal(afterDenied.lease, null);
  assert.ok(sameFile(before, fileState(dir)));
  assert.deepEqual(service.handles.get(projectId).state.bindings, {});

  // 分段职责：冷读的同一 projectRev 允许 human verify；恢复和业务同一条物理日志。
  const verifyResponse = await fetch(base + '/projects/' + projectId + '/commands', {
    method: 'POST',
    headers: { 'x-project-board-token': runtime.token, 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'task.verify', cmdId: 'cmd-cold-verify', taskId: reviewTaskId,
      expected: { projectRev: coldWork.projectRev, entityRev: coldReview.value.task.rev } }),
  });
  assert.equal(verifyResponse.status, 200, JSON.stringify(await verifyResponse.clone().json()));
  assert.equal((await verifyResponse.json()).result.committed, true);
  const added = fileState(dir).log.subarray(before.log.length).toString().trim().split('\n').map(JSON.parse);
  assert.equal(added.length, 1);
  assert.equal(added[0].cmdId, 'cmd-cold-verify');
  assert.equal(added[0].seq, coldWork.projectRev + 1);
  assert.deepEqual(added[0].events.slice(0, 2).map(event => [event.type, event.actor?.kind]), [['lease/expired', 'system'], ['task/interrupted', 'system']]);
  assert.equal((await get(coldPath)).value.task.state, 'interrupted');
  const reviewAfterVerify = await get('/projects/' + projectId + '/tasks/' + reviewTaskId);
  assert.equal(reviewAfterVerify.value.task.state, 'done');
  assert.equal(reviewAfterVerify.value.task.verifiedBy, 'human');

  // 分段职责：HTTP 与原生写共用同一 application.command 业务判定（stale-revision）。
  const staleHttp = await fetch(base + '/projects/' + projectId + '/commands', {
    method: 'POST',
    headers: { 'x-project-board-token': runtime.token, 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'task.claim', taskId, expected: { entityRev: 999 } }),
  });
  assert.equal(staleHttp.status, 409);
  assert.equal((await staleHttp.json()).error.code, 'stale-revision');
  const nativeTask = tools.get('project_task');
  await assert.rejects(
    nativeTask.execute({ op: 'claim', taskId, expectedRev: 999 }, exec),
    (error) => { assert.equal(JSON.parse(error.message).code, 'stale-revision'); return true; },
  );

  // 分段职责：拒绝不可改变业务状态、提升任务版本或附带转移记录。
  const taskAfter = await get('/projects/' + projectId + '/tasks/' + taskId);
  assert.equal(taskAfter.value.task.state, task.value.task.state, 'rejected writes must not move the task');
  assert.equal(taskAfter.value.task.rev, task.value.task.rev, 'rejected writes must not bump the task rev');
  const eventsAfter = await get('/projects/' + projectId + '/events');
  assert.equal(eventsAfter.value.events.some((event) => event.type === 'task/claimed' && event.taskId === taskId), false, 'rejected claim left a business event for this task');

  // 分段职责：热读（已附着 + 活跃租约）经三端都带 hints 的 allowedOps，且不向其他
  // 会话泄露 fencing token；未知任务冷读只报 not-found，不伪造授权。
  const execA = { agent: { id: 'hot-session-a', session: { header: { cwd: ws } } }, signal: new AbortController().signal };
  const execB = { agent: { id: 'hot-session-b', session: { header: { cwd: ws } } }, signal: new AbortController().signal };
  const claimed = await tools.get('project_task').execute({ op: 'claim', taskId, expectedRev: task.value.task.rev }, execA);
  assert.equal(claimed.ok, true);
  const taskA = await tools.get('project_board').execute({ view: 'task', taskId, fresh: true }, execA);
  const taskB = await tools.get('project_board').execute({ view: 'task', taskId, fresh: true }, execB);
  assert.ok(Array.isArray(taskA.allowedOps) && Array.isArray(taskB.allowedOps), 'hot reads carry task hints');
  assert.ok(taskA.lease && Number.isInteger(taskA.lease.token), 'the owner sees its own credential');
  assert.equal(taskB.lease, null, 'another session sees ownership without the credential');
  assert.equal(taskB.task.owner, null);
  assert.equal(JSON.stringify(taskB).includes('"token"'), false, 'no token from another session');
  const enabledB = taskB.allowedOps.filter((entry) => entry.enabled).map((entry) => entry.op);
  for (const op of ['renew', 'submit', 'release']) {
    assert.equal(enabledB.includes(op), false, 'non-owner cannot renew/submit/release: ' + op);
  }
  const detailB = await tools.get('project_board').execute({ view: 'task_detail', taskId, section: 'operations' }, execB);
  assert.deepEqual(JSON.parse(detailB.content), taskB.allowedOps, 'task_detail projects the same hinted allowedOps');
  assert.equal(detailB.content.includes('"token"'), false);

  const httpTask = await get('/projects/' + projectId + '/tasks/' + taskId);
  assert.equal(httpTask.status, 200);
  assert.ok(Array.isArray(httpTask.value.allowedOps), 'HTTP task reads carry allowedOps');

  const mcpTask = await fullTools.find((tool) => tool.name === 'project_board').run({ view: 'task', taskId, context: hotContext }, {});
  const mcpText = mcpTask.content[0].text;
  assert.doesNotMatch(mcpText, /token \d+/, 'MCP hot read does not leak another session token');
  assert.match(mcpText, /allowed: /);
  const mcpDetail = await fullTools.find((tool) => tool.name === 'project_board').run({ view: 'task_detail', taskId, section: 'operations', context: hotContext }, {});
  assert.doesNotMatch(mcpDetail.content[0].text, /"token"/);
  assert.match(mcpDetail.content[0].text, /Coverage/);

  const unknownTask = await get('/projects/' + projectId + '/tasks/tsk_0000000000000000');
  assert.equal(unknownTask.status, 404);
  assert.equal(JSON.stringify(unknownTask.value).includes('allowedOps'), false, 'an unknown cold task never pretends authorization');
  await assert.rejects(
    tools.get('project_board').execute({ view: 'task', taskId: 'tsk_0000000000000000' }, execB),
    (error) => { const body = JSON.parse(error.message); assert.equal(body.code, 'not-found'); return true; },
  );

  console.log('PASS backend-ingress: cold HTTP/native reads are read-only; scope and writes share one entry');
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const dispose of disposers) { try { dispose(); } catch { /* ignore */ } }
  if (coldService) { try { await coldService.close(); } catch { /* already closed */ } }
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
  for (const extraWs of extraWorkspaces) fs.rmSync(extraWs, { recursive: true, force: true });
}
