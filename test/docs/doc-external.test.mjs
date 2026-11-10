/**
 * 测试职责：约束外置文档登记、管理、确认及读取只操作元数据的完整生命周期。
 * 典型流程：临时文件与项目 → register/update/confirm/relocate/unregister → 比较字节树、版本、状态及缓存。
 * 覆盖边界：覆盖 安全定位、管理状态、绑定和基线语义；不覆盖 UI 视觉或真实 Git 固定对象。
 * 外部前置：链接越界用例依赖 junction/symlink 权限，受限平台可能跳过；其余无外部服务。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectService } from '../../lib/core/service.js';
import { bindWorktree, unbind } from '../../lib/core/identity/ops.js';
import { inspectExternalDoc, listExternalDocs } from '../../lib/core/documents/external-observe.js';
import { normalizeEvidence } from '../../lib/core/evidence.js';

const tmp = (prefix) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')));
const human = (op, extra = {}) => ({ cmdId: 'cmd_' + crypto.randomUUID(), actor: { kind: 'human', via: 'test' }, op, ...extra });
const agent = (op, extra = {}) => ({ cmdId: 'cmd_' + crypto.randomUUID(), actor: { kind: 'agent', sessionId: 's1' }, op, ...extra });
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

function put(root, rel, body) {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

/** Bytes + mtime of every file: proves a command neither created, changed nor removed one. */
function tree(root, base = root, out = {}) {
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (entry.isDirectory()) tree(full, base, out);
    else out[rel] = sha(fs.readFileSync(full)) + '@' + fs.statSync(full).mtimeMs;
  }
  return out;
}

async function setup() {
  const board = tmp('pbx-board');
  const ws = tmp('pbx-ws');
  put(ws, 'docs/spec.md', '# Spec\n\nbody\n');
  put(ws, 'notes.txt', 'plain\n');
  let now = Date.parse('2026-11-02T00:00:00Z');
  const clock = () => new Date(now);
  const svc = new ProjectService({ rootDir: board, clock, privilegedInlineWrites: true });
  await svc.init();
  const h = await svc.createProject({ workspacePath: ws, name: 'ext' });
  const task = await h.command(human('task.create', { title: 'T', acceptance: [{ text: 'a' }] }));
  const taskId = task.events[0].data.id;
  return { board, ws, svc, h, taskId, advance: (ms) => { now += ms; } };
}

async function register(h, extra = {}) {
  const out = await h.command(agent('doc.external.register', { title: 'Spec', relPath: 'docs/spec.md', ...extra }));
  return out.docId;
}

const rejects = (promise, code) => assert.rejects(promise, (e) => { assert.equal(e.code, code, e.message); return true; });

// 责任：登记并重启后 docId/links 须稳定，工作区字节及 blob 目录不得变化。
test('register writes no blob, touches no file and keeps a stable docId and links', async () => {
  const { board, ws, svc, h, taskId } = await setup();
  const blobsDir = path.join(h.meta.dir, 'blobs');
  const blobsBefore = fs.readdirSync(blobsDir);
  const wsBefore = tree(ws);
  const docId = await register(h, { kind: 'spec', links: { taskIds: [taskId] } });
  assert.match(docId, /^doc_/);
  assert.deepEqual(fs.readdirSync(blobsDir), blobsBefore, 'no body blob');
  assert.deepEqual(tree(ws), wsBefore, 'workspace untouched');
  const doc = h.state.docs[docId];
  assert.equal(doc.source, 'external');
  assert.equal(doc.rev, 1);
  assert.equal(doc.status, 'draft');
  assert.deepEqual(doc.locator, { bindingId: svc.bindings().mainOf(h.id).bindingId, relPath: 'docs/spec.md' });
  assert.equal(doc.hash, undefined);
  assert.deepEqual(doc.links.taskIds, [taskId]);
  assert.equal(listExternalDocs(h).docs.length, 1);

  await svc.close();
  const again = new ProjectService({ rootDir: board, privilegedInlineWrites: true });
  await again.init();
  const reopened = await again.open(h.id);
  assert.deepEqual(reopened.state.docs[docId], doc, 'restart projects the same record');
  const view = inspectExternalDoc(reopened, docId);
  assert.equal(view.availability, 'readable');
  assert.equal(view.doc.id, docId);
  await again.close();
});

