/**
 * 测试职责：保证工具和 HTTP 暴露只读固定字节查询，提交证据仍由系统自动固定。
 * 典型流程：临时 Git 文档 → 注册合成工具/流式 HTTP 路由 → 查询、提交及传入坏引用 → 对照响应和日志。
 * 覆盖边界：覆盖 get_fixed 表面、schema、鉴权与开项前拒绝；不覆盖真实网络服务或 DSH 页面。
 * 外部前置：需要 Git；缺 DSH 工具 peer 时用例显式跳过。
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

async function setup(t) {
  const { root, oid } = repository();
  const service = new ProjectService({ rootDir: temp() });
  await service.init();
  const h = await service.createProject({ workspacePath: root });
  const out = await h.command(command('doc.external.register', { title: '工具固定正文', relPath: 'docs/spec.md' }));
  await bootstrapPin(h, out.docId);
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
  return { service, h, oid, docId: out.docId, runtime, tools, exec, call };
}

// 责任：工具 get_fixed 须返回显式历史字节且不涨版本，task submit 只给 docId 即自动固定并停在 review。
test('project_doc get_fixed reads explicit Git bytes and project_task accepts auto doc evidence', async (t) => {
  if (!registerTools) return t.skip('DSH tool peer is unavailable');
  const s = await setup(t);
  const doc = s.tools.get('project_doc');
  const task = s.tools.get('project_task');
  assert.ok(doc.parameters.properties.op.enum.includes('get_fixed'));
  const evidenceFields = task.parameters.properties.evidence.items.properties;
  for (const removed of ['fixed', 'fixedConfirmed', 'bindingId']) assert.equal(Object.hasOwn(evidenceFields, removed), false, 'evidence must not expose ' + removed);
  const rev = s.h.rev;
  const value = await doc.execute({ op: 'get_fixed', docId: s.docId, commitOid: s.oid, pathAtCommit: 'docs/spec.md' }, s.exec);
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.body, 'version one\n');
  assert.equal(s.h.rev, rev);
  assert.match(doc.output.render({ op: 'get_fixed' }, value)[0].text, /not evidence/);
  const pinned = await doc.execute({ op: 'get_fixed', docId: s.docId, fixed: value.fixed }, s.exec);
  assert.equal(pinned.body, value.body);
  const created = await task.execute({ op: 'create', title: '固定交付', requiresAudit: true, acceptance: [{ text: 'Git 字节' }] }, s.exec);
  const id = created.task.task.id;
  await task.execute({ op: 'claim', taskId: id, expectedRev: s.h.state.tasks[id].rev }, s.exec);
  const fencingToken = s.h.leases.get(id).token;
  await task.execute({ op: 'begin', taskId: id, expectedRev: s.h.state.tasks[id].rev, fencingToken, summary: '取证' }, s.exec);
  const result = await task.execute({ op: 'submit', taskId: id, expectedRev: s.h.state.tasks[id].rev, fencingToken, evidence: [{ kind: 'doc', ref: s.docId, acceptanceId: s.h.state.tasks[id].acceptance[0].id }] }, s.exec);
  assert.ok(result.result.events.some((event) => event.type === 'doc/content-fixed'));
  assert.equal(s.h.state.tasks[id].evidence[0].fixedState, 'pinned');
  assert.equal(s.h.state.tasks[id].state, 'review');
  await s.service.close();
});

// 责任：HTTP fixed 查询须返回 schemaVersion=1 且零证据写入，坏鉴权报 403、坏引用在 open 前报 400。
test('HTTP external/:docId/fixed returns schemaVersion=1 without generating evidence; rejects bad references before open', async (t) => {
  if (!registerTools) return t.skip('DSH tool peer is unavailable');
  const s = await setup(t);
  const before = fs.readFileSync(s.h.store.commitsFile);
  const fixedBefore = structuredClone(s.h.state.fixedContents);
  const result = await s.call({ schemaVersion: 1, commitOid: s.oid, pathAtCommit: 'docs/spec.md' });
  assert.equal(result.status, 200);
  assert.equal(result.value.schemaVersion, 1);
  assert.equal(result.value.body, 'version one\n');
  assert.equal((await s.call({ fixed: result.value.fixed })).status, 200);
  assert.deepEqual(fs.readFileSync(s.h.store.commitsFile), before);
  assert.deepEqual(s.h.state.fixedContents, fixedBefore, 'a fixed read must not register content');
  assert.equal((await s.call({ fixed: result.value.fixed }, 'wrong-token')).status, 403);
  let opened = 0;
  const original = s.runtime.service.open;
  s.runtime.service.open = function (...args) { opened++; return original.apply(this, args); };
  for (const body of [
    { fixed: { ...result.value.fixed, v: 2 } },
    { fixed: { ...result.value.fixed, bindingId: 'bnd_fake' } },
    { schemaVersion: 2, fixed: result.value.fixed },
    { fixed: result.value.fixed, contentHash: 'a'.repeat(64) },
    { fixed: null },
  ]) assert.equal((await s.call(body)).status, 400);
  assert.equal(opened, 0, 'malformed fixed reads never cold-open a project');
  assert.deepEqual(fs.readFileSync(s.h.store.commitsFile), before);
  await s.service.close();
});
