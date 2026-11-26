/**
 * 测试职责：验证文档/项目/会话的具名模型操作只从私有状态与合法入参派生记录。
 * 典型流程：合成 draft/request → 执行操作 → 对照事件、版本与拒绝后的草稿不变。
 * 覆盖边界：覆盖内嵌/外置/迁移、项目阶段与搬迁、会话交接；不覆盖宿主、文件或提交。
 * 外部前置：无；全部为纯函数与合成状态。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyState } from '../../lib/core/model.js';
import { BoardError } from '../../lib/core/errors.js';
import { DOC_RELATION_HANDLERS } from '../../lib/core/commands/doc-relations.js';
import { DOCUMENT_OPERATIONS } from '../../lib/core/domain/operations/documents.js';
import { projectOperations } from '../../lib/core/domain/operations/projects.js';
import { sessionOperations } from '../../lib/core/domain/operations/sessions.js';
import { rebindExternalDocuments } from '../../lib/core/domain/operations/documents-external.js';

const AT = '2030-01-01T00:00:00.000Z';
const human = { kind: 'human', via: 'test' };
const agent = { kind: 'agent', sessionId: 's_ops', agentId: 'a_ops' };
const hash = (char) => char.repeat(64);

function projectState(extra = {}) {
  return { ...emptyState({ id: 'prj_ops', name: 'ops', workspacePath: 'D:/ws', schemaVersion: 3, inlineWritesDisabled: false, ...extra }) };
}

function work(state, { at = AT, ids = ['a', 'b', 'c'] } = {}) {
  let index = 0;
  return {
    state, leases: new Map(), rev: state.lastSeq, scratch: new Map(),
    clock: () => new Date(at), newId: (prefix) => prefix + '_' + ids[index++],
  };
}

// 责任：所有测试都不提供公开业务名；读取隐藏的 op/payload 会直接失败。
function identity(actor, extra = {}) {
  const request = { cmdId: 'synthetic-operation', actor, ...extra };
  for (const field of ['op', 'choice', 'payload']) Object.defineProperty(request, field, { get() { throw new Error('model read public command field: ' + field); } });
  return request;
}

function run(dict, kind, state, args, actor = human, extra = {}) {
  const job = work(state);
  const result = dict[kind](job, args, identity(actor, extra));
  return { job, result };
}

function task(id, overrides = {}) {
  return { id, rev: 1, title: id, state: 'ready', acceptance: [], links: [], ...overrides };
}

// 责任：冻结操作字典只暴露约定的具名 kind，避免命令与模型注册表漂移。
test('frozen operation dictionaries expose exactly the named kinds', () => {
  assert.deepEqual(Object.keys(DOCUMENT_OPERATIONS).sort(), [
    'document.addRelation', 'document.changeLinks', 'document.confirmExternalBaseline', 'document.convertInlineToExternal',
    'document.editExternalMetadata', 'document.moveExternalLocator', 'document.rebindExternalBinding',
    'document.registerExternal', 'document.removeRelation', 'document.reportCaptureGap', 'document.retainVersion',
    'document.unregisterExternal', 'document.writeRevision',
  ]);
  assert.deepEqual(Object.keys(projectOperations).sort(), ['project.applyUpdate', 'project.moveWorkspace', 'project.setInlineWritePolicy']);
  assert.deepEqual(Object.keys(sessionOperations).sort(), ['session.recordCheckpoint', 'session.recordHandoff']);
  for (const dict of [DOCUMENT_OPERATIONS, projectOperations, sessionOperations]) {
    assert.equal(Object.isFrozen(dict), true);
  }
});

// 责任：隐藏关系不能通过 stale revision 或替代写入口暴露。
test('relation writes conceal denied predecessor before any source comparison or capture', () => {
  const from = { kind: 'task', id: 'tsk_a', seq: 1, event: 0 };
  const write = { actor: human, expectedRev: 1 };
  const read = {
    state: { tasks: { tsk_a: { id: 'tsk_a', rev: 1 } }, documentRelations: { rel_hidden: {
      relationId: 'rel_hidden', fromVersion: { ...from, id: 'tsk_b' }, sourceOwnerId: 'tsk_b',
      toVersionRef: { kind: 'workspace-body', docId: 'doc_a', versionId: 'hidden' },
    } } },
    documents: {
      assertRelationSpace() {}, relationOwner: () => 'tsk_a',
      assertRelationTarget() { throw new BoardError('missing-binding', 'denied', { status: 409 }); },
    },
  };
  assert.throws(() => DOC_RELATION_HANDLERS['doc.relation.remove'](read,
    { ...write, op: 'doc.relation.remove', relationId: 'rel_hidden' }), { code: 'not-found' });
  assert.throws(() => DOC_RELATION_HANDLERS['doc.relation.add'](read,
    { ...write, op: 'doc.relation.add', from, to: { kind: 'workspace-current', docId: 'doc_a' }, replacesId: 'rel_hidden' }), { code: 'not-found' });
});

// 责任：内嵌 put 的 id/版本/时间由模型派生，调用方注入的事件或实体不得进入日志。
test('inline put derives id, rev and timestamps itself and ignores injected events or entities', () => {
  const state = projectState();
  const before = structuredClone(state);
  // 注入实体后像、事件或目标 state 的入参被拒绝，而不是被静默忽略。
  assert.throws(() => run(DOCUMENT_OPERATIONS, 'document.writeRevision', state, {
    title: 'Spec', hash: hash('a'), size: 4,
    id: 'doc_evil', rev: 9, createdAt: '1999-01-01T00:00:00.000Z',
    events: [{ type: 'task/created', data: { id: 'tsk_evil' } }],
  }), { code: 'invalid-command' });
  const { result } = run(DOCUMENT_OPERATIONS, 'document.writeRevision', state, {
    title: '  Spec  ', kind: 'spec', hash: hash('a'), size: 4, links: undefined, baseRev: undefined,
  });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, 'doc/created');
  const doc = result.events[0].data;
  assert.equal(doc.id, 'doc_a');
  assert.equal(doc.title, 'Spec');
  assert.equal(doc.rev, 1);
  assert.equal(doc.hash, hash('a'));
  assert.equal(doc.size, 4);
  assert.equal(doc.createdAt, AT);
  assert.deepEqual(doc.links, { taskIds: [], planRefs: [] });
  assert.equal(result.entityRev, 1);
  assert.deepEqual(state, before, 'operation must not mutate the private draft directly');
});

// 责任：已有文档的 baseRev 必须精确匹配，拒绝时不改私有草稿。
test('inline put requires the exact baseRev and leaves the draft untouched when rejected', () => {
  const state = projectState();
  state.docs.doc_a = { id: 'doc_a', rev: 3, title: 'Old', kind: 'note', hash: hash('a'), size: 1, links: { taskIds: [], planRefs: [] }, createdAt: AT, updatedAt: AT };
  const before = structuredClone(state);
  assert.throws(() => run(DOCUMENT_OPERATIONS, 'document.writeRevision', state, { docId: 'doc_a', title: 'New', hash: hash('b'), size: 2, baseRev: 2 }), { code: 'stale-revision' });
  assert.deepEqual(state, before);
  const { result } = run(DOCUMENT_OPERATIONS, 'document.writeRevision', state, { docId: 'doc_a', title: 'New', hash: hash('b'), size: 2, baseRev: 3, kind: 'note' });
  assert.equal(result.events[0].data.rev, 4);
  assert.equal(result.events[0].data.hash, hash('b'));
});

// 责任：内嵌写操作拒绝外置与已迁移记录，不能把元数据改写成正文。
test('inline operations refuse external and migrated records instead of rewriting them as bodies', () => {
  const state = projectState();
  state.docs.doc_a = { id: 'doc_a', source: 'external', rev: 1, title: 'X', kind: 'note', status: 'draft', locator: { bindingId: 'b1', relPath: 'x.md' }, links: { taskIds: [], planRefs: [] }, baseline: null, baselineInContext: false, unregistered: null, createdAt: AT, updatedAt: AT };
  state.docs.doc_b = { id: 'doc_b', source: 'external', rev: 2, title: 'Y', kind: 'note', status: 'draft', locator: { bindingId: 'b1', relPath: 'y.md' }, links: { taskIds: [], planRefs: [] }, baseline: null, baselineInContext: false, unregistered: null, createdAt: AT, updatedAt: AT, migration: { v: 1 } };
  assert.throws(() => run(DOCUMENT_OPERATIONS, 'document.changeLinks', state, { docId: 'doc_a', links: {} }), { code: 'external-doc-operation-required' });
  assert.throws(() => run(DOCUMENT_OPERATIONS, 'document.changeLinks', state, { docId: 'doc_b', links: {} }), { code: 'inline-write-disabled' });
});

// 责任：doc.link 按私有 state 归一化关联，未知目标必须拒绝。
test('document.link normalizes links against the private state and rejects unknown targets', () => {
  const state = projectState();
  state.tasks.tsk_a = task('tsk_a');
  state.docs.doc_a = { id: 'doc_a', rev: 1, title: 'Doc', kind: 'note', hash: hash('a'), size: 1, links: { taskIds: [], planRefs: [] }, createdAt: AT, updatedAt: AT };
  assert.throws(() => run(DOCUMENT_OPERATIONS, 'document.changeLinks', state, { docId: 'doc_a', links: { taskIds: ['tsk_missing'], planRefs: [] } }), { code: 'invalid-command' });
  const { result } = run(DOCUMENT_OPERATIONS, 'document.changeLinks', state, { docId: 'doc_a', links: { taskIds: ['tsk_a', 'tsk_a'], planRefs: [] } });
  assert.deepEqual(result.events[0].data.links.taskIds, ['tsk_a']);
  assert.equal(result.events[0].data.rev, 2);
});

// 责任：外置登记由模型生成身份/状态/createdBy，不接受调用方正文哈希。
test('external register derives identity/status/createdBy and never accepts a body hash', () => {
  const state = projectState();
  state.tasks.tsk_a = task('tsk_a');
  assert.throws(() => run(DOCUMENT_OPERATIONS, 'document.registerExternal', state, {
    title: 'Spec', locator: { bindingId: 'b1', relPath: 'docs/spec.md' },
    hash: hash('f'), status: 'adopted', rev: 7,
  }, agent), { code: 'invalid-command' });
  const { result } = run(DOCUMENT_OPERATIONS, 'document.registerExternal', state, {
    title: ' Spec ', kind: 'spec', locator: { bindingId: 'b1', relPath: 'docs/spec.md' },
    links: { taskIds: ['tsk_a'] },
  }, agent);
  const doc = result.events[0].data;
  assert.equal(doc.id, 'doc_a');
  assert.equal(doc.source, 'external');
  assert.equal(doc.rev, 1);
  assert.equal(doc.status, 'draft');
  assert.equal(doc.hash, undefined);
  assert.deepEqual(doc.createdBy, { kind: 'agent', sessionId: 's_ops', agentId: 'a_ops' });
  assert.deepEqual(doc.links.taskIds, ['tsk_a']);
  assert.equal(result.result.docId, 'doc_a');
});

function externalDoc(overrides = {}) {
  return {
    id: 'doc_a', source: 'external', rev: 1, title: 'Spec', kind: 'spec', status: 'draft',
    locator: { bindingId: 'b1', relPath: 'docs/spec.md' }, links: { taskIds: [], planRefs: [] },
    baseline: null, baselineInContext: false, unregistered: null, createdAt: AT, updatedAt: AT,
    ...overrides,
  };
}

// 责任：外置管理状态只沿合法边迁移，归档重开必须带理由并记录真实字段差异。
test('external update_meta enforces edges, requires a reopen reason and records the actual field diff', () => {
  const state = projectState();
  state.docs.doc_a = externalDoc();
  assert.throws(() => run(DOCUMENT_OPERATIONS, 'document.editExternalMetadata', state, { docId: 'doc_a', expectedMetaRev: 1, status: 'adopted' }), { code: 'illegal-transition' });
  assert.throws(() => run(DOCUMENT_OPERATIONS, 'document.editExternalMetadata', state, { docId: 'doc_a', expectedMetaRev: 1 }), { code: 'invalid-command' });
  assert.throws(() => run(DOCUMENT_OPERATIONS, 'document.editExternalMetadata', state, { docId: 'doc_a', expectedMetaRev: 2, title: 'X' }), { code: 'stale-revision' });
  const { result } = run(DOCUMENT_OPERATIONS, 'document.editExternalMetadata', state, {
    docId: 'doc_a', expectedMetaRev: 1, title: 'Spec v2', status: 'in_review',
  });
  const event = result.events[0];
  assert.equal(event.type, 'doc/external-updated');
  assert.equal(event.data.rev, 2);
  assert.equal(event.data.status, 'in_review');
  assert.deepEqual(event.change.fields, ['title', 'status']);
  assert.deepEqual(event.change.transition, { from: 'draft', to: 'in_review', reason: null });

  const archived = projectState();
  archived.docs.doc_a = externalDoc({ status: 'archived', rev: 4 });
  assert.throws(() => run(DOCUMENT_OPERATIONS, 'document.editExternalMetadata', archived, { docId: 'doc_a', expectedMetaRev: 4, status: 'draft' }), { code: 'invalid-command' });
  const { result: reopened } = run(DOCUMENT_OPERATIONS, 'document.editExternalMetadata', archived, { docId: 'doc_a', expectedMetaRev: 4, status: 'draft', reason: ' reopen ' });
  assert.deepEqual(reopened.events[0].change.transition, { from: 'archived', to: 'draft', reason: 'reopen' });
});

// 责任：确认基线只取事务外观测事实，调用方不能自带记录字段伪造基线。
test('external confirm builds the baseline from the observation, not from caller-supplied record fields', () => {
  const state = projectState();
  state.docs.doc_a = externalDoc();
  const observation = { contentHash: hash('c'), size: 21, bindingId: 'b1', relPath: 'docs/spec.md', retained: true };
  assert.throws(() => run(DOCUMENT_OPERATIONS, 'document.confirmExternalBaseline', state, {
    docId: 'doc_a', expectedMetaRev: 1, expectedContentHash: hash('d'), observation,
  }), { code: 'stale-revision' });
  assert.throws(() => run(DOCUMENT_OPERATIONS, 'document.confirmExternalBaseline', state, {
    docId: 'doc_a', expectedMetaRev: 1, expectedContentHash: hash('c'), observation,
    baseline: { contentHash: hash('e') },
  }), { code: 'invalid-command' });
  const { result } = run(DOCUMENT_OPERATIONS, 'document.confirmExternalBaseline', state, {
    docId: 'doc_a', expectedMetaRev: 1, expectedContentHash: hash('c'), observation,
  });
  assert.deepEqual(result.events.map(event => event.type), ['doc/workspace-retained', 'doc/external-confirmed']);
  const doc = result.events[1].data;
  assert.deepEqual(Object.keys(doc.baseline).sort(), ['bindingId', 'confirmedAt', 'confirmedBy', 'contentHash', 'domain', 'readerVersion', 'relPath', 'workspaceVersion']);
  assert.deepEqual(doc.baseline.workspaceVersion, result.events[0].data.version.versionRef);
  assert.equal(doc.baseline.contentHash, hash('c'));
  assert.equal(doc.baseline.confirmedAt, AT);
  assert.equal(doc.baselineInContext, true);
});

// 责任：外置定位迁移拒绝同目标写入，并保留旧基线供审计。
test('external relocate refuses a same-target write and keeps the previous baseline for audit', () => {
  const state = projectState();
  state.docs.doc_a = externalDoc({ baseline: { domain: 'workspace-bytes', contentHash: hash('a'), bindingId: 'b1', relPath: 'docs/spec.md', gitHeadOid: null, confirmedAt: AT, confirmedBy: human, readerVersion: 'v' }, baselineInContext: true });
  assert.throws(() => run(DOCUMENT_OPERATIONS, 'document.moveExternalLocator', state, { docId: 'doc_a', expectedMetaRev: 1, locator: { bindingId: 'b1', relPath: 'docs/spec.md' } }), { code: 'invalid-command' });
  const { result } = run(DOCUMENT_OPERATIONS, 'document.moveExternalLocator', state, { docId: 'doc_a', expectedMetaRev: 1, locator: { bindingId: 'b2', relPath: 'moved/spec.md' }, reason: 'move' });
  assert.deepEqual(result.events[0].data.locator, { bindingId: 'b2', relPath: 'moved/spec.md' });
  assert.equal(result.events[0].data.baselineInContext, false);
  assert.equal(result.events[0].data.baseline.relPath, 'docs/spec.md');
});

// 责任：绑定退役后的 rebind 只迁移仍在旧绑定的记录并报告实际匹配。
test('external rebind moves only docs still on the retired binding and reports actual matches', () => {
  const state = projectState();
  state.docs.doc_a = externalDoc();
  state.docs.doc_b = externalDoc({ id: 'doc_b', locator: { bindingId: 'b2', relPath: 'b.md' } });
  state.docs.doc_c = externalDoc({ id: 'doc_c', unregistered: { at: AT, by: human, reason: null } });
  const { result } = run(DOCUMENT_OPERATIONS, 'document.rebindExternalBinding', state, { fromBindingId: 'b1', toBindingId: 'b3' }, human, { expected: { projectRev: 0 } });
  assert.equal(result.result.matched, 1);
  assert.deepEqual(result.result.docIds, ['doc_a']);
  assert.deepEqual(result.events[0].data.locator, { bindingId: 'b3', relPath: 'docs/spec.md' });
  assert.equal(result.events[0].change.rebind, true);
});

// 责任：注销只产生墓碑记录，之后的管理写必须被拒绝。
test('external unregister tombstones the record and later management writes are refused', () => {
  const state = projectState();
  state.docs.doc_a = externalDoc();
  const { result } = run(DOCUMENT_OPERATIONS, 'document.unregisterExternal', state, { docId: 'doc_a', expectedMetaRev: 1, reason: ' superseded ' });
  const doc = result.events[0].data;
  assert.equal(doc.rev, 2);
  assert.equal(doc.unregistered.reason, 'superseded');
  assert.equal(doc.unregistered.by.kind, 'human');
  state.docs.doc_a = doc;
  assert.throws(() => run(DOCUMENT_OPERATIONS, 'document.editExternalMetadata', state, { docId: 'doc_a', expectedMetaRev: 2, title: 'Z' }), { code: 'illegal-transition' });
});

// 责任：迁移保留身份与历史映射，只有完全相同的重复映射才幂等。
test('migration keeps identity/history and is idempotent only for the exact same mapping', () => {
  const state = projectState();
  state.docs.doc_a = {
    id: 'doc_a', rev: 3, title: 'Spec', kind: 'note', hash: hash('b'), size: 2,
    links: { taskIds: [], planRefs: [] }, createdAt: AT, updatedAt: AT,
  };
  state.lastSeq = 4; state.lastHash = 'sha256:' + hash('e');
  const args = {
    sourceDocId: 'doc_a', sourceRev: 3, sourceHash: hash('b'),
    locator: { bindingId: 'b1', relPath: 'spec.md' },
    target: { contentHash: hash('b'), size: 2 },
    history: [
      { sourceRev: 1, sourceHash: hash('a'), size: 2, archive: { domain: 'inline-utf8', hash: hash('a'), readOnly: true, gitManaged: false } },
      { sourceRev: 3, sourceHash: hash('b'), size: 2, archive: { domain: 'inline-utf8', hash: hash('b'), readOnly: true, gitManaged: false } },
    ],
    backup: { projectId: 'prj_ops', seq: 4, hash: 'sha256:' + hash('e'), restoreTested: true },
  };
  const { result } = run(DOCUMENT_OPERATIONS, 'document.convertInlineToExternal', state, args, human, { authorized: true });
  const event = result.events[0];
  assert.equal(event.type, 'doc/external-migrated');
  assert.equal(event.sourceRev, 3);
  assert.equal(event.data.id, 'doc_a');
  assert.equal(event.data.rev, 4);
  assert.deepEqual(event.data.links, { taskIds: [], planRefs: [] });
  assert.deepEqual(event.data.migration.target.locator, args.locator);
  assert.deepEqual(result.result.mapping.history, args.history);

  state.docs.doc_a = event.data;
  const duplicate = run(DOCUMENT_OPERATIONS, 'document.convertInlineToExternal', state, args, human, { authorized: true });
  assert.deepEqual(duplicate.result.events, []);
  assert.deepEqual(duplicate.result.result.mapping, result.result.mapping);
  assert.deepEqual(run(DOCUMENT_OPERATIONS, 'document.convertInlineToExternal', state, { ...args, backup: null }, human, { authorized: true }).result.result.mapping, result.result.mapping);
  assert.throws(() => run(DOCUMENT_OPERATIONS, 'document.convertInlineToExternal', state, { ...args, sourceHash: hash('f') }, human, { authorized: true }), { code: 'migration-conflict' });
  assert.throws(() => run(DOCUMENT_OPERATIONS, 'document.convertInlineToExternal', projectState(), { ...args, sourceDocId: 'doc_missing' }, human, { authorized: true }), { code: 'not-found' });
});

// 责任：项目更新只发布一条项目记录，解除归档时同批释放活工作。
test('project.update publishes one project record and releases live work only when unarchiving', () => {
  const active = projectState({ phase: 'paused' });
  active.tasks.tsk_a = task('tsk_a', { state: 'in_progress', owner: { sessionId: 's1' }, rev: 2 });
  const { result } = run(projectOperations, 'project.applyUpdate', active, { name: ' Renamed ', phase: 'active', policy: { maxInProgress: 2 } });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].data.name, 'Renamed');
  assert.equal(result.events[0].data.updatedAt, AT);
  assert.equal(result.events[0].data.policy.maxInProgress, 2);

  const archived = projectState({ phase: 'archived', policy: { maxInProgress: 3 } });
  archived.tasks.tsk_a = task('tsk_a', { state: 'in_progress', owner: { sessionId: 's1' }, rev: 2 });
  const archivedWork = work(archived);
  archivedWork.leases.set('tsk_a', { taskId: 'tsk_a', sessionId: 's1' });
  const unarchive = projectOperations['project.applyUpdate'](archivedWork, { phase: 'active' }, identity(human));
  assert.deepEqual(unarchive.events.map((event) => event.type), ['project/updated', 'task/readied']);
  assert.equal(unarchive.events[1].data.state, 'ready');
  assert.equal(unarchive.events[1].data.rev, 3);
  assert.equal(archivedWork.leases.size, 0, 'unarchive must not keep runtime leases');
});

// 责任：项目搬迁路径只来自操作参数，归档项目只接受解除归档。
test('project.relocate derives the new path from its argument and refuses archived non-unarchive updates', () => {
  const state = projectState({ phase: 'paused' });
  assert.throws(() => run(projectOperations, 'project.moveWorkspace', state, { workspacePath: 'D:/next', project: { name: 'evil' } }), { code: 'invalid-command' });
  const { result } = run(projectOperations, 'project.moveWorkspace', state, { workspacePath: 'D:/next' });
  assert.equal(result.events[0].data.workspacePath, 'D:/next');
  assert.equal(result.events[0].data.name, 'ops');
  assert.equal(result.events[0].data.updatedAt, AT);
  const archived = projectState({ phase: 'archived' });
  assert.throws(() => run(projectOperations, 'project.applyUpdate', archived, { name: 'No' }), { code: 'project-archived' });
});

// 责任：内嵌写策略需要精确项目版本，未变化不产生事件，翻转必须可审计。
test('project.inline_policy requires the expected revision, is eventless when unchanged and auditable when flipped', () => {
  const state = projectState({ inlineWritesDisabled: true });
  state.lastSeq = 4;
  const job = work(state);
  const policyRequest = identity(human, { authorized: true });
  assert.throws(() => projectOperations['project.setInlineWritePolicy'](job, { disabled: false, expectedProjectRev: 3 }, policyRequest), { code: 'stale-revision' });
  assert.deepEqual(projectOperations['project.setInlineWritePolicy'](job, { disabled: true, expectedProjectRev: 4 }, policyRequest).events, []);
  const { result } = run(projectOperations, 'project.setInlineWritePolicy', state, { disabled: false, expectedProjectRev: 4 }, human, { authorized: true });
  assert.equal(result.events[0].data.inlineWritesDisabled, false);
});

// 责任：会话交接身份取自可信 request.actor，参数不能伪造会话或项目。
test('session notes take the session identity from request.actor and cannot be spoofed by args', () => {
  const state = projectState();
  assert.throws(() => run(sessionOperations, 'session.recordCheckpoint', state, {
    note: 'checkpoint', sessionId: 's_spoof', projectId: 'prj_spoof',
  }, agent), { code: 'invalid-command' });
  const { result } = run(sessionOperations, 'session.recordCheckpoint', state, {
    note: '  checkpoint  ', nextActions: ['next'],
  }, agent);
  assert.deepEqual(result.events[0], {
    type: 'session/checkpoint',
    data: { sessionId: 's_ops', projectId: 'prj_ops', note: 'checkpoint', nextActions: ['next'], at: AT },
  });
  const handoff = run(sessionOperations, 'session.recordHandoff', state, { note: 'handoff' }, agent);
  assert.equal(handoff.result.events[0].type, 'session/handoff');
  assert.throws(() => run(sessionOperations, 'session.recordCheckpoint', state, { note: 'x' }, human), { code: 'forbidden-role' });
  assert.throws(() => run(sessionOperations, 'session.recordCheckpoint', state, { note: '  ' }, agent), { code: 'invalid-command' });
});

// 责任：无公开命令名时仍保持角色、授权和合法状态；参数不能冒充可信身份。
test('independent operations enforce trusted identity, explicit permission and legal edges', () => {
  const state = projectState();
  state.docs.doc_a = externalDoc();
  const migrationArgs = { sourceDocId: 'doc_a', sourceRev: 1, sourceHash: hash('a'), locator: { bindingId: 'b1', relPath: 'x.md' }, target: { contentHash: hash('a'), size: 1 }, history: [], backup: { projectId: 'prj_ops', restoreTested: true } };
  assert.throws(() => run(projectOperations, 'project.applyUpdate', state, { name: 'X' }, agent), { code: 'forbidden-role' });
  assert.throws(() => run(projectOperations, 'project.moveWorkspace', state, { workspacePath: 'D:/x' }, agent), { code: 'forbidden-role' });
  assert.throws(() => run(projectOperations, 'project.setInlineWritePolicy', state, { disabled: false, expectedProjectRev: 0 }, agent, { authorized: true }), { code: 'forbidden-role' });
  assert.throws(() => run(projectOperations, 'project.setInlineWritePolicy', state, { disabled: false, expectedProjectRev: 0 }, human), { code: 'migration-authorization-required' });
  assert.throws(() => run(DOCUMENT_OPERATIONS, 'document.convertInlineToExternal', state, migrationArgs, human, { authorized: false }), { code: 'migration-authorization-required' });
  assert.throws(() => run(DOCUMENT_OPERATIONS, 'document.convertInlineToExternal', state, migrationArgs, agent, { authorized: true }), { code: 'forbidden-role' });
  assert.throws(() => run(projectOperations, 'project.applyUpdate', state, { phase: 'bogus' }), { code: 'invalid-command' });
  assert.throws(() => run(projectOperations, 'project.moveWorkspace', state, { workspacePath: '' }), { code: 'invalid-command' });
  for (const key of ['actor', 'authorized', 'op', 'payload']) assert.throws(() => run(DOCUMENT_OPERATIONS, 'document.editExternalMetadata', state, { docId: 'doc_a', expectedMetaRev: 1, title: 'Y', [key]: human }, agent), { code: 'invalid-command' });
  assert.throws(() => run(DOCUMENT_OPERATIONS, 'document.registerExternal', state, { title: 'X', locator: state.docs.doc_a.locator }, { kind: 'intruder' }), { code: 'forbidden-role' });
  assert.throws(() => run(sessionOperations, 'session.recordHandoff', state, { note: 'X' }, { kind: 'human', sessionId: agent.sessionId }), { code: 'forbidden-role' });
});

// 责任：rebind 模型操作可被直接测试，并且拒绝同一绑定的空迁移。
test('rebindExternalDocuments is exported for direct model tests and rejects a same-binding rebind', () => {
  const state = projectState();
  assert.throws(() => rebindExternalDocuments(work(state), { fromBindingId: 'b1', toBindingId: 'b1' }, identity(human, { expected: { projectRev: 0 } })), { code: 'invalid-command' });
});

// 责任：模型独立执行时也不绕过项目策略、正文身份边界或绑定精确 CAS。
test('nameless document operations preserve policy, body bounds and exact rebind CAS', () => {
  const state = projectState({ inlineWritesDisabled: true });
  const args = { title: 'X', hash: hash('a'), size: 1 };
  assert.throws(() => run(DOCUMENT_OPERATIONS, 'document.writeRevision', state, args), { code: 'inline-write-disabled' });
  assert.throws(() => run(DOCUMENT_OPERATIONS, 'document.writeRevision', state, { ...args, privilegedInlineWrites: true }), { code: 'invalid-command' });
  state.project.inlineWritesDisabled = false;
  for (const fields of [{ hash: 'bad' }, { size: -1 }, { size: 262145 }, { size: 1.5 }]) assert.throws(() => run(DOCUMENT_OPERATIONS, 'document.writeRevision', state, { ...args, ...fields }), { code: 'invalid-command' });
  state.docs.doc_a = externalDoc(); state.lastSeq = 3;
  const before = structuredClone(state);
  assert.throws(() => run(DOCUMENT_OPERATIONS, 'document.rebindExternalBinding', state, { fromBindingId: 'b1', toBindingId: 'b2' }, human, { expected: { projectRev: 2 } }), { code: 'stale-revision' });
  assert.deepEqual(state, before);
  const result = run(DOCUMENT_OPERATIONS, 'document.rebindExternalBinding', state, { fromBindingId: 'b1', toBindingId: 'b2' }, human, { expected: { projectRev: 3 } });
  assert.equal(result.result.events[0].data.locator.bindingId, 'b2');
});

// 责任：内容确认必须绑定同一目标事实，不能借别的文件哈希伪造此文档的基线。
test('baseline confirmation rejects another locator and malformed observations without mutation', () => {
  const state = projectState(); state.docs.doc_a = externalDoc();
  const args = { docId: 'doc_a', expectedMetaRev: 1, expectedContentHash: hash('a'), observation: { contentHash: hash('a'), size: 1, bindingId: 'b1', relPath: 'docs/spec.md', retained: true } };
  const before = structuredClone(state);
  for (const fields of [{ bindingId: 'other' }, { relPath: 'other.md' }, { size: -1 }, { confirmedBy: human }]) assert.throws(() => run(DOCUMENT_OPERATIONS, 'document.confirmExternalBaseline', state, { ...args, observation: { ...args.observation, ...fields } }), { code: 'invalid-command' });
  assert.deepEqual(state, before);
});

// 责任：授权只允许申请迁移，不替代源 CAS、目标字节与历史档案事实校验。
test('authorized nameless migration still rejects wrong source target history and destination facts', () => {
  const state = projectState();
  state.docs.doc_a = { id: 'doc_a', rev: 1, title: 'Spec', kind: 'note', hash: hash('a'), size: 2, links: { taskIds: [], planRefs: [] }, createdAt: AT, updatedAt: AT };
  state.lastSeq = 2; state.lastHash = 'sha256:' + hash('e');
  const args = { sourceDocId: 'doc_a', sourceRev: 1, sourceHash: hash('a'), locator: { bindingId: 'b1', relPath: 'spec.md' }, target: { contentHash: hash('a'), size: 2 }, history: [{ sourceRev: 1, sourceHash: hash('a'), size: 2, archive: { domain: 'inline-utf8', hash: hash('a'), readOnly: true, gitManaged: false } }], backup: { projectId: 'prj_ops', seq: 2, hash: 'sha256:' + hash('e'), restoreTested: true } };
  const before = structuredClone(state);
  const invoke = (fields) => run(DOCUMENT_OPERATIONS, 'document.convertInlineToExternal', state, { ...args, ...fields }, human, { authorized: true });
  assert.throws(() => invoke({ sourceRev: 2 }), { code: 'stale-revision' });
  assert.throws(() => invoke({ target: { contentHash: hash('b'), size: 2 } }), { code: 'migration-conflict' });
  assert.throws(() => invoke({ target: { contentHash: hash('a'), size: 3 } }), { code: 'migration-conflict' });
  assert.throws(() => invoke({ history: [] }), { code: 'invalid-external-doc' });
  assert.throws(() => invoke({ history: [{ ...args.history[0], archive: { ...args.history[0].archive, gitManaged: true } }] }), { code: 'invalid-external-doc' });
  assert.throws(() => invoke({ backup: { projectId: 'foreign', restoreTested: true } }), { code: 'migration-backup-required' });
  for (const proof of [{ ...args.backup, seq: 3 }, { ...args.backup, hash: 'sha256:' + hash('f') }, { ...args.backup, hash: 'bad' }, { ...args.backup, seq: 0 }]) assert.throws(() => invoke({ backup: proof }), { code: 'migration-backup-required' });
  assert.deepEqual(state, before);
  state.docs.doc_b = externalDoc({ id: 'doc_b', locator: args.locator });
  assert.throws(() => invoke({}), { code: 'migration-conflict' });
});

// 责任：真实事务执行器只凭稳定身份和操作值完成文档/会话事实，拒绝后不发布模型或介质。
test('real transaction model runs nameless document project and session operations atomically', async () => {
  const { TransactionModel } = await import('../../lib/core/transaction/model.js');
  const model = new TransactionModel({ state: projectState({ inlineWritesDisabled: true }) });
  const medium = { commits: [], commitPhysical(record) { this.commits.push(structuredClone(record)); return { seq: record.seq, hash: record.hash }; } };
  let id = 0;
  const ports = { medium, clock: () => new Date(AT), newId: (prefix) => prefix + '_model', systemActor: { kind: 'system' }, privilegedInlineWrites: false };
  const runModel = (operations, actor = human, extra = {}) => {
    const header = { cmdId: 'nameless-' + ++id, actor, expected: { projectRev: model.rev }, ...extra };
    const { sample } = model.beginCommand(header, [{ kind: 'lease.normalizeBeforeCommand', args: {} }], ports);
    return model.submitOperations(sample, operations);
  };
  const registered = runModel([{ kind: 'document.registerExternal', args: { title: 'Model', locator: { bindingId: 'b1', relPath: 'model.md' } } }], agent);
  assert.equal(registered.events[0].type, 'doc/external-registered');
  assert.deepEqual(model.state.docs.doc_model.createdBy, { kind: 'agent', sessionId: agent.sessionId, agentId: agent.agentId });
  const before = model.snapshot(), count = medium.commits.length;
  assert.throws(() => runModel([{ kind: 'document.editExternalMetadata', args: { docId: 'doc_model', expectedMetaRev: 1, status: 'adopted' } }]), { code: 'illegal-transition' });
  assert.throws(() => runModel([{ kind: 'project.setInlineWritePolicy', args: { disabled: false, expectedProjectRev: model.rev } }], agent, { authorized: true }), { code: 'forbidden-role' });
  assert.throws(() => runModel([{ kind: 'project.setInlineWritePolicy', args: { disabled: false, expectedProjectRev: model.rev } }]), { code: 'migration-authorization-required' });
  assert.throws(() => runModel([{ kind: 'document.writeRevision', args: { title: 'No', hash: hash('a'), size: 1 } }]), { code: 'inline-write-disabled' });
  assert.deepEqual(model.snapshot(), before); assert.equal(medium.commits.length, count);
  runModel([{ kind: 'project.setInlineWritePolicy', args: { disabled: false, expectedProjectRev: model.rev } }], human, { authorized: true });
  assert.equal(model.state.project.inlineWritesDisabled, false);
  for (const [kind, type] of [['session.recordCheckpoint', 'session/checkpoint'], ['session.recordHandoff', 'session/handoff']]) {
    const result = runModel([{ kind, args: { note: '交接' } }], agent);
    assert.equal(result.events[0].type, type);
    assert.equal(result.events[0].data.sessionId, agent.sessionId);
  }
  assert.throws(() => model.beginCommand({ cmdId: 'raw-command', actor: human, op: 'doc.put' }, [{ kind: 'lease.normalizeBeforeCommand', args: {} }], ports), { code: 'invalid-command' });
});