// 责任：登记越界、绝对路径、目录、缺失文件或未知绑定须拒绝且不产生文档。
test('register refuses unsafe or non-file targets and unknown bindings', async () => {
  const { h } = await setup();
  fs.mkdirSync(path.join(h.workspacePath, 'dir'));
  await rejects(register(h, { relPath: '../outside.md' }), 'security-rejected');
  await rejects(register(h, { relPath: 'C:/x.md' }), 'security-rejected');
  await rejects(register(h, { relPath: 'docs/nope.md' }), 'file-missing');
  await rejects(register(h, { relPath: 'dir' }), 'not-regular');
  await rejects(register(h, { bindingId: 'bnd_unknown' }), 'missing-binding');
  await rejects(register(h, { bindingId: '' }), 'invalid-external-doc');
  await rejects(register(h, { title: ' ' }), 'invalid-command');
  assert.equal(Object.keys(h.state.docs).length, 0);
});

// 责任：反复 inspect 及外部编辑后读取均不得推进项目版本、metaRev 或基线。
test('inspect and reads never advance metaRev, projectRev or the baseline', async () => {
  const { h } = await setup();
  const docId = await register(h);
  const before = structuredClone(h.state.docs[docId]);
  const rev = h.rev;
  for (let i = 0; i < 3; i++) inspectExternalDoc(h, docId, { fresh: true, preview: true });
  fs.appendFileSync(path.join(h.workspacePath, 'docs/spec.md'), 'edit\n');
  inspectExternalDoc(h, docId, { fresh: true });
  assert.equal(h.rev, rev);
  assert.deepEqual(h.state.docs[docId], before);
});

