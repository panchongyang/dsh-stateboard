/**
 * 测试职责：保证 Prompt/brief 热路径只读内存，深证据审计隔离运行且不复用过期健康结果。
 * 典型流程：注册真实 Prompt 回调并禁止同步 I/O → 发起深审计/HTTP/修改版本 → 比较响应与诊断。
 * 覆盖边界：覆盖 字面注入、single-flight、事件循环响应与审计失效；不覆盖真实宿主模板全链路或视觉。
 * 外部前置：固定 Git 证据场景需要 Git；HTTP 响应性用例需要回环临时端口。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { ProjectService } from '../../lib/core/service.js';
import { MemoryStore } from '../../lib/core/store.js';
import { createProjectReader } from '../../lib/core/project-reader.js';
import { createApplication } from '../../lib/core/application/index.js';
import { digestFromPublished } from '../../lib/core/projection/views.js';
import { installPrompt } from '../../lib/host/prompt.js';
import { healthRoute } from '../../lib/host/routes/health.js';
import { command, repository, sha, temp } from '../helpers/fixed-fixture.mjs';
import { commitPinnedEvidence, commitTaskEvidence, pinDocEvidence } from '../helpers/prompt-evidence-fixture.mjs';

async function fixture({ fixed = false } = {}) {
  const root = fixed ? repository().root : temp();
  const svc = new ProjectService({
    rootDir: temp(),
    privilegedInlineWrites: true,
    storeFactory: (_dir, meta) => new MemoryStore(meta),
  });
  await svc.init();
  const h = await svc.createProject({ workspacePath: root, name: 'Prompt audit fixture' });
  let taskId, row, gitSource;
  if (fixed) {
    const out = await h.command(command('doc.external.register', { title: 'spec', relPath: 'docs/spec.md' }));
    const created = await h.command(command('task.create', { title: 'material', acceptance: [{ text: 'bytes' }] }));
    taskId = created.events[0].data.id;
    const pinned = pinDocEvidence(h, out.docId);
    row = pinned.row;
    gitSource = pinned.repository;
  } else {
    const out = await h.command(command('task.create', { title: 'material', acceptance: [{ text: 'bytes' }] }));
    taskId = out.events[0].data.id;
    fs.writeFileSync(path.join(root, 'artifact.txt'), 'original');
    row = { id: 'ev_file', kind: 'file', ref: 'artifact.txt', hash: sha('original'), verifiedAt: h.clock().toISOString() };
    commitTaskEvidence(h, taskId, [row]);
  }
  return { svc, h, root, row, taskId, gitSource };
}

function registration(h) {
  let section;
  const runtime = { promptFibers: new Map(), sessionProjects: new Map([['s1', { projectId: h.id }]]), service: h.service, ctx: { logger: { warn() {} } } };
  installPrompt(runtime, { id: 's1', ctx: { inject(_names, fn) {
    fn({ systemPrompt: { section(value) { section = value; return { dispose() {} }; } } });
    return { dispose() {} };
  } } });
  return section;
}

function callback(h) {
  return registration(h).text;
}

// Captures the actual registration object, not a stand-in string renderer.
// 责任：project:brief 注册须 interpolate=false 且保留动态回调，后续任务变化必须反映到文本。
test('project:brief registration declares literal text semantics without freezing the digest', async () => {
  const { svc, h } = await fixture();
  try {
    const section = registration(h);
    assert.equal(section.name, 'project:brief');
    assert.equal(section.interpolate, false, 'board text must reach the host as data, not a template');
    assert.equal(typeof section.text, 'function');
    const first = section.text();
    assert.match(first, /## Project: Prompt audit fixture/);
    assert.match(first.split('\n')[1], /resuming known project work/);
    assert.match(first.split('\n')[1], /project_board view=task/);
    await h.command(command('task.create', { title: 'later title', acceptance: [{ text: 'dynamic' }] }));
    assert.notEqual(section.text(), first, 'the section still reads the live project handle');
  } finally { await svc.close(); }
});

// Captures the actual registration, not a stand-in string renderer. The
// repeated fixed rows are synthetic historical records, not new evidence.
// 责任：同版本重复 fixed 证据的 Prompt/brief 须零同步 Git/fs/blob I/O，并明确 evidence unchecked。
test('registered Prompt and brief do zero sync Git, filesystem or blob I/O at same rev with repeated fixed evidence', async (t) => {
  const { svc, h, row, taskId, gitSource } = await fixture({ fixed: true });
  commitPinnedEvidence(h, taskId, Array.from({ length: 12 }, (_, i) => ({ ...row, id: 'ev_repeat_' + i })), gitSource);
  const text = callback(h);
  let calls = 0;
  const forbidden = () => { calls += 1; throw new Error('hot path I/O'); };
  t.mock.method(childProcess, 'spawnSync', forbidden);
  for (const method of ['readFileSync', 'statSync', 'lstatSync', 'realpathSync', 'openSync', 'readSync', 'existsSync', 'readdirSync']) t.mock.method(fs, method, forbidden);
  t.mock.method(h.store, 'readBlob', forbidden);
  t.mock.method(h, 'health', forbidden);
  t.mock.method(h, 'healthAsync', forbidden);
  syncBuiltinESMExports();
  try {
    const first = text();
    assert.match(first, /evidence unchecked/);
    for (let i = 0; i < 10; i += 1) {
      assert.equal(text(), first);
      assert.equal(h.query('brief').health.ok, false);
      assert.equal(h.query('brief').health.evidenceAudit.status, 'unchecked');
    }
    assert.equal(calls, 0);
    h.closed = true;
    assert.equal(text(), '');
    assert.throws(() => h.digest('s1'), { code: 'closed' });
    h.closed = false;
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await svc.close(); }
});

// 责任：实际文件深审计应保持 single-flight 和独立 HTTP 响应，旧来源警告不能冒充已核验。
test('real file audit and legacy provenance notices remain isolated and single-flight', async () => {
  const { svc, h, root, row, taskId, gitSource } = await fixture({ fixed: true });
  const relative = 'review-sample.txt';
  const bytes = 'deep audit sample\n'.repeat(128 * 1024);
  fs.writeFileSync(path.join(root, relative), bytes);
  const fixedRows = Array.from({ length: 3 }, (_, i) => ({ ...row, id: 'ev_deep_' + i }));
  const fileRows = Array.from({ length: 12 }, (_, i) => ({ id: 'ev_file_deep_' + i, kind: 'file', ref: relative, hash: sha(bytes), verifiedAt: h.clock().toISOString() }));
  commitPinnedEvidence(h, taskId, [...fixedRows, ...fileRows], gitSource);
  const server = http.createServer((_req, res) => res.end('alive'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  let ticks = 0;
  let maxGap = 0;
  let last = Date.now();
  const timer = setInterval(() => { const now = Date.now(); ticks += 1; maxGap = Math.max(maxGap, now - last); last = now; }, 20);
  try {
    const flight = h.healthAsync();
    assert.equal(h.healthAsync(), flight, 'same-revision callers share one flight');
    let audited = false;
    flight.then(() => { audited = true; });
    const before = Date.now();
    const response = await new Promise((resolve, reject) => {
      http.get('http://127.0.0.1:' + port, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
    });
    assert.equal(response, 200);
    assert.ok(Date.now() - before < 750, 'HTTP does not wait for the evidence worker');
    assert.equal(audited, false, 'request completed while deep audit was running');
    const health = await flight;
    assert.equal(health.ok, false, 'historical Git metadata is not newly verified');
    assert.equal(health.evidenceAudit.status, 'complete');
    assert.equal(health.warnings.filter(message => message.includes('legacy-git-not-reverified')).length, fixedRows.length);
    assert.doesNotMatch(health.warnings.join('\n'), /file-drift|file-missing/);
    assert.ok(ticks > 0);
    assert.ok(maxGap < 750, 'timer largest gap ' + maxGap + 'ms');
    assert.equal(h.query('brief').health.evidenceAudit.status, 'unchecked', 'completed deep observations never become live brief health');
    const rev = h.rev;
    fs.writeFileSync(path.join(root, relative), 'changed without a board revision');
    const drifted = await h.healthAsync();
    assert.equal(h.rev, rev);
    assert.equal(drifted.ok, false);
    assert.match(drifted.warnings.join('\n'), /file-drift/);
  } finally { clearInterval(timer); await new Promise((resolve) => server.close(resolve)); await svc.close(); }
});

// 责任：同版本下修改/删除文件及损坏内嵌 blob 后，隔离审计必须重新发现错误而非复用 healthy 缓存。
test('isolated audit detects changed/missing files and corrupt pinned inline bytes with no same-rev result cache', async () => {
  const { svc, h, root, taskId } = await fixture();
  try {
    const rev = h.rev;
    assert.equal((await h.healthAsync()).ok, true);
    fs.writeFileSync(path.join(root, 'artifact.txt'), 'changed');
    const changed = await h.healthAsync();
    assert.equal(h.rev, rev);
    assert.equal(changed.ok, false);
    assert.match(changed.warnings.join('\n'), /file-drift/);
    const missing = { id: 'ev_missing', kind: 'file', ref: 'never-created.txt', hash: sha('original'), verifiedAt: h.clock().toISOString() };
    commitTaskEvidence(h, taskId, [missing]);
    assert.match((await h.healthAsync()).warnings.join('\n'), /file-missing/);
    const first = await h.command(command('doc.put', { title: 'archive', kind: 'note', body: 'historical' }));
    const docId = first.events[0].data.id;
    await h.command(command('doc.put', { docId, baseRev: 1, title: 'archive', kind: 'note', body: 'head' }));
    const hash = sha('historical');
    h.store.blobs.set(hash, 'corrupt bytes');
    commitTaskEvidence(h, taskId, [{ id: 'ev_corrupt', kind: 'doc', ref: docId + '@1', hash }]);
    const corrupt = await h.healthAsync();
    assert.equal(corrupt.ok, false);
    assert.match(corrupt.warnings.join('\n'), /doc-blob-corrupt/);
  } finally { await svc.close(); }
});

// 责任：版本前进、审计过期或 handle 关闭后，旧隔离结果须拒绝不能复用。
test('revision change, expiration and close reject isolated results rather than reusing healthy data', async () => {
  const { svc, h } = await fixture();
  try {
    const stale = h.healthAsync();
    const rejection = assert.rejects(stale, { code: 'audit-stale' });
    await h.command(command('task.create', { title: 'new rev', acceptance: [{ text: 'scope' }] }));
    await rejection;
    await assert.rejects(h.healthAsync({ maxAgeMs: 1 }), { code: 'audit-expired' });
    const closing = h.healthAsync();
    const closed = assert.rejects(closing, { code: 'closed' });
    h.close();
    await closed;
    assert.throws(() => h.healthAsync(), { code: 'closed' });
  } finally { await svc.close(); }
});

// 责任：host health 路由必须 await 隔离 API，不能转调同步深审计。
test('host health route exclusively awaits the isolated API', async () => {
  let body;
  const res = { writeHead(status) { assert.equal(status, 200); }, end(value) { body = JSON.parse(value); } };
  let asyncCalls = 0;
  await healthRoute({}, res, null, null, {
    read(view) {
      assert.equal(view, 'health');
      asyncCalls += 1;
      return Promise.resolve({ ok: false, warnings: ['unobservable'] });
    },
  });
  assert.equal(asyncCalls, 1);
  assert.equal(body.health.ok, false);
});

// 责任：注册的 host health 路由经统一 query 在热、冷两种来源都返回隔离审计结果。
test('registered host health route serves the query port hot and cold', async (t) => {
  const root = temp(t);
  const workspace = temp(t);
  const svc = new ProjectService({ rootDir: path.join(root, 'board') });
  await svc.init();
  const h = await svc.createProject({ workspacePath: workspace, name: 'Route query' });
  fs.writeFileSync(path.join(workspace, 'spec.md'), 'route doc');
  const registered = await h.command(command('doc.external.register', { title: 'Spec', relPath: 'spec.md', kind: 'spec' }));
  const projectId = h.id;
  let reader = createProjectReader(svc);
  const call = async (source) => {
    let body;
    const res = { writeHead(status) { assert.equal(status, 200); }, end(value) { body = JSON.parse(value); } };
    await healthRoute({}, res, null, null, { read: (view, params) => source.query(projectId, view, params, { kind: 'human' }).then((value) => value.health) });
    return body;
  };
  try {
    const application = createApplication({ service: svc, reader });
    const summary = await application.read(projectId, 'summary');
    assert.equal(summary.id, projectId);
    assert.equal(summary.readOnly, false);
    const record = await application.read(projectId, 'doc_record', { docId: registered.docId });
    assert.equal(record.id, registered.docId);
    const hot = await call(reader);
    assert.equal(hot.health.evidenceAudit.status, 'complete');
    await reader.close();
    await svc.close();
    const coldSvc = new ProjectService({ rootDir: path.join(root, 'board') });
    await coldSvc.init();
    reader = createProjectReader(coldSvc);
    const coldApplication = createApplication({ service: coldSvc, reader });
    const coldSummary = await coldApplication.read(projectId, 'summary');
    assert.equal(coldSummary.readOnly, false, 'no writer is not a held read-only lock');
    const coldRecord = await coldApplication.read(projectId, 'doc_record', { docId: registered.docId });
    assert.equal(coldRecord.id, registered.docId);
    const cold = await call(reader);
    assert.equal(cold.health.evidenceAudit.status, 'complete');
    assert.equal(cold.health.seq, h.rev);
    assert.equal(coldSvc.handles.size, 0);
    await reader.close();
    await coldSvc.close();
  } finally {
    try { await reader.close(); } catch { /* already closed */ }
    try { await svc.close(); } catch { /* already closed */ }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// 责任：Prompt 摘要只消费已发布值，不遍历 timeline/commits、不读盘。
test('digestFromPublished reads only the committed tail and never timeline or a live handle', async () => {
  const { svc, h } = await fixture();
  try {
    await h.command(command('session.checkpoint', { actor: { kind: 'agent', sessionId: 's1' }, note: 'checkpoint note' }));
    const published = Object.create(svc.publishedState(h.id));
    Object.defineProperty(published, 'timeline', { get() { throw new Error('timeline must not be read'); } });
    const text = digestFromPublished(published, 's1', {}, h.clock().getTime());
    assert.match(text, /## Project: Prompt audit fixture/);
    assert.match(text, /LAST CHECKPOINT/);
    assert.match(text, /checkpoint note/);
    assert.match(text, /evidence unchecked/);
  } finally { await svc.close(); }
});
