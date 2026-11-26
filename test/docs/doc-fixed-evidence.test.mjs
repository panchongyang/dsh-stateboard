/**
 * 测试职责：历史 Git 固定记录只作为 deprecated 来源元数据回放，读取不访问 Git、不返回正文。
 * 典型流程：合成旧固定日志 → 读取元数据与审计 → 改正文/重开/坏引用 → 校验身份不变与拒绝边界。
 * 覆盖边界：覆盖 元数据投影、只读性、结构/跨项目拒绝、内嵌历史与冷重放；不覆盖真实远端或宿主 UI。
 * 外部前置：Git 只用于构造合成旧日志；运行期用例把 Git 执行面替换为直接失败。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { ProjectService } from '../../lib/core/service.js';
import { auditEvidence, evidenceVerified } from '../../lib/core/evidence.js';
import { getFixedContent } from '../../lib/core/documents/fixed-content.js';
import { bootstrapPin, command, put, repository, sha, temp } from '../helpers/fixed-fixture.mjs';

const LEGACY = { availability: 'legacy-git-record-only', provenance: 'legacy-git', deprecated: true, reverified: false };

async function setup({ inline = false } = {}) {
  const { root, oid } = repository();
  const board = temp();
  const svc = new ProjectService({ rootDir: board, privilegedInlineWrites: true });
  await svc.init();
  const h = await svc.createProject({ workspacePath: root, name: '固定证据测试' });
  await h.attach({ sessionId: 'fixed-test', agentId: 'fixed-test', source: 'test', role: 'worker' });
  const out = await h.command(inline
    ? command('doc.put', { title: '旧内嵌', body: 'inline historical body' })
    : command('doc.external.register', { title: '历史固定文档', relPath: 'docs/spec.md' }));
  const docId = out.docId || out.events[0].data.id;
  const pin = inline ? null : await bootstrapPin(h, docId);
  const created = await h.command(command('task.create', { title: '交付文档', acceptance: [{ text: '历史记录' }] }));
  const taskId = created.events[0].data.id;
  return { svc, h, root, oid, board, docId, taskId, pin };
}

function read(s, extra = {}) {
  return getFixedContent(s.h, { docId: s.docId, commitOid: s.oid, pathAtCommit: 'docs/spec.md', ...extra });
}
function legacyFixed(s) {
  return { id: 'ev_legacy', taskId: 'tsk_legacy', kind: 'doc', ref: s.docId, hash: s.pin.fixed.blobContentHash, fixed: structuredClone(s.pin.fixed), verifiedAt: '2025-01-01T00:00:00.000Z' };
}
async function noGit(t, body) {
  for (const name of ['execFileSync', 'execFile', 'spawnSync', 'spawn', 'exec', 'execSync']) {
    t.mock.method(childProcess, name, () => { throw new Error('product runtime must not run Git'); });
  }
  syncBuiltinESMExports();
  try { return await body(); } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
}

// 责任：旧固定记录只投影已存字段，读取不启动 Git、不返回正文、不改原始身份。
test('legacy fixed records project deprecated metadata without running Git or returning a body', async (t) => {
  const s = await setup();
  const value = await noGit(t, () => read(s));
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.body, null);
  assert.equal(value.truncated, false);
  assert.equal(value.totalBytes, null);
  assert.equal(value.hash, s.pin.fixed.blobContentHash);
  assert.equal(value.hashDomain, 'git-blob-bytes');
  assert.deepEqual(value.fixed, s.pin.fixed);
  for (const [key, expected] of Object.entries(LEGACY)) assert.equal(value[key], expected, key);
  assert.match(value.notice, /recorded Git commit\/path\/blob\/format\/hash/i);
  assert.equal(Object.hasOwn(value, 'workspaceComparison'), false, 'no current/Git comparison is attempted');
  assert.equal(Object.keys(s.h.state.fixedContents).length, 1);
  assert.ok(s.h.state.project.gitContentRepository, 'the recorded source replays as data');
  const byRef = await noGit(t, () => getFixedContent(s.h, { docId: s.docId, fixed: value.fixed }));
  assert.deepEqual(byRef.fixed, value.fixed);
  assert.equal(byRef.body, null);
  await s.svc.close();
});

// 责任：调用方不能自报固定事实；拒绝发生在任何字节落盘之前。
test('caller-supplied fixed fields are rejected before any commit', async () => {
  const s = await setup();
  const { h, taskId } = s;
  await h.command(command('task.claim', { taskId, expected: { entityRev: h.state.tasks[taskId].rev } }));
  await h.command(command('task.begin', { taskId, fencingToken: h.leases.get(taskId).token, expected: { entityRev: h.state.tasks[taskId].rev }, summary: '自报固定字段' }));
  const value = read(s);
  const before = h.rev;
  const logBefore = fs.readFileSync(h.store.commitsFile);
  const acceptanceId = h.state.tasks[taskId].acceptance[0].id;
  for (const extra of [{ fixed: value.fixed }, { fixedConfirmed: true }, { bindingId: 'bnd_unused' }, { workspaceVersion: value.fixed }, { fixedState: 'pinned' }]) {
    await assert.rejects(h.command(command('task.submit', {
      taskId, fencingToken: h.leases.get(taskId).token, expected: { entityRev: h.state.tasks[taskId].rev },
      evidence: [{ kind: 'doc', ref: s.docId, acceptanceId, ...extra }],
    })), { code: 'invalid-command', status: 400 });
    assert.equal(h.rev, before);
  }
  assert.deepEqual(fs.readFileSync(h.store.commitsFile), logBefore, 'a rejected submit must write zero bytes');
  await s.svc.close();
});

// 责任：坏结构、外项目身份和未记录目标必须显式拒绝，不能从当前工作区或 Git 对象推断。
test('malformed, foreign and unrecorded fixed references are rejected without inference', async () => {
  const s = await setup();
  const before = structuredClone(s.h.state);
  const tampered = [
    { ...s.pin.fixed, projectId: 'prj_foreign' },
    { ...s.pin.fixed, pathAtCommit: '../unsafe' },
    { ...s.pin.fixed, blobOid: 'a'.repeat(4) },
    { ...s.pin.fixed, v: 2 },
  ];
  for (const bad of tampered) assert.throws(() => read(s, { fixed: bad }), { code: 'invalid-fixed-reference', status: 400 });
  assert.throws(() => read(s, { commitOid: 'a'.repeat(40) }), { code: 'not-found', status: 404 });
  assert.throws(() => read(s, { pathAtCommit: 'docs/other.md' }), { code: 'not-found', status: 404 });
  // A recorded row belongs to its own document and project only.
  const other = await s.svc.createProject({ workspacePath: repository().root, name: '别的项目' });
  assert.ok(other.id !== s.h.id);
  assert.throws(() => getFixedContent(s.h, { docId: 'doc_' + 'a'.repeat(16), commitOid: s.oid, pathAtCommit: 'docs/spec.md' }), { code: 'not-found', status: 404 });
  assert.deepEqual(s.h.state, before, 'rejected reads never mutate state');
  await s.svc.close();
});

// 责任：审计只把旧固定行标为不可复核的 deprecated 来源，不冒充内容匹配或错误。
test('legacy rows audit as deprecated record-only warnings and keep their raw hash', async () => {
  const s = await setup();
  const row = legacyFixed(s);
  const raw = structuredClone(row);
  const warnings = auditEvidence(s.h, { evidence: [row] });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'legacy-git-not-reverified');
  assert.equal(warnings[0].severity, 'warning');
  assert.equal(warnings[0].provenance, 'legacy-git');
  assert.equal(warnings[0].deprecated, true);
  assert.equal(warnings[0].reverified, false);
  assert.match(warnings[0].message, /no content match is asserted/);
  assert.equal(evidenceVerified(s.h, null, row), false);
  assert.deepEqual(row, raw, 'an audit must not rewrite the recorded identity');
  await s.svc.close();
});

// 责任：当前正文编辑、元数据更新与重定位都不改变历史记录，也不制造漂移错误。
test('current edits and metadata updates do not drift legacy records or compare with Git', async () => {
  const s = await setup();
  const row = legacyFixed(s);
  const first = read(s);
  put(s.root, 'docs/spec.md', 'later bytes\n');
  const afterEdit = read(s);
  assert.deepEqual(afterEdit.fixed, first.fixed);
  assert.equal(afterEdit.hash, first.hash);
  assert.equal(Object.hasOwn(afterEdit, 'workspaceComparison'), false);
  assert.deepEqual(auditEvidence(s.h, { evidence: [row] })[0], auditEvidence(s.h, { evidence: [row] })[0]);
  assert.equal(auditEvidence(s.h, { evidence: [row] })[0].severity, 'warning');
  await s.h.command(command('doc.external.update_meta', { docId: s.docId, expectedMetaRev: 1, title: '新标题' }));
  assert.deepEqual(read(s).fixed, first.fixed);
  assert.equal(Object.keys(s.h.state.fixedContents).length, 1);
  await s.svc.close();
});

// 责任：内嵌文档历史 @rev 仍按原字节映射，不产生固定事实。
test('inline docs keep historical docId@rev bytes and never gain fixed facts', async () => {
  const s = await setup({ inline: true });
  const old = s.h.state.docs[s.docId];
  assert.equal(old.hash, sha('inline historical body'));
  await s.h.command(command('doc.put', { docId: s.docId, baseRev: 1, title: '内嵌新版本', body: 'new inline body' }));
  assert.equal(s.h.state.docs[s.docId].hash, sha('new inline body'));
  assert.equal(Object.keys(s.h.state.fixedContents || {}).length, 0);
  await s.svc.close();
});

// 责任：带旧固定行与来源的日志须冷重放、快照并再次打开，全部不需要 Git。
test('a legacy log with fixed rows and a content source replays and snapshots without Git', async (t) => {
  const s = await setup();
  const row = s.pin;
  assert.ok(row.fixed);
  assert.ok(s.h.state.project.gitContentRepository);
  s.h.store.saveSnapshot();
  const projectId = s.h.id;
  const count = Object.keys(s.h.state.fixedContents).length;
  await s.svc.close();
  await noGit(t, async () => {
    const svc = new ProjectService({ rootDir: s.board, privilegedInlineWrites: true });
    await svc.init();
    const h = await svc.open(projectId);
    assert.equal(Object.keys(h.state.fixedContents).length, count);
    assert.ok(h.state.project.gitContentRepository);
    const view = getFixedContent(h, { docId: s.docId, commitOid: s.oid, pathAtCommit: 'docs/spec.md' });
    assert.equal(view.body, null);
    assert.equal(view.hash, row.fixed.blobContentHash);
    assert.equal(auditEvidence(h, { evidence: [legacyFixed({ ...s, h })] })[0].severity, 'warning');
    await svc.close();
  });
});
