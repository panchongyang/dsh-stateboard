/**
 * 测试职责：固定内容入口只暴露旧 Git 记录的只读元数据，提交证据不再产生 Git 固定事实。
 * 典型流程：合成旧固定日志 → 注册工具/HTTP → 查询元数据、提交 doc 证据、传坏引用 → 对照响应与日志。
 * 覆盖边界：覆盖 get_fixed 元数据表面、schema、鉴权与开项前拒绝；不覆盖真实网络服务或 DSH 页面。
 * 外部前置：Git 只用于构造合成旧日志；缺 DSH 工具 peer 时用例显式跳过。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import test from 'node:test';
import { ProjectService } from '../../lib/core/service.js';
import { registerRoutes } from '../../lib/host/routes.js';
let registerTools;
try { ({ registerTools } = await import('../../lib/host/tools.js')); }
catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND' || !error.message.includes('@deepseek-ai/')) throw error;
}
import { bootstrapPin, command, repository, temp } from '../helpers/fixed-fixture.mjs';

const LEGACY = { availability: 'legacy-git-record-only', provenance: 'legacy-git', deprecated: true, reverified: false };

async function setup(t) {
  const { root, oid } = repository();
  const service = new ProjectService({ rootDir: temp() });
  await service.init();
  const h = await service.createProject({ workspacePath: root });
  await h.attach({ sessionId: 'fixed-tools', agentId: 'fixed-tools', source: 'test', role: 'worker' });
  const out = await h.command(command('doc.external.register', { title: '历史固定记录', relPath: 'docs/spec.md' }));
  const pin = await bootstrapPin(h, out.docId);
  const runtime = { service, token: 'fixed-token', ready: Promise.resolve(), sessionProjects: new Map() };
  const tools = new Map();
  let handler;
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool); } },
    webServer: { register(route) { handler = route.handler; return () => {}; } },
    on() { return () => {}; }, logger: { error() {} },
    effect(fn) { t.after(fn()); },
  };
  registerTools(ctx, runtime);
  registerRoutes(ctx, runtime);
  const exec = { agent: { id: 'fixed-tools', session: { header: { cwd: root } } }, callId: 'call-fixed' };
  const call = (body, token = runtime.token) => new Promise((resolve) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.method = 'POST';
    req.url = '/project-board/api/projects/' + h.id + '/docs/external/' + out.docId + '/fixed';
    req.headers = { 'x-project-board-token': token };
    const res = { writeHead(status) { this.status = status; this.headersSent = true; }, end(data) { resolve({ status: this.status, value: JSON.parse(data) }); } };
    handler(req, res);
  });
  return { service, h, oid, docId: out.docId, pin, runtime, tools, exec, call };
}

// 责任：工具 get_fixed 只返回已记录的历史身份元数据，不返回正文、不重算、不涨版本。
test('project_doc get_fixed returns deprecated legacy metadata with no body and no revision change', async (t) => {
  if (!registerTools) return t.skip('DSH tool peer is unavailable');
  const s = await setup(t);
  const doc = s.tools.get('project_doc');
  assert.ok(doc.parameters.properties.op.enum.includes('get_fixed'));
  const rev = s.h.rev;
  const value = await doc.execute({ op: 'get_fixed', docId: s.docId, commitOid: s.oid, pathAtCommit: 'docs/spec.md' }, s.exec);
  assert.equal(value.schemaVersion, 1);
  for (const [key, expected] of Object.entries(LEGACY)) assert.equal(value[key], expected, key);
  assert.equal(value.body, null);
  assert.equal(value.truncated, false);
  assert.equal(value.totalBytes, null);
  assert.equal(value.hash, s.pin.fixed.blobContentHash);
  assert.equal(value.hashDomain, 'git-blob-bytes');
  assert.deepEqual(value.fixed, s.pin.fixed);
  assert.match(value.notice, /has not been reverified/);
  assert.equal(s.h.rev, rev, 'a read never advances the log');
  const rendered = doc.output.render({ op: 'get_fixed' }, value)[0].text;
  assert.deepEqual(JSON.parse(rendered), JSON.parse(JSON.stringify(value)), 'the tool renders the same metadata JSON as the value');
  assert.doesNotMatch(rendered, /version one|not evidence/, 'neither the historical body nor the retired notice text is rendered');
  const byRef = await doc.execute({ op: 'get_fixed', docId: s.docId, fixed: s.pin.fixed }, s.exec);
  assert.deepEqual(byRef.fixed, value.fixed);
  await s.service.close();
});

// 责任：提交 doc 证据不再生成 Git 固定事实；证据只记录当前内容观测并停在 review。
test('project_task submits doc evidence without creating Git fixed facts', async (t) => {
  if (!registerTools) return t.skip('DSH tool peer is unavailable');
  const s = await setup(t);
  const task = s.tools.get('project_task');
  const evidenceFields = task.parameters.properties.evidence.items.properties;
  for (const removed of ['fixed', 'fixedConfirmed', 'bindingId', 'workspaceVersion']) {
    assert.equal(Object.hasOwn(evidenceFields, removed), false, 'evidence must not expose ' + removed);
  }
  const created = await task.execute({ op: 'create', title: '历史记录交付', acceptance: [{ text: '当前内容' }] }, s.exec);
  const id = created.task.task.id;
  await task.execute({ op: 'claim', taskId: id, expectedRev: s.h.state.tasks[id].rev }, s.exec);
  const fencingToken = s.h.leases.get(id).token;
  await task.execute({ op: 'begin', taskId: id, expectedRev: s.h.state.tasks[id].rev, fencingToken, summary: '取证' }, s.exec);
  const result = await task.execute({ op: 'submit', taskId: id, expectedRev: s.h.state.tasks[id].rev, fencingToken, evidence: [{ kind: 'doc', ref: s.docId, acceptanceId: s.h.state.tasks[id].acceptance[0].id }] }, s.exec);
  assert.equal(result.result.events.some((event) => event.type === 'doc/content-fixed'), false);
  const row = s.h.state.tasks[id].evidence[0];
  assert.equal(Object.hasOwn(row, 'fixed'), false);
  assert.equal(row.fixedState, 'current-only');
  assert.equal(row.hash, s.pin.fixed.blobContentHash, 'the current bytes still hash to the recorded identity');
  assert.equal(s.h.state.tasks[id].state, 'review');
  await s.service.close();
});

// 责任：HTTP 查询同样只返回元数据且零证据写入；坏鉴权 403、坏引用在冷开前 400、未记录目标 404。
test('HTTP fixed read returns metadata only and rejects bad references before open', async (t) => {
  if (!registerTools) return t.skip('DSH tool peer is unavailable');
  const s = await setup(t);
  const before = fs.readFileSync(s.h.store.commitsFile);
  const fixedBefore = structuredClone(s.h.state.fixedContents);
  const result = await s.call({ schemaVersion: 1, commitOid: s.oid, pathAtCommit: 'docs/spec.md' });
  assert.equal(result.status, 200);
  assert.equal(result.value.schemaVersion, 1);
  assert.equal(result.value.body, null);
  assert.equal(result.value.availability, LEGACY.availability);
  assert.equal((await s.call({ fixed: s.pin.fixed })).status, 200);
  assert.deepEqual(fs.readFileSync(s.h.store.commitsFile), before);
  assert.deepEqual(s.h.state.fixedContents, fixedBefore, 'a fixed read must not register content');
  assert.equal((await s.call({ fixed: s.pin.fixed }, 'wrong-token')).status, 403);
  assert.equal((await s.call({ commitOid: 'a'.repeat(40), pathAtCommit: 'docs/spec.md' })).status, 404, 'unrecorded sources are not inferred');
  let opened = 0;
  const original = s.runtime.service.open;
  s.runtime.service.open = function (...args) { opened++; return original.apply(this, args); };
  for (const body of [
    { fixed: { ...s.pin.fixed, v: 2 } },
    { fixed: { ...s.pin.fixed, bindingId: 'bnd_fake' } },
    { schemaVersion: 2, fixed: s.pin.fixed },
    { fixed: s.pin.fixed, contentHash: 'a'.repeat(64) },
    { fixed: null },
  ]) assert.equal((await s.call(body)).status, 400);
  assert.equal(opened, 0, 'malformed fixed reads never cold-open a project');
  assert.deepEqual(fs.readFileSync(s.h.store.commitsFile), before);
  await s.service.close();
});
