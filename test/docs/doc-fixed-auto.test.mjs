/**
 * 测试职责：保证提交文档证据自动固定可信 Git 内容，能力不足时带明确原因降级。
 * 典型流程：临时 Git 仓库与任务 → submit/reconcile → 检查固定身份、审批/屏障事件及冷重放。
 * 覆盖边界：覆盖 自动固定、原子事件、各类 current-only 降级；不覆盖远程 Git 获取或真实发布。
 * 外部前置：需要 Git；fixture 创建本地仓库，不使用真实 profile。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { withProject, command } from '../helpers/service-fixture.mjs';
import { auditEvidence } from '../../lib/core/evidence.js';
import { assertEventSupported } from '../../lib/core/model.js';
import { EVENT_REGISTRY } from '../../lib/shared/events.js';
import { bindWorktree } from '../../lib/core/identity/ops.js';
import { git, put, repository, sha, temp } from '../helpers/fixed-fixture.mjs';

async function setup(t, { relPath = 'docs/spec.md' } = {}) {
  const { root, oid } = repository('sha1', t);
  const { svc, h, board } = await withProject(t, { workspacePath: root, privilegedInlineWrites: true, name: '自动壳测试' });
  await h.attach({ sessionId: 'auto-test', agentId: 'auto-test', source: 'test', role: 'worker' });
  const out = await h.command(command('doc.external.register', { title: '自动文档', relPath }));
  const created = await h.command(command('task.create', { title: '交付文档', acceptance: [{ text: '自动固定或降级' }] }));
  return { root, oid, board, svc, h, docId: out.docId, taskId: created.events[0].data.id, bindingId: h.service.bindings().mainOf(h.id).bindingId };
}

async function newDoc(s, relPath, bindingId) {
  const out = await s.h.command(command('doc.external.register', { title: '补充文档', relPath, ...(bindingId ? { bindingId } : {}) }));
  return out.docId;
}

async function newTask(s, title = '第二个任务') {
  const created = await s.h.command(command('task.create', { title, acceptance: [{ text: '自动固定或降级' }] }));
  return created.events[0].data.id;
}

async function startWork(s, taskId) {
  const { h } = s;
  await h.command(command('task.claim', { taskId, expected: { entityRev: h.state.tasks[taskId].rev } }));
  await h.command(command('task.begin', { taskId, fencingToken: h.leases.get(taskId).token, expected: { entityRev: h.state.tasks[taskId].rev }, summary: '自动固定文档' }));
}

async function submitEvidence(s, taskId, evidence) {
  await startWork(s, taskId);
  return s.h.command(command('task.submit', {
    taskId,
    fencingToken: s.h.leases.get(taskId).token,
    expected: { entityRev: s.h.state.tasks[taskId].rev },
    evidence,
  }));
}

async function submitDoc(s, taskId, docId) {
  const acceptanceId = s.h.state.tasks[taskId].acceptance[0].id;
  return submitEvidence(s, taskId, [{ kind: 'doc', ref: docId, acceptanceId }]);
}

function row(s, taskId) {
  return structuredClone(s.h.state.tasks[taskId].evidence.at(-1));
}

function approvalCount(s) {
  return s.h.store.commits.filter((commit) => commit.events.some((event) => event.type === 'project/updated' && event.data?.gitContentRepository)).length;
}

// 责任：从 PATH 隐藏 Git 后 submit 仍须成功，证据为 current-only/no-git 且无审批或屏障。
test('a missing git executable degrades to current-only with reason no-git', async (t) => {
  const s = await setup(t);
  const previousPath = process.env.PATH;
  let result;
  try {
    process.env.PATH = temp(t);
    result = await submitDoc(s, s.taskId, s.docId);
  } finally {
    process.env.PATH = previousPath;
  }
  assert.equal(result.committed, true);
  const evidence = row(s, s.taskId);
  assert.equal(evidence.fixedState, 'current-only');
  assert.equal(evidence.fixedReason, 'no-git');
  assert.equal(Object.hasOwn(evidence, 'fixed'), false);
  assert.equal(evidence.hash, sha('version one\n'));
  assert.deepEqual(result.events.map((event) => event.type).filter((type) => type === 'project/updated' || type === 'doc/content-fixed'), []);
  assert.equal(s.h.state.project.gitContentRepository, undefined);
  assert.deepEqual(auditEvidence(s.h, s.h.state.tasks[s.taskId]), []);
  await s.svc.close();
});

// 责任：提交干净已提交文档须产生 pinned 身份，审批、内容屏障和证据在同次提交按序落盘。
test('a clean committed document is auto-pinned in the same commit as its content barrier', async (t) => {
  const s = await setup(t);
  const result = await submitDoc(s, s.taskId, s.docId);
  const evidence = row(s, s.taskId);
  const approval = result.events.find((event) => event.type === 'project/updated');
  const barrier = result.events.find((event) => event.type === 'doc/content-fixed');
  const types = result.events.map((event) => event.type);

  assert.equal(evidence.fixedState, 'pinned');
  assert.equal(evidence.fixedReason, undefined);
  assert.equal(evidence.hash, sha('version one\n'));
  assert.equal(evidence.hash, evidence.fixed.blobContentHash);
  assert.equal(evidence.fixed.commitOid, s.oid);
  assert.equal(evidence.fixed.pathAtCommit, 'docs/spec.md');
  assert.deepEqual(evidence.fixed, {
    v: 1, projectId: s.h.id, commitOid: s.oid, pathAtCommit: 'docs/spec.md',
    blobOid: evidence.fixed.blobOid, objectFormat: 'sha1', blobContentHash: evidence.hash,
  });

  assert.ok(approval, 'the automatic repository approval rides in the same commit');
  assert.deepEqual(approval.data.gitContentRepository, { v: 1, objectFormat: 'sha1', anchorCommitOid: s.oid, bindingIds: [s.bindingId] });
  assert.deepEqual(approval.actor, { kind: 'system', reason: 'auto-approve-git-content-repository' });
  assert.ok(types.indexOf('project/updated') < types.indexOf('doc/content-fixed'), 'approval precedes the content barrier');
  assert.ok(types.indexOf('doc/content-fixed') < types.indexOf('task/submitted'), 'barrier precedes the task evidence row');
  assert.deepEqual(barrier.data, { kind: 'doc', ref: s.docId, hash: evidence.hash, fixed: evidence.fixed });
  assert.deepEqual(s.h.state.fixedContents[Object.keys(s.h.state.fixedContents)[0]].hash, evidence.hash);

  // The commit still belongs to the caller; only the event is system-generated.
  assert.equal(s.h.store.commits.at(-1).actor.kind, 'human');
  const projected = s.h.query('events').events.filter((event) => event.type === 'project/updated').at(-1);
  assert.deepEqual(projected.actor, { kind: 'system', reason: 'auto-approve-git-content-repository' });
  assert.deepEqual(auditEvidence(s.h, s.h.state.tasks[s.taskId]), []);
  await s.svc.close();
});

// 责任：未提交文件和脏工作区均须降级，证据不能带 fixed 引用。
test('uncommitted content and a dirty worktree both degrade without a fixed reference', async (t) => {
  const s = await setup(t);
  put(s.root, 'docs/draft.md', 'not committed yet\n');
  const draft = await newDoc(s, 'docs/draft.md');
  const draftResult = await submitDoc(s, s.taskId, draft);
  const draftRow = row(s, s.taskId);
  assert.equal(draftRow.fixedState, 'current-only');
  assert.equal(draftRow.fixedReason, 'uncommitted');
  assert.equal(Object.hasOwn(draftRow, 'fixed'), false);
  assert.deepEqual(draftResult.events.map((event) => event.type).filter((type) => type === 'doc/content-fixed'), []);

  const second = await newTask(s);
  put(s.root, 'docs/spec.md', 'edited but uncommitted\n');
  const dirtyResult = await submitDoc(s, second, s.docId);
  const dirtyRow = row(s, second);
  assert.equal(dirtyRow.fixedState, 'current-only');
  assert.equal(dirtyRow.fixedReason, 'dirty-worktree');
  assert.equal(Object.hasOwn(dirtyRow, 'fixed'), false);
  assert.equal(dirtyRow.hash, sha('edited but uncommitted\n'));
  assert.deepEqual(dirtyResult.events.map((event) => event.type).filter((type) => type === 'doc/content-fixed'), []);
  assert.equal(s.h.state.project.gitContentRepository, undefined);
  await s.svc.close();
});

// 责任：路径命中 filter 时须降级 content-transform，禁止执行配置的驱动。
test('a path that hits a filter attribute degrades as content-transform and never runs the driver', async (t) => {
  const s = await setup(t);
  const marker = path.join(s.root, 'MARK');
  // Commit the attribute first: `git add` itself would run a configured driver,
  // which must be proven absent only for the board's own read path.
  put(s.root, '.gitattributes', '*.md filter=danger\n');
  git(s.root, 'add', '.gitattributes');
  git(s.root, 'commit', '-m', '测试 filter 属性');
  git(s.root, 'config', 'filter.danger.clean', 'echo unsafe > MARK');
  git(s.root, 'config', 'filter.danger.smudge', 'echo unsafe > MARK');
  git(s.root, 'config', 'filter.danger.process', 'echo unsafe > MARK');
  assert.equal(fs.existsSync(marker), false);

  const result = await submitDoc(s, s.taskId, s.docId);
  const evidence = row(s, s.taskId);
  assert.equal(evidence.fixedState, 'current-only');
  assert.equal(evidence.fixedReason, 'content-transform');
  assert.equal(Object.hasOwn(evidence, 'fixed'), false);
  assert.equal(fs.existsSync(marker), false, 'no clean/smudge/process driver may execute');
  assert.deepEqual(result.events.map((event) => event.type).filter((type) => type === 'project/updated' || type === 'doc/content-fixed'), []);
  await s.svc.close();
});

// 责任：即使文件存在，LFS 指针也不得当成真实文档内容固定。
test('an LFS pointer is never pinned as document content', async (t) => {
  const s = await setup(t);
  const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 123\n';
  put(s.root, 'docs/spec.md', pointer);
  git(s.root, 'add', 'docs/spec.md');
  git(s.root, 'commit', '-m', '测试 LFS 指针');
  const result = await submitDoc(s, s.taskId, s.docId);
  const evidence = row(s, s.taskId);
  assert.equal(evidence.fixedState, 'current-only');
  assert.equal(evidence.fixedReason, 'lfs-pointer');
  assert.equal(Object.hasOwn(evidence, 'fixed'), false);
  assert.equal(evidence.hash, sha(pointer), 'the evidence hashes workspace bytes, not a fabricated blob');
  assert.equal(Object.keys(s.h.state.fixedContents || {}).length, 0);
  assert.deepEqual(result.events.map((event) => event.type).filter((type) => type === 'doc/content-fixed'), []);
  await s.svc.close();
});

// 责任：文档来自非主绑定时须降级 multiple-repositories，不得选错内容仓库。
test('a document outside the main binding degrades as multiple-repositories', async (t) => {
  const s = await setup(t);
  const clone = temp(t);
  fs.cpSync(s.root, clone, { recursive: true });
  const binding = bindWorktree(s.svc, { projectId: s.h.id, workspacePath: clone, actor: { kind: 'human' } });
  const second = await newDoc(s, 'docs/spec.md', binding.bindingId);
  const result = await submitDoc(s, s.taskId, second);
  const evidence = row(s, s.taskId);
  assert.equal(evidence.fixedState, 'current-only');
  assert.equal(evidence.fixedReason, 'multiple-repositories');
  assert.equal(Object.hasOwn(evidence, 'fixed'), false);
  assert.deepEqual(result.events.map((event) => event.type).filter((type) => type === 'project/updated'), []);
  await s.svc.close();
});

// 责任：后续固定同仓库文档须复用已记来源，不能重复写自动审批事件。
test('automatic approval is idempotent and later pins reuse the recorded source', async (t) => {
  const s = await setup(t);
  await submitDoc(s, s.taskId, s.docId);
  assert.equal(approvalCount(s), 1);
  const first = row(s, s.taskId);
  const second = await newTask(s);
  const result = await submitDoc(s, second, s.docId);
  const evidence = row(s, second);
  assert.deepEqual(result.events.map((event) => event.type).filter((type) => type === 'project/updated'), []);
  assert.equal(approvalCount(s), 1, 'a second trigger must not write another approval event');
  assert.equal(evidence.fixedState, 'pinned');
  assert.deepEqual(evidence.fixed, first.fixed);
  assert.equal(s.h.state.project.gitContentRepository.anchorCommitOid, s.oid);
  await s.svc.close();
});

// 责任：自动固定日志须支持冷重放和快照，旧注册表必须拒绝新内容事件。
test('an auto-pinned log replays cold, survives a snapshot and is refused by the old registry', async (t) => {
  const s = await setup(t);
  const result = await submitDoc(s, s.taskId, s.docId);
  const evidence = row(s, s.taskId);
  const fixedContents = structuredClone(s.h.state.fixedContents);
  const projectId = s.h.id;
  const barrier = result.events.find((event) => event.type === 'doc/content-fixed');

  const oldRegistry = { ...EVENT_REGISTRY };
  delete oldRegistry['doc/content-fixed'];
  assert.throws(() => assertEventSupported(s.h.state, barrier, s.h.store.commits.at(-1), oldRegistry), { code: 'incompatible-event', status: 409 });

  s.h.store.saveSnapshot();
  const dir = s.h.meta.dir;
  assert.equal(fs.existsSync(path.join(dir, 'snapshot.json')), true);
  await s.svc.close();

  const { svc, h } = await withProject(t, { rootDir: s.board, workspacePath: s.root, projectId, privilegedInlineWrites: true });
  assert.deepEqual(h.state.tasks[s.taskId].evidence.at(-1), evidence);
  assert.deepEqual(h.state.fixedContents, fixedContents);
  assert.deepEqual(h.state.project.gitContentRepository, { v: 1, objectFormat: 'sha1', anchorCommitOid: s.oid, bindingIds: [s.bindingId] });
  assert.deepEqual(auditEvidence(h, h.state.tasks[s.taskId]), []);
  // The snapshot does not carry the timeline; the log line keeps event-level
  // provenance even though the commit actor stays the command caller.
  const lastCommit = JSON.parse(fs.readFileSync(path.join(dir, 'commits.jsonl'), 'utf8').trim().split('\n').at(-1));
  assert.deepEqual(lastCommit.events.find((event) => event.type === 'project/updated').actor, { kind: 'system', reason: 'auto-approve-git-content-repository' });
  assert.equal(lastCommit.actor.kind, 'human');
  await svc.close();
});

// 责任：非 UTF-8 markdown 须降级而非让整次 submit 失败。
test('a non-UTF-8 markdown document degrades instead of failing the submit', async (t) => {
  const s = await setup(t);
  const bytes = Buffer.from([0xb0, 0xa1, 0xba, 0xc3]); // GBK bytes, invalid UTF-8
  const file = path.join(s.root, 'docs/gbk.md');
  fs.writeFileSync(file, bytes);
  git(s.root, 'add', 'docs/gbk.md');
  git(s.root, 'commit', '-m', '非 UTF-8 文档');
  const doc = await newDoc(s, 'docs/gbk.md');
  const result = await submitDoc(s, s.taskId, doc);
  const evidence = row(s, s.taskId);
  assert.equal(result.committed, true);
  assert.equal(evidence.fixedState, 'current-only');
  assert.equal(evidence.fixedReason, 'unsupported-format');
  assert.equal(evidence.hash, sha(bytes), 'raw bytes hash, same rule as file evidence');
  assert.equal(Object.hasOwn(evidence, 'fixed'), false);
  assert.deepEqual(result.events.map((event) => event.type).filter((type) => type === 'project/updated' || type === 'doc/content-fixed'), []);
  assert.deepEqual(auditEvidence(s.h, s.h.state.tasks[s.taskId]), [], 'undecodable current-only evidence stays auditable');
  await s.svc.close();
});

// 责任：外置 docId@rev 须忽略元数据版本并走自动固定壳，不取历史元数据当正文。
test('an external docId@rev ignores the metadata revision and uses the auto shell', async (t) => {
  const s = await setup(t);
  const acceptanceId = s.h.state.tasks[s.taskId].acceptance[0].id;
  const pinned = await submitEvidence(s, s.taskId, [{ kind: 'doc', ref: s.docId + '@99', acceptanceId }]);
  const pinnedRow = row(s, s.taskId);
  assert.equal(pinned.committed, true);
  assert.equal(pinnedRow.ref, s.docId, 'the stored ref is the bare docId');
  assert.equal(pinnedRow.fixedState, 'pinned');
  assert.ok(pinned.events.some((event) => event.type === 'doc/content-fixed'));

  const second = await newTask(s);
  put(s.root, 'docs/spec.md', 'metadata rev must not change the rule\n');
  const degraded = await submitEvidence(s, second, [{ kind: 'doc', ref: s.docId + '@1', acceptanceId: s.h.state.tasks[second].acceptance[0].id }]);
  const degradedRow = row(s, second);
  assert.equal(degraded.committed, true);
  assert.equal(degradedRow.ref, s.docId);
  assert.equal(degradedRow.fixedState, 'current-only');
  assert.equal(degradedRow.fixedReason, 'dirty-worktree');
  await s.svc.close();
});

// 责任：内嵌 docId@rev 仍须读取对应历史 body 字节，不跟随当前 head。
test('inline docId@rev keeps its historical pinned bytes', async (t) => {
  const s = await setup(t);
  const put = await s.h.command(command('doc.put', { title: '内嵌历史', body: 'inline v1' }));
  const inlineId = put.events[0].data.id;
  const inlineHash = s.h.state.docs[inlineId].hash;
  const acceptanceId = s.h.state.tasks[s.taskId].acceptance[0].id;
  const result = await submitEvidence(s, s.taskId, [{ kind: 'doc', ref: inlineId + '@1', acceptanceId }]);
  const evidence = row(s, s.taskId);
  assert.equal(result.committed, true);
  assert.equal(evidence.ref, inlineId + '@1');
  assert.equal(evidence.hash, inlineHash);
  assert.equal(Object.hasOwn(evidence, 'fixed'), false);
  assert.equal(Object.hasOwn(evidence, 'fixedState'), false);

  const second = await newTask(s);
  await startWork(s, second);
  await assert.rejects(s.h.command(command('task.submit', {
    taskId: second,
    fencingToken: s.h.leases.get(second).token,
    expected: { entityRev: s.h.state.tasks[second].rev },
    evidence: [{ kind: 'doc', ref: inlineId + '@99', acceptanceId: s.h.state.tasks[second].acceptance[0].id }],
  })), { code: 'missing-evidence' });
  await s.svc.close();
});

// 责任：审计前置条件拒绝 submit 时，不得残留自动审批或部分提交。
test('a rejected pre-review audit leaves no automatic approval or partial commit', async (t) => {
  const s = await setup(t);
  const acceptanceId = s.h.state.tasks[s.taskId].acceptance[0].id;
  await startWork(s, s.taskId);
  const beforeRev = s.h.rev;
  const beforeCommits = s.h.store.commits.length;
  await assert.rejects(s.h.command(command('task.submit', {
    taskId: s.taskId,
    fencingToken: s.h.leases.get(s.taskId).token,
    expected: { entityRev: s.h.state.tasks[s.taskId].rev },
    evidence: [
      { kind: 'doc', ref: s.docId, acceptanceId },
      { kind: 'file', ref: '../outside-the-workspace.txt' },
    ],
  })), { code: 'invalid-command' });

  assert.equal(s.h.rev, beforeRev);
  assert.equal(s.h.store.commits.length, beforeCommits);
  assert.equal(s.h.state.project.gitContentRepository, undefined, 'rejected audit must not persist the source');
  assert.equal(s.h.state.tasks[s.taskId].evidence.length, 0);
  assert.equal(s.h.state.tasks[s.taskId].state, 'in_progress');
  await s.svc.close();
});

// 责任：reconcile(completed) 固定文档时，自动审批和内容屏障必须同次原子提交。
test('reconcile(completed) keeps the auto approval and content barrier in one commit', async (t) => {
  const s = await setup(t);
  const { h, taskId } = s;
  await startWork(s, taskId);
  await h.command(command('task.interrupt', {
    taskId,
    expected: { entityRev: h.state.tasks[taskId].rev },
    fencingToken: h.leases.get(taskId).token,
    note: 'crash before completion',
    sideEffects: [{ kind: 'command', ref: 'npm test' }],
  }));
  const acceptanceId = h.state.tasks[taskId].acceptance[0].id;
  const result = await h.command(command('task.reconcile', {
    taskId,
    expected: { entityRev: h.state.tasks[taskId].rev },
    choice: 'completed',
    note: 'recovered and completed',
    evidence: [{ kind: 'doc', ref: s.docId, acceptanceId }],
  }));
  const types = result.events.map((event) => event.type);
  assert.ok(types.includes('project/updated'));
  assert.ok(types.includes('doc/content-fixed'));
  assert.ok(types.indexOf('project/updated') < types.indexOf('doc/content-fixed'));
  assert.ok(types.indexOf('doc/content-fixed') < types.indexOf('task/reconciled'));
  assert.equal(approvalCount(s), 1);
  assert.equal(row(s, taskId).fixedState, 'pinned');
  assert.ok(s.h.state.tasks[taskId].evidence.some((item) => Object.hasOwn(item, 'fixed')));
  await s.svc.close();
});

// 责任：一次提交两份干净文档须各自固定，但仓库自动审批只记录一次。
test('one submit with two clean documents records a single approval', async (t) => {
  const s = await setup(t);
  put(s.root, 'docs/two.md', 'second document\n');
  git(s.root, 'add', 'docs/two.md');
  git(s.root, 'commit', '-m', '第二份文档');
  const secondDoc = await newDoc(s, 'docs/two.md');
  const acceptanceId = s.h.state.tasks[s.taskId].acceptance[0].id;
  const result = await submitEvidence(s, s.taskId, [
    { kind: 'doc', ref: s.docId, acceptanceId },
    { kind: 'doc', ref: secondDoc, acceptanceId },
  ]);
  assert.equal(approvalCount(s), 1);
  assert.equal(result.events.filter((event) => event.type === 'project/updated').length, 1);
  assert.equal(result.events.filter((event) => event.type === 'doc/content-fixed').length, 2);
  const evidence = s.h.state.tasks[s.taskId].evidence;
  assert.deepEqual(evidence.map((item) => item.fixedState), ['pinned', 'pinned']);
  assert.equal(Object.keys(s.h.state.fixedContents).length, 2);
  await s.svc.close();
});
