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
import { installPrompt } from '../../lib/host/prompt.js';
import { healthRoute } from '../../lib/host/routes/health.js';
import { bootstrapPin, command, repository, sha, temp } from '../helpers/fixed-fixture.mjs';

async function fixture({ fixed = false } = {}) {
  const root = fixed ? repository().root : temp();
  const svc = new ProjectService({ rootDir: temp(), storeFactory: (_dir, meta) => new MemoryStore(meta) });
  await svc.init();
  const h = await svc.createProject({ workspacePath: root, name: 'Prompt audit fixture' });
  let row;
  if (fixed) {
    const out = await h.command(command('doc.external.register', { title: 'spec', relPath: 'docs/spec.md' }));
    row = await bootstrapPin(h, out.docId);
  } else {
    const out = await h.command(command('task.create', { title: 'material', acceptance: [{ text: 'bytes' }] }));
    row = { id: 'ev_file', kind: 'file', ref: 'artifact.txt', hash: sha('original'), verifiedAt: new Date().toISOString() };
    h.state.tasks[out.events[0].data.id].evidence = [row];
    fs.writeFileSync(path.join(root, 'artifact.txt'), 'original');
  }
  return { svc, h, root, row };
}

function registration(h) {
  let section;
  const runtime = { promptFibers: new Map(), sessionProjects: new Map([['s1', h]]), ctx: { logger: { warn() {} } } };
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
    await h.command(command('task.create', { title: 'later title', acceptance: [{ text: 'dynamic' }] }));
    assert.notEqual(section.text(), first, 'the section still reads the live project handle');
  } finally { await svc.close(); }
});

// Captures the actual registration, not a stand-in string renderer. The fixed
// row comes from normal submit; repetitions are synthetic historical scale.
// 责任：同版本重复 fixed 证据的 Prompt/brief 须零同步 Git/fs/blob I/O，并明确 evidence unchecked。
test('registered Prompt and brief do zero sync Git, filesystem or blob I/O at same rev with repeated fixed evidence', async (t) => {
  const { svc, h, row } = await fixture({ fixed: true });
  const task = Object.values(h.state.tasks)[0];
  task.evidence = Array.from({ length: 12 }, (_, i) => ({ ...row, id: 'ev_repeat_' + i }));
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

// 责任：真实深审计须 single-flight，期间独立定时器和 HTTP 仍能及时响应。
test('real fixed deep audit is single-flight and keeps timer and independent HTTP responsive', async () => {
  const { svc, h, row } = await fixture({ fixed: true });
  Object.values(h.state.tasks)[0].evidence = Array.from({ length: 3 }, (_, i) => ({ ...row, id: 'ev_deep_' + i }));
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
    assert.ok(Date.now() - before < 750, 'HTTP does not wait for serial Git');
    assert.equal(audited, false, 'request completed while deep audit was running');
    const health = await flight;
    assert.equal(health.ok, true, health.warnings.join('\n'));
    assert.equal(health.evidenceAudit.status, 'complete');
    assert.ok(ticks > 2);
    assert.ok(maxGap < 750, 'timer largest gap ' + maxGap + 'ms');
    assert.equal(h.query('brief').health.evidenceAudit.status, 'unchecked', 'completed deep observations never become live brief health');
    Object.values(h.state.tasks)[0].evidence = [{ ...row, fixed: { ...row.fixed, commitOid: 'a'.repeat(40) } }];
    const unavailable = await h.healthAsync();
    assert.equal(unavailable.ok, false, 'unobservable Git objects cannot assert healthy content');
    assert.match(unavailable.warnings.join('\n'), /fixed-object-missing/);
  } finally { clearInterval(timer); await new Promise((resolve) => server.close(resolve)); await svc.close(); }
});

// 责任：同版本下修改/删除文件及损坏内嵌 blob 后，隔离审计必须重新发现错误而非复用 healthy 缓存。
test('isolated audit detects changed/missing files and corrupt pinned inline bytes with no same-rev result cache', async () => {
  const { svc, h, root, row } = await fixture();
  try {
    const rev = h.rev;
    assert.equal((await h.healthAsync()).ok, true);
    fs.writeFileSync(path.join(root, 'artifact.txt'), 'changed');
    const changed = await h.healthAsync();
    assert.equal(h.rev, rev);
    assert.equal(changed.ok, false);
    assert.match(changed.warnings.join('\n'), /file-drift/);
    row.ref = 'never-created.txt';
    assert.match((await h.healthAsync()).warnings.join('\n'), /file-missing/);
    const hash = sha('historical');
    h.state.docs.doc_corrupt = { id: 'doc_corrupt', rev: 2, hash: sha('head'), links: {} };
    h.store.blobs.set(hash, 'corrupt bytes');
    Object.values(h.state.tasks)[0].evidence = [{ id: 'ev_corrupt', kind: 'doc', ref: 'doc_corrupt@1', hash }];
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
    health() { throw new Error('must not run on host'); },
    async healthAsync() { asyncCalls += 1; return { ok: false, warnings: ['unobservable'] }; },
  });
  assert.equal(asyncCalls, 1);
  assert.equal(body.health.ok, false);
});
