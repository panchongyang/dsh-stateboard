/**
 * 测试职责：保证固定证据身份由系统产生，历史对象审计不退回当前文件或异源仓库。
 * 典型流程：本地 Git 文档和任务 → 自动规范化/提交/迁移来源/冷开 → 校验身份、屏障及诊断。
 * 覆盖边界：覆盖 伪造字段拒绝、只读 get_fixed、来源认领与历史兼容；不覆盖真实远端或宿主 UI。
 * 外部前置：需要 Git；缺 Git/超时场景由测试替换执行边界。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { ProjectService } from '../../lib/core/service.js';
import { auditEvidence, evidenceVerified, normalizeEvidence } from '../../lib/core/evidence.js';
import { getFixedContent } from '../../lib/core/documents/fixed-content.js';
import { assertEventSupported } from '../../lib/core/model.js';
import { EVENT_REGISTRY } from '../../lib/shared/events.js';
import { JsonlStore, makeCommit, MemoryStore } from '../../lib/core/store.js';
import { bindWorktree } from '../../lib/core/identity/ops.js';
import { bootstrapPin, command, git, put, repository, sha, temp } from '../helpers/fixed-fixture.mjs';

async function setup({ inline = false } = {}) {
  const { root, oid } = repository();
  const board = temp();
  const svc = new ProjectService({ rootDir: board, privilegedInlineWrites: true });
  await svc.init();
  const h = await svc.createProject({ workspacePath: root, name: '固定证据测试' });
  await h.attach({ sessionId: 'fixed-test', agentId: 'fixed-test', source: 'test', role: 'worker' });
  const out = await h.command(inline
    ? command('doc.put', { title: '旧内嵌', body: 'inline historical body' })
    : command('doc.external.register', { title: '固定文档', relPath: 'docs/spec.md' }));
  const docId = out.docId || out.events[0].data.id;
  if (!inline) await bootstrapPin(h, docId);
  const created = await h.command(command('task.create', { title: '交付文档', acceptance: [{ text: '固定版本' }] }));
  const taskId = created.events[0].data.id;
  return { svc, h, root, oid, board, docId, taskId };
}

function read(s, extra = {}) {
  return getFixedContent(s.h, { docId: s.docId, commitOid: s.oid, pathAtCommit: 'docs/spec.md', ...extra });
}
async function freshProject() {
  const { root, oid } = repository();
  const board = temp();
  const svc = new ProjectService({ rootDir: board, privilegedInlineWrites: true });
  await svc.init();
  const h = await svc.createProject({ workspacePath: root, name: '只读固定测试' });
  await h.attach({ sessionId: 'fixed-read', agentId: 'fixed-read', source: 'test', role: 'worker' });
  const out = await h.command(command('doc.external.register', { title: '只读文档', relPath: 'docs/spec.md' }));
  return { svc, h, root, oid, board, docId: out.docId };
}
function auto(s, extra = {}) {
  return { kind: 'doc', ref: s.docId, ...extra };
}
function legacyFixed(s) {
  const value = read(s);
  return { id: 'ev_legacy', taskId: 'tsk_legacy', kind: 'doc', ref: s.docId, hash: value.fixed.blobContentHash, fixed: value.fixed, verifiedAt: '2025-01-01T00:00:00.000Z' };
}
function normalize(s, value) {
  return normalizeEvidence(s.h, s.h.state.tasks[s.taskId], value, new Date().toISOString(), {});
}
async function submit(s) {
  const { h, taskId } = s;
  await h.command(command('task.claim', { taskId, expected: { entityRev: h.state.tasks[taskId].rev } }));
  await h.command(command('task.begin', { taskId, fencingToken: h.leases.get(taskId).token, expected: { entityRev: h.state.tasks[taskId].rev }, summary: '固定 Git 内容' }));
  return h.command(command('task.submit', { taskId, fencingToken: h.leases.get(taskId).token, expected: { entityRev: h.state.tasks[taskId].rev }, evidence: [auto(s, { acceptanceId: h.state.tasks[taskId].acceptance[0].id })] }));
}
async function moveMain(s, root) {
  const from = s.svc.bindings().mainOf(s.h.id).bindingId;
  await s.h.command(command('project.relocate', { workspacePath: root, expected: { projectRev: s.h.rev } }));
  const to = s.svc.bindings().mainOf(s.h.id).bindingId;
  assert.notEqual(to, from);
  return { from, to };
}
async function rebindDocs(s, from, to) {
  await s.h.command(command('doc.external.rebind', { fromBindingId: from, toBindingId: to, expected: { projectRev: s.h.rev } }));
}

// 责任：自动规范化须固定干净文档，调用方夹带 fixed/confirmed/binding 字段一律报 invalid-command。
test('doc evidence is pinned automatically and rejects caller-supplied fixed fields', async () => {
  const s = await setup();
  const generated = normalize(s, auto(s));
  const view = read(s);
  assert.equal(generated.fixedState, 'pinned');
  assert.equal(generated.hash, sha('version one\n'));
  assert.deepEqual(generated.fixed, view.fixed);
  assert.equal(generated.ref, s.docId);
  assert.equal(evidenceVerified(s.h, null, generated), true);
  for (const explicit of [{ fixed: view.fixed }, { fixedConfirmed: true }, { bindingId: 'bnd_unused' }]) {
    assert.throws(() => normalize(s, { ...auto(s), ...explicit }), {
      code: 'invalid-command', status: 400, message: 'doc evidence is pinned automatically; pass only the docId',
    });
  }
  assert.throws(() => normalize(s, { ...auto(s), fixed: { ...view.fixed, blobOid: 'b'.repeat(40) } }), { code: 'invalid-command', status: 400 });
  put(s.root, 'docs/spec.md', 'changed\n');
  const degraded = normalize(s, auto(s));
  assert.equal(degraded.fixedState, 'current-only');
  assert.equal(degraded.fixedReason, 'dirty-worktree');
  assert.equal(Object.hasOwn(degraded, 'fixed'), false);
  await s.svc.close();
});

// 责任：对 submit 自报固定字段须在提交前拒绝，项目版本和日志字节完全不变。
test('a submit that self-reports fixed fields is rejected before any commit', async () => {
  const s = await setup();
  const { h, taskId } = s;
  await h.command(command('task.claim', { taskId, expected: { entityRev: h.state.tasks[taskId].rev } }));
  await h.command(command('task.begin', { taskId, fencingToken: h.leases.get(taskId).token, expected: { entityRev: h.state.tasks[taskId].rev }, summary: '自报固定字段' }));
  const value = read(s);
  const before = h.rev;
  const logBefore = fs.readFileSync(h.store.commitsFile);
  const acceptanceId = h.state.tasks[taskId].acceptance[0].id;
  for (const extra of [{ fixed: value.fixed }, { fixedConfirmed: true }, { bindingId: 'bnd_unused' }]) {
    await assert.rejects(h.command(command('task.submit', {
      taskId,
      fencingToken: h.leases.get(taskId).token,
      expected: { entityRev: h.state.tasks[taskId].rev },
      evidence: [{ kind: 'doc', ref: s.docId, acceptanceId, ...extra }],
    })), { code: 'invalid-command', status: 400 });
    assert.equal(h.rev, before);
  }
  assert.deepEqual(fs.readFileSync(h.store.commitsFile), logBefore, 'a rejected submit must write zero bytes');
  await s.svc.close();
});

// 责任：审计须区分对象不可用、路径错误和内容身份不匹配，不能把未知当成已证伪。
test('fixed diagnostics separate unavailable objects from proven path and content mismatches', async () => {
  const s = await setup();
  const row = legacyFixed(s);
  const cases = [
    ['fixed-object-missing', { commitOid: 'a'.repeat(40) }, 404],
    ['fixed-path-missing', { pathAtCommit: 'missing.md' }, 404],
    ['fixed-object-mismatch', { blobOid: 'a'.repeat(40) }, 409],
    ['content-hash-mismatch', { blobContentHash: 'a'.repeat(64) }, 409],
  ];
  for (const [code, patch, status] of cases) {
    const changed = { ...row, fixed: { ...row.fixed, ...patch } };
    if (patch.blobContentHash) changed.hash = patch.blobContentHash;
    assert.throws(() => getFixedContent(s.h, { docId: s.docId, fixed: changed.fixed }), { code, status });
    const warning = auditEvidence(s.h, { evidence: [changed] })[0];
    assert.equal(warning.code, code);
    assert.equal(warning.severity, code === 'fixed-object-missing' ? 'warning' : 'error');
    assert.equal(evidenceVerified(s.h, null, changed), false);
  }
  await s.svc.close();
});

// 责任：隐藏 Git 或注入超时后历史 fixed 身份须保留，人工审查操作仍可用。
test('historical fixed rows keep identity when Git is missing or times out; human review remains available', async (t) => {
  const s = await setup();
  await submit(s);
  const before = structuredClone(s.h.state.tasks[s.taskId].evidence[0]);
  const source = structuredClone(s.h.state.project.gitContentRepository);
  let failure = 'ENOENT';
  t.mock.method(childProcess, 'spawnSync', () => ({ error: Object.assign(new Error('unavailable'), { code: failure }) }));
  syncBuiltinESMExports();
  try {
    const warnings = auditEvidence(s.h, s.h.state.tasks[s.taskId]);
    assert.equal(warnings[0].code, 'git-unavailable');
    assert.equal(warnings[0].severity, 'warning');
    assert.match(warnings[0].message, /not observable/);
    assert.equal(evidenceVerified(s.h, null, before), false);
    assert.throws(() => getFixedContent(s.h, { docId: s.docId, fixed: before.fixed }), { code: 'git-unavailable', status: 503 });
    failure = 'ETIMEDOUT';
    assert.equal(auditEvidence(s.h, s.h.state.tasks[s.taskId])[0].severity, 'warning');
    for (const changed of [{ ...before, hash: 'a'.repeat(64) }, { ...before, fixed: { ...before.fixed, projectId: 'prj_foreign' } }, { ...before, fixed: { ...before.fixed, pathAtCommit: '../unsafe' } }]) {
      assert.equal(auditEvidence(s.h, { evidence: [changed] })[0].severity, 'error', 'unavailable Git never relaxes structural or identity safety');
    }
    await s.h.command(command('task.verify', { taskId: s.taskId, expected: { entityRev: s.h.state.tasks[s.taskId].rev } }));
    assert.equal(s.h.state.tasks[s.taskId].state, 'done');
    assert.deepEqual(s.h.state.tasks[s.taskId].evidence[0], before);
    assert.deepEqual(s.h.state.project.gitContentRepository, source);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await s.svc.close(); }
});

// 责任：历史 blob 缺失须标 unavailable，畸形或外项目身份仍必须作为错误拒绝。
test('missing historical blob is unavailable, but malformed and foreign fixed identity remain errors', async () => {
  const s = await setup();
  const row = legacyFixed(s);
  for (const fixed of [{ ...row.fixed, projectId: 'prj_foreign' }, { ...row.fixed, pathAtCommit: '../unsafe' }, { ...row.fixed, blobOid: s.oid }]) {
    const warning = auditEvidence(s.h, { evidence: [{ ...row, fixed }] })[0];
    assert.equal(warning.severity, 'error');
  }
  const hashWarning = auditEvidence(s.h, { evidence: [{ ...row, hash: 'a'.repeat(64) }] })[0];
  assert.equal(hashWarning.severity, 'error');
  assert.equal(hashWarning.code, 'content-hash-mismatch');
  const recorded = structuredClone(row.fixed);
  const blob = path.resolve(s.root, '.git', 'objects', row.fixed.blobOid.slice(0, 2), row.fixed.blobOid.slice(2));
  assert.ok(blob.startsWith(path.resolve(s.root, '.git', 'objects') + path.sep));
  fs.unlinkSync(blob);
  const warning = auditEvidence(s.h, { evidence: [row] })[0];
  assert.equal(warning.code, 'fixed-object-missing');
  assert.equal(warning.severity, 'warning');
  assert.deepEqual(row.fixed, recorded);
  await s.svc.close();
});

// 责任：主来源不可用时审计不得偷偷改用另一已记录 worktree。
test('fixed audit never falls back to another recorded worktree when the main source is unavailable', async (t) => {
  const s = await setup();
  const row = legacyFixed(s);
  const other = temp();
  fs.cpSync(s.root, other, { recursive: true });
  const binding = bindWorktree(s.svc, { projectId: s.h.id, workspacePath: other, actor: { kind: 'human' } });
  const source = structuredClone(s.h.state.project.gitContentRepository);
  s.h.state.project.gitContentRepository.bindingIds = [binding.bindingId];
  const spawn = childProcess.spawnSync;
  const observedRoots = [];
  t.mock.method(childProcess, 'spawnSync', (file, args, options) => {
    observedRoots.push(options.cwd);
    if (options.cwd === s.root) return { status: 128, stdout: Buffer.alloc(0) };
    return spawn(file, args, options);
  });
  syncBuiltinESMExports();
  try {
    const warning = auditEvidence(s.h, { evidence: [row] })[0];
    assert.equal(warning.code, 'unsupported-repository');
    assert.equal(warning.severity, 'warning');
    assert.ok(observedRoots.length > 0);
    assert.equal(observedRoots.includes(other), false, 'another binding is not an implicit observation fallback');
    assert.equal(row.fixed.commitOid, s.oid);
  } finally {
    s.h.state.project.gitContentRepository = source;
    t.mock.restoreAll(); syncBuiltinESMExports(); await s.svc.close();
  }
});

// 责任：get_fixed 读取不得创建证据或涨版本，畸形 fixed 版本须拒绝。
test('get_fixed reads never create evidence, advance revisions or accept malformed fixed versions', async () => {
  const s = await setup();
  const before = structuredClone(s.h.state);
  const first = read(s);
  assert.equal(first.body, 'version one\n');
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.workspaceComparison.state, 'matches_git_bytes');
  getFixedContent(s.h, { docId: s.docId, fixed: first.fixed });
  assert.deepEqual(s.h.state, before);
  for (const fixed of [null, {}, { ...first.fixed, v: 2 }, { ...first.fixed, bindingId: 'bnd_fake' }]) {
    assert.throws(() => getFixedContent(s.h, { docId: s.docId, fixed }), { code: 'invalid-fixed-reference', status: 400 });
  }
  await s.svc.close();
});

// 责任：工作区编辑、元数据更新及分支前进不得漂移历史固定内容，重启须还原同一身份。
test('current edits, metadata updates and branch movement do not drift fixed content; restart replays it', async () => {
  const s = await setup();
  const result = await submit(s);
  assert.ok(result.events.some((e) => e.type === 'doc/content-fixed'));
  const row = structuredClone(s.h.state.tasks[s.taskId].evidence[0]);
  const count = Object.keys(s.h.state.fixedContents).length;
  put(s.root, 'docs/spec.md', 'later bytes\n');
  const changedView = getFixedContent(s.h, { docId: s.docId, fixed: row.fixed });
  assert.equal(changedView.workspaceComparison.state, 'differs_from_git_bytes');
  assert.match(changedView.workspaceComparison.notice, /pinned Git version/);
  await s.h.command(command('doc.external.update_meta', { docId: s.docId, expectedMetaRev: 1, title: '新标题' }));
  assert.deepEqual(auditEvidence(s.h, s.h.state.tasks[s.taskId]), []);
  git(s.root, 'add', 'docs/spec.md');
  git(s.root, 'commit', '-m', '测试后续版本');
  git(s.root, 'branch', 'fixed-test-branch', 'HEAD');
  git(s.root, 'symbolic-ref', 'HEAD', 'refs/heads/fixed-test-branch');
  assert.equal(getFixedContent(s.h, { docId: s.docId, fixed: row.fixed }).body, 'version one\n');
  assert.deepEqual(auditEvidence(s.h, s.h.state.tasks[s.taskId]), []);
  s.h.store.saveSnapshot();
  await s.svc.close();
  const svc = new ProjectService({ rootDir: s.board, privilegedInlineWrites: true });
  await svc.init();
  const h = await svc.open(s.h.id);
  assert.deepEqual(h.state.tasks[s.taskId].evidence[0], row);
  assert.equal(Object.keys(h.state.fixedContents).length, count);
  assert.deepEqual(auditEvidence(h, h.state.tasks[s.taskId]), []);
  await svc.close();
});

// 责任：迁移到同源仓库绑定后可自动认领来源，旧固定字节仍须可读。
test('a same-source binding is adopted automatically and old fixed content stays readable', async () => {
  const s = await setup();
  const old = read(s);
  assert.equal(old.body, 'version one\n');
  await assert.rejects(s.h.command(command('doc.repository.approve', { expected: { projectRev: s.h.rev } })), { code: 'invalid-command' });
  const worktreeRoot = temp();
  fs.cpSync(s.root, worktreeRoot, { recursive: true });
  const worktree = bindWorktree(s.svc, { projectId: s.h.id, workspacePath: worktreeRoot, actor: { kind: 'human' } });
  const recorded = s.h.state.project.gitContentRepository.bindingIds;
  assert.equal(read(s, { bindingId: worktree.bindingId }).body, 'version one\n');
  assert.deepEqual(s.h.state.project.gitContentRepository.bindingIds, recorded, 'a read never appends the binding');
  const clone = temp();
  fs.cpSync(s.root, clone, { recursive: true });
  const { from, to } = await moveMain(s, clone);
  assert.deepEqual(s.h.state.project.gitContentRepository.bindingIds, recorded, 'a read never appends the main binding either');
  // Read-only same-source allowance before the new binding is recorded.
  assert.equal(read(s).body, 'version one\n');
  assert.equal(read(s, { bindingId: to }).body, 'version one\n');
  assert.deepEqual(s.h.state.project.gitContentRepository.bindingIds, [from]);
  await rebindDocs(s, from, to);
  const submission = await submit(s);
  const row = s.h.state.tasks[s.taskId].evidence[0];
  assert.equal(row.fixedState, 'pinned');
  assert.equal(row.hash, sha('version one\n'));
  assert.deepEqual(row.fixed, old.fixed);
  const approval = submission.events.find((event) => event.type === 'project/updated');
  assert.ok(approval, 'the automatic source event rides in the same commit');
  assert.deepEqual(approval.actor, { kind: 'system', reason: 'auto-rebind-git-content-repository' });
  assert.deepEqual(s.h.state.project.gitContentRepository.bindingIds, [from, to]);
  assert.equal(read(s, { bindingId: to }).body, 'version one\n');
  assert.equal(getFixedContent(s.h, { docId: s.docId, fixed: old.fixed, bindingId: to }).body, 'version one\n');
  await s.svc.close();
});

// 责任：迁移到异源仓库后 fixed 读取须拒绝，证据不得自动认领该仓库。
test('a different repository is refused for reads and never adopted by evidence', async () => {
  const s = await setup();
  const foreign = repository();
  put(foreign.root, 'docs/spec.md', 'foreign bytes\n');
  git(foreign.root, 'add', '.');
  git(foreign.root, 'commit', '-m', '无关提交');
  const source = structuredClone(s.h.state.project.gitContentRepository);
  const { from, to } = await moveMain(s, foreign.root);
  assert.throws(() => read(s), { code: 'unsupported-repository' });
  assert.throws(() => read(s, { bindingId: to }), { code: 'unsupported-repository' });
  assert.deepEqual(s.h.state.project.gitContentRepository, source);
  await rebindDocs(s, from, to);
  const submission = await submit(s);
  const row = s.h.state.tasks[s.taskId].evidence[0];
  assert.equal(row.fixedState, 'current-only');
  assert.equal(row.fixedReason, 'multiple-repositories');
  assert.equal(Object.hasOwn(row, 'fixed'), false);
  assert.deepEqual(submission.events.map((event) => event.type).filter((type) => type === 'project/updated'), []);
  assert.deepEqual(s.h.state.project.gitContentRepository, source);
  await s.svc.close();
});

// 责任：新仓库缺少已记锚点时读取和自动认领均须拒绝。
test('a repository missing the recorded anchor is refused and never adopted', async () => {
  const s = await setup();
  const clone = temp();
  fs.cpSync(s.root, clone, { recursive: true });
  const anchor = s.h.state.project.gitContentRepository.anchorCommitOid;
  fs.rmSync(path.join(clone, '.git', 'objects', anchor.slice(0, 2), anchor.slice(2)));
  const source = structuredClone(s.h.state.project.gitContentRepository);
  const { from, to } = await moveMain(s, clone);
  assert.throws(() => read(s), { code: 'unsupported-repository' });
  assert.throws(() => read(s, { bindingId: to }), { code: 'unsupported-repository' });
  await rebindDocs(s, from, to);
  const submission = await submit(s);
  const row = s.h.state.tasks[s.taskId].evidence[0];
  assert.equal(row.fixedState, 'current-only');
  assert.equal(row.fixedReason, 'multiple-repositories');
  assert.equal(Object.hasOwn(row, 'fixed'), false);
  assert.deepEqual(submission.events.map((event) => event.type).filter((type) => type === 'project/updated'), []);
  assert.deepEqual(s.h.state.project.gitContentRepository, source);
  await s.svc.close();
});

// 责任：新项目只读 get_fixed 可返回显式 Git 字节，但不得登记仓库来源。
test('get_fixed reads a brand-new project without recording a source', async () => {
  const s = await freshProject();
  const before = fs.readFileSync(s.h.store.commitsFile);
  const view = getFixedContent(s.h, { docId: s.docId, commitOid: s.oid, pathAtCommit: 'docs/spec.md' });
  assert.equal(view.body, 'version one\n');
  assert.equal(view.hash, sha('version one\n'));
  assert.equal(view.workspaceComparison.state, 'matches_git_bytes');
  assert.equal(s.h.state.project.gitContentRepository, undefined);
  assert.equal(getFixedContent(s.h, { docId: s.docId, fixed: view.fixed }).body, 'version one\n');
  const bindingId = s.svc.bindings().mainOf(s.h.id).bindingId;
  assert.equal(getFixedContent(s.h, { docId: s.docId, commitOid: s.oid, pathAtCommit: 'docs/spec.md', bindingId }).body, 'version one\n');
  assert.equal(s.h.state.project.gitContentRepository, undefined, 'a read must not record a source');
  assert.deepEqual(fs.readFileSync(s.h.store.commitsFile), before, 'a read must not write a commit');
  await s.svc.close();
});

// 责任：无来源只读查询仍须拒绝坏对象和外项目绑定。
test('read-only get_fixed without a source rejects bad objects and foreign bindings', async () => {
  const s = await freshProject();
  const before = fs.readFileSync(s.h.store.commitsFile);
  const view = getFixedContent(s.h, { docId: s.docId, commitOid: s.oid, pathAtCommit: 'docs/spec.md' });
  assert.throws(() => getFixedContent(s.h, { docId: s.docId, commitOid: 'a'.repeat(40), pathAtCommit: 'docs/spec.md' }), { code: 'fixed-object-missing', status: 404 });
  assert.throws(() => getFixedContent(s.h, { docId: s.docId, commitOid: s.oid, pathAtCommit: 'docs/missing.md' }), { code: 'fixed-path-missing', status: 404 });
  assert.throws(() => getFixedContent(s.h, { docId: s.docId, fixed: { ...view.fixed, blobContentHash: 'a'.repeat(64) } }), { code: 'content-hash-mismatch', status: 409 });
  const foreign = await s.svc.createProject({ workspacePath: repository().root, name: '别的项目' });
  const foreignBinding = s.svc.bindings().mainOf(foreign.id).bindingId;
  assert.throws(() => getFixedContent(s.h, { docId: s.docId, commitOid: s.oid, pathAtCommit: 'docs/spec.md', bindingId: foreignBinding }), { code: 'missing-binding', status: 409 });
  assert.equal(s.h.state.project.gitContentRepository, undefined);
  assert.deepEqual(fs.readFileSync(s.h.store.commitsFile), before);
  await s.svc.close();
});

// 责任：内嵌文档历史 @rev 字节须保持原样，不能自动变成 Git 固定证据。
test('inline docs keep their historical docId@rev bytes and are never auto-pinned', async () => {
  const s = await setup({ inline: true });
  const old = normalize(s, { kind: 'doc', ref: s.docId + '@1' });
  assert.equal(old.hash, sha('inline historical body'));
  await s.h.command(command('doc.put', { docId: s.docId, baseRev: 1, title: '内嵌新版本', body: 'new inline body' }));
  assert.deepEqual(auditEvidence(s.h, { evidence: [old] }), []);
  const current = normalize(s, { kind: 'doc', ref: s.docId });
  assert.equal(current.hash, sha('new inline body'));
  assert.equal(Object.hasOwn(current, 'fixed'), false);
  assert.equal(Object.hasOwn(current, 'fixedState'), false);
  await s.svc.close();
});

// 责任：首条 fixed 证据缺同提交屏障时，append 与快照覆盖的重放均须拒绝。
test('first fixed evidence without a matching atomic barrier is rejected on append and snapshot-covered replay', async () => {
  const s = await setup();
  await submit(s);
  const commits = fs.readFileSync(s.h.store.commitsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const last = commits.at(-1);
  const taskEvent = last.events.find((event) => event.type === 'task/submitted');
  const meta = { project: s.h.meta.project };
  const memory = new MemoryStore(meta, structuredClone(commits.slice(0, -1)));
  memory.open();
  const broken = makeCommit(last.seq, last.prev, last.actor, 'cmd_missing_barrier', last.baseRev, [taskEvent]);
  const length = memory.commits.length;
  assert.throws(() => memory.append(broken), { code: 'invalid-fixed-reference' });
  assert.equal(memory.commits.length, length);
  assert.throws(() => new MemoryStore(meta, structuredClone([...commits.slice(0, -1), broken])).open(), { code: 'invalid-fixed-reference' });
  s.h.store.saveSnapshot();
  const dir = s.h.meta.dir;
  await s.svc.close();
  const snapshotFile = path.join(dir, 'snapshot.json');
  const snapshot = JSON.parse(fs.readFileSync(snapshotFile));
  snapshot.hash = broken.hash;
  fs.writeFileSync(snapshotFile, JSON.stringify(snapshot));
  fs.writeFileSync(path.join(dir, 'commits.jsonl'), [...commits.slice(0, -1), broken].map(JSON.stringify).join('\n') + '\n');
  const before = fs.readFileSync(path.join(dir, 'commits.jsonl'));
  assert.throws(() => new JsonlStore(dir, meta, { lock: false }).open(), { code: 'invalid-fixed-reference' });
  assert.deepEqual(fs.readFileSync(path.join(dir, 'commits.jsonl')), before);
});

// 责任：旧注册表不认识 doc/content-fixed 时须拒绝整个固定提交，不得部分应用。
test('old registry without doc/content-fixed rejects the whole fixed-content commit', async () => {
  const s = await setup();
  const result = await submit(s);
  const registry = { ...EVENT_REGISTRY };
  delete registry['doc/content-fixed'];
  const event = result.events.find((e) => e.type === 'doc/content-fixed');
  assert.throws(() => assertEventSupported(s.h.state, event, s.h.store.commits.at(-1), registry), { code: 'incompatible-event', status: 409 });
  await s.svc.close();
});

// 责任：带历史 fixed 行与 gitContentRepository 的旧日志须可重放、审计和生成快照。
test('a legacy log with a historical fixed row and gitContentRepository replays, audits and snapshots', async () => {
  const s = await setup();
  await submit(s);
  const dir = s.h.meta.dir;
  const projectId = s.h.id;
  const taskId = s.taskId;
  const file = s.h.store.commitsFile;
  const commits = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  const last = commits.at(-1);
  const withEvidence = last.events.filter((event) => Array.isArray(event.data?.evidence));
  assert.ok(withEvidence.length > 0);
  // Pre-auto-shell rows carried fixed without the fixedState/fixedReason pair.
  const legacyRow = structuredClone(withEvidence[0].data.evidence[0]);
  delete legacyRow.fixedState;
  legacyRow.id = 'ev_legacy_fixed';
  for (const event of withEvidence) event.data.evidence = [structuredClone(legacyRow)];
  const legacy = makeCommit(last.seq, last.prev, last.actor, last.cmdId, last.baseRev, last.events);
  fs.writeFileSync(file, [...commits.slice(0, -1), legacy].map(JSON.stringify).join('\n') + '\n');
  await s.svc.close();

  const svc = new ProjectService({ rootDir: s.board, privilegedInlineWrites: true });
  await svc.init();
  const h = await svc.open(projectId);
  const row = h.state.tasks[taskId].evidence[0];
  assert.equal(row.id, 'ev_legacy_fixed');
  assert.deepEqual(row.fixed, legacyRow.fixed);
  assert.equal(Object.hasOwn(row, 'fixedState'), false);
  assert.ok(h.state.project.gitContentRepository);
  assert.equal(Object.keys(h.state.fixedContents).length, 1);
  assert.deepEqual(auditEvidence(h, h.state.tasks[taskId]), []);
  h.store.saveSnapshot();
  await svc.close();

  const again = new ProjectService({ rootDir: s.board, privilegedInlineWrites: true });
  await again.init();
  const reopened = await again.open(projectId);
  assert.deepEqual(reopened.state.tasks[taskId].evidence[0], row);
  assert.deepEqual(reopened.state.fixedContents, h.state.fixedContents);
  assert.deepEqual(auditEvidence(reopened, reopened.state.tasks[taskId]), []);
  await again.close();
});
