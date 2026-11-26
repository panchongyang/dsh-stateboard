/**
 * 测试职责：验证外部已有文档的正文留存纯模型——版本派生、连续同哈希复用、
 * 事件重放校验、旧文档/基线不变与快照一致性。
 * 典型流程：合成外部 doc → document.retainVersion → applyEvent → 对照版本链。
 * 覆盖边界：覆盖事件推导、快照与重放；不覆盖文件读取或宿主协议。
 * 外部前置：无；全部为纯函数与合成状态。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyEvent, emptyState } from '../../lib/core/model.js';
import { JsonlStore, makeCommit } from '../../lib/core/store.js';
import { DOCUMENT_OPERATIONS } from '../../lib/core/domain/operations/documents.js';
import {
  WORKSPACE_RETAINED_EVENT, assertWorkspaceVersionsInState, assertWorkspaceVersionsMatch, retainedVersionsInLog,
} from '../../lib/core/domain/workspace-record.js';
import { eventClass } from '../../lib/shared/events.js';

const AT = '2030-01-01T00:00:00.000Z';
const hash = (char) => char.repeat(64);
const LOC = { bindingId: 'b1', relPath: 'docs/spec.md' };

function externalDoc(overrides = {}) {
  return {
    id: 'doc_a', source: 'external', rev: 1, title: 'Spec', kind: 'spec', status: 'draft',
    locator: { ...LOC }, links: { taskIds: [], planRefs: [] }, baseline: null, baselineInContext: false,
    unregistered: null, createdAt: AT, updatedAt: AT, ...overrides,
  };
}

function projectState() {
  return emptyState({ id: 'prj_retain', name: 'retain', workspacePath: 'D:/ws', schemaVersion: 3 });
}

function stateWithDoc(overrides = {}) {
  const state = projectState();
  state.docs.doc_a = externalDoc(overrides);
  return state;
}

function work(state) {
  return { state, leases: new Map(), rev: state.lastSeq, scratch: new Map(), clock: () => new Date(AT), newId: (prefix) => prefix + '_x' };
}

function run(state, overrides = {}) {
  const args = { docId: 'doc_a', locator: { ...LOC }, contentHash: hash('a'), size: 10, ...overrides };
  return DOCUMENT_OPERATIONS['document.retainVersion'](work(state), args, { cmdId: 'synthetic-retain', actor: { kind: 'system' } });
}

function commit(state, result) {
  const record = { seq: state.lastSeq + 1, at: AT, actor: { kind: 'system' } };
  for (const event of result.events) applyEvent(state, structuredClone(event), record);
  state.lastSeq += 1;
  return state;
}

// 责任：核对新事件兼容分类及未知事件拒绝。
test('retained event is registered as applied and unknown events still refuse', () => {
  assert.equal(eventClass(WORKSPACE_RETAINED_EVENT), 'applied');
  assert.equal(eventClass('doc/workspace-imaginary'), 'refuse');
});

// 责任：采集只产生版本，不推进元数据或确认基线。
test('retention derives version identity and leaves the document and baseline untouched', () => {
  const state = stateWithDoc({ baseline: { domain: 'workspace-bytes', contentHash: hash('f') }, baselineInContext: true });
  const before = structuredClone(state.docs.doc_a);
  const facts = run(state, { size: 11 });
  const { result } = facts;
  assert.equal(facts.events.length, 1);
  assert.equal(facts.events[0].type, WORKSPACE_RETAINED_EVENT);
  assert.equal(facts.events[0].docId, 'doc_a');
  const version = facts.events[0].data.version;
  assert.deepEqual(Object.keys(version).sort(), ['locator', 'observedAt', 'provenance', 'seq', 'size', 'versionRef']);
  assert.deepEqual(version.locator, LOC);
  assert.equal(version.size, 11);
  assert.equal(version.observedAt, AT);
  assert.equal(version.seq, 1);
  assert.equal(version.provenance, 'observed');
  assert.deepEqual(version.versionRef, {
    v: 1, kind: 'workspace-body', projectId: 'prj_retain', docId: 'doc_a',
    versionId: version.versionRef.versionId, contentHash: hash('a'),
  });
  assert.equal(result.retained, true);
  assert.deepEqual(result.versionRef, version.versionRef);
  assert.deepEqual(state.docs.doc_a, before, 'retention must not change the document or baseline');
});

// 责任：拒绝未登记文档及伪造的观察字段。
test('only a registered valid external document can be retained and forged fields are refused', () => {
  assert.throws(() => run(projectState()), { code: 'not-found' });
  const inline = stateWithDoc();
  inline.docs.doc_a = { id: 'doc_a', rev: 1, title: 'Inline', kind: 'note', hash: hash('a'), size: 1, links: { taskIds: [], planRefs: [] }, createdAt: AT, updatedAt: AT };
  assert.throws(() => run(inline), { code: 'external-doc-operation-required' });
  assert.throws(() => run(stateWithDoc({ unregistered: { at: AT, by: null, reason: null } })), { code: 'illegal-transition' });
  const state = stateWithDoc();
  for (const fields of [
    { locator: { bindingId: 'b2', relPath: 'docs/spec.md' } },
    { locator: { bindingId: 'b1', relPath: '../spec.md' } },
    { contentHash: 'A'.repeat(64) }, { contentHash: 'bad' },
    { size: -1 }, { size: 16 * 1024 * 1024 + 1 }, { size: 1.5 },
    { versionId: 'ver_evil' }, { provenance: 'put' }, { seq: 9 }, { baseline: null }, { rev: 7 },
  ]) {
    assert.throws(() => run(state, fields), { code: 'invalid-command' }, 'forged field must be rejected: ' + Object.keys(fields)[0]);
  }
  assert.deepEqual(state.docs.doc_a, externalDoc(), 'rejections must not mutate the draft');
});

// 责任：验证相邻相同版本复用及来回变化留存。
test('consecutive identical observations reuse the previous version while A→B→A keeps three', () => {
  const state = stateWithDoc();
  const first = run(state, { contentHash: hash('a'), size: 10 });
  commit(state, first);
  const before = structuredClone(state);
  const same = run(state, { contentHash: hash('a'), size: 10 });
  assert.deepEqual(same.events, []);
  assert.deepEqual(same.result.versionRef, first.result.versionRef);
  assert.equal(same.result.retained, false);
  assert.deepEqual(state, before, 'a reused observation appends nothing');

  for (const [char, size] of [['b', 11], ['a', 10]]) {
    const next = run(state, { contentHash: hash(char), size });
    assert.equal(next.events.length, 1);
    commit(state, next);
  }
  const versions = Object.values(state.workspaceVersions).sort((a, b) => a.seq - b.seq);
  assert.equal(versions.length, 3, 'A→B→A retains A, B and the later A');
  assert.deepEqual(versions.map((v) => v.versionRef.contentHash), [hash('a'), hash('b'), hash('a')]);
  assert.deepEqual(versions.map((v) => v.seq), [1, 2, 3]);
  assert.equal(state.docs.doc_a.rev, 1);
  assert.equal(state.docs.doc_a.baseline, null);
});

// 责任：重放拒绝不合法的序列和定位。
test('replay validates retained versions, refuses forged records and hydrates older state', () => {
  const state = stateWithDoc();
  commit(state, run(state, { contentHash: hash('a') }));
  commit(state, run(state, { contentHash: hash('b'), size: 12 }));
  const events = Object.values(state.workspaceVersions);

  const legacy = stateWithDoc();
  delete legacy.workspaceVersions;
  delete legacy.counters.workspaceVersionSeq;
  applyEvent(legacy, structuredClone({ type: WORKSPACE_RETAINED_EVENT, docId: 'doc_a', data: { version: events[0] } }), { seq: 1 });
  assert.equal(legacy.counters.workspaceVersionSeq, 1);
  assert.equal(legacy.workspaceVersions[events[0].versionRef.versionId].provenance, 'observed');

  const forged = structuredClone({ type: WORKSPACE_RETAINED_EVENT, docId: 'doc_a', data: { version: events[1] } });
  forged.data.version.locator = { bindingId: 'b2', relPath: 'docs/other.md' };
  assert.throws(() => applyEvent(structuredClone(state), forged, { seq: 3 }), { code: 'invalid-workspace-version' });

  const gap = structuredClone({ type: WORKSPACE_RETAINED_EVENT, docId: 'doc_a', data: { version: events[1] } });
  assert.throws(() => applyEvent(stateWithDoc(), gap, { seq: 1 }), { code: 'invalid-workspace-version' }, 'seq must advance by one');

  const duplicate = structuredClone({ type: WORKSPACE_RETAINED_EVENT, docId: 'doc_a', data: { version: events[1] } });
  assert.throws(() => applyEvent(structuredClone(state), duplicate, { seq: 3 }), { code: 'invalid-workspace-version' });

  const inline = stateWithDoc();
  inline.docs.doc_i = { id: 'doc_i', rev: 1, title: 'Inline', kind: 'note', hash: hash('a'), size: 1, links: { taskIds: [], planRefs: [] }, createdAt: AT, updatedAt: AT };
  assert.doesNotThrow(() => applyEvent(inline, { type: 'doc/updated', data: inline.docs.doc_i }, { seq: 1 }));
});

// 责任：快照中的版本内容和计数必须与日志一致。
test('snapshot retained versions are validated and compared with the authoritative log', () => {
  const state = stateWithDoc();
  commit(state, run(state, { contentHash: hash('a') }));
  commit(state, run(state, { contentHash: hash('b'), size: 12 }));
  const commits = [
    { seq: 1, events: [{ type: 'doc/external-registered', data: externalDoc() }] },
    { seq: 2, events: [{ type: WORKSPACE_RETAINED_EVENT, docId: 'doc_a', data: { version: structuredClone(Object.values(state.workspaceVersions)[0]) } }] },
    { seq: 3, events: [{ type: WORKSPACE_RETAINED_EVENT, docId: 'doc_a', data: { version: structuredClone(Object.values(state.workspaceVersions)[1]) } }] },
  ];
  const atSnapshot = retainedVersionsInLog(commits, 3);
  assert.deepEqual(atSnapshot, state.workspaceVersions);
  assert.equal(Object.keys(retainedVersionsInLog(commits, 2)).length, 1);
  assert.doesNotThrow(() => assertWorkspaceVersionsInState({ ...state, project: { id: 'prj_retain' } }, { seq: 3 }));

  assert.doesNotThrow(() => assertWorkspaceVersionsMatch(state, atSnapshot, { seq: 3 }));
  const tampered = structuredClone(state.workspaceVersions);
  tampered[Object.keys(tampered)[0]].size += 1;
  assert.throws(
    () => assertWorkspaceVersionsMatch({ ...state, workspaceVersions: tampered }, atSnapshot, { seq: 3 }),
    (error) => error.code === 'invalid-workspace-version' && error.details?.reason === 'snapshot-version-mismatch',
  );
  const wrongKey = structuredClone(state.workspaceVersions);
  const key = Object.keys(wrongKey)[0];
  const version = wrongKey[key];
  delete wrongKey[key];
  wrongKey['ver_other'] = version;
  assert.throws(() => assertWorkspaceVersionsInState({ ...state, workspaceVersions: wrongKey, project: { id: 'prj_retain' } }, { seq: 3 }), { code: 'invalid-workspace-version' });
});

// 责任：从真实快照打开并识别被篡改的版本表。
test('a real store opens from a snapshot and rejects a tampered retained ledger', () => {
  const state = stateWithDoc();
  const first = run(state, { contentHash: hash('a') });
  commit(state, first);
  const second = run(state, { contentHash: hash('b'), size: 12 });
  commit(state, second);
  const project = { id: 'prj_retain', name: 'retain', workspacePath: 'D:/ws', phase: 'active', rev: 0, schemaVersion: 3 };
  const meta = { projectId: 'prj_retain', project, schemaVersion: 3 };
  const c1 = makeCommit(1, 'genesis', { kind: 'system' }, 'cmd_1', 0, [{ type: 'doc/external-registered', data: externalDoc() }], AT);
  const c2 = makeCommit(2, c1.hash, { kind: 'system' }, 'cmd_2', 1, structuredClone(first.events), AT);
  const c3 = makeCommit(3, c2.hash, { kind: 'system' }, 'cmd_3', 2, structuredClone(second.events), AT);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-retain-snap-'));
  fs.writeFileSync(path.join(dir, 'commits.jsonl'), [c1, c2, c3].map((commit) => JSON.stringify(commit)).join('\n') + '\n');
  const snapshotState = emptyState(project);
  for (const commit of [c1, c2, c3]) {
    for (const event of commit.events) applyEvent(snapshotState, structuredClone(event), commit);
    snapshotState.lastSeq = commit.seq; snapshotState.lastHash = commit.hash; snapshotState.project.rev = commit.seq;
  }
  const snapshotFile = path.join(dir, 'snapshot.json');
  fs.writeFileSync(snapshotFile, JSON.stringify({ v: 1, seq: 3, hash: c3.hash, state: snapshotState }));
  const store = new JsonlStore(dir, meta, { lock: false });
  store.open();
  assert.equal(Object.keys(store.state.workspaceVersions).length, 2);
  assert.equal(store.state.counters.workspaceVersionSeq, 2);
  store.close();

  const tampered = structuredClone(snapshotState);
  tampered.workspaceVersions[Object.keys(tampered.workspaceVersions)[0]].size += 1;
  fs.writeFileSync(snapshotFile, JSON.stringify({ v: 1, seq: 3, hash: c3.hash, state: tampered }));
  assert.throws(() => new JsonlStore(dir, meta, { lock: false }).open(), { code: 'invalid-workspace-version' });

  const counter = structuredClone(snapshotState);
  counter.counters.workspaceVersionSeq = 7;
  fs.writeFileSync(snapshotFile, JSON.stringify({ v: 1, seq: 3, hash: c3.hash, state: counter }));
  assert.throws(() => new JsonlStore(dir, meta, { lock: false }).open(), (error) => error.code === 'invalid-workspace-version' && error.details?.reason === 'snapshot-version-counter');
});

// 责任：确认内嵌迁移记录在新快照校验下仍可读取。
test('a pre-migration inline record still opens from a retained snapshot', () => {
  const state = projectState();
  const inline = { id: 'doc_a', rev: 1, title: 'Spec', kind: 'spec', hash: hash('a'), size: 10, links: { taskIds: [], planRefs: [] }, createdAt: AT, updatedAt: AT };
  state.docs.doc_a = inline;
  state.lastSeq = 1; state.lastHash = 'sha256:' + hash('e');
  const migrated = DOCUMENT_OPERATIONS['document.convertInlineToExternal'](work(state), {
    sourceDocId: 'doc_a', sourceRev: 1, sourceHash: hash('a'), locator: { ...LOC },
    target: { contentHash: hash('a'), size: 10 }, history: [{ sourceRev: 1, sourceHash: hash('a'), size: 10, archive: { domain: 'inline-utf8', hash: hash('a'), readOnly: true, gitManaged: false } }],
    backup: { projectId: 'prj_retain', seq: 1, hash: state.lastHash, restoreTested: true },
  }, { actor: { kind: 'human' }, authorized: true });
  commit(state, migrated);
  assert.equal(state.docs.doc_a.source, 'external');
  const retained = run(state, { contentHash: hash('a') });
  commit(state, retained);

  const project = { id: 'prj_retain', name: 'retain', workspacePath: 'D:/ws', phase: 'active', rev: 0, schemaVersion: 3 };
  const meta = { projectId: 'prj_retain', project, schemaVersion: 3 };
  const c1 = makeCommit(1, 'genesis', { kind: 'system' }, 'cmd_1', 0, [{ type: 'doc/created', data: inline }], AT);
  const c2 = makeCommit(2, c1.hash, { kind: 'system' }, 'cmd_2', 1, structuredClone(migrated.events), AT);
  const c3 = makeCommit(3, c2.hash, { kind: 'system' }, 'cmd_3', 2, structuredClone(retained.events), AT);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-retain-migrate-'));
  fs.writeFileSync(path.join(dir, 'commits.jsonl'), [c1, c2, c3].map((commit) => JSON.stringify(commit)).join('\n') + '\n');
  const snapshotState = emptyState(project);
  for (const commit of [c1, c2, c3]) {
    for (const event of commit.events) applyEvent(snapshotState, structuredClone(event), commit);
    snapshotState.lastSeq = commit.seq; snapshotState.lastHash = commit.hash; snapshotState.project.rev = commit.seq;
  }
  fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify({ v: 1, seq: 3, hash: c3.hash, state: snapshotState }));
  const store = new JsonlStore(dir, meta, { lock: false });
  store.open();
  assert.equal(store.state.docs.doc_a.source, 'external');
  assert.equal(store.state.docs.doc_a.migration.v, 1);
  assert.equal(Object.keys(store.state.workspaceVersions).length, 1);
  store.close();
});
