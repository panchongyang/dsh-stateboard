/**
 * 测试职责：验证文档确认、证据留存和旧 Git 来源回放不调用 Git。
 * 典型流程：创建合成工作区与文档 → 真实写入或追加旧记录 → 回读、审计与校验日志。
 * 覆盖边界：覆盖 留存原子关系、复制/冷回放和拒绝分支；不覆盖 真实数据。
 * 外部前置：无 Git 运行时依赖；所有磁盘对象都位于隔离的合成工作区。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { ProjectService } from '../../lib/core/service.js';
import { auditEvidence, evidenceVerified } from '../../lib/core/evidence.js';
import { assertEventSupported } from '../../lib/core/model.js';
import { EVENT_REGISTRY } from '../../lib/shared/events.js';
import { assertWorkspaceAttachmentCommit, assertWorkspaceAttachmentLog } from '../../lib/core/domain/workspace-attachments.js';
import { bindWorktree } from '../../lib/core/identity/ops.js';
import { readWorkspaceObject } from '../../lib/core/store/workspace-objects.js';
import { appendLegacyFacts, command, legacyGitMaterial, put, sha, temp } from '../helpers/fixed-fixture.mjs';

const retainedType = 'doc/workspace-retained';
const noGitEvents = events => assert.deepEqual(events.filter(event => event.type === 'doc/content-fixed' || event.data?.gitContentRepository), []);
function forbidChildren(t) {
  const attempts = [];
  for (const name of ['execFileSync', 'execFile', 'spawnSync', 'spawn', 'exec', 'execSync']) {
    t.mock.method(childProcess, name, (...args) => { attempts.push([name, args[0]]); throw new Error('unexpected runtime child process'); });
  }
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll(); syncBuiltinESMExports();
    assert.deepEqual(attempts, [], 'even swallowed subprocess attempts violate the runtime boundary');
  });
}

async function setup(t, { owning = true, docPath = 'docs/spec.md', text = 'version one\n' } = {}) {
  const root = temp(t);
  const board = owning ? null : temp(t);
  put(root, docPath, text);
  const options = owning ? { spaceRoot: root } : { rootDir: board };
  const serviceOptions = { ...options, privilegedInlineWrites: true };
  const svc = new ProjectService(serviceOptions);
  t.after(() => svc.close());
  await svc.init();
  const h = await svc.createProject({ workspacePath: root, name: 'Workspace evidence fixture' });
  const s = { h, svc, root, serviceOptions };
  s.docId = await newDoc(s, docPath);
  s.taskId = await newTask(s);
  return s;
}

async function newDoc({ h }, relPath, bindingId) {
  return (await h.command(command('doc.external.register', { title: 'Fixture document', relPath, ...(bindingId ? { bindingId } : {}) }))).docId;
}

async function newTask({ h }, title = 'Fixture task') {
  return (await h.command(command('task.create', { title, acceptance: [{ text: 'Review recorded evidence', requiredKinds: ['doc'] }] }))).events[0].data.id;
}

async function startWork({ h }, taskId) {
  await h.command(command('task.claim', { taskId, expected: { entityRev: h.state.tasks[taskId].rev } }));
  await h.command(command('task.begin', { taskId, fencingToken: h.leases.get(taskId).token, expected: { entityRev: h.state.tasks[taskId].rev }, summary: 'Document evidence' }));
}

const linked = (h, taskId, ref, fields = {}) => ({ kind: 'doc', ref, acceptanceId: h.state.tasks[taskId].acceptance[0].id, ...fields });
const submit = (h, taskId, evidence) => h.command(command('task.submit', { taskId, fencingToken: h.leases.get(taskId).token, expected: { entityRev: h.state.tasks[taskId].rev }, evidence }));
async function submitDoc(s, taskId = s.taskId, docId = s.docId) {
  await startWork(s, taskId);
  return submit(s.h, taskId, [linked(s.h, taskId, docId)]);
}
const row = ({ h }, taskId) => structuredClone(h.state.tasks[taskId].evidence.at(-1));
const refs = result => result.events.filter(event => event.type === retainedType).map(event => event.data.version.versionRef);
const ledger = h => fs.readFileSync(h.store.commitsFile);

function assertRetained(s, evidence, bytes, docId = s.docId) {
  const ref = evidence.workspaceVersion;
  assert.deepEqual(ref, { v: 1, kind: 'workspace-body', docId, projectId: s.h.id, versionId: ref.versionId, contentHash: sha(bytes) });
  assert.equal(evidence.hash, ref.contentHash);
  assert.equal(Object.hasOwn(evidence, 'fixed'), false);
  assert.equal(Object.hasOwn(evidence, 'fixedState'), false);
  assert.deepEqual(readWorkspaceObject(s.svc.spaceHome, ref.contentHash), Buffer.from(bytes));
  return ref;
}

function assertCurrent(evidence, bytes, reason) {
  assert.equal(evidence.hash, sha(bytes));
  assert.equal(evidence.fixedState, 'current-only');
  assert.equal(evidence.fixedReason, reason);
  for (const key of ['fixed', 'workspaceVersion']) assert.equal(Object.hasOwn(evidence, key), false);
}

// 责任：禁止子进程时，提交仍原子保存实际字节及其版本引用。
test('Git absent and child execution forbidden: submit retains exact bytes atomically', async t => {
  forbidChildren(t);
  const text = '\uFEFFworkspace 文档\r\n';
  const s = await setup(t, { text });
  const before = s.h.rev;
  const result = await submitDoc(s);
  const evidence = row(s, s.taskId);
  const ref = assertRetained(s, evidence, text);
  assert.deepEqual(refs(result), [ref]);
  const types = result.events.map(event => event.type);
  assert.ok(types.indexOf(retainedType) < types.indexOf('task/submitted'));
  assert.equal(result.projectRev, before + 3); // claim, begin, one submit batch
  assert.equal(s.h.store.commits.at(-1).actor.kind, 'human');
  assert.deepEqual(s.h.store.commits.at(-1).events, result.events);
  assert.equal(s.h.state.project.gitContentRepository, undefined);
  noGitEvents(result.events);
  assert.equal(evidenceVerified(s.h, null, evidence), true);
  assert.deepEqual(auditEvidence(s.h, s.h.state.tasks[s.taskId]), []);
});

// 责任：确认与证据可共用同版；后来编辑不改变已经留存的历史。
test('confirmation and later evidence share an unchanged version; later current edits do not drift history', async t => {
  forbidChildren(t);
  const s = await setup(t);
  const { h, docId } = s;
  const expectedContentHash = sha('version one\n');
  const confirmed = await h.command(command('doc.external.confirm', { docId, expectedMetaRev: 1, expectedContentHash }));
  assert.deepEqual(confirmed.events.map(event => event.type), [retainedType, 'doc/external-confirmed']);
  assert.deepEqual(h.state.docs[docId].baseline.workspaceVersion, refs(confirmed)[0]);
  assert.equal(Object.hasOwn(h.state.docs[docId].baseline, 'gitHeadOid'), false);
  const submitted = await submitDoc(s);
  assert.deepEqual(refs(submitted), []);
  assert.deepEqual(assertRetained(s, row(s, s.taskId), 'version one\n'), refs(confirmed)[0]);
  put(s.root, 'docs/spec.md', 'edited without Git\n');
  const second = await newTask(s);
  const changed = await submitDoc(s, second);
  assert.deepEqual(refs(changed), [assertRetained(s, row(s, second), 'edited without Git\n')]);
  assert.notEqual(row(s, second).workspaceVersion.versionId, row(s, s.taskId).workspaceVersion.versionId);
  assert.deepEqual(auditEvidence(h, h.state.tasks[s.taskId]), []);
  const verify = await h.command(command('task.verify', { taskId: s.taskId, expected: { entityRev: h.state.tasks[s.taskId].rev } }));
  assert.equal(verify.committed, true);
  assert.equal(h.state.tasks[s.taskId].state, 'done');
});

// 责任：普通文件不要求 Git 跟踪或属性转换，按实际字节留存。
test('untracked current bytes and an inert filter declaration do not need Git provenance', async t => {
  forbidChildren(t);
  const s = await setup(t);
  put(s.root, '.gitattributes', '*.md filter=danger\n');
  put(s.root, '.git/config', '[filter "danger"]\nclean = echo unsafe > MARK\nsmudge = echo unsafe > MARK\nprocess = echo unsafe > MARK\n');
  put(s.root, 'docs/untracked.md', 'untracked\n');
  const doc = await newDoc(s, 'docs/untracked.md');
  const result = await submitDoc(s, s.taskId, doc);
  assertRetained(s, row(s, s.taskId), 'untracked\n', doc);
  assert.equal(fs.existsSync(path.join(s.root, 'MARK')), false);
  noGitEvents(result.events);
});

// 责任：按字面留存指针文本，不读取或拉取其远端内容。
test('LFS pointer text records literal workspace bytes and does not resolve a remote object', async t => {
  forbidChildren(t);
  const text = 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 123\n';
  const s = await setup(t, { text });
  const result = await submitDoc(s);
  assertRetained(s, row(s, s.taskId), text);
  assert.equal(Object.keys(s.h.state.fixedContents ?? {}).length, 0);
  noGitEvents(result.events);
});

// 责任：旧布局没有对象库时限于当前证据，不改从其他位置寻找。
test('legacy non-owning project and non-main locator use current-only, never an alternate source', async t => {
  forbidChildren(t);
  const s = await setup(t, { owning: false });
  const other = temp(t);
  put(other, 'docs/spec.md', 'alternate binding bytes\n');
  const binding = bindWorktree(s.svc, { projectId: s.h.id, workspacePath: other, actor: { kind: 'human' } });
  const second = await newDoc(s, 'docs/spec.md', binding.bindingId);
  const result = await submitDoc(s, s.taskId, second);
  assertCurrent(row(s, s.taskId), 'alternate binding bytes\n', 'no-owning-space');
  assert.deepEqual(refs(result), []);
  noGitEvents(result.events);
  assert.deepEqual(auditEvidence(s.h, s.h.state.tasks[s.taskId]), []);
});

// 责任：无 Git 的冷回放保留证据；不能识别版本事件的旧读端明确拒绝。
test('no-Git cold replay and snapshot preserve retained evidence; old event registry refuses the ledger event', async t => {
  forbidChildren(t);
  const s = await setup(t);
  const result = await submitDoc(s);
  const evidence = row(s, s.taskId);
  const oldRegistry = { ...EVENT_REGISTRY };
  delete oldRegistry[retainedType];
  const retention = result.events.find(event => event.type === retainedType);
  assert.throws(() => assertEventSupported(s.h.state, retention, s.h.store.commits.at(-1), oldRegistry), { code: 'incompatible-event', status: 409 });
  s.h.store.saveSnapshot();
  const bytes = ledger(s.h);
  await s.svc.close();
  const reopened = await new ProjectService(s.serviceOptions).init();
  t.after(() => reopened.close());
  const h = await reopened.open(s.h.id);
  assert.deepEqual(row({ h }, s.taskId), evidence);
  assert.deepEqual(h.state.workspaceVersions[evidence.workspaceVersion.versionId].versionRef, evidence.workspaceVersion);
  assert.deepEqual(auditEvidence(h, h.state.tasks[s.taskId]), []);
  assert.deepEqual(ledger(h), bytes);
});

// 责任：不可解码字节生效为当前哈希，不冒充已留存的正文版本。
test('undecodable text remains auditable current-only without fake retained bytes', async t => {
  forbidChildren(t);
  const text = Buffer.from([0xb0, 0xa1, 0xba, 0xc3]);
  const s = await setup(t, { text });
  const result = await submitDoc(s);
  assertCurrent(row(s, s.taskId), text, 'unsupported-format');
  assert.deepEqual(refs(result), []);
  assert.deepEqual(auditEvidence(s.h, s.h.state.tasks[s.taskId]), []);
});

// 责任：区分外置元数据修订和内嵌正文历史修订。
test('external @rev is metadata; inline docId@rev still checks the archive revision', async t => {
  const s = await setup(t, { owning: false });
  const { h, taskId } = s;
  const ref = s.docId + '@99';
  await startWork(s, taskId);
  const out = await submit(h, taskId, [linked(h, taskId, ref)]);
  assert.equal(out.committed, true);
  assert.equal(row(s, taskId).ref, s.docId);
  assertCurrent(row(s, taskId), 'version one\n', 'no-owning-space');
  const made = await h.command(command('doc.put', { title: 'Archive', body: 'inline v1' }));
  const docId = made.events[0].data.id;
  const second = await newTask(s);
  await startWork(s, second);
  await assert.rejects(submit(h, second, [linked(h, second, docId + '@99')]), { code: 'missing-evidence' });
  await submit(h, second, [linked(h, second, docId + '@1')]);
  assert.equal(row(s, second).ref, docId + '@1');
  assert.equal(row(s, second).hash, sha('inline v1'));
  assert.equal(Object.hasOwn(row(s, second), 'workspaceVersion'), false);
  await h.command(command('doc.put', { docId, baseRev: 1, title: 'Archive moved', body: 'inline v2' }));
  assert.deepEqual(auditEvidence(h, h.state.tasks[second]), []);
});

// 责任：预审失败不得发布版本、证据或新的任务状态。
test('failed pre-review validation leaves no version, evidence, event, or state advancement', async t => {
  const s = await setup(t);
  const { h, taskId, docId } = s;
  await startWork(s, taskId);
  const bytes = ledger(h);
  const rev = h.rev;
  const lease = h.leases.get(taskId).token;
  await assert.rejects(submit(h, taskId, [linked(h, taskId, docId), { kind: 'file', ref: '../escape.txt' }]), { code: 'invalid-command' });
  await assert.rejects(submit(h, taskId, [linked(h, taskId, docId, { workspaceVersion: {} })]), { code: 'invalid-command' });
  assert.deepEqual(ledger(h), bytes);
  assert.equal(h.rev, rev);
  assert.equal(h.leases.get(taskId).token, lease);
  assert.equal(h.state.tasks[taskId].state, 'in_progress');
  assert.deepEqual(h.state.tasks[taskId].evidence, []);
  assert.deepEqual(h.state.workspaceVersions, {});
});

// 责任：完成对账的版本、恢复结果与证据必须同批。
test('reconcile(completed) logs retention, recovered work, and task evidence in the same batch', async t => {
  forbidChildren(t);
  const s = await setup(t);
  const { h, taskId } = s;
  await startWork(s, taskId);
  await h.command(command('task.interrupt', { taskId, expected: { entityRev: h.state.tasks[taskId].rev }, fencingToken: h.leases.get(taskId).token,
    note: 'Interruption after work', sideEffects: [{ kind: 'command', ref: 'node --test' }] }));
  const out = await h.command(command('task.reconcile', { taskId, expected: { entityRev: h.state.tasks[taskId].rev }, choice: 'completed',
    note: 'Recovered', evidence: [linked(h, taskId, s.docId + '@999')] }));
  assert.deepEqual(out.events.map(event => event.type), [retainedType, 'work/result', 'task/reconciled']);
  assert.deepEqual(refs(out), [assertRetained(s, row(s, taskId), 'version one\n')]);
  assert.equal(h.state.tasks[taskId].state, 'review');
  assert.deepEqual(h.store.commits.at(-1).events, out.events);
  noGitEvents(out.events);
});

// 责任：同批分别留存各文档，而同一文档的重复证据复用一次观测。
test('one submission retains two documents independently and reuses each capture on duplicate rows', async t => {
  const s = await setup(t);
  const { h, taskId } = s;
  put(s.root, 'docs/two.md', 'second document\n');
  const doc = await newDoc(s, 'docs/two.md');
  await startWork(s, taskId);
  const before = structuredClone(h.state);
  const result = await submit(h, taskId, [linked(h, taskId, s.docId), linked(h, taskId, doc), linked(h, taskId, s.docId + '@9')]);
  const [first, second, again] = h.state.tasks[taskId].evidence;
  assert.deepEqual(refs(result), [assertRetained(s, first, 'version one\n'), assertRetained(s, second, 'second document\n', doc)]);
  assert.deepEqual(again.workspaceVersion, first.workspaceVersion);
  const commit = h.store.commits.at(-1);
  assert.throws(() => assertWorkspaceAttachmentCommit(before, { ...commit, events: commit.events.filter(event => event.type !== retainedType) }), { code: 'invalid-workspace-version' });
  noGitEvents(result.events);
});

// 责任：对象损坏不能变成已确认版本，安全核得的当前字节可以显式降级。
test('object corruption cannot create a reference or fake a confirmation; task can use safe current observation', async t => {
  const s = await setup(t);
  const { h, docId } = s;
  const hash = sha('version one\n');
  const object = path.join(s.svc.spaceHome.namespace, 'objects', 'workspace-bytes', hash.slice(0, 2), hash);
  fs.mkdirSync(path.dirname(object), { recursive: true });
  fs.writeFileSync(object, 'wrong object bytes');
  const before = ledger(h);
  await assert.rejects(h.command(command('doc.external.confirm', { docId, expectedMetaRev: 1, expectedContentHash: hash })), { code: 'content-object-corrupt' });
  assert.deepEqual(ledger(h), before);
  assert.equal(h.state.docs[docId].baseline, null);
  const out = await submitDoc(s);
  assert.deepEqual(refs(out), []);
  assertCurrent(row(s, s.taskId), 'version one\n', 'workspace-retention-unavailable');
  assert.equal(fs.readFileSync(object, 'utf8'), 'wrong object bytes');
});

// 责任：旧来源和哈希基线可回放，人审可查看未重新核验警告。
test('old Git evidence and hash-only confirmations replay unchanged; human verification receives an explicit warning', async t => {
  forbidChildren(t);
  const s = await setup(t, { owning: false });
  const { h, docId, taskId } = s;
  await submitDoc(s);
  const before = structuredClone(h.state.tasks[taskId]);
  const doc = h.state.docs[docId];
  const { data, source } = legacyGitMaterial(h, docId, { synthetic: true });
  const at = '2025-01-01T00:00:00.000Z';
  const fixed = { ...before.evidence[0], ...data, id: 'ev_synthetic_legacy_git', fixedState: 'pinned' };
  delete fixed.fixedReason;
  const baseline = { domain: 'workspace-bytes', contentHash: sha('version one\n'), ...doc.locator,
    gitHeadOid: data.fixed.commitOid, confirmedAt: at, confirmedBy: { kind: 'human' }, readerVersion: 'workspace-reader/1' };
  appendLegacyFacts(h, [
    { type: 'project/updated', data: { ...h.state.project, gitContentRepository: source } },
    { type: 'doc/content-fixed', docId, data },
    { type: 'doc/external-confirmed', docId, rev: 2, data: { ...doc, rev: 2, baseline, baselineInContext: true } },
    { type: 'task/submitted', taskId, rev: before.rev + 1, data: { ...before, rev: before.rev + 1,
      acceptance: before.acceptance.map(item => ({ ...item, evidenceIds: [fixed.id] })), evidence: [fixed] } },
  ]);
  const oldBytes = ledger(h);
  await s.svc.close();
  const reopened = await new ProjectService(s.serviceOptions).init();
  t.after(() => reopened.close());
  const reopenedHandle = await reopened.open(h.id);
  assert.deepEqual(ledger(reopenedHandle), oldBytes);
  assert.deepEqual(reopenedHandle.state.docs[docId].baseline, baseline);
  assert.equal(Object.hasOwn(reopenedHandle.state.docs[docId].baseline, 'workspaceVersion'), false);
  assert.deepEqual(row({ h: reopenedHandle }, taskId), fixed);
  assert.equal(evidenceVerified(reopenedHandle, null, fixed), false);
  const verified = await reopenedHandle.command(command('task.verify', { taskId, expected: { entityRev: reopenedHandle.state.tasks[taskId].rev } }));
  assert.equal(verified.committed, true);
  assert.equal(reopenedHandle.state.tasks[taskId].state, 'done');
  const [warning] = verified.warnings;
  assert.deepEqual([warning.code, warning.severity, warning.provenance, warning.deprecated, warning.reverified],
    ['legacy-git-not-reverified', 'warning', 'legacy-git', true, false]);
  assert.deepEqual(row({ h: reopenedHandle }, taskId), fixed);
  assert.deepEqual(ledger(reopenedHandle).subarray(0, oldBytes.length), oldBytes);
});

// 责任：预检与失锁都不安装对象或追加权威日志。
test('preflight and missing writer lock cannot create workspace objects or append log bytes', async t => {
  const s = await setup(t);
  const { h, taskId, docId } = s;
  await startWork(s, taskId);
  const bytes = ledger(h);
  const objects = path.join(s.svc.spaceHome.namespace, 'objects', 'workspace-bytes');
  const tree = () => fs.existsSync(objects) ? fs.readdirSync(objects, { recursive: true }).sort() : [];
  const before = tree();
  const cmd = command('task.submit', { taskId, fencingToken: h.leases.get(taskId).token,
    expected: { entityRev: h.state.tasks[taskId].rev }, evidence: [linked(h, taskId, docId)] });
  await h._preflight(cmd);
  assert.deepEqual(tree(), before);
  assert.deepEqual(ledger(h), bytes);
  const lock = t.mock.method(h.store, 'ownsLockFile', () => false);
  await assert.rejects(h.command(cmd), { code: 'read-only' });
  lock.mock.restore();
  assert.deepEqual(tree(), before);
  assert.deepEqual(ledger(h), bytes);
  assert.deepEqual(h.state.workspaceVersions, {});
});

// 责任：附带版本的证据必须和日志身份、最新版本以及快照逐行一致。
test('attachment replay rejects altered snapshots, duplicate IDs and an older same-hash A version', async t => {
  const s = await setup(t);
  const { h, taskId, docId } = s;
  const old = refs(await h.command(command('doc.workspace_capture', { docId })))[0];
  put(s.root, 'docs/spec.md', 'B');
  await h.command(command('doc.workspace_capture', { docId }));
  put(s.root, 'docs/spec.md', 'version one\n');
  await startWork(s, taskId);
  const previous = structuredClone(h.state);
  const events = (await submit(h, taskId, [linked(h, taskId, docId), linked(h, taskId, docId)])).events;
  const row = events.find(event => event.type === 'task/submitted').data.evidence[0];
  assert.equal(old.contentHash, row.workspaceVersion.contentHash);
  assert.notEqual(old.versionId, row.workspaceVersion.versionId);
  for (const mutate of [rows => { rows[0].workspaceVersion = old; }, rows => { rows[1].id = rows[0].id; }, rows => { rows[0].id = ''; }]) {
    const altered = structuredClone(h.store.commits.at(-1));
    mutate(altered.events.find(event => event.type === 'task/submitted').data.evidence);
    assert.throws(() => assertWorkspaceAttachmentCommit(previous, altered), { code: 'invalid-workspace-version' });
  }
  for (const mutate of [rows => { rows[0].kind = 'note'; }, rows => { rows[0].hash = 'a'.repeat(64); }, rows => { rows[0].ref = 'doc_other'; },
    rows => { rows[0].supersededAt = 'invented'; }, rows => { rows.reverse(); }]) {
    const state = structuredClone(h.state);
    mutate(state.tasks[taskId].evidence);
    assert.throws(() => assertWorkspaceAttachmentLog(h.store.commits, h.id, { seq: h.rev, state }), { code: 'invalid-workspace-version' });
  }
  assert.throws(() => assertWorkspaceAttachmentLog([], h.id, { seq: 0, state: h.state }), { code: 'invalid-workspace-version' });
});

// 责任：后续记录缺失文档引用时，追加、冷重放和审计均拒绝已有留存身份。
test('existing retained evidence cannot lose its document reference', async t => {
  const s = await setup(t);
  const { h, taskId, docId } = s;
  await startWork(s, taskId);
  await submit(h, taskId, [linked(h, taskId, docId)]);
  const task = structuredClone(h.state.tasks[taskId]);
  delete task.evidence[0].ref;
  const added = { seq: h.rev + 1, events: [{ type: 'task/updated', taskId, data: task }] };
  assert.throws(() => assertWorkspaceAttachmentCommit(h.state, added), { code: 'invalid-workspace-version' });
  assert.throws(() => assertWorkspaceAttachmentLog([...h.store.commits, added], h.id), { code: 'invalid-workspace-version' });
  assert.deepEqual(auditEvidence(h, task).map(({code, severity}) => ({ code, severity })), [{ code: 'invalid-workspace-version', severity: 'error' }]);
});