// 责任：缺失/错误 metaRev 须拒绝，同版本并发更新只能一条成功并推进一次版本。
test('metaRev guards every write and two concurrent update_meta let exactly one through', async () => {
  const { h } = await setup();
  const docId = await register(h);
  await rejects(h.command(agent('doc.external.update_meta', { docId, title: 'X' })), 'stale-revision');
  await rejects(h.command(agent('doc.external.update_meta', { docId, expectedMetaRev: 7, title: 'X' })), 'stale-revision');
  const results = await Promise.allSettled([
    h.command(agent('doc.external.update_meta', { docId, expectedMetaRev: 1, title: 'A' })),
    h.command(agent('doc.external.update_meta', { docId, expectedMetaRev: 1, title: 'B' })),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'stale-revision');
  assert.equal(h.state.docs[docId].rev, 2);
  await rejects(h.command(agent('doc.external.update_meta', { docId, expectedMetaRev: 2 })), 'invalid-command');
});

// 责任：状态迁移须遵守 draft/in_review/adopted/archived 边界，归档重开必须提供理由。
test('management transitions follow contract §2.1 and reopening needs a reason', async () => {
  const { h } = await setup();
  const docId = await register(h);
  const step = async (status, extra = {}) => {
    const out = await h.command(human('doc.external.update_meta', { docId, expectedMetaRev: h.state.docs[docId].rev, status, ...extra }));
    return out.events.find((e) => e.type === 'doc/external-updated');
  };
  await rejects(step('adopted'), 'illegal-transition');
  await step('in_review');
  await step('draft');
  await step('in_review');
  await step('adopted');
  await rejects(step('draft'), 'illegal-transition');
  await step('archived');
  await rejects(step('in_review'), 'illegal-transition');
  await rejects(step('draft'), 'invalid-command');
  const event = await step('draft', { reason: 'reopen for v2' });
  assert.deepEqual(event.change.transition, { from: 'archived', to: 'draft', reason: 'reopen for v2' });
  assert.ok(fs.existsSync(path.join(h.workspacePath, 'docs/spec.md')), 'archive never deletes the file');
});

// 责任：confirm 须按最新完整字节校验哈希并记录基线，读间竞态须拒绝。
test('confirm verifies a fresh full read, records the contract baseline and rejects a raced change', async () => {
  const { h } = await setup();
  const docId = await register(h);
  const file = path.join(h.workspacePath, 'docs/spec.md');
  const first = inspectExternalDoc(h, docId);
  assert.equal(first.confirmation.state, 'unconfirmed');
  const hash = first.observation.contentHash;
  assert.equal(hash, sha(fs.readFileSync(file)));

  fs.appendFileSync(file, 'raced\n');
  const rev = h.rev;
  await rejects(h.command(agent('doc.external.confirm', { docId, expectedMetaRev: 1, expectedContentHash: hash })), 'stale-revision');
  assert.equal(h.rev, rev, 'a rejected confirm writes nothing');
  assert.equal(h.state.docs[docId].baseline, null);

  const current = sha(fs.readFileSync(file));
  await h.command(agent('doc.external.confirm', { docId, expectedMetaRev: 1, expectedContentHash: current }));
  const baseline = h.state.docs[docId].baseline;
  assert.deepEqual(Object.keys(baseline).sort(), ['bindingId', 'confirmedAt', 'confirmedBy', 'contentHash', 'domain', 'gitHeadOid', 'readerVersion', 'relPath']);
  assert.equal(baseline.domain, 'workspace-bytes');
  assert.equal(baseline.contentHash, current);
  assert.equal(baseline.relPath, 'docs/spec.md');
  assert.equal(baseline.gitHeadOid, null, 'not a repository');
  assert.equal(inspectExternalDoc(h, docId, { fresh: true }).confirmation.state, 'matches_baseline');

  fs.appendFileSync(file, 'later\n');
  const after = inspectExternalDoc(h, docId, { fresh: true });
  assert.equal(after.confirmation.state, 'changed_since_confirm');
  assert.equal(h.state.docs[docId].baseline.contentHash, current, 'observation never moves the baseline');
  await rejects(h.command(agent('doc.external.confirm', { docId, expectedMetaRev: 2, expectedContentHash: 'abc' })), 'invalid-command');
  fs.rmSync(file);
  await rejects(h.command(agent('doc.external.confirm', { docId, expectedMetaRev: 2, expectedContentHash: current })), 'file-missing');
  assert.equal(inspectExternalDoc(h, docId, { fresh: true }).confirmation.state, 'not_comparable');
});

// 责任：文件不可用时 inspect 仍须保留登记身份、关联与管理状态。
test('unavailable files keep registration, links and status in inspect', async (t) => {
  const { h, taskId } = await setup();
  const ws = h.workspacePath;
  put(ws, 'big.md', 'x');
  put(ws, 'sub/a.md', 'inside\n');
  const big = await register(h, { relPath: 'big.md', links: { taskIds: [taskId] } });
  const linked = await register(h, { relPath: 'sub/a.md' });
  const spec = await register(h);
  fs.writeFileSync(path.join(ws, 'big.md'), Buffer.alloc(16 * 1024 * 1024 + 1, 0x61));
  fs.rmSync(path.join(ws, 'docs/spec.md'));
  const missing = inspectExternalDoc(h, spec);
  assert.equal(missing.availability, 'missing');
  assert.equal(missing.code, 'file-missing');
  assert.equal(missing.doc.title, 'Spec');
  const oversize = inspectExternalDoc(h, big);
  assert.equal(oversize.availability, 'oversize');
  assert.equal(oversize.observation.contentHash, null);
  assert.deepEqual(oversize.doc.links.taskIds, [taskId]);

  const outside = tmp('pbx-outside');
  put(outside, 'a.md', 'outside\n');
  fs.renameSync(path.join(ws, 'sub'), path.join(ws, 'sub-moved'));
  try {
    fs.symlinkSync(outside, path.join(ws, 'sub'), 'junction');
  } catch (error) {
    t.diagnostic('junction unavailable: ' + error.code);
  }
  if (fs.existsSync(path.join(ws, 'sub'))) {
    const escaped = inspectExternalDoc(h, linked, { fresh: true });
    assert.equal(escaped.availability, 'outside_root');
    assert.equal(escaped.code, 'outside-root');
    assert.equal(escaped.git, null, 'git is not run on a rejected path');
  }
});

// 责任：根目录或绑定失效时须分别报 root_unavailable/missing_binding，不能换根读文件。
test('root_unavailable and missing_binding are reported, never read from another root', async () => {
  const { svc, h } = await setup();
  const wt = tmp('pbx-wt');
  put(wt, 'docs/spec.md', 'worktree copy\n');
  const binding = bindWorktree(svc, { projectId: h.id, workspacePath: wt, actor: { kind: 'human' } });
  const docId = await register(h, { bindingId: binding.bindingId });
  const view = inspectExternalDoc(h, docId);
  assert.equal(view.observation.context.bindingId, binding.bindingId);
  assert.equal(view.observation.contentHash, sha('worktree copy\n'));

  const moved = wt + '-gone';
  fs.renameSync(wt, moved);
  assert.equal(inspectExternalDoc(h, docId, { fresh: true }).availability, 'root_unavailable');
  fs.renameSync(moved, wt);

  unbind(svc, { bindingId: binding.bindingId, actor: { kind: 'human' } });
  const gone = inspectExternalDoc(h, docId, { fresh: true });
  assert.equal(gone.availability, 'missing_binding');
  assert.equal(gone.code, 'missing-binding');
  assert.equal(gone.observation.context.root, null, 'no fallback root');
  assert.equal(gone.doc.title, 'Spec');
});

// 责任：会话 cwd 指向另一 worktree 时，文档仍须从登记的绑定根读取。
test('a worktree session cwd never changes the root a doc is read from', async () => {
  const { svc, h } = await setup();
  const wt = tmp('pbx-wt');
  put(wt, 'docs/spec.md', 'other content\n');
  bindWorktree(svc, { projectId: h.id, workspacePath: wt, actor: { kind: 'human' } });
  const docId = await register(h);
  const found = svc.resolveWorkspace(wt);
  assert.equal(found.projectId, h.id);
  const viaWorktree = await svc.openByWorkspace(wt);
  const view = inspectExternalDoc(viaWorktree, docId, { fresh: true });
  assert.equal(view.observation.context.root, svc.bindings().mainOf(h.id).root);
  assert.equal(view.observation.contentHash, sha('# Spec\n\nbody\n'));
});

// 责任：迁移、注销、归档只能变元数据，定位改变后旧确认不得当作当前基线。
test('relocate, unregister and archive move metadata only; relocation needs a new confirmation', async () => {
  const { h } = await setup();
  const ws = h.workspacePath;
  const docId = await register(h);
  const hash = sha(fs.readFileSync(path.join(ws, 'docs/spec.md')));
  await h.command(agent('doc.external.confirm', { docId, expectedMetaRev: 1, expectedContentHash: hash }));
  put(ws, 'moved/spec.md', '# Spec\n\nbody\n');
  const before = tree(ws);
  await rejects(h.command(agent('doc.external.relocate', { docId, expectedMetaRev: 2, relPath: 'docs/spec.md' })), 'invalid-command');
  await rejects(h.command(agent('doc.external.relocate', { docId, expectedMetaRev: 2, relPath: 'moved/none.md' })), 'file-missing');
  await h.command(agent('doc.external.relocate', { docId, expectedMetaRev: 2, relPath: 'moved/spec.md' }));
  const doc = h.state.docs[docId];
  assert.equal(doc.locator.relPath, 'moved/spec.md');
  assert.equal(doc.baseline.relPath, 'docs/spec.md', 'old baseline kept for audit');
  const view = inspectExternalDoc(h, docId);
  assert.equal(view.observation.contentHash, hash, 'same bytes');
  assert.equal(view.confirmation.state, 'not_comparable', 'same bytes still need a confirmation in the new context');
  await h.command(agent('doc.external.confirm', { docId, expectedMetaRev: 3, expectedContentHash: hash }));
  assert.equal(inspectExternalDoc(h, docId).confirmation.state, 'matches_baseline');

  await h.command(human('doc.external.update_meta', { docId, expectedMetaRev: 4, status: 'archived' }));
  await h.command(agent('doc.external.unregister', { docId, expectedMetaRev: 5, reason: 'superseded' }));
  assert.deepEqual(tree(ws), before, 'no file was deleted, moved or rewritten');
  const tomb = h.state.docs[docId];
  assert.equal(tomb.unregistered.reason, 'superseded');
  assert.equal(inspectExternalDoc(h, docId).unregistered, true);
  assert.equal(listExternalDocs(h).docs.length, 0);
  assert.equal(listExternalDocs(h, { includeUnregistered: true }).docs.length, 1);
  await rejects(h.command(agent('doc.external.update_meta', { docId, expectedMetaRev: 6, title: 'Z' })), 'illegal-transition');
});

// 责任：项目搬迁后文档须显示 missing_binding，显式 rebind 才可恢复定位。
test('project relocate leaves docs missing_binding until an explicit rebind', async () => {
  const { svc, h } = await setup();
  const docId = await register(h);
  const hash = sha('# Spec\n\nbody\n');
  await h.command(agent('doc.external.confirm', { docId, expectedMetaRev: 1, expectedContentHash: hash }));
  const oldBinding = h.state.docs[docId].locator.bindingId;
  const next = tmp('pbx-next');
  fs.cpSync(h.workspacePath, next, { recursive: true });
  await h.command(human('project.relocate', { workspacePath: next }));
  const newBinding = svc.bindings().mainOf(h.id).bindingId;
  assert.notEqual(newBinding, oldBinding);
  assert.equal(inspectExternalDoc(h, docId, { fresh: true }).availability, 'missing_binding');

  await rejects(h.command(agent('doc.external.rebind', { fromBindingId: oldBinding, toBindingId: newBinding, expected: { projectRev: h.rev } })), 'forbidden-role');
  await rejects(h.command(human('doc.external.rebind', { fromBindingId: oldBinding, toBindingId: newBinding })), 'invalid-command');
  await rejects(h.command(human('doc.external.rebind', { fromBindingId: oldBinding, toBindingId: oldBinding, expected: { projectRev: h.rev } })), 'missing-binding');
  const out = await h.command(human('doc.external.rebind', { fromBindingId: oldBinding, toBindingId: newBinding, expected: { projectRev: h.rev } }));
  assert.equal(out.matched, 1);
  assert.deepEqual(out.events.filter((e) => e.type === 'doc/external-relocated').map((e) => e.docId), [docId]);
  const view = inspectExternalDoc(h, docId, { fresh: true });
  assert.equal(view.availability, 'readable');
  assert.equal(view.doc.locator.relPath, 'docs/spec.md');
  assert.equal(view.confirmation.state, 'not_comparable');
  const none = await h.command(human('doc.external.rebind', { fromBindingId: oldBinding, toBindingId: newBinding, expected: { projectRev: h.rev } }));
  assert.equal(none.committed, false);
  assert.equal(none.matched, 0);
});

// 责任：对外置记录执行旧 get/put/link 入口须拒绝，不能转成内嵌 body。
test('legacy doc operations refuse to read or change an external record', async () => {
  const { h, taskId } = await setup();
  const docId = await register(h);
  const rev = h.rev;
  await rejects(h.command(agent('doc.put', { docId, baseRev: 1, title: 'x', body: 'y' })), 'external-doc-operation-required');
  await rejects(h.command(agent('doc.link', { docId, links: { taskIds: [taskId] } })), 'external-doc-operation-required');
  assert.throws(() => h.query('doc', { docId }), { code: 'external-doc-operation-required' });
  // External @rev is metadata, not content: the auto shell ignores it and
  // degrades to current-only here (the temp workspace is not a Git repository).
  const externalRow = normalizeEvidence(h, h.state.tasks[taskId], { kind: 'doc', ref: docId + '@1' }, new Date().toISOString(), {});
  assert.equal(externalRow.ref, docId);
  assert.equal(externalRow.fixedState, 'current-only');
  assert.equal(externalRow.fixedReason, 'not-a-repo');
  assert.equal(h.rev, rev);
  const inline = await h.command(agent('doc.put', { title: 'inline', body: 'still works' }));
  assert.equal(inline.committed, true);
  assert.throws(() => inspectExternalDoc(h, inline.events[0].data.id), { code: 'invalid-command' });
});

// 责任：观测缓存最多保留三十秒，confirm 必须绕过缓存读取新内容。
test('observations are cached for at most 30 seconds and confirm never uses the cache', async () => {
  const { h, advance } = await setup();
  const docId = await register(h);
  const file = path.join(h.workspacePath, 'docs/spec.md');
  const first = inspectExternalDoc(h, docId);
  assert.equal(first.observation.cached, false);
  fs.appendFileSync(file, 'new\n');
  const cached = inspectExternalDoc(h, docId);
  assert.equal(cached.observation.cached, true);
  assert.equal(cached.observation.observedAt, first.observation.observedAt);
  await rejects(h.command(agent('doc.external.confirm', { docId, expectedMetaRev: 1, expectedContentHash: cached.observation.contentHash })), 'stale-revision');
  advance(30_000);
  const expired = inspectExternalDoc(h, docId);
  assert.equal(expired.observation.cached, false);
  assert.equal(expired.observation.contentHash, sha(fs.readFileSync(file)));
});
