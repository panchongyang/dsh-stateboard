/**
 * 测试职责：维护内嵌文档默认只读归档策略及唯一人工授权开关。
 * 典型流程：临时项目/历史内嵌记录 → 命令或 HTTP 写入 → 比较字节树、权限错误和审计事件。
 * 覆盖边界：覆盖 默认拒写、历史可读、人工 rev 守卫及 fixture 种子入口；不覆盖真实迁移执行或 UI。
 * 外部前置：无；HTTP 使用内存请求流。
 */
// Inline documents are archive-only: every inline write entry (repository
// command, HTTP /commands, agent tool) is fail-closed until a human flips the
// per-project escape hatch. Rejections must leave the log, blobs and state
// untouched; reads must keep working; fixture-only seeding is the sole way to
// mint new inline records.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { ProjectService } from '../../lib/core/service.js';
import { commandsRoute } from '../../lib/host/routes/commands.js';
import { authorizeWebRequest } from '../../lib/host/auth.js';

const { authority: webAuthority } = authorizeWebRequest({ headers: { 'x-project-board-token': 'fixture-token' } }, 'fixture-token');

const human = (op, fields = {}) => ({ op, cmdId: randomUUID(), actor: { kind: 'human', via: 'test' }, ...fields });
const agent = (op, fields = {}) => ({ op, cmdId: randomUUID(), actor: { kind: 'agent', sessionId: 's1' }, ...fields });

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
}

/** Every file under the board root, hashed: a rejected write must not add bytes. */
function tree(root, result = {}, base = root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) tree(full, result, base);
    else {
      result[path.relative(base, full).split(path.sep).join('/')] = fs.readFileSync(full).toString('base64')
        + '@' + fs.statSync(full).mtimeMs;
    }
  }
  return result;
}

async function setup({ privilegedInlineWrites = false } = {}) {
  const root = tmp('pb-inline-policy');
  const ws = path.join(root, 'ws');
  fs.mkdirSync(ws);
  const svc = new ProjectService({ rootDir: path.join(root, 'board'), privilegedInlineWrites });
  await svc.init();
  const h = await svc.createProject({ workspacePath: ws, name: 'inline policy' });
  return { root, ws, svc, h };
}

const rejects = (promise, code) => assert.rejects(promise, (error) => {
  assert.equal(error.code, code, error.message);
  return true;
});

function fakeRequest(body) {
  return Readable.from([Buffer.from(JSON.stringify(body))]);
}

function fakeResponse() {
  const res = {
    status: null,
    body: null,
    headersSent: false,
    writeHead(status) { this.status = status; this.headersSent = true; },
    end(text) { this.body = JSON.parse(text); },
  };
  return res;
}

// 责任：新项目的内存、meta 和 genesis 事件均须明确记录 inlineWritesDisabled=true。
test('new projects start with inline writes disabled in their genesis record', async () => {
  const { h } = await setup();
  assert.equal(h.state.project.inlineWritesDisabled, true);
  const meta = JSON.parse(fs.readFileSync(path.join(h.meta.dir, 'meta.json'), 'utf8'));
  assert.equal(meta.project.inlineWritesDisabled, true);
  assert.equal(h.store.commits[0].events[0].data.inlineWritesDisabled, true);
});

// 责任：默认拒绝新建和编辑内嵌记录，目录字节、提交数量及文档数量须完全不变。
test('default-deny covers create, edit and link with no blob, event or state side effect', async () => {
  const { h, svc } = await setup();
  await h.command(human('task.create', { title: 'T', acceptance: [{ text: 'a' }] }));
  const before = tree(svc.rootDir);
  const events = h.store.commits.length;
  const docs = Object.keys(h.state.docs).length;

  await rejects(h.command(human('doc.put', { title: 'New', body: 'body' })), 'inline-write-disabled');
  await rejects(h.command(human('doc.put', { docId: 'doc_missing', baseRev: 1, title: 'Edit', body: 'body' })), 'inline-write-disabled');

  assert.deepEqual(tree(svc.rootDir), before, 'rejected writes add no files, blobs or log bytes');
  assert.equal(h.store.commits.length, events);
  assert.equal(Object.keys(h.state.docs).length, docs);
});

// 责任：冷开历史内嵌文档后 get/list 须可用，put/link 仍须报 inline-write-disabled。
test('existing inline records stay readable; the sole production write path is the migration tool', async () => {
  const seeded = await setup({ privilegedInlineWrites: true });
  const created = await seeded.h.command(human('doc.put', { title: 'Archive', body: '# archive\n' }));
  const docId = created.events[0].data.id;
  await seeded.svc.close();

  const svc = new ProjectService({ rootDir: path.join(seeded.root, 'board') });
  await svc.init();
  const h = await svc.open(seeded.h.id);
  assert.equal(h.state.docs[docId].rev, 1);
  assert.equal(h.query('doc', { docId }).body, '# archive\n');
  assert.equal(h.query('docs', {}).docs.some((doc) => doc.id === docId), true);
  await rejects(h.command(human('doc.put', { docId, baseRev: 1, title: 'Archive', body: 'changed' })), 'inline-write-disabled');
  await rejects(h.command(human('doc.link', { docId, links: { taskIds: [] } })), 'inline-write-disabled');
  await svc.close();
});

