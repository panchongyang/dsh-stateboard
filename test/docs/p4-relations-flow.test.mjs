/**
 * 测试职责：核对已提交工作版本 → 显式文档关系 → 双向查询及精确正文的 core 链。
 * 典型流程：同一任务两次定位 A/B，当前文件变 C，解除链接后冷开回读旧版本。
 * 覆盖边界：覆盖关系关闭、去重、拒绝、降级与确认基线；不覆盖宿主协议。
 * 外部前置：仅隔离的合成临时空间；Git 固定版本用例使用本地 Git，无网络依赖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ProjectService } from '../../lib/core/service.js';
import { createProjectReader } from '../../lib/core/project-reader.js';
import { bootstrapPin, seedLegacyGitRelation, repository } from '../helpers/fixed-fixture.mjs';

const actor = { kind: 'human', via: 'test' };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const ledger = root => fs.readFileSync(path.join(root, '.projectboard', 'state', 'commits.jsonl'));
const objectAt = (root, hash) => path.join(root, '.projectboard', 'objects', 'workspace-bytes', hash.slice(0, 2), hash);
const current = docId => ({ kind: 'workspace-current', docId });
const target = (docId, versionId) => ({ kind: 'workspace-body', docId, versionId });
const ids = result => result.relations.map(row => row.relationId);

async function connect(t, root, id, options) {
  const service = await new ProjectService({ spaceRoot: root, ...options }).init();
  const reader = createProjectReader(service);
  const close = async () => { await reader.close(); await service.close(); };
  t.after(close);
  const handle = id ? null : await service.createProject({ workspacePath: root, actor });
  const projectId = id ?? handle.id;
  const command = (op, args) => service.command(projectId, { op, cmdId: randomUUID(), actor, ...args });
  const query = (view, params) => reader.query(projectId, view, params, actor);
  const relations = params => query('doc_relations', params);
  return { root, projectId, service, handle, command, query, relations, close };
}

async function fixture(t, options) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'p4-relations-')));
  return connect(t, root, null, options);
}

function source(write, type, kind, id) {
  assert.equal(write.committed, true, 'source must come from a committed write');
  const event = write.events.findIndex(row => row.type === type);
  assert.ok(event >= 0, 'source event exists: ' + type);
  return { kind, id: id ?? write.events[event].data.id, seq: write.projectRev, event };
}

async function task(f, title = 'Task A') {
  const write = await f.command('task.create', { title, acceptance: [{ text: 'Evidence exists' }] });
  const from = source(write, 'task/created', 'task');
  return { from, expectedRev: write.events[from.event].data.rev };
}

async function revise(f, before, title = 'Task B') {
  const write = await f.command('task.update', { taskId: before.from.id, expected: { entityRev: before.expectedRev }, title });
  const from = source(write, 'task/updated', 'task');
  return { from, expectedRev: write.events[from.event].data.rev };
}

async function register(f, name, bytes, args) {
  const file = path.join(f.root, name);
  fs.writeFileSync(file, bytes);
  const reg = await f.command('doc.external.register', { title: name, kind: 'decision', relPath: name, ...args });
  return { file, docId: reg.docId };
}

function parkFile(root, file, expectedBytes) {
  const relative = path.relative(root, file);
  assert.ok(relative && !path.isAbsolute(relative) && !relative.startsWith('..' + path.sep) && relative !== '..');
  assert.equal(fs.realpathSync.native(file), file);
  assert.ok(fs.lstatSync(file).isFile());
  assert.deepEqual(fs.readFileSync(file), Buffer.from(expectedBytes));
  const parked = file + '.p4-fixture-held';
  assert.equal(fs.lstatSync(parked, { throwIfNoEntry: false }), undefined);
  fs.renameSync(file, parked);
  return () => {
    assert.equal(fs.realpathSync.native(parked), parked);
    assert.deepEqual(fs.readFileSync(parked), Buffer.from(expectedBytes));
    assert.equal(fs.lstatSync(file, { throwIfNoEntry: false }), undefined);
    fs.renameSync(parked, file);
  };
}

async function exactBody(f, link, docId, bytes) {
  const read = await f.relations({ relationId: link.relationId });
  assert.equal(read.docId, docId);
  assert.equal(read.relation.relationId, link.relationId);
  assert.deepEqual(read.relation.toVersionRef, link.toVersionRef);
  assert.equal(read.versionRef.versionId, link.toVersionRef.versionId);
  assert.equal(read.versionRef.contentHash, sha(bytes));
  assert.equal(read.body, bytes);
  return read.relation;
}

// 责任：当前链接和精确历史独立；不同任务版本保留各自正文，冷读与重试不追加事实。
test('task versions reference A and B after C, current unlink, exact removal and cold replay', async t => {
  const f = await fixture(t);
  const a = await task(f);
  const textA = '\uFEFF决策 A\r\n', textB = '决策 B\n', textC = 'C (current only)\n';
  const { docId, file } = await register(f, 'decision.md', textA, { links: { taskIds: [a.from.id] } });
  const registered = (await f.query('doc_record', { docId })).doc;
  assert.deepEqual(registered.links.taskIds, [a.from.id]);
  assert.deepEqual(ids(await f.relations({ docId })), [], 'a stable current link is not an exact fact');
  assert.deepEqual((await f.query('workspace_history', { docId })).versions, [], 'registration and reads do not capture');
  const first = await f.command('doc.relation.add', { ...a, to: current(docId) });
  assert.equal(first.relationState, 'exact');
  assert.deepEqual(first.events.map(row => row.type), ['doc/workspace-retained', 'doc/relation-added'], 'one commit both captures and relates');
  const taskA = (await f.query('task', { taskId: a.from.id })).task;
  assert.equal(taskA.rev, a.expectedRev, 'relation does not advance its source revision');
  assert.equal(taskA.title, 'Task A');
  assert.deepEqual((await f.query('doc_record', { docId })).doc, registered, 'exact relation changes no current metadata');

  fs.writeFileSync(file, textB);
  const b = await revise(f, a);
  const taskB = (await f.query('task', { taskId: b.from.id })).task;
  const addB = { ...b, to: current(docId), cmdId: randomUUID() };
  const second = await f.command('doc.relation.add', addB);
  assert.equal(second.relationState, 'exact');
  assert.notEqual(first.relationId, second.relationId);
  assert.notEqual(first.toVersionRef.versionId, second.toVersionRef.versionId);
  const afterB = ledger(f.root);
  const duplicate = await f.command('doc.relation.add', { ...b, to: current(docId) });
  assert.equal(duplicate.relationId, second.relationId);
  assert.equal(duplicate.relationState, 'exact');
  assert.deepEqual(ledger(f.root), afterB, 'equivalent open relation and retention are no-ops');

  fs.writeFileSync(file, textC);
  await f.command('doc.external.update_meta', { docId, expectedMetaRev: registered.rev, links: { taskIds: [] } });
  assert.deepEqual((await f.query('doc_record', { docId })).doc.links.taskIds, []);
  assert.equal((await f.query('workspace_compare', { docId, versionId: second.toVersionRef.versionId })).state, 'changed');
  assert.deepEqual(ids(await f.relations({ from: b.from })), [second.relationId], 'unlinking the current doc does not close exact history');
  await assert.rejects(f.command('doc.relation.remove', { relationId: second.relationId, expectedRev: a.expectedRev }), { code: 'stale-revision' });
  await f.command('doc.relation.remove', { relationId: second.relationId, expectedRev: b.expectedRev });
  assert.deepEqual((await f.query('task', { taskId: b.from.id })).task, taskB, 'add/remove do not transition or edit the task');
  const unlinked = (await f.query('doc_record', { docId })).doc;
  await f.command('doc.external.unregister', { docId, expectedMetaRev: unlinked.rev, reason: 'retire current locator' });
  assert.equal(fs.readFileSync(file, 'utf8'), textC);
  await f.close();

  const cold = await connect(t, f.root, f.projectId);
  const beforeReads = ledger(f.root);
  const firstRow = await exactBody(cold, first, docId, textA);
  const secondRow = await exactBody(cold, second, docId, textB);
  assert.equal(firstRow.relationKind, 'reference');
  assert.deepEqual(firstRow.fromVersion, a.from);
  assert.deepEqual(secondRow.fromVersion, b.from);
  assert.equal(firstRow.sourceOwnerId, a.from.id);
  assert.equal(secondRow.sourceOwnerId, a.from.id);
  assert.ok(!firstRow.closedAt);
  assert.ok(secondRow.closedAt);
  assert.deepEqual(ids(await cold.relations({ from: a.from })), [first.relationId]);
  assert.deepEqual(ids(await cold.relations({ docId, versionId: first.toVersionRef.versionId })), [first.relationId]);
  assert.deepEqual(ids(await cold.relations({ to: target(docId, second.toVersionRef.versionId) })), [second.relationId]);
  const page = await cold.relations({ docId, limit: 1 });
  assert.ok(page.nextCursor);
  const last = await cold.relations({ docId, limit: 1, after: page.nextCursor });
  assert.equal(last.nextCursor, null);
  assert.deepEqual([...ids(page), ...ids(last)].sort(), [first.relationId, second.relationId].sort());
  const bounded = await cold.relations({ relationId: second.relationId, maxBytes: Buffer.byteLength('决策') });
  assert.equal(bounded.body, '决策');
  assert.equal(bounded.relation.relationId, second.relationId);
  assert.equal(cold.service.handles.size, 0, 'cold reads never open a writer');
  assert.deepEqual(ledger(f.root), beforeReads);

  // Same command ID after replay returns the existing write outcome, never a new fact about C.
  const retry = await cold.command('doc.relation.add', addB);
  assert.equal(retry.deduped, true);
  assert.deepEqual(ledger(f.root), beforeReads);
  assert.deepEqual(ids(await cold.relations({ from: b.from })), [second.relationId]);
  assert.equal(fs.existsSync(objectAt(f.root, sha(textC))), false, 'neither read nor restart retry captures C');
});

// 责任：伪造定位、过期 revision、旧 metadata rev 和不明选择器不能变成历史事实。
test('malformed, forged, stale and cross-document references fail without capture or fallback', async t => {
  const f = await fixture(t);
  const a = await task(f), other = await task(f, 'Other task'), b = await revise(f, a);
  const { docId, file } = await register(f, 'spec.md', 'prior retained text\n', { links: { taskIds: [a.from.id] } });
  const { docId: otherDoc } = await register(f, 'other.md', 'prior retained text\n');
  const pinned = (await f.command('doc.workspace_capture', { docId })).versionRef;
  const changed = 'different current text\n';
  fs.writeFileSync(file, changed);
  const unretained = await f.query('workspace_compare', { docId, versionId: 'not-retained' });
  assert.equal(unretained.state, 'unavailable');
  assert.equal(unretained.reason, 'version-not-retained');
  assert.deepEqual(ids(await f.relations({ from: a.from })), [], 'even a captured doc with a current link has no implicit relation');
  assert.deepEqual(ids(await f.relations({ docId })), []);
  const before = ledger(f.root);
  const unrecordedFixed = {
    v: 1, projectId: f.projectId, pathAtCommit: 'spec.md', objectFormat: 'sha1',
    commitOid: '1'.repeat(40), blobOid: '2'.repeat(40), blobContentHash: pinned.contentHash,
  };
  const invalidAdds = [
    [{ ...a, to: current(docId) }, 'stale-revision'],
    [{ ...b, from: { ...b.from, seq: b.from.seq + 10_000 }, to: current(docId) }, 'not-found'],
    [{ ...b, from: { ...b.from, event: b.from.event + 1 }, to: current(docId) }, 'not-found'],
    [{ ...b, from: { ...b.from, id: other.from.id }, to: current(docId) }, 'not-found'],
    [{ ...b, from: { ...b.from, kind: 'event' }, to: current(docId) }, 'invalid-command'],
    [{ ...b, to: { kind: 'inline', docId, rev: 1 } }, 'not-found'],
    [{ ...b, to: { kind: 'workspace-current', docId, rev: 1 } }, 'invalid-command'],
    [{ ...b, to: target(otherDoc, pinned.versionId) }, 'not-found'],
    [{ ...b, to: target(docId, 'forged-version') }, 'not-found'],
    [{ ...b, to: { kind: 'git-fixed', docId, fixed: unrecordedFixed } }, 'invalid-command'],
    [{ ...b, to: pinned }, 'invalid-command'],
    [{ ...b, to: current(docId), actor: { kind: 'observer', via: 'test' } }, 'forbidden-role'],
  ];
  for (const [args, code] of invalidAdds) await assert.rejects(f.command('doc.relation.add', args), { code });
  for (const selector of [{}, { from: a.from, docId }, { versionId: pinned.versionId }, { to: current(docId) }, { docId, maxBytes: 1 }]) {
    await assert.rejects(f.relations(selector), { code: 'invalid-command' });
  }
  assert.deepEqual(ledger(f.root), before);
  assert.equal(fs.existsSync(objectAt(f.root, sha(changed))), false, 'invalid requests leave no retained object');
  assert.deepEqual((await f.query('workspace_history', { docId })).versions.map(row => row.versionRef), [pinned]);
  assert.deepEqual(ids(await f.relations({ docId })), []);
});

// 责任：缺少当前文件可如实降级，缺少已承诺的对象不得猜测现有文件或掩盖错误。
test('current-only observation failure and a missing retained object are distinct, durable outcomes', async t => {
  const f = await fixture(t);
  const a = await task(f);
  const initial = 'Original retained A\n', latest = 'Unrelated live B\n';
  const { docId, file } = await register(f, 'decision.md', initial, { links: { taskIds: [a.from.id] } });
  const first = await f.command('doc.relation.add', { ...a, to: current(docId) });
  const b = await revise(f, a);
  fs.writeFileSync(file, latest);
  const restoreCurrent = parkFile(f.root, file, latest);
  const before = ledger(f.root);
  try {
    const result = await f.command('doc.relation.add', { ...b, to: current(docId) });
    assert.equal(result.relationState, 'current-only');
    assert.equal(result.reason, 'file-missing');
    assert.ok(!result.relationId && !result.toVersionRef);
    const replacement = await f.command('doc.relation.add', {
      from: a.from, expectedRev: b.expectedRev, to: current(docId), replacesId: first.relationId,
    });
    assert.equal(replacement.relationState, 'current-only');
    assert.deepEqual(ids(await f.relations({ from: b.from })), []);
    assert.deepEqual((await f.query('doc_record', { docId })).doc.links.taskIds, [a.from.id]);
    const historical = await exactBody(f, first, docId, initial);
    assert.ok(!historical.closedAt, 'failed replacement leaves the old exact relation open');
    assert.deepEqual(ledger(f.root), before, 'failed observation does not retain or append a fact');
  } finally { restoreCurrent(); }

  const object = objectAt(f.root, sha(initial));
  const restoreObject = parkFile(f.root, object, initial);
  try {
    assert.deepEqual(ids(await f.relations({ docId, versionId: first.toVersionRef.versionId })), [first.relationId]);
    const unavailable = await f.relations({ relationId: first.relationId });
    assert.equal(unavailable.relation.relationId, first.relationId);
    assert.equal(unavailable.versionRef.versionId, first.toVersionRef.versionId);
    assert.equal(unavailable.state, 'unavailable');
    assert.equal(unavailable.reason, 'content-object-missing');
    assert.equal(Object.hasOwn(unavailable, 'body'), false);
    await assert.rejects(f.command('doc.relation.add', { ...b, to: target(docId, first.toVersionRef.versionId) }), { code: 'content-object-missing' });
    assert.deepEqual(ledger(f.root), before);
    assert.equal(fs.readFileSync(file, 'utf8'), latest, 'neither exact path falls back to or edits current content');
  } finally { restoreObject(); }
  await exactBody(f, first, docId, initial);
});

// 责任：显式替代只关闭同一来源的关系；文档用途、管理状态和正文确认互不推进。
test('explicit replacement differs from document responsibility, management state and confirmation', async t => {
  const f = await fixture(t);
  const a = await task(f), other = await task(f, 'Different source');
  const initial = 'Prior rule\n', revised = 'Revised practice\n';
  const { docId: priorDocId } = await register(f, 'prior.md', initial);
  const { docId, file } = await register(f, 'practice.md', initial, {
    purpose: 'Explain the practice', scope: 'Operators', supersedes: [priorDocId],
  });
  const { doc: registered } = await f.query('doc_record', { docId });
  assert.deepEqual(
    { kind: registered.kind, purpose: registered.purpose, scope: registered.scope, supersedes: registered.supersedes, status: registered.status, baseline: registered.baseline },
    { kind: 'decision', purpose: 'Explain the practice', scope: 'Operators', supersedes: [priorDocId], status: 'draft', baseline: null },
  );
  assert.deepEqual(ids(await f.relations({ docId })), [], 'declared supersession does not synthesize version relations');
  assert.equal((await f.query('doc_record', { docId: priorDocId })).doc.status, 'draft', 'supersedes does not archive the older document');
  await f.command('doc.external.confirm', { docId, expectedMetaRev: registered.rev, expectedContentHash: sha(initial) });
  const first = await f.command('doc.relation.add', { ...a, to: current(docId) });
  const { doc: confirmed } = await f.query('doc_record', { docId });
  assert.equal(confirmed.status, 'draft', 'confirm and relate do not move management state');
  assert.equal(confirmed.baseline.contentHash, sha(initial));

  fs.writeFileSync(file, revised);
  await f.command('doc.external.update_meta', { docId, expectedMetaRev: confirmed.rev, purpose: 'Guide review', status: 'in_review' });
  const edited = await f.query('inspect', { docId, fresh: true });
  assert.equal(edited.doc.purpose, 'Guide review');
  assert.equal(edited.doc.scope, 'Operators');
  assert.deepEqual(edited.doc.supersedes, [priorDocId]);
  assert.equal(edited.doc.status, 'in_review');
  assert.deepEqual(edited.doc.baseline, confirmed.baseline, 'metadata edits do not move the byte baseline');
  assert.equal(edited.confirmation.state, 'changed_since_confirm');
  const before = ledger(f.root);
  await assert.rejects(f.command('doc.relation.add', { ...other, to: current(docId), replacesId: first.relationId }), { code: 'invalid-command' });
  assert.deepEqual(ledger(f.root), before);

  const second = await f.command('doc.relation.add', { ...a, to: current(docId), replacesId: first.relationId });
  assert.equal(second.relationState, 'exact');
  assert.notEqual(second.relationId, first.relationId);
  const closed = await exactBody(f, first, docId, initial);
  const active = await exactBody(f, second, docId, revised);
  assert.deepEqual(closed.fromVersion, active.fromVersion);
  assert.ok(closed.closedAt);
  assert.equal(closed.replacedBy, active.relationId);
  assert.ok(!active.closedAt);
  assert.deepEqual((await f.query('doc_record', { docId })).doc, edited.doc);
  assert.equal((await f.query('inspect', { docId, fresh: true })).confirmation.state, 'changed_since_confirm');
  await f.close();
  const cold = await connect(t, f.root, f.projectId);
  assert.deepEqual(await exactBody(cold, first, docId, initial), closed);
  assert.deepEqual((await cold.query('doc_record', { docId })).doc, edited.doc);
});

async function submitForReview(f, taskId) {
  const h = f.handle;
  const worker = { kind: 'agent', sessionId: 'p4-fixture-worker', agentId: 'p4-fixture-worker' };
  const expected = () => ({ entityRev: h.state.tasks[taskId].rev });
  await h.attach({ ...worker, source: 'test', role: 'worker' });
  await f.command('task.claim', { actor: worker, taskId, expected: expected() });
  const fencingToken = h.leases.get(taskId).token;
  await f.command('task.begin', { actor: worker, taskId, expected: expected(), fencingToken, summary: 'Fixture work' });
  const acceptanceId = h.state.tasks[taskId].acceptance[0].id;
  return f.command('task.submit', {
    actor: worker, taskId, expected: expected(), fencingToken,
    evidence: [{ kind: 'note', ref: 'Synthetic evidence', acceptanceId }],
  });
}

// 责任：计划、证据和审查按各自的已提交位置反查；内嵌档案仍用其独立旧 rev。
test('plan, evidence and audit sources reverse to their exact committed ordinals and owners', async t => {
  const f = await fixture(t, { privilegedInlineWrites: true });
  const plan = await f.command('plan.publish', {
    title: 'Plan for review', steps: [{ id: 'step', title: 'Review step', tasks: [{ key: 'work', title: 'Review work', acceptance: [{ text: 'Evidence exists' }] }] }],
  });
  const planFrom = source(plan, 'plan/published', 'plan');
  const taskId = plan.events.find(row => row.type === 'task/created').data.id;
  const submitted = await submitForReview(f, taskId);
  const taskAtSubmit = submitted.events.find(row => row.type === 'task/submitted').data;
  const evidence = source(submitted, 'task/submitted', 'evidence', taskAtSubmit.evidence[0].id);
  assert.ok(evidence.event > 0, 'submission writes the work result before the task event');
  const verified = await f.command('task.verify', { taskId, expected: { entityRev: taskAtSubmit.rev } });
  const taskAtVerify = verified.events.find(row => row.type === 'task/verified').data;
  const audit = source(verified, 'task/verified', 'audit', taskAtVerify.lastAudit.id);
  const ownerTask = (await f.query('task', { taskId })).task;
  assert.equal(ownerTask.state, 'done', 'human verification still works without a report');
  const { docId } = await register(f, 'review.md', 'Reviewed text\n');
  const inline = await f.command('doc.put', { title: 'Inline archive', body: 'Archive rev 1\n' });
  const inlineTarget = { kind: 'inline', docId: inline.events.find(row => row.type === 'doc/created').docId, rev: 1 };
  await f.command('doc.put', { docId: inlineTarget.docId, baseRev: 1, title: 'Inline archive', body: 'Archive rev 2\n' });
  assert.equal((await f.query('doc', { docId: inlineTarget.docId })).body, 'Archive rev 2\n');

  const planLink = await f.command('doc.relation.add', {
    from: planFrom, to: inlineTarget, expectedRev: plan.events[planFrom.event].head.rev,
  });
  const oldLink = await f.command('doc.relation.add', { from: evidence, to: current(docId), expectedRev: taskAtVerify.rev });
  const auditLink = await f.command('doc.relation.add', { from: audit, to: oldLink.toVersionRef, expectedRev: taskAtVerify.rev });
  assert.equal(planLink.relationState, 'exact');
  assert.deepEqual(planLink.toVersionRef, inlineTarget);
  const archive = await f.relations({ relationId: planLink.relationId });
  assert.deepEqual(archive.readRef, inlineTarget);
  assert.equal(archive.body, 'Archive rev 1\n');
  assert.equal(archive.truncated, false);
  const archivePreview = await f.relations({ relationId: planLink.relationId, maxBytes: 7 });
  assert.equal(archivePreview.body, 'Archive');
  assert.equal(archivePreview.truncated, true);
  const planRows = (await f.relations({ to: inlineTarget })).relations;
  assert.equal(planRows.length, 1);
  assert.deepEqual(planRows[0].fromVersion, planFrom);
  assert.equal(planRows[0].sourceOwnerId, planFrom.id);
  const reviewRows = (await f.relations({ to: auditLink.toVersionRef })).relations;
  assert.deepEqual(reviewRows.map(row => row.relationId).sort(), [oldLink.relationId, auditLink.relationId].sort());
  assert.deepEqual(reviewRows.find(row => row.relationId === oldLink.relationId).fromVersion, evidence);
  assert.deepEqual(reviewRows.find(row => row.relationId === auditLink.relationId).fromVersion, audit);
  assert.ok(reviewRows.every(row => row.sourceOwnerId === taskId));
  assert.deepEqual((await f.query('task', { taskId })).task, ownerTask);
});

// 责任：关系只指向已记录的 Git 固定版本，不能用工作区现状替代或采集成另一版本。
test('a recorded Git pin remains the exact reverse and read reference after workspace drift', async t => {
  const { root, oid } = repository();
  const f = await connect(t, root);
  const relPath = 'docs/spec.md';
  const { docId } = await f.command('doc.external.register', { title: 'Git decision', relPath });
  const pinned = await bootstrapPin(f.handle, docId);
  assert.equal(pinned.fixedState, 'pinned', pinned.fixedReason);
  assert.equal(pinned.fixed.commitOid, oid);
  assert.equal(pinned.fixed.blobContentHash, sha('version one\n'));
  const file = path.join(root, relPath), changed = 'Uncommitted working text\n';
  fs.writeFileSync(file, changed);

  const a = await task(f, 'Reference recorded Git evidence');
  const to = { kind: 'git-fixed', docId, fixed: pinned.fixed };
  await assert.rejects(f.command('doc.relation.add', { ...a, to }), { code: 'invalid-command' });
  const result = seedLegacyGitRelation(f.handle, { from: a.from, to });
  assert.equal(result.relationState, 'exact');
  assert.deepEqual(result.toVersionRef, to);
  const metadata = structuredClone(f.handle.state.docs[docId]);
  const recorded = structuredClone(f.handle.state.fixedContents);
  f.handle.store.saveSnapshot();
  const snapshotFile = path.join(root, '.projectboard', 'state', 'snapshot.json');
  const snapshotBytes = fs.readFileSync(snapshotFile);
  assert.deepEqual(JSON.parse(snapshotBytes).state.fixedContents, recorded);
  await f.close();
  const gitDir = path.join(root, '.git'), heldGit = path.join(root, '.git.fixture-held');
  assert.equal(fs.realpathSync.native(gitDir), gitDir);
  assert.equal(fs.lstatSync(gitDir).isDirectory(), true);
  assert.equal(fs.lstatSync(heldGit, { throwIfNoEntry: false }), undefined);
  fs.renameSync(gitDir, heldGit);
  t.after(() => {
    assert.equal(fs.realpathSync.native(heldGit), heldGit);
    assert.equal(fs.lstatSync(gitDir, { throwIfNoEntry: false }), undefined);
    fs.renameSync(heldGit, gitDir);
  });

  const cold = await connect(t, root, f.projectId);
  const before = ledger(root);
  const reverse = await cold.relations({ to });
  assert.deepEqual(ids(reverse), [result.relationId]);
  assert.deepEqual(reverse.relations[0].fromVersion, a.from);
  const exact = await cold.relations({ relationId: result.relationId });
  assert.deepEqual(exact.relation, reverse.relations[0]);
  assert.deepEqual(exact.readRef, to);
  assert.equal(exact.availability, 'legacy-git-record-only');
  assert.equal(exact.body, null);
  assert.equal(exact.reverified, false);
  assert.equal(reverse.relations[0].deprecated, true);
  const { docId: fixedDoc, fixed } = exact.readRef;
  const bytes = await cold.query('get_fixed', { docId: fixedDoc, fixed });
  assert.equal(bytes.domain, 'git-blob-bytes');
  assert.equal(bytes.body, null);
  assert.equal(bytes.availability, 'legacy-git-record-only');
  assert.deepEqual(bytes.fixed, fixed);
  assert.equal(bytes.reverified, false);
  assert.deepEqual(await cold.query('get_fixed', { docId, commitOid: fixed.commitOid, pathAtCommit: fixed.pathAtCommit }), bytes);
  await assert.rejects(cold.query('get_fixed', { docId, fixed: { ...fixed, commitOid: 'f'.repeat(40) } }), { code: 'not-found' });
  assert.equal(fs.readFileSync(file, 'utf8'), changed);
  assert.deepEqual((await cold.query('workspace_history', { docId })).versions, []);
  assert.deepEqual((await cold.query('doc_record', { docId })).doc, metadata);
  assert.deepEqual(fs.readFileSync(snapshotFile), snapshotBytes, 'snapshot replay preserves old fixed metadata without backfill');
  assert.deepEqual(ledger(root), before);
});
