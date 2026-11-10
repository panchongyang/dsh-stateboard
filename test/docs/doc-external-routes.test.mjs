/**
 * 测试职责：约束外置文档 HTTP 协议、鉴权及拒绝请求不得触发冷开恢复的边界。
 * 典型流程：合成宿主注册路由 → 本机临时 HTTP 端口请求 → 对照状态码、响应和日志字节。
 * 覆盖边界：覆盖 登记/观测/管理路由及早期校验零写入；不覆盖真实 DSH 服务或浏览器视觉。
 * 外部前置：需要 DSH peer 可导入及可监听本机回环临时端口。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../../lib/index.js';
import { ProjectService } from '../../lib/core/service.js';
import { replay } from '../../lib/core/store/format.js';

// HTTP surface for external documents (contract §6.1). A missing workspace file
// stays a 200 inspect result; only auth, unknown docs and store-level failures
// are request failures. Writes are validated before the project is opened, so a
// 400 never runs cold-open recovery.

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-ext-routes-state-'));
const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-ext-routes-ws-'));
const coldWsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-ext-routes-cold-ws-'));
const tools = new Map();
const disposers = [];
let route = null;
let inject = null;
const fakeWebServer = { register(options) { route = options; return () => {}; } };
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

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** Content hash of every project log under the store: rejected writes must not append. */
function logBytes(root, out = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) logBytes(full, out);
    else if (entry.name === 'commits.jsonl') out.push(path.relative(root, full) + ' ' + sha(fs.readFileSync(full)));
  }
  return out.sort().join('|');
}

/** Task state replayed read-only from the log; never opens the project (no recovery). */
function taskStateFromLog(root, taskId) {
  let logFile = null;
  (function find(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) find(full);
      else if (entry.name === 'commits.jsonl' && !logFile) logFile = full;
    }
  })(root);
  const commits = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const { state } = replay({ project: {} }, commits);
  return state.tasks[taskId]?.state ?? null;
}

let server = null;

