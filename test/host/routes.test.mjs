/**
 * 测试职责：验证项目 HTTP API 的成功主流程、鉴权、输入校验与错误状态映射。
 * 典型流程：合成宿主注册路由 → 回环临时端口发送请求 → 比较项目/任务/文档响应、错误与副作用。
 * 覆盖边界：覆盖 路由协议、正文大小与安全边界；不覆盖真实 DSH 服务、TLS 或浏览器页面。
 * 外部前置：需要 DSH peer 可导入及可监听回环临时端口。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../../lib/index.js';
import { ProjectService } from '../../lib/core/service.js';
import { MAX_BODY_BYTES, sendError } from '../../lib/host/util.js';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-routes-state-'));
const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-routes-ws-'));
const tools = new Map();
const disposers = [];
let route = null;
let inject = null;

const fakeWebServer = {
  register(options) {
    route = options;
    return () => {};
  },
};
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  tools: { register(tool) { tools.set(tool.name, tool); } },
  systemPrompt: { section() { return () => {}; }, getSectionOrder() { return 9000; } },
  agents: { list() { return []; } },
  on(event, callback) {
    if (event === 'webserver/index-inject') inject = callback;
    return () => {};
  },
  effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return () => {}; },
  get(name) { return name === 'webServer' ? fakeWebServer : undefined; },
};

let server = null;
try {
  // 分段职责：启动合成路由及全局注入，验证 prefix、token 和回环 HTTP 装配。
  apply(ctx, { rootDir: stateDir });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(route, 'route registered');
  assert.equal(route.kind, 'prefix');
  assert.equal(route.path, '/project-board/api');
  assert.ok(inject, 'index inject registered');
  const table = [];
  inject(table);
  assert.equal(table.length, 1);
  assert.equal(table[0].kind, 'global');
  assert.equal(table[0].name, '__PROJECT_BOARD__');
  const token = table[0].value.token;
  assert.ok(token);

  server = http.createServer((req, res) => route.handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = 'http://127.0.0.1:' + port + '/project-board/api';

  async function call(method, pathname, body) {
    const response = await fetch(baseUrl + pathname, {
      method,
      headers: { 'x-project-board-token': token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json();
    return { status: response.status, value };
  }

  // 分段职责：依次 ping/创建项目/发布计划/读看板与计划，响应须与领域状态一致。
  const ping = await call('GET', '/ping');
  assert.equal(ping.status, 200);
  assert.equal(ping.value.ok, true);

  const created = await call('POST', '/projects', { workspacePath: wsDir, name: 'Route project', actor: { kind: 'system' } });
  assert.equal(created.status, 200);
  assert.equal(created.value.ok, true);
  const projectId = created.value.project.id;

  const list = await call('GET', '/projects');
  assert.equal(list.status, 200);
  assert.ok(list.value.projects.some((project) => project.id === projectId));

  const publish = await call('POST', '/projects/' + projectId + '/commands', {
    cmdId: 'cmd-route-plan',
    actor: { kind: 'agent', sessionId: 'spoofed' },
    op: 'plan.publish',
    title: 'Route plan',
    steps: [{ id: 's1', title: 'one', tasks: [{ key: 't1', title: 'Route task', acceptance: [{ text: 'ok' }] }] }],
  });
  assert.equal(publish.status, 200);
  assert.equal(publish.value.result.ok, true);

  const history = await call('GET', '/projects/' + projectId + '/events');
  for (const type of ['project/created', 'plan/published']) {
    assert.deepEqual(history.value.events.find((event) => event.type === type).actor, { kind: 'human', via: 'web' });
  }

  const board = await call('GET', '/projects/' + projectId + '/board');
  assert.equal(board.status, 200);
  assert.equal(board.value.ok, true);
  assert.equal(board.value.columns.ready.length, 1);
  assert.ok(Array.isArray(board.value.plans));
  assert.ok(board.value.focusPlanId);

  const plans = await call('GET', '/projects/' + projectId + '/plans');
  assert.equal(plans.status, 200);
  assert.equal(plans.value.ok, true);
  assert.equal(plans.value.plans.length, 1);
  assert.equal(plans.value.plans[0].focus, true);
  const planId = plans.value.plans[0].id;

  const current = await call('GET', '/projects/' + projectId + '/plans/current');
  assert.equal(current.status, 200);
  assert.equal(current.value.plan.id, planId);

  const detail = await call('GET', '/projects/' + projectId + '/plans/' + planId);
  assert.equal(detail.status, 200);
  assert.equal(detail.value.plan.id, planId);
  assert.equal(detail.value.head.status, 'active');

  const health = await call('GET', '/projects/' + projectId + '/health');
  assert.equal(health.status, 200);
  assert.equal(health.value.ok, true);

  // 分段职责：缺 token、旧 token、恶意 origin 和 cross-site 请求必须分别被 403 拒绝。
  const unauthorized = await fetch(baseUrl + '/ping');
  assert.equal(unauthorized.status, 403);
  assert.equal((await unauthorized.json()).error.code, 'token-mismatch');
  for (const [extra, code] of [
    [{ 'x-project-board-token': 'old-page-token' }, 'token-mismatch'],
    [{ 'x-project-board-token': token, origin: 'http://evil.example' }, 'origin-rejected'],
    [{ 'x-project-board-token': 'old-page-token', origin: 'http://evil.example' }, 'origin-rejected'],
    [{ 'x-project-board-token': token, 'sec-fetch-site': 'cross-site' }, 'fetch-site-rejected'],
  ]) {
    const rejected = await fetch(baseUrl + '/ping', { headers: extra });
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json()).error.code, code);
  }


  // 分段职责：危险路径编码、非法项目/task id 须在查找前 400，不能拼接出越界目录。
  // --- HTTP boundary cases -------------------------------------------------
  const traversal = await call('GET', '/projects/..%2F..%2Fetc');
  assert.equal(traversal.status, 400, 'a path that decodes to ../.. is not a project id');
  assert.equal(traversal.value.error.code, 'invalid-command');

  const badEncoding = await call('GET', '/projects/%zz');
  assert.equal(badEncoding.status, 400, 'malformed percent-encoding is a bad request');
  assert.equal(badEncoding.value.error.code, 'invalid-path');

  const wrongPrefix = await call('GET', '/projects/tsk_abcdef');
  assert.equal(wrongPrefix.status, 400, 'ids carry their prefix');

  const badTaskId = await call('GET', '/projects/' + projectId + '/tasks/not-an-id');
  assert.equal(badTaskId.status, 400, 'task ids are validated before lookup');

  // 分段职责：坏 JSON/缺 op/未知资源/旧版本须映射准确 400/404/409，当前版本领取可成功。
  // --- error mapping -------------------------------------------------------
  const badJson = await fetch(baseUrl + '/projects/' + projectId + '/commands', {
    method: 'POST',
    headers: { 'x-project-board-token': token, 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(badJson.status, 400, 'a malformed JSON body is a bad request');
  assert.equal((await badJson.json()).error.message, 'request body is not valid JSON');

  const missingOp = await call('POST', '/projects/' + projectId + '/commands', {});
  assert.equal(missingOp.status, 400, 'a command without op is a bad request');
  assert.equal(missingOp.value.error.code, 'invalid-command');

  const noProject = await call('GET', '/projects/prj_0000000000000000');
  assert.equal(noProject.status, 404, 'an unknown project id is a not-found');
  assert.equal(noProject.value.error.code, 'not-found');

  const noRoute = await call('GET', '/projects/' + projectId + '/nope');
  assert.equal(noRoute.status, 404, 'an unknown resource is a not-found');
  assert.match(noRoute.value.error.message, /^Unknown route: /);

  const noTopRoute = await call('GET', '/nope');
  assert.equal(noTopRoute.status, 404, 'an unknown top-level path is a not-found');
  assert.equal(noTopRoute.value.error.message, 'Unknown route.');

  const readyTask = board.value.columns.ready[0];
  assert.ok(readyTask, 'the published task is ready');
  const stale = await call('POST', '/projects/' + projectId + '/commands', {
    op: 'task.claim',
    taskId: readyTask.id,
    expected: { entityRev: readyTask.rev + 50 },
  });
  assert.equal(stale.status, 409, 'a stale expectedRev is a conflict');
  assert.equal(stale.value.error.code, 'stale-revision');

  const claimed = await call('POST', '/projects/' + projectId + '/commands', {
    op: 'task.claim',
    taskId: readyTask.id,
    expected: { entityRev: readyTask.rev },
  });
  assert.equal(claimed.status, 200, 'claim with the current rev succeeds');
  const lease = claimed.value.result.events.find((event) => event.type === 'lease/granted').data;
  assert.ok(Number.isInteger(lease.token));

  const noEvidence = await call('POST', '/projects/' + projectId + '/commands', {
    op: 'task.submit',
    taskId: readyTask.id,
    expected: { entityRev: claimed.value.result.entityRev },
    fencingToken: lease.token,
  });
  assert.equal(noEvidence.status, 422, 'submit without evidence is unprocessable');
  assert.equal(noEvidence.value.error.code, 'missing-evidence');

  // 分段职责：多计划 HTTP 操作须保留 CAS、草案/活动边界及领域错误码。
  // --- plan v2 routes and command error codes (T1) -------------------------
  const draftCreate = await call('POST', '/projects/' + projectId + '/commands', {
    op: 'plan.create',
    title: 'Route draft',
    goal: 'created via HTTP',
    steps: [{ id: 'd1', title: 'draft step', tasks: [{ key: 'k1', title: 'Draft task', acceptance: [{ text: 'ok' }] }] }],
  });
  assert.equal(draftCreate.status, 200);
  const draftId = draftCreate.value.result.events.find((event) => event.type === 'plan/created').data.id;

  const plansTwo = await call('GET', '/projects/' + projectId + '/plans');
  assert.equal(plansTwo.status, 200);
  assert.equal(plansTwo.value.plans.length, 2, '/plans lists active + draft');
  assert.ok(plansTwo.value.plans.some((plan) => plan.id === draftId && plan.status === 'draft'));

  const draftDetail = await call('GET', '/projects/' + projectId + '/plans/' + draftId);
  assert.equal(draftDetail.status, 200);
  assert.equal(draftDetail.value.plan.status, 'draft');
  assert.equal(draftDetail.value.head.status, 'draft');

  const publishActive = await call('POST', '/projects/' + projectId + '/commands', {
    op: 'plan.publish', planId, expected: { entityRev: 2 },
  });
  assert.equal(publishActive.status, 409, 'publishing an active plan is a conflict');
  assert.equal(publishActive.value.error.code, 'plan-not-draft');

  const staleRevise = await call('POST', '/projects/' + projectId + '/commands', {
    op: 'plan.revise', planId, baseVersion: 99,
    steps: [{ id: 's1', title: 'one', tasks: [{ key: 't1', taskId: readyTask.id, title: 'Route task' }] }],
  });
  assert.equal(staleRevise.status, 409, 'a stale baseVersion is a conflict');
  assert.equal(staleRevise.value.error.code, 'stale-revision');
  assert.equal(staleRevise.value.error.details.currentVersion, 1);

  const reviseMissingPlan = await call('POST', '/projects/' + projectId + '/commands', {
    op: 'plan.revise', planId: 'pln_0000000000000000', baseVersion: 1, steps: [{ id: 's1', title: 'x', tasks: [] }],
  });
  assert.equal(reviseMissingPlan.status, 404);
  assert.equal(reviseMissingPlan.value.error.code, 'plan-not-found');

  const adoptBadStep = await call('POST', '/projects/' + projectId + '/commands', {
    op: 'plan.adopt', planId, baseVersion: 1, stepId: 'nope', taskIds: [readyTask.id],
  });
  assert.equal(adoptBadStep.status, 400, 'adopting into a missing step is a bad request');
  assert.equal(adoptBadStep.value.error.code, 'plan-step-not-found');

  const looseCreate = await call('POST', '/projects/' + projectId + '/commands', {
    op: 'task.create', title: 'Loose route task', acceptance: [{ text: 'ok' }],
  });
  assert.equal(looseCreate.status, 200);
  const looseId = looseCreate.value.result.events.find((event) => event.type === 'task/created').taskId;
  const releaseForeign = await call('POST', '/projects/' + projectId + '/commands', {
    op: 'plan.release', planId, baseVersion: 1, taskIds: [looseId],
  });
  assert.equal(releaseForeign.status, 400, 'releasing a non-member task is a bad request');
  assert.equal(releaseForeign.value.error.code, 'invalid-command');

  const publishDraft = await call('POST', '/projects/' + projectId + '/commands', {
    op: 'plan.publish', planId: draftId, expected: { entityRev: 1 },
  });
  assert.equal(publishDraft.status, 200);
  const draftTaskId = publishDraft.value.result.events.find((event) => event.type === 'task/created').taskId;
  assert.ok(draftTaskId, 'publishing the draft creates its task atomically');

  const focusDraft = await call('POST', '/projects/' + projectId + '/commands', { op: 'plan.focus', planId: draftId });
  assert.equal(focusDraft.status, 200, 'the web actor is human and may focus');
  const currentDraft = await call('GET', '/projects/' + projectId + '/plans/current');
  assert.equal(currentDraft.status, 200);
  assert.equal(currentDraft.value.plan.id, draftId, '/plans/current follows the focus');

  const draftClaim = await call('POST', '/projects/' + projectId + '/commands', {
    op: 'task.claim', taskId: draftTaskId, expected: { entityRev: 1 },
  });
  assert.equal(draftClaim.status, 200);
  const archiveLive = await call('POST', '/projects/' + projectId + '/commands', {
    op: 'plan.archive', planId: draftId, expected: { entityRev: 2 },
  });
  assert.equal(archiveLive.status, 409, 'archiving a plan with live work is a conflict');
  assert.equal(archiveLive.value.error.code, 'plan-has-live-work');

  const draftToken = draftClaim.value.result.events.find((event) => event.type === 'lease/granted').data.token;
  const releaseDraftTask = await call('POST', '/projects/' + projectId + '/commands', {
    op: 'task.release', taskId: draftTaskId, expected: { entityRev: draftClaim.value.result.entityRev }, fencingToken: draftToken,
  });
  assert.equal(releaseDraftTask.status, 200);
  const archiveDraft = await call('POST', '/projects/' + projectId + '/commands', {
    op: 'plan.archive', planId: draftId, expected: { entityRev: 2 },
  });
  assert.equal(archiveDraft.status, 200);

  const currentCleared = await call('GET', '/projects/' + projectId + '/plans/current');
  assert.equal(currentCleared.status, 200);
  assert.equal(currentCleared.value.plan, null, 'archiving the focused plan clears /plans/current');

  const archivedDetail = await call('GET', '/projects/' + projectId + '/plans/' + draftId);
  assert.equal(archivedDetail.status, 200);
  assert.equal(archivedDetail.value.head.status, 'archived');
  const plansAll = await call('GET', '/projects/' + projectId + '/plans');
  assert.equal(plansAll.value.plans.length, 2);
  assert.equal(plansAll.value.focusPlanId, null);
  const plansActiveOnly = await call('GET', '/projects/' + projectId + '/plans?includeArchived=0');
  assert.equal(plansActiveOnly.value.plans.length, 1, 'includeArchived=0 hides archived heads');
  assert.ok(plansActiveOnly.value.plans.every((plan) => plan.status !== 'archived'));

  const unarchiveDraft = await call('POST', '/projects/' + projectId + '/commands', {
    op: 'plan.unarchive', planId: draftId, expected: { entityRev: 3 },
  });
  assert.equal(unarchiveDraft.status, 200);

  const unknownPlan = await call('GET', '/projects/' + projectId + '/plans/pln_0000000000000000');
  assert.equal(unknownPlan.status, 200, 'plan detail for an unknown id degrades to plan:null (kept as-is, see PLAN-V2 §5.4 note)');
  assert.equal(unknownPlan.value.plan, null);
  const badPlanPrefix = await call('GET', '/projects/' + projectId + '/plans/tsk_abcdef');
  assert.equal(badPlanPrefix.status, 400, 'plan ids are validated before lookup');
  assert.equal(badPlanPrefix.value.error.code, 'invalid-command');

  // 分段职责：伪造异主机活锁后请求须 503 只读错误，不能抢占对方 writer。
  // 503: a fresh lock from another host makes the handle read-only. The lock
  // file is written directly because a second in-process store would trip the
  // log-busy guard instead of producing a read-only handle.
  const roService = new ProjectService({ rootDir: stateDir });
  await roService.init();
  const roWs = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-routes-ro-ws-'));
  const roHandle = await roService.createProject({ workspacePath: roWs, name: 'Locked project' });
  const roId = roHandle.id;
  await roService.close();
  fs.writeFileSync(path.join(stateDir, 'projects', roId, 'lock.json'), JSON.stringify({
    pid: 424242,
    hostname: 'other-host',
    nonce: 'foreign-writer',
    startedAt: new Date().toISOString(),
    heartbeatAt: Date.now(),
  }));
  const locked = await call('POST', '/projects/' + roId + '/commands', { op: 'session.checkpoint', note: 'x' });
  assert.equal(locked.status, 503, 'a read-only handle answers 503');
  assert.equal(locked.value.error.code, 'read-only');
  fs.rmSync(roWs, { recursive: true, force: true });

  const huge = 'x'.repeat(MAX_BODY_BYTES + 4096);
  const tooBig = await fetch(baseUrl + '/projects/' + projectId + '/commands', {
    method: 'POST',
    headers: { 'x-project-board-token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'ping', pad: huge }),
  });
  assert.equal(tooBig.status, 413, 'an oversized body is answered, not reset');
  const tooBigBody = await tooBig.json();
  assert.equal(tooBigBody.error.message, 'request body too large');

  const fakeRes = {
    headersSent: false,
    writeHead(status) { this.status = status; },
    end(body) { this.body = body; },
  };
  sendError(fakeRes, new Error('ENOENT: open D:\\secret\\vault.txt failed'), { error() {} });
  assert.equal(fakeRes.status, 500);
  const leaked = JSON.parse(fakeRes.body);
  assert.equal(leaked.error.message, 'internal error', 'a 500 body must not leak internals');
  assert.ok(!fakeRes.body.includes('secret'), 'no filesystem path in the body');
  for (const endpoint of ['commands']) {
    for (const op of ['submit', 'reconcile']) {
      for (const kind of ['command', 'test']) {
        const prefix = '/projects/' + projectId;
        const made = await call('POST', prefix + '/commands', { op: 'task.create', title: endpoint + op + kind, acceptance: [{ text: 'material', requiredKinds: [kind] }] });
        const task = made.value.result.events.find((event) => event.type === 'task/created').data;
        const claimed = await call('POST', prefix + '/commands', { op: 'task.claim', taskId: task.id, expected: { entityRev: task.rev } });
        const token = claimed.value.result.events.find((event) => event.type === 'lease/granted').data.token;
        const begun = await call('POST', prefix + '/commands', { op: 'task.begin', taskId: task.id, expected: { entityRev: claimed.value.result.entityRev }, fencingToken: token, summary: 'record only' });
        let rev = begun.value.result.entityRev;
        if (op === 'reconcile') {
          const interrupted = await call('POST', prefix + '/commands', { op: 'task.interrupt', note: 'interrupted for reconciliation', taskId: task.id, expected: { entityRev: rev }, fencingToken: token });
          rev = interrupted.value.result.entityRev;
        }
        const payload = { op: 'task.' + op, taskId: task.id, expected: { entityRev: rev }, fencingToken: token, choice: 'completed', note: 'recorded', evidence: [{ kind, ref: 'node -e "require(\'fs\').writeFileSync(\'http-executed\',\'bad\')"', acceptanceId: task.acceptance[0].id, execution: { executor: 'host', status: 'failed', exitCode: 1 } }] };
        const target = endpoint === 'commands' ? prefix + '/commands' : prefix + '/tasks/' + task.id + '/' + op;
        const submitted = await call('POST', target, payload);
        assert.equal(submitted.status, 200, JSON.stringify(submitted.value));
        const observed = await call('GET', prefix + '/tasks/' + task.id);
        assert.equal(observed.value.task.state, 'review');
        assert.equal(observed.value.task.evidence[0].execution, null);
        assert.equal(fs.existsSync(path.join(wsDir, 'http-executed')), false);

        if (op === 'submit' && kind === 'test') {
          const verified = await call('POST', prefix + '/commands', {
            op: 'task.verify', taskId: task.id, expected: { entityRev: observed.value.task.rev },
            actor: { kind: 'agent', sessionId: 'spoofed' },
          });
          assert.equal(verified.status, 200, 'authorized human verify needs no agent report');
          const event = verified.value.result.events.find((item) => item.type === 'task/verified');
          assert.equal(event.data.state, 'done');
          assert.equal(event.data.lastAudit.by.kind, 'human');
        }
      }
    }
  }
  console.log('PASS routes: ping/create/plan/board/health/auth/boundaries/materials');
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const dispose of disposers) { try { dispose(); } catch { /* ignore */ } }
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(wsDir, { recursive: true, force: true });
}
