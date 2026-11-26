/**
 * 测试职责：逐项核对计划、内嵌档案、证据、旧审查、会话与固定内容的留存来源。
 * 典型流程：正常领域命令生成多版本 → 人工列出预期原文 → 搜索并精确读回。
 * 覆盖边界：覆盖留存来源逐项对照；不覆盖工作区扫描或命令证据执行。
 * 外部前置：固定内容用例需要本地 Git，仅操作合成仓库。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createKnowledgeReader } from '../../lib/core/knowledge/reader.js';
import { encodeReference } from '../../lib/core/knowledge/reference.js';
import { BoardError } from '../../lib/core/errors.js';
import { ProjectService } from '../../lib/core/service.js';
import { DOCUMENT_RELATION_OPERATIONS } from '../../lib/core/domain/operations/documents-relations.js';
import { makeService, withProject } from '../helpers/service-fixture.mjs';
import { bootstrapPin, seedLegacyGitRelation, repository, git, put } from '../helpers/fixed-fixture.mjs';
import { knowledgeFixture, addTask, cmd, registerFile, tree } from '../helpers/knowledge-fixture.mjs';

async function submit(h, taskId, evidence) {
  const expected = () => ({ entityRev: h.state.tasks[taskId].rev });
  await h.command(cmd('task.claim', { taskId, expected: expected() }));
  const fencingToken = h.leases.get(taskId).token;
  await h.command(cmd('task.begin', { taskId, expected: expected(), fencingToken, summary: 'syntheticintent' }));
  await h.command(cmd('task.submit', { taskId, expected: expected(), fencingToken,
    evidence: evidence.map(row => ({ ...row, acceptanceId: h.state.tasks[taskId].acceptance[0].id })) }));
}

// 责任：旧计划、同一内嵌文档的旧版本和 additive 会话说明均保留原文。
test('immutable plans, inline revisions and additive session notes all retain their original wording', async t => {
  const f = await knowledgeFixture(t);
  await f.h.command(cmd('plan.publish', { title: 'Plan fixture', goal: 'legacyplanword',
    steps: [{ id: 's1', title: 'First', tasks: [{ key: 'x', title: 'Member', acceptance: [{ text: 'pass' }] }] }] }));
  const planId = f.h.state.project.focusPlanId;
  await f.h.command(cmd('plan.revise', { planId, baseVersion: 1, goal: 'currentplanword', steps: [{ id: 's1', title: 'First' }] }));
  const doc = await f.h.command(cmd('doc.put', { title: 'Archive', body: 'inlineoldword 第一版' }));
  const docId = doc.events[0].data.id;
  await f.h.command(cmd('doc.put', { docId, baseRev: 1, title: 'Archive', body: 'inlinenewword 第二版' }));
  assert.equal(f.h.state.docs[docId].rev, 2);
  await f.h.command(cmd('session.checkpoint', { actor: { kind: 'agent', sessionId: 'synthetic-history' }, note: 'checkpointword 继续核验原始边界' }));
  f.h.store.saveSnapshot();
  for (const [query, kind, expected] of [['legacyplanword', 'plan', 'legacyplanword'], ['currentplanword', 'plan', 'currentplanword'],
    ['inlineoldword', 'content', 'inlineoldword 第一版'], ['inlinenewword', 'content', 'inlinenewword 第二版'],
    ['checkpointword', 'session', 'checkpointword 继续核验原始边界']]) {
    const found = await f.search(query, { kinds: [kind] });
    assert.ok(found.hits.length, query);
    const read = await f.read(found.hits[0].ref);
    assert.ok(read.records[0].content.includes(expected), query);
  }
  const plans = await f.search('legacyplanword', { kinds: ['plan'] });
  const history = await f.search('legacyplanword', { kinds: ['plan'], historyRef: plans.hits[0].ref });
  const oldPlan = history.hits.find(row => row.eventType === 'plan/published');
  assert.equal(oldPlan.version, 1);
  const planRecord = JSON.parse((await f.read(oldPlan.ref)).records[0].content);
  assert.equal(planRecord.data.goal, 'legacyplanword');
  assert.ok(planRecord.head, 'the saved event head is part of the public original record');
});

// 责任：明确文档版本的证据只能展开对应旧版，再沿引用读到其原正文。
test('explicit evidence revision expands the saved document version, not current metadata', async t => {
  const f = await knowledgeFixture(t);
  const taskId = await addTask(f.h, 'Version binding');
  const first = await f.h.command(cmd('doc.put', { title: 'Versioned doc', body: 'boundoldbody' }));
  const docId = first.events[0].data.id;
  await submit(f.h, taskId, [{ kind: 'doc', ref: docId + '@1', summary: 'boundevidencemarker' }]);
  await f.h.command(cmd('doc.put', { docId, baseRev: 1, title: 'Versioned doc', body: 'boundnewbody' }));
  const evidence = (await f.search('boundevidencemarker', { kinds: ['evidence'] })).hits[0];
  const context = await f.read(evidence.ref, { mode: 'context' });
  const document = context.related.find(row => row.via.reason === 'evidence.document');
  assert.equal(document.revision, 1);
  assert.equal(document.via.scope, 'explicit-version');
  const expanded = await f.read(document.ref, { mode: 'context' });
  const content = expanded.related.find(row => row.via.reason === 'source.content');
  assert.equal((await f.read(content.ref)).records[0].content, 'boundoldbody');
});

// 责任：任务重开后仍能读取旧证据和审查，命令材料不会被执行。
test('superseded evidence and prior audit survive reopen; command refs are records only', async t => {
  const f = await knowledgeFixture(t);
  const taskId = await addTask(f.h, 'Audit fixture');
  await submit(f.h, taskId, [{ kind: 'note', ref: 'evidenceoldword' }, { kind: 'command', ref: 'never_execute_fixture_command', summary: 'commandmarker' }]);
  await f.h.command(cmd('task.verify', { taskId, expected: { entityRev: f.h.state.tasks[taskId].rev }, note: 'auditoldword 原始验收说明留存并不代表后来仍然适用' }));
  await f.h.command(cmd('task.reopen', { taskId, expected: { entityRev: f.h.state.tasks[taskId].rev }, reason: 'New work changes context' }));
  assert.equal(f.h.state.tasks[taskId].lastAudit, null);
  await submit(f.h, taskId, [{ kind: 'note', ref: 'evidencenewword' }]);
  // 真正关闭 writer 后冷读：保留对所有文件（含锁）的逐字节断言，
  // 不把另一个活跃 writer 的正常心跳计作查询的副作用，也不排除任何路径。
  const dir = f.h.meta.dir;
  await f.svc.close();
  const cold = await makeService(t, { rootDir: f.stateDir, workspacePath: f.wsDir });
  const reader = createKnowledgeReader(cold.svc);
  t.after(() => reader.close());
  const before = tree(dir);
  assert.ok(!before.some(([name]) => name === 'lock.json'));
  for (const [word, kind] of [['auditoldword', 'audit'], ['evidenceoldword', 'evidence'], ['commandmarker', 'evidence'], ['syntheticintent', 'event']]) {
    const result = await reader.search({ projectId: f.projectId, query: word, kinds: [kind], relatedLimit: 0 });
    assert.ok(result.hits.length, word);
    if (word === 'evidenceoldword') assert.equal(result.hits[0].fragment, word);
    assert.ok((await reader.read({ projectId: f.projectId, refs: [result.hits[0].ref] })).records[0].content.includes(word));
  }
  assert.deepEqual(tree(dir), before);
});

// 责任：文件证据核对内容 hash 并隐藏绝对路径，撤销登记后停止当前正文读取。
test('file evidence is hash-bound, absolute paths are hidden, and unregistered docs stop automatic body reads', async t => {
  const f = await knowledgeFixture(t);
  const taskId = await addTask(f.h, 'File evidence fixture');
  const file = path.join(f.wsDir, 'evidence.txt');
  fs.writeFileSync(file, 'evidencebodyword retained only on disk');
  await submit(f.h, taskId, [{ kind: 'file', ref: file }]);
  const found = await f.search('evidencebodyword', { kinds: ['content'] });
  assert.equal(found.hits.length, 1);
  assert.ok(!JSON.stringify(found).includes(f.wsDir));
  assert.ok(!JSON.stringify(await f.read(found.hits[0].ref)).includes(f.wsDir.replaceAll('\\', '\\\\')));
  fs.writeFileSync(file, 'changed');
  assert.equal((await f.read(found.hits[0].ref)).records[0].availability, 'source-changed');
  const registered = await registerFile(f, 'registered.md', 'unregisteredmarker');
  const observed = (await f.search('unregisteredmarker', { kinds: ['content'] })).hits[0];
  await f.h.command(cmd('doc.external.unregister', { docId: registered.docId, expectedMetaRev: 1 }));
  assert.equal((await f.read(observed.ref)).records[0].availability, 'source-unregistered');
  assert.equal((await f.search('unregisteredmarker', { kinds: ['content'] })).hits.length, 0);
});

// 责任：旧 kb1 固定引用仅显示已记录来源，不读 Git 字节或回填当前正文。
test('recorded Git kb1 sources remain identifiable but never return or index historical bytes', async t => {
  const { root } = repository('sha1', t);
  put(root, 'history.md', 'fixedhistoryword original Git bytes\n');
  git(root, 'add', 'history.md');
  git(root, 'commit', '-m', 'fixed history fixture');
  const { svc, h } = await withProject(t, { workspacePath: root });
  const registered = await h.command(cmd('doc.external.register', { title: 'History', relPath: 'history.md' }));
  const evidence = await bootstrapPin(h, registered.docId);
  assert.ok(evidence.fixed);
  const commit = h.store.commits.find(row => row.events.some(event => event.type === 'doc/content-fixed' && event.data.ref === registered.docId));
  const event = commit.events.findIndex(row => row.type === 'doc/content-fixed' && row.data.ref === registered.docId);
  const ref = encodeReference({ projectId: h.id, seq: commit.seq, commitHash: commit.hash, event, part: 'fixed', contentHash: evidence.fixed.blobContentHash });
  put(root, 'history.md', 'changed workspace bytes');
  const reader = createKnowledgeReader(svc);
  t.after(() => reader.close());
  const read = await reader.read({ projectId: h.id, refs: [ref] });
  const record = read.records[0];
  assert.equal(record.availability, 'legacy-git-record-only');
  assert.equal(record.provenance, 'legacy-git');
  assert.equal(record.deprecated, true);
  assert.equal(record.reverified, false);
  assert.deepEqual(record.fixed, evidence.fixed);
  assert.equal(record.content, null);
  const compact = await reader.read({ projectId: h.id, refs: [ref], mode: 'compact' });
  assert.deepEqual(compact.records[0].fixed, evidence.fixed);
  assert.equal(compact.records[0].reverified, false);
  assert.equal((await reader.search({ projectId: h.id, query: 'fixedhistoryword', kinds: ['content'], relatedLimit: 0 })).hits.length, 0);
  await assert.rejects(reader.read({ projectId: 'prj_not_this_project', refs: [ref] }));
});

function committedLocator(h, write, eventType, kind) {
  assert.equal(write.committed, true);
  const commit = h.store.commits[write.projectRev - 1];
  assert.equal(commit.seq, write.projectRev);
  const event = commit.events.findIndex(row => row.type === eventType);
  assert.ok(event >= 0);
  const { data, head } = commit.events[event];
  const from = { kind, id: data.id, seq: commit.seq, event };
  const ref = encodeReference({ projectId: h.id, seq: commit.seq, commitHash: commit.hash, event, part: 'record' });
  return { from, ref, expectedRev: head?.rev ?? data.rev };
}

const exactRows = result => result.related.filter(row => row.via.reason === 'document.version-relation');

async function owningSpace(t, options = {}) {
  const services = [];
  t.after(async () => { for (const service of services.toReversed()) await service.close(); });
  const { wsDir } = await makeService(t);
  const spaceRoot = fs.realpathSync.native(wsDir);
  const open = async () => {
    const service = new ProjectService({ ...options, spaceRoot });
    services.push(service);
    return service.init();
  };
  const service = await open();
  const h = await service.createProject({ workspacePath: spaceRoot, actor: { kind: 'human', via: 'test' } });
  return { h, service, open, wsDir: spaceRoot };
}

// 责任：已提交关系绑定精确历史正文和任务事件，不关联现行、同文或其他版本。
test('knowledge context reopens the exact workspace relation, preserves loss, and hides denied targets', async t => {
  let denyPrefixes = [];
  const f = await owningSpace(t, { projectionDenyPrefixes: () => denyPrefixes });
  const { h, service, open, wsDir: spaceRoot } = f;
  const a = committedLocator(h, await h.command(cmd('task.create', {
    title: 'Relation anchor', acceptance: [{ text: 'Verify exact bytes' }],
  })), 'task/created', 'task');
  const original = '\uFEFF旧版：exact body\r\n';
  const { file, docId } = await registerFile(f, 'decisions/retain.md', original, { links: { taskIds: [a.from.id] } });
  await registerFile(f, 'decisions/matching-only.md', original, { links: { taskIds: [a.from.id] } });
  const linked = await h.command(cmd('doc.relation.add', {
    from: a.from, expectedRev: a.expectedRev, to: { kind: 'workspace-current', docId },
  }));
  assert.equal(linked.relationState, 'exact');
  const b = committedLocator(h, await h.command(cmd('task.update', {
    taskId: a.from.id, expected: { entityRev: a.expectedRev }, description: 'The same task, different committed edition',
  })), 'task/updated', 'task');
  fs.writeFileSync(file, 'Unrelated current bytes');
  await h.command(cmd('doc.relation.remove', { relationId: linked.relationId, expectedRev: b.expectedRev }));
  const relationCommit = h.store.commits[linked.projectRev - 1];
  const rawRelation = encodeReference({ projectId: h.id, seq: relationCommit.seq, commitHash: relationCommit.hash,
    event: relationCommit.events.findIndex(event => event.type === 'doc/relation-added'), part: 'record' });
  await service.close();
  const cold = await open();
  const reader = createKnowledgeReader(cold);
  t.after(() => reader.close());
  let granted = true;
  const authority = { scopeKey: 'synthetic-workspace', assertCurrent() {
    if (!granted) throw new BoardError('project-forbidden', 'Synthetic grant revoked', { status: 403 });
  } };
  const lifecycle = { authority };
  const read = (ref, extra = {}, access = lifecycle) => reader.read({ projectId: h.id, refs: [ref], mode: 'context', ...extra }, access);
  const authorityDir = path.join(spaceRoot, '.projectboard');
  const before = tree(authorityDir);

  const expanded = await read(a.ref);
  assert.equal(exactRows(expanded).length, 1, 'current metadata and matching text do not synthesize exact relations');
  const [document] = exactRows(expanded);
  assert.equal(document.availability, 'available');
  assert.match(document.ref, /^kb2\./u);
  assert.equal(document.via.documentRef, document.ref);
  assert.equal(document.via.direction, 'out');
  assert.equal(document.via.basis, 'recorded');
  assert.equal(document.via.scope, 'explicit-version');
  assert.deepEqual(document.via.relation.fromVersion, a.from);
  assert.deepEqual(document.via.relation.toVersionRef, linked.toVersionRef);
  assert.equal(document.via.relation.relationId, linked.relationId);
  assert.ok(document.via.relation.closedAt, 'closed fact remains historical');
  assert.ok(!JSON.stringify(expanded).includes('doc/relation-'));
  assert.deepEqual(exactRows(await read(b.ref)), [], 'another committed event for the same task does not inherit the edge');
  assert.deepEqual(exactRows(await read(a.ref, { relatedLimit: 0 })), []);
  const bounded = await read(a.ref, { relatedLimit: 1 });
  assert.deepEqual(bounded.related.map(row => row.ref), [document.ref]);
  assert.equal(bounded.relatedTruncated, true);
  await assert.rejects(read(rawRelation), { code: 'knowledge-reference-invalid' });

  const reopened = await read(document.ref);
  assert.equal(reopened.records[0].content, original);
  const [reverse] = exactRows(reopened);
  assert.equal(reverse.ref, a.ref);
  assert.equal(reverse.via.direction, 'in');
  assert.deepEqual(reverse.via.relation, document.via.relation);
  assert.equal(reverse.via.documentRef, document.ref);
  assert.deepEqual(exactRows(await read(a.ref, {}, {})), [], 'the legacy non-workspace reader gains no exact workspace relation');
  assert.ok(!JSON.stringify(await read(a.ref, {}, {})).includes(linked.relationId));

  denyPrefixes = ['decisions'];
  const denied = await read(a.ref);
  assert.ok(!JSON.stringify(denied).includes(linked.relationId), 'policy denial does not disclose relation or availability');
  denyPrefixes = [];
  granted = false;
  await assert.rejects(read(a.ref), { code: 'project-forbidden' });
  granted = true;

  const hash = reopened.records[0].contentHash;
  const object = path.join(authorityDir, 'objects', 'workspace-bytes', hash.slice(0, 2), hash);
  assert.equal(fs.realpathSync.native(object), object);
  assert.deepEqual(fs.readFileSync(object), Buffer.from(original));
  const held = object + '.fixture-held';
  assert.equal(fs.lstatSync(held, { throwIfNoEntry: false }), undefined);
  fs.renameSync(object, held);
  try {
    const missing = await read(a.ref);
    assert.deepEqual(exactRows(missing), []);
    const unavailable = missing.relatedUnavailable.find(row => row.reason === 'document.version-relation');
    assert.equal(unavailable.availability, 'content-object-missing');
    assert.equal(unavailable.targetRef, document.ref);
    assert.deepEqual(unavailable.via.relation, document.via.relation);
    assert.equal((await read(document.ref)).records[0].content, null);
    assert.equal(fs.readFileSync(file, 'utf8'), 'Unrelated current bytes');
  } finally {
    assert.equal(fs.realpathSync.native(held), held);
    assert.equal(fs.lstatSync(object, { throwIfNoEntry: false }), undefined);
    fs.renameSync(held, object);
  }
  assert.deepEqual(tree(authorityDir), before, 'cold knowledge reads never change the authoritative store');
  assert.equal(cold.handles.size, 0);
});

// 责任：历史计划事件只展开并回读它明确关联的内嵌档案版。
test('knowledge context maps an exact plan event to an archival inline revision', async t => {
  const f = await owningSpace(t, { privilegedInlineWrites: true });
  const reader = createKnowledgeReader(f.service);
  t.after(() => reader.close());
  const read = ref => reader.read({ projectId: f.h.id, refs: [ref], mode: 'context' });
  const plan = committedLocator(f.h, await f.h.command(cmd('plan.publish', {
    title: 'Exact plan archive', steps: [{ id: 's1', title: 'First',
      tasks: [{ key: 'item', title: 'Plan member', acceptance: [{ text: 'Verify archive' }] }] }],
  })), 'plan/published', 'plan');
  const inline = await f.h.command(cmd('doc.put', { title: 'Archive', body: 'old exact archival bytes' }));
  const docId = inline.events.find(event => event.type === 'doc/created').data.id;
  await f.h.command(cmd('doc.put', { docId, baseRev: 1, title: 'Archive', body: 'new unlinked archive' }));
  const to = { kind: 'inline', docId, rev: 1 };
  const linked = await f.h.command(cmd('doc.relation.add', { from: plan.from, expectedRev: plan.expectedRev, to }));
  assert.equal(linked.relationState, 'exact');
  const [archive] = exactRows(await read(plan.ref));
  assert.equal(archive.revision, 1);
  assert.deepEqual(archive.via.relation.fromVersion, plan.from);
  assert.deepEqual(archive.via.relation.toVersionRef, to);
  const material = await read(archive.ref);
  assert.equal(material.records[0].content, 'old exact archival bytes');
  assert.deepEqual(exactRows(material).map(row => row.ref), [plan.ref]);
});

// 责任：当前正文的整源、分块和续读均按原始 UTF-8 字节覆盖 BOM、CRLF 和多字节。
test('workspace whole and chunk references preserve BOM and exact UTF-8 byte intervals', async t => {
  const f = await owningSpace(t);
  const authority = { scopeKey: 'byte-check', assertCurrent() {} };
  const reader = createKnowledgeReader(f.service);
  t.after(() => reader.close());
  const text = '\uFEFFp5rawmarker：记录🙂\r\n' + '中🙂'.repeat(700);
  const bytes = Buffer.from(text);
  fs.writeFileSync(path.join(f.wsDir, 'raw-bom.md'), bytes);
  const found = await reader.search({ projectId: f.h.id, query: 'p5rawmarker', kinds: ['content'], relatedLimit: 0 }, { authority });
  const [hit] = found.hits;
  assert.match(hit.ref, /^kb2\./u);
  assert.equal(hit.sourceRange.start, 0);
  const read = (ref, rest = {}) => reader.read({ projectId: f.h.id, refs: [ref], ...rest }, { authority });
  assert.equal((await read(hit.sourceRef)).records[0].content, text);
  const original = bytes.subarray(hit.sourceRange.start, hit.sourceRange.end);
  const first = (await read(hit.ref, { maxBytes: 27 })).records[0];
  const part = [first.content];
  let cursor = first.nextCursor;
  while (cursor) {
    const entry = (await read(hit.ref, { maxBytes: 1024, cursor })).records[0];
    part.push(entry.content); cursor = entry.nextCursor;
  }
  assert.deepEqual(Buffer.from(part.join('')), original);
});

// 责任：旧索引页的失效正文既不交付，也不吞掉下一页仍获准的命中。
test('a fully stale indexed result page still leaves valid later results reachable', async t => {
  const f = await owningSpace(t);
  const authority = { scopeKey: 'stale-page-check', assertCurrent() {} };
  const reader = createKnowledgeReader(f.service);
  t.after(() => reader.close());
  for (let i = 0; i < 7; i++) fs.writeFileSync(path.join(f.wsDir, 'file-' + i + '.md'), 'p5stalequery current text ' + i);
  const search = args => reader.search({ projectId: f.h.id, query: 'p5stalequery', kinds: ['content'], relatedLimit: 0, ...args }, { authority });
  let all = await search({ limit: 20 });
  if (all.engine !== 'fts5') return t.skip('SQLite unavailable: this checks a persisted FTS page');
  for (let i = 0; all.hits.length < 7 && i < 6; i++) all = await search({ limit: 20 });
  assert.equal(all.hits.length, 7);
  const first = await search({ limit: 2 });
  assert.deepEqual(first.hits.map(hit => hit.ref), all.hits.slice(0, 2).map(hit => hit.ref));
  for (const hit of all.hits.slice(2, 5)) fs.writeFileSync(path.join(f.wsDir, hit.sourceVersion.relPath), 'changed after indexing');
  const stale = await search({ limit: 2, cursor: first.nextCursor });
  assert.deepEqual(stale.hits, []);
  assert.equal(stale.coverage.workspace.hidden['source-changed'], 2);
  assert.ok(stale.nextCursor);
  const next = await search({ limit: 2, cursor: stale.nextCursor });
  assert.equal(next.hits[0].ref, all.hits[5].ref);
});

// 责任：带授权的派生索引损坏后新代重建，留存正文和精确引用依然从真实来源回读。
test('a damaged scoped index rebuilds retained refs and rejects the previous generation cursor', async t => {
  const f = await owningSpace(t);
  const authority = { scopeKey: 'scoped-rebuild', assertCurrent() {} };
  const reader = createKnowledgeReader(f.service);
  t.after(() => reader.close());
  const retainedText = 'rebuildscopekey 留存版本\r\n';
  const { file, docId } = await registerFile(f, 'rebuild-retained.md', retainedText);
  await f.h.command(cmd('doc.workspace_capture', { docId }));
  fs.writeFileSync(file, 'new unrelated content');
  fs.writeFileSync(path.join(f.wsDir, 'rebuild-current.md'), 'rebuildscopekey current content');
  const search = args => reader.search({ projectId: f.h.id, query: 'rebuildscopekey', kinds: ['content'], relatedLimit: 0, ...args }, { authority });
  const proof = await search({ limit: 8 });
  if (proof.engine !== 'fts5') return t.skip('SQLite unavailable: fallback has distinct tests');
  assert.deepEqual(new Set(proof.hits.map(hit => hit.sourcePart)), new Set(['workspace-body', 'workspace-current']));
  const { sourceRef } = proof.hits.find(hit => hit.sourcePart === 'workspace-body');
  const first = await search({ limit: 1 });
  assert.ok(first.nextCursor);
  const cache = path.join(f.service.rootDir, 'knowledge-cache');
  const [slot, ...rest] = fs.readdirSync(cache).filter(entry => /-[a-f0-9]{64}\.sqlite$/u.test(entry));
  assert.ok(slot); assert.equal(rest.length, 0);
  const slotPath = path.join(cache, slot);
  assert.equal(fs.realpathSync.native(slotPath), slotPath);
  fs.writeFileSync(slotPath, 'synthetic broken SQLite cache');
  const rebuilt = await search({ limit: 8 });
  assert.deepEqual(rebuilt.hits.map(hit => hit.ref).sort(), proof.hits.map(hit => hit.ref).sort());
  await assert.rejects(search({ limit: 1, cursor: first.nextCursor }), { code: 'knowledge-cursor-stale' });
  const body = await reader.read({ projectId: f.h.id, refs: [sourceRef] }, { authority });
  assert.equal(body.records[0].content, retainedText);
});

// 责任：旧 Git 关系保留已记录目标，即使没有可用 Git 介质也不改变主记录。
test('legacy Git relations return recorded targets without Git ownership scans', async t => {
  let denyPrefixes = [];
  const f = await owningSpace(t, { projectionDenyPrefixes: () => denyPrefixes });
  const { docId } = await registerFile(f, 'fixed-budget.md', 'present workspace bytes\n');
  const pinned = await bootstrapPin(f.h, docId, { synthetic: true });
  assert.equal(fs.lstatSync(path.join(f.wsDir, '.git'), { throwIfNoEntry: false }), undefined);
  const a = committedLocator(f.h, await f.h.command(cmd('task.create', {
    title: 'Primary source unaffected by legacy Git', acceptance: [{ text: 'Primary source remains readable' }],
  })), 'task/created', 'task');
  const to = { kind: 'git-fixed', docId, fixed: pinned.fixed };
  await assert.rejects(f.h.command(cmd('doc.relation.add', { from: a.from, expectedRev: a.expectedRev, to })), { code: 'invalid-command' });
  assert.throws(() => DOCUMENT_RELATION_OPERATIONS['document.addRelation']({ state: f.h.state }, {
    from: a.from, to, ownerId: a.from.id, expectedRev: a.expectedRev,
  }, { actor: { kind: 'human' } }), { code: 'invalid-command' });
  const link = seedLegacyGitRelation(f.h, { from: a.from, to });
  const authority = { scopeKey: 'git-record-check', assertCurrent() {} };
  const reader = createKnowledgeReader(f.service);
  t.after(() => reader.close());
  const read = ref => reader.read({ projectId: f.h.id, refs: [ref], mode: 'context', relatedLimit: 2 }, { authority });
  const initial = await read(a.ref);
  const [target] = exactRows(initial);
  assert.ok(target);
  assert.equal(target.availability, 'legacy-git-record-only');
  assert.deepEqual(target.fixed, pinned.fixed);
  assert.equal(target.via.relation.relationId, link.relationId);
  const source = (await read(target.ref)).records[0];
  assert.equal(source.content, null);
  assert.equal(source.reverified, false);
  assert.deepEqual(exactRows(await read(target.ref)).map(row => row.ref), [a.ref]);
  denyPrefixes = ['fixed-budget.md'];
  assert.ok(!JSON.stringify(await read(a.ref)).includes(link.relationId), 'record-only relations still respect current path policy');
  const denied = (await read(target.ref)).records[0];
  assert.equal(denied.content, null);
  assert.equal(Object.hasOwn(denied, 'fixed'), false, 'denied identity does not expose the fixed target');
});