try {
  // 分段职责：准备冷项目和未开始任务，作为拒绝请求不得触发恢复的对照。
  // A cold project with an in_progress task: opening it runs recovery, which is
  // exactly the side effect a rejected write must not trigger.
  const coldSvc = new ProjectService({ rootDir: stateDir, privilegedInlineWrites: true });
  await coldSvc.init();
  const cold = await coldSvc.createProject({ workspacePath: coldWsDir, name: 'Cold project' });
  const coldTask = await cold.command({
    cmdId: 'cmd-cold-task', actor: { kind: 'human', via: 'test' }, op: 'task.create', title: 'Cold task', acceptance: [{ text: 'x' }],
  });
  const coldTaskId = coldTask.events[0].data.id;
  const coldDoc = await cold.command({
    cmdId: 'cmd-cold-doc', actor: { kind: 'human', via: 'test' }, op: 'doc.put', title: 'Legacy inline', body: 'legacy body',
  });
  const coldDocId = coldDoc.events[0].docId;
  await cold.command({
    cmdId: 'cmd-cold-claim', actor: { kind: 'human', via: 'test' }, op: 'task.claim', taskId: coldTaskId, expected: { entityRev: 1 },
  });
  await coldSvc.close();

  apply(ctx, { rootDir: stateDir });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(route, 'route registered');
  const table = [];
  inject(table);
  const token = table[0].value.token;

  server = http.createServer((req, res) => route.handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + server.address().port + '/project-board/api';

  async function call(method, pathname, body, options = {}) {
    const headers = { 'content-type': 'application/json' };
    if (options.auth !== false) headers['x-project-board-token'] = token;
    const response = await fetch(baseUrl + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json();
    return { status: response.status, value };
  }

  // 分段职责：坏 schema 或拼错字段必须 400，日志和冷任务状态不变。
  // ---- rejected external writes must not cold-open the project ------------
  const coldBase = '/projects/' + cold.id + '/docs';
  const coldLogBefore = logBytes(stateDir);
  for (const [routePath, body] of [
    ['/projects', { workspacePath: coldWsDir }],
    ['/projects/' + cold.id + '/commands', { op: 'project.update', phase: 'paused' }],
    [coldBase + '/external', { title: 'Spec', relPath: 'docs/spec.md' }],
  ]) {
    const response = await call('POST', routePath, { ...body, actor: { kind: 'human', via: 'web' } }, { auth: false });
    assert.equal(response.status, 403);
    assert.equal(response.value.error.code, 'token-mismatch');
  }
  assert.equal(logBytes(stateDir), coldLogBefore, 'spoofed actor does not bypass authentication or trigger recovery');
  assert.equal(fs.existsSync(cold.store.lockFile), false);
  const coldVersion = await call('POST', coldBase + '/external', { schemaVersion: 2, title: 'Future', relPath: 'docs/spec.md' });
  assert.equal(coldVersion.status, 400);
  assert.equal(coldVersion.value.error.code, 'invalid-command');
  const coldField = await call('POST', coldBase + '/external', { title: 'Wrong', relPath: 'docs/spec.md', bindingID: 'bnd_nonexistent' });
  assert.equal(coldField.status, 400);
  assert.equal(coldField.value.error.code, 'invalid-command');
  assert.equal(logBytes(stateDir), coldLogBefore, 'rejected writes never cold-open or append recovery');
  assert.equal(taskStateFromLog(stateDir, coldTaskId), 'in_progress', 'the in_progress task is untouched by rejected writes');

  // 分段职责：默认内嵌写拒绝须在 open 前作出，数字标题、坏形状及坏链接同样零写。
  // An inline write is refused by policy: the verdict is peeked from the
  // persisted record before open, so it must not cold-open/recover either.
  const coldInline = await call('POST', '/projects/' + cold.id + '/commands', { op: 'doc.put', title: 'Blocked', body: 'x' });
  assert.equal(coldInline.status, 409);
  assert.equal(coldInline.value.error.code, 'inline-write-disabled');
  assert.equal(logBytes(stateDir), coldLogBefore, 'inline policy rejection never cold-opens');
  assert.equal(taskStateFromLog(stateDir, coldTaskId), 'in_progress');

  // Core coerces title with String(); the precheck must use the same rule, or a
  // numeric title slips past it and the cold open writes recovery first.
  const coldNumeric = await call('POST', '/projects/' + cold.id + '/commands', { op: 'doc.put', title: 123, body: 'x' });
  assert.equal(coldNumeric.status, 409);
  assert.equal(coldNumeric.value.error.code, 'inline-write-disabled');
  assert.equal(logBytes(stateDir), coldLogBefore, 'numeric-title rejection also stays zero-write');
  assert.equal(taskStateFromLog(stateDir, coldTaskId), 'in_progress');

  // Malformed shape is the core's 400, now also decided before the open.
  const coldShape = await call('POST', '/projects/' + cold.id + '/commands', { op: 'doc.put', title: 'No body' });
  assert.equal(coldShape.status, 400);
  assert.equal(coldShape.value.error.code, 'invalid-command');
  assert.equal(logBytes(stateDir), coldLogBefore, 'shape rejection never cold-opens');
  assert.equal(taskStateFromLog(stateDir, coldTaskId), 'in_progress');

  // Core normalizes links before the policy check; a bad link is its own 400.
  const coldLinks = await call('POST', '/projects/' + cold.id + '/commands', { op: 'doc.put', title: 'Bad links', body: 'x', links: { taskIds: ['tsk_missing'] } });
  assert.equal(coldLinks.status, 400);
  assert.equal(coldLinks.value.error.code, 'invalid-command');
  assert.equal(logBytes(stateDir), coldLogBefore, 'link-shape rejection never cold-opens');
  assert.equal(taskStateFromLog(stateDir, coldTaskId), 'in_progress');

  // 分段职责：合法读取作为对照须真正冷开恢复，让零写断言不因测试失效而误绿。
  // Control: a valid request still opens the cold project and runs recovery.
  const coldList = await call('GET', coldBase);
  assert.equal(coldList.status, 200);
  assert.notEqual(logBytes(stateDir), coldLogBefore, 'a valid open still runs recovery (log grew)');
  const coldBoard = await call('GET', '/projects/' + cold.id + '/board');
  assert.equal(coldBoard.value.columns.in_progress.length, 0, 'recovery moved the task out of in_progress');
  assert.ok(coldBoard.value.columns.ready.some((task) => task.id === coldTaskId), 'recovery readied the task');

  const created = await call('POST', '/projects', { workspacePath: wsDir, name: 'External routes' });
  const projectId = created.value.project.id;
  const docsBase = '/projects/' + projectId + '/docs';
  const file = path.join(wsDir, 'docs', 'spec.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# Spec\n\nbody\n');

  // 分段职责：登记/列表/inspect 须返回 schema1 和真实观测，外置行不能伪造 body hash/size。
  // ---- register + list + inspect -----------------------------------------
  const registered = await call('POST', docsBase + '/external', { title: 'Spec', kind: 'spec', relPath: 'docs/spec.md' });
  assert.equal(registered.status, 200);
  assert.equal(registered.value.ok, true);
  assert.equal(registered.value.schemaVersion, 1);
  const docId = registered.value.doc.id;
  assert.equal(registered.value.doc.source, 'external');
  assert.equal(registered.value.doc.hash, undefined);
  assert.equal(registered.value.doc.size, undefined);

  const listed = await call('GET', docsBase + '/external');
  assert.equal(listed.status, 200);
  assert.equal(listed.value.schemaVersion, 1);
  assert.deepEqual(listed.value.docs.map((doc) => doc.id), [docId]);

  const inspected = await call('GET', docsBase + '/external/' + docId + '?fresh=1&preview=1');
  assert.equal(inspected.status, 200);
  assert.equal(inspected.value.ok, true);
  assert.equal(inspected.value.schemaVersion, 1);
  assert.equal(inspected.value.metaRev, 1);
  assert.equal(inspected.value.availability, 'readable');
  assert.equal(inspected.value.code, null);
  assert.equal(inspected.value.observation.contentHash, sha(fs.readFileSync(file)));
  assert.equal(inspected.value.observation.cached, false);
  assert.ok(inspected.value.observation.preview.text.includes('# Spec'));
  assert.equal(inspected.value.confirmation.state, 'unconfirmed');

  // The old inline endpoint does not parse external bodies.
  const oldRead = await call('GET', docsBase + '/' + docId);
  assert.equal(oldRead.status, 409);
  assert.equal(oldRead.value.error.code, 'external-doc-operation-required');

  // The inline list still shows the row, with its source and without a body hash.
  const inlineList = await call('GET', docsBase);
  const row = inlineList.value.docs.find((doc) => doc.id === docId);
  assert.equal(row.source, 'external');
  assert.equal(row.hash, undefined);
  assert.equal(row.size, undefined);

  // 分段职责：未知/跨域字段及非对象 body 须在 open 前 400，不改变元数据。
  // ---- strict write whitelist: unknown/cross-domain fields are 400 and the
  // ---- body must be a JSON object (all checks before service.open) ---------
  const logBeforeFields = logBytes(stateDir);
  const revBeforeFields = (await call('GET', '/projects/' + projectId)).value.project.rev;
  const badWrites = [
    ['register misspelled bindingId', 'POST', docsBase + '/external', { title: 'Wrong binding', relPath: 'docs/spec.md', bindingID: 'bnd_nonexistent' }, 'bindingID'],
    ['register cross-domain status', 'POST', docsBase + '/external', { title: 'Wrong status', relPath: 'docs/spec.md', status: 'archived' }, 'status'],
    ['update_meta misspelled status', 'PATCH', docsBase + '/external/' + docId, { expectedMetaRev: 1, statuss: 'archived' }, 'statuss'],
    ['relocate cross-domain hash', 'POST', docsBase + '/external/' + docId + '/relocate', { expectedMetaRev: 1, expectedContentHash: '0'.repeat(64) }, 'expectedContentHash'],
    ['confirm cross-domain title', 'POST', docsBase + '/external/' + docId + '/confirm', { expectedMetaRev: 1, expectedContentHash: '0'.repeat(64), title: 'x' }, 'title'],
    ['unregister cross-domain binding', 'POST', docsBase + '/external/' + docId + '/unregister', { expectedMetaRev: 1, bindingId: 'bnd_nonexistent' }, 'bindingId'],
    ['body docId contradicts the URL', 'PATCH', docsBase + '/external/' + docId, { docId: 'doc_other', expectedMetaRev: 1, title: 'x' }, null],
    ['JSON null body', 'POST', docsBase + '/external', null, null],
    ['JSON array body', 'POST', docsBase + '/external', [], null],
  ];
  for (const [label, method, pathname, body, field] of badWrites) {
    const result = await call(method, pathname, body);
    assert.equal(result.status, 400, label + ': ' + JSON.stringify(result.value));
    assert.equal(result.value.error.code, 'invalid-command', label);
    if (field) assert.ok((result.value.error.details?.fields || []).includes(field), label + ' names the offending field');
  }
  assert.equal((await call('GET', '/projects/' + projectId)).value.project.rev, revBeforeFields, 'rejected writes never bump the project rev');
  assert.equal(logBytes(stateDir), logBeforeFields, 'rejected writes never append to the project log');
  assert.equal((await call('GET', docsBase + '/external')).value.docs[0].rev, 1, 'rejected writes never move metaRev');

  // 分段职责：更新、定位、确认、注销按 metaRev 前进，旧文件不得被管理操作修改。
  // ---- metadata, relocate, confirm, unregister ---------------------------
  const patched = await call('PATCH', docsBase + '/external/' + docId, { expectedMetaRev: 1, title: 'Spec renamed', status: 'in_review' });
  assert.equal(patched.status, 200, JSON.stringify(patched.value));
  assert.equal(patched.value.schemaVersion, 1);
  assert.equal(patched.value.doc.rev, 2);
  assert.equal(patched.value.doc.title, 'Spec renamed');

  const stalePatch = await call('PATCH', docsBase + '/external/' + docId, { expectedMetaRev: 1, title: 'Again' });
  assert.equal(stalePatch.status, 409);
  assert.equal(stalePatch.value.error.code, 'stale-revision');

  const renamed = path.join(wsDir, 'docs', 'spec-v2.md');
  fs.renameSync(file, renamed);
  const relocated = await call('POST', docsBase + '/external/' + docId + '/relocate', { expectedMetaRev: 2, relPath: 'docs/spec-v2.md' });
  assert.equal(relocated.status, 200);
  assert.equal(relocated.value.doc.rev, 3);
  assert.equal(relocated.value.doc.locator.relPath, 'docs/spec-v2.md');
  assert.equal(fs.existsSync(renamed), true, 'relocate never moves the file');

  const staleConfirm = await call('POST', docsBase + '/external/' + docId + '/confirm', { expectedMetaRev: 3, expectedContentHash: '0'.repeat(64) });
  assert.equal(staleConfirm.status, 409);
  assert.equal(staleConfirm.value.error.code, 'stale-revision');
  assert.equal(staleConfirm.value.error.details.currentContentHash, sha(fs.readFileSync(renamed)));

  const confirmed = await call('POST', docsBase + '/external/' + docId + '/confirm', { expectedMetaRev: 3, expectedContentHash: sha(fs.readFileSync(renamed)) });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.value.doc.rev, 4);
  assert.equal(confirmed.value.doc.baselineInContext, true);

  const history = await call('GET', '/projects/' + projectId + '/events');
  for (const type of ['doc/external-registered', 'doc/external-updated', 'doc/external-relocated', 'doc/external-confirmed']) {
    assert.deepEqual(history.value.events.find((event) => event.type === type).actor, { kind: 'human', via: 'web' });
  }

  // 分段职责：登记文件消失仍须是 200 inspect 结果，保留身份而非变 HTTP 失败。
  // A registered file that disappears is an inspect result, not an HTTP failure.
  fs.rmSync(renamed);
  const unavailable = await call('GET', docsBase + '/external/' + docId + '?fresh=1');
  assert.equal(unavailable.status, 200);
  assert.equal(unavailable.value.availability, 'missing', 'reader availability enum');
  assert.equal(unavailable.value.code, 'file-missing', 'contract §6.2 code');
  assert.equal(unavailable.value.doc.id, docId, 'registration survives an unavailable file');
  fs.writeFileSync(renamed, '# Spec\n\nbody\n');

  const tomb = await call('POST', docsBase + '/external/' + docId + '/unregister', { expectedMetaRev: 4, reason: 'done' });
  assert.equal(tomb.status, 200);
  assert.equal(tomb.value.doc.rev, 5);
  assert.ok(tomb.value.doc.unregistered.at);
  assert.equal((await call('GET', docsBase + '/external')).value.docs.length, 0);
  assert.equal((await call('GET', docsBase + '/external?includeUnregistered=1')).value.docs.length, 1);

  const afterTomb = await call('POST', docsBase + '/external/' + docId + '/unregister', { expectedMetaRev: 5 });
  assert.equal(afterTomb.status, 409);
  assert.equal(afterTomb.value.error.code, 'illegal-transition');

  // 分段职责：写请求未知 schema 必须拒绝，读取不受写版本门误阻。
  // ---- schema version gate is write-only and rejects before any write -----
  const badVersion = await call('POST', docsBase + '/external', { schemaVersion: 2, title: 'Future', relPath: 'docs/spec-v2.md' });
  assert.equal(badVersion.status, 400);
  assert.equal(badVersion.value.error.code, 'invalid-command');
  assert.match(badVersion.value.error.message, /schemaVersion/);
  const badPatch = await call('PATCH', docsBase + '/external/' + docId, { schemaVersion: 2, expectedMetaRev: 5, title: 'Future' });
  assert.equal(badPatch.status, 400);
  const unchanged = await call('GET', docsBase);
  assert.equal(unchanged.value.docs.length, 1, 'a rejected future-version write changed nothing: ' + JSON.stringify(unchanged.value.docs));
  assert.equal(unchanged.value.docs.find((doc) => doc.id === docId).rev, 5);

  // 分段职责：坏鉴权、未知文档和 store 故障仍须映射真正 HTTP 错误。
  // ---- real failures stay failures ---------------------------------------
  const unknown = await call('GET', docsBase + '/external/doc_doesnotexist');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.value.error.code, 'not-found');
  const unknownAction = await call('POST', docsBase + '/external/' + docId + '/bogus', {});
  assert.equal(unknownAction.status, 404);

  const inline = await call('POST', '/projects/' + projectId + '/commands', { cmdId: 'cmd-inline-route', op: 'doc.put', title: 'Inline', kind: 'note', body: 'inline body' });
  assert.equal(inline.status, 409);
  assert.equal(inline.value.error.code, 'inline-write-disabled');
  const inspectInline = await call('GET', '/projects/' + cold.id + '/docs/external/' + coldDocId);
  assert.equal(inspectInline.status, 400);
  assert.equal(inspectInline.value.error.code, 'invalid-command');

  const unauthorized = await call('GET', docsBase + '/external', undefined, { auth: false });
  assert.equal(unauthorized.status, 403);

  console.log('PASS doc-external-routes: register/list/inspect/PATCH/relocate/confirm/unregister + schemaVersion + old-endpoint 409');
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const dispose of disposers) { try { dispose(); } catch { /* ignore */ } }
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(wsDir, { recursive: true, force: true });
  fs.rmSync(coldWsDir, { recursive: true, force: true });
}