// 责任：仅人工显式授权且项目版本匹配时可开关写屏障，变更必须落 project/updated 审计事件。
test('the per-project escape hatch is human-only, rev-guarded and audited', async () => {
  const { h } = await setup();
  await rejects(h.command(agent('doc.inline_policy', { authorized: true, disabled: false, expected: { projectRev: h.rev } })), 'forbidden-role');
  await rejects(h.command(human('doc.inline_policy', { disabled: false, expected: { projectRev: h.rev } })), 'migration-authorization-required');
  await rejects(h.command(human('doc.inline_policy', { authorized: true, disabled: false })), 'stale-revision');
  await rejects(h.command(human('doc.inline_policy', { authorized: true, disabled: 'no', expected: { projectRev: h.rev } })), 'invalid-command');
  const events = h.store.commits.length;

  await h.command(human('doc.inline_policy', { authorized: true, disabled: false, expected: { projectRev: h.rev } }));
  assert.equal(h.state.project.inlineWritesDisabled, false);
  assert.equal(h.service.peekProject(h.id).inlineWritesDisabled, false, 'admission reads the persisted opt-in');
  const opened = h.store.commits.slice(events).filter((commit) => commit.events.some((event) => event.type === 'project/updated'));
  assert.equal(opened.length, 1, 'opening the fence is a committed project/updated event');
  assert.equal(opened[0].events.find((event) => event.type === 'project/updated').data.inlineWritesDisabled, false);
  assert.equal(opened[0].actor.kind, 'human', 'the commit records who opened the fence');

  const created = await h.command(human('doc.put', { title: 'Allowed', body: 'v1' }));
  const docId = created.events[0].data.id;
  await h.command(human('doc.put', { docId, baseRev: 1, title: 'Allowed', body: 'v2' }));
  await h.command(human('doc.link', { docId, links: { taskIds: [] } }));

  await h.command(human('doc.inline_policy', { authorized: true, disabled: true, expected: { projectRev: h.rev } }));
  assert.equal(h.state.project.inlineWritesDisabled, true);
  assert.equal(h.service.peekProject(h.id).inlineWritesDisabled, true, 'closing the fence is visible to admission');
  await rejects(h.command(human('doc.put', { docId, baseRev: 3, title: 'Allowed', body: 'v3' })), 'inline-write-disabled');
});

// 责任：设置看似启用内嵌写的环境变量后，doc.put 仍须被默认策略拒绝。
test('no environment variable opens the fence', async () => {
  const { h } = await setup();
  const previous = process.env.PROJECT_BOARD_INLINE_WRITES;
  process.env.PROJECT_BOARD_INLINE_WRITES = '1';
  try {
    await rejects(h.command(human('doc.put', { title: 'Env', body: 'x' })), 'inline-write-disabled');
  } finally {
    if (previous === undefined) delete process.env.PROJECT_BOARD_INLINE_WRITES;
    else process.env.PROJECT_BOARD_INLINE_WRITES = previous;
  }
});

// 责任：HTTP 写入口默认须拒绝且不追加事件，人工开屏障后同类请求才可成功。
test('the HTTP command route is fail-closed too', async () => {
  const { h, svc } = await setup();
  const events = h.store.commits.length;
  await assert.rejects(
    commandsRoute(fakeRequest({ op: 'doc.put', title: 'Web', body: 'x' }), fakeResponse(), h.id, svc, webAuthority),
    (error) => { assert.equal(error.code, 'inline-write-disabled'); return true; },
  );
  assert.equal(h.store.commits.length, events);
  // The same route may open the fence after a human policy command.
  await h.command(human('doc.inline_policy', { authorized: true, disabled: false, expected: { projectRev: h.rev } }));
  const res = fakeResponse();
  await commandsRoute(fakeRequest({ op: 'doc.put', title: 123, body: 'x' }), res, h.id, svc, webAuthority);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.result.events.at(-1).data.title, '123');
});

// 责任：准入后若写策略变化，串行命令仍按最新状态拒绝，不会写正文。
test('inline admission is rechecked inside the serial command', async (t) => {
  const { h, svc } = await setup();
  t.after(() => svc.close());
  await h.command(human('doc.inline_policy', { authorized: true, disabled: false, expected: { projectRev: h.rev } }));
  const open = svc.open.bind(svc);
  let before;
  svc.open = async (projectId) => {
    const handle = await open(projectId);
    await h.command(human('doc.inline_policy', { authorized: true, disabled: true, expected: { projectRev: h.rev } }));
    before = tree(svc.rootDir);
    return handle;
  };
  await rejects(svc.command(h.id, human('doc.put', { title: 'Changed policy', body: 'x' })), 'inline-write-disabled');
  assert.ok(before, 'the policy changed after the request passed admission');
  assert.deepEqual(tree(svc.rootDir), before);
});

// 责任：仅 fixture 构造参数启用时可播种内嵌记录，读取须返回原始 synthetic 正文。
test('the fixture-only seeding path still mints inline records for read coverage', async () => {
  const { h } = await setup({ privilegedInlineWrites: true });
  const created = await h.command(human('doc.put', { title: 'Fixture', body: 'synthetic' }));
  assert.equal(created.events[0].type, 'doc/created');
  assert.equal(h.query('doc', { docId: created.events[0].data.id }).body, 'synthetic');
});
