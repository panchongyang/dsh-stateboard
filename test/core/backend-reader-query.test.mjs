/**
 * 测试职责：验证统一只读 query(projectId, view, params, actor) 的原始 DTO、隔离副作用与并发边界。
 * 典型流程：合成项目 → 发布/冷读两种来源 → query 各视图 → 比较值、磁盘、句柄与租约。
 * 覆盖边界：覆盖冷热查询、冷读资格与 task_detail operations、DTO 400、Web 项目列表、正文、观测、审计、取消与水位变化；不覆盖传输层、真实数据或远端 Git。
 * 外部前置：临时 board/workspace；get_fixed 用临时本地 Git 仓库。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { createProjectReader } from '../../lib/core/project-reader.js';
import { inlineDocProjection } from '../../lib/core/projection/doc.js';
import { digestValue } from '../../lib/core/projection/views.js';
import { taskHints } from '../../lib/core/application/task-hints.js';
import { createApplication } from '../../lib/core/application/index.js';
import { executeRead } from '../../lib/core/reader/execute.js';
import { repository, sha } from '../helpers/fixed-fixture.mjs';
import { command, makeService, withProject } from '../helpers/service-fixture.mjs';
import { commitPinnedEvidence, pinDocEvidence } from '../helpers/prompt-evidence-fixture.mjs';

function snapshotFiles(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
    .map(({ parentPath, name }) => path.join(parentPath, name)).sort()
    .map((file) => [file, fs.readFileSync(file, 'base64')]);
}

async function addTask(handle, title, extra = {}) {
  const result = await handle.command(command('task.create', { title, acceptance: [{ text: 'Check result' }], ...extra }));
  return result.events[0].taskId;
}

// 责任：live query 必须返回脱离 live 对象的原始 DTO，不经过 MCP 裁剪，也不改变 rev/租约/文件。
test('query publishes raw detached DTOs from publishedState without touching the writer', async (t) => {
  const { svc, h, stateDir } = await withProject(t, { name: 'Raw reader' });
  const taskId = await addTask(h, 'Raw task', { description: 'd'.repeat(1200) });
  const human = { kind: 'human', via: 'test' };
  await h.command(command('task.claim', { actor: human, taskId, expected: { entityRev: h.state.tasks[taskId].rev } }));
  await h.command(command('task.begin', {
    actor: human, taskId, fencingToken: h.leases.get(taskId).token,
    expected: { entityRev: h.state.tasks[taskId].rev }, summary: 'implement raw reader',
  }));
  const projectId = h.id;
  const rev = h.rev;
  const leaseExpiry = h.leases.get(taskId).expiresAt;
  const reader = createProjectReader(svc, { taskHints });
  try {
    const before = snapshotFiles(stateDir);
    const task = await reader.query(projectId, 'task', { taskId }, human);
    assert.equal(task.projectId, projectId);
    assert.equal(task.view, 'task');
    assert.equal(task.projectRev, rev);
    assert.equal(task.task.id, taskId);
    assert.equal(task.task.description.length, 1200, 'raw trusted DTO is not MCP-trimmed');
    assert.equal(task.lease.token, h.leases.get(taskId).token, 'raw lease keeps the token');
    assert.equal(task.intent.summary, 'implement raw reader', 'task_detail can consume the open intent');
    assert.ok(Array.isArray(task.allowedOps) && task.allowedOps.length > 0);
    assert.notEqual(task.task, h.state.tasks[taskId], 'DTO must not alias live state');
    task.task.title = 'mutated locally';
    task.task.acceptance[0].text = 'mutated acceptance';
    const again = await reader.query(projectId, 'task', { taskId }, human);
    assert.equal(again.task.title, 'Raw task');
    assert.equal(again.task.acceptance[0].text, 'Check result');
    const other = await reader.query(projectId, 'task', { taskId }, { kind: 'agent', sessionId: 'other-session' });
    assert.equal(other.lease, null, 'another session does not receive the lease token');
    assert.equal(other.task.owner, null, 'another session does not receive the owner token');
    assert.ok(Array.isArray(other.allowedOps), 'eligibility still comes from the value hints provider');
    // Same values the host needs for sectioning; core does not import host.
    const overview = await reader.query(projectId, 'task_overview', { taskId }, human);
    assert.equal(overview.task.id, taskId);
    assert.equal(overview.task.description.length, 4000 > 1200 ? 1200 : 4000);
    const work = await reader.query(projectId, 'work_context', { taskId }, human);
    assert.equal(work.task.id, taskId);
    assert.equal(work.nextAction, 'check_work_session');

    const summary = await reader.query(projectId, 'summary');
    assert.deepEqual(Object.keys(summary).sort(), ['counts', 'id', 'lastAt', 'name', 'phase', 'projectId', 'projectRev', 'readOnly', 'rev', 'view', 'workspacePath'].sort());
    assert.equal(summary.id, projectId);
    assert.equal(summary.rev, rev);
    assert.equal(summary.readOnly, false);
    assert.equal(summary.counts.inProgress, 1);

    const brief = await reader.query(projectId, 'brief', {}, { kind: 'human', sessionId: 'raw-reader' });
    assert.equal(brief.project.name, 'Raw reader');
    assert.equal(brief.health.evidenceAudit.status, 'unchecked');
    const digest = await reader.query(projectId, 'digest', {}, { kind: 'human', sessionId: 'raw-reader' });
    assert.match(digest.digest, /## Project: Raw reader/);
    assert.equal(digest.brief.project.name, 'Raw reader');
    const events = await reader.query(projectId, 'events', { after: 0, limit: 5 });
    assert.ok(events.events.length > 0 && events.events.every((event) => Number.isInteger(event.seq)));

    assert.equal(h.rev, rev);
    assert.equal(h.leases.get(taskId).expiresAt, leaseExpiry);
    assert.deepEqual(snapshotFiles(stateDir), before);
  } finally { await reader.close(); }
});

// 责任：冷读在 worker 内 replay，不创建 handle、不加锁；任务/摘要视图仍返回可用值。
test('cold query replays in a worker without creating a handle or a lock', async (t) => {
  const { svc, h, stateDir } = await withProject(t, { name: 'Cold reader' });
  const taskId = await addTask(h, 'Cold task');
  const projectId = h.id;
  const rev = h.rev;
  const liveEvents = h.query('events', { after: 0, limit: 100 }).events;
  await svc.close();
  const { svc: cold } = await makeService(t, { rootDir: stateDir });
  const reader = createProjectReader(cold);
  try {
    const before = snapshotFiles(stateDir);
    const task = await reader.query(projectId, 'task', { taskId });
    assert.equal(task.task.title, 'Cold task');
    assert.equal(task.projectRev, rev);
    assert.equal(task.lease, null, 'cold replay has no runtime lease table');
    const summary = await reader.query(projectId, 'summary');
    assert.equal(summary.readOnly, false, 'no writer is not the same as a held read-only lock');
    assert.equal(summary.rev, rev);
    const docs = await reader.query(projectId, 'docs');
    assert.deepEqual(docs.docs, []);
    const events = await reader.query(projectId, 'events', { after: 0, limit: 100 });
    assert.deepEqual(events.events, liveEvents, 'cold events keep the complete committed order');
    await assert.rejects(reader.query(projectId, 'doc_record', { docId: 'doc_missing' }), { code: 'not-found', status: 404 });
    await assert.rejects(reader.query(projectId, 'doc', { docId: 'doc_missing' }), { code: 'not-found', status: 404 });
    assert.equal(cold.handles.size, 0);
    assert.equal(fs.existsSync(path.join(cold.projectsDir, projectId, 'lock.json')), false);
    assert.deepEqual(snapshotFiles(stateDir), before);
  } finally { await reader.close(); }
});

// 责任：冷读的 task/task_detail 资格必须由同一纯 provider 从已提交事实算出；
// 运行态 lease 未知时不伪造可执行操作，human verify 仍可点，非本人不漏 token。
test('cold query computes task eligibility and task_detail operations from committed facts', async (t) => {
  const { svc, h, stateDir } = await withProject(t, { name: 'Cold eligibility' });
  const taskId = await addTask(h, 'Cold review');
  const human = { kind: 'human', via: 'test' };
  await h.command(command('task.claim', { actor: human, taskId, expected: { entityRev: h.state.tasks[taskId].rev } }));
  await h.command(command('task.begin', {
    actor: human, taskId, fencingToken: h.leases.get(taskId).token,
    expected: { entityRev: h.state.tasks[taskId].rev }, summary: 'cold eligibility',
  }));
  await h.command(command('task.submit', {
    actor: human, taskId, fencingToken: h.leases.get(taskId).token,
    expected: { entityRev: h.state.tasks[taskId].rev },
    evidence: [{ kind: 'note', ref: 'cold-eligibility', acceptanceId: h.state.tasks[taskId].acceptance[0].id }],
  }));
  assert.equal(h.state.tasks[taskId].state, 'review');
  await svc.close();
  const before = snapshotFiles(stateDir);
  const { svc: cold } = await makeService(t, { rootDir: stateDir });
  const reader = createProjectReader(cold, { taskHints });
  try {
    const view = await reader.query(h.id, 'task', { taskId }, human);
    assert.ok(Array.isArray(view.allowedOps), 'a cold task read carries eligibility hints');
    const verify = view.allowedOps.find((entry) => entry.op === 'verify');
    assert.equal(verify.enabled, true, 'human verify is a persisted state/role decision');
    assert.equal(view.lease, null, 'a cold replay has no runtime lease to lend');
    assert.equal(JSON.stringify(view).includes('"token"'), false);
    const agent = await reader.query(h.id, 'task', { taskId }, { kind: 'agent', sessionId: 'cold-other' });
    assert.equal(agent.lease, null);
    assert.equal(agent.task.owner, null);
    assert.equal(JSON.stringify(agent).includes('"token"'), false);
    const application = createApplication({ service: cold, reader });
    const detail = await application.read(h.id, 'task_detail', { taskId, section: 'operations' }, human);
    const operations = JSON.parse(detail.content);
    assert.equal(operations.find((entry) => entry.op === 'verify').enabled, true);
    assert.equal(detail.content.includes('"token"'), false);
    assert.equal(cold.handles.size, 0);
    assert.equal(fs.existsSync(path.join(cold.projectsDir, h.id, 'lock.json')), false);
    assert.deepEqual(snapshotFiles(stateDir), before);
  } finally { await reader.close(); }
});

// 责任：非本人读取 task 时，open intent 的 fencing token 也不能绕过 lease 脱敏。
test('task view redacts the intent token when the actor cannot see the lease', () => {
  const now = Date.parse('2026-11-18T12:00:00.000Z');
  const lease = { taskId: 'tsk_intent_token', sessionId: 'owner-session', token: 7, epoch: 0, expiresAt: new Date(now + 60_000).toISOString(), renewCount: 0 };
  const task = {
    id: 'tsk_intent_token', title: 'intent', state: 'in_progress', rev: 2, priority: 100,
    labels: [], deps: [], planRef: null, assignee: null, workers: [], evidence: [],
    acceptance: [{ id: 'acc_1', text: 'ok', met: false, evidenceIds: [] }], requiresAudit: false,
    owner: { sessionId: 'owner-session', fencingToken: 7, expiresAt: lease.expiresAt },
    updatedAt: new Date(now).toISOString(),
  };
  const state = {
    project: { id: 'prj_intent_token', phase: 'active', policy: {} },
    tasks: { tsk_intent_token: task }, bindings: {}, planHeads: {}, docs: {},
    intents: { int_1: { id: 'int_1', taskId: 'tsk_intent_token', status: 'open', token: 7, summary: 'work', startedAt: new Date(now).toISOString() } },
  };
  const snapshot = { projectId: 'prj_intent_token', state, rev: 2, timeline: [], leases: [lease], now, readOnly: false };
  const foreign = executeRead({ snapshot, view: 'task', params: { taskId: task.id, sessionId: 'other' }, actor: { kind: 'agent', sessionId: 'other' } });
  assert.equal(foreign.lease, null);
  assert.equal(foreign.task.owner, null);
  assert.equal(Object.hasOwn(foreign.intent, 'token'), false, 'a foreign task read leaks the intent fencing token');
  assert.equal(foreign.intent.summary, 'work');
  const owner = executeRead({ snapshot, view: 'task', params: { taskId: task.id }, actor: { kind: 'agent', sessionId: 'owner-session' } });
  assert.equal(owner.lease.token, 7);
  assert.equal(owner.intent.token, 7);
});

// 责任：内嵌文档正文读取是显式注入的副作用；元数据与 body 分离，结果不引用快照。
test('inline doc projection composes an injected blob reader and detaches metadata', () => {
  const hash = sha('hello');
  const snapshot = { rev: 7, state: { docs: {
    doc_reader: { id: 'doc_reader', rev: 1, title: 'Title', kind: 'note', hash, size: 5, links: { taskIds: [], planRefs: [] } },
    doc_external: { id: 'doc_external', rev: 1, title: 'External', kind: 'spec', source: 'external', status: 'draft', locator: { bindingId: 'b1', relPath: 'a.md' }, links: { taskIds: [], planRefs: [] }, baselineInContext: false, baseline: null },
  } } };
  const doc = inlineDocProjection(snapshot, 'doc_reader', 'hello', 2);
  assert.equal(doc.body, 'he');
  assert.equal(doc.truncated, true);
  assert.equal(doc.rev, 7);
  doc.doc.title = 'Mutated';
  assert.equal(snapshot.state.docs.doc_reader.title, 'Title');
  assert.throws(() => inlineDocProjection(snapshot, 'doc_reader', null, 10), { code: 'hash-chain-broken' });
  assert.throws(() => inlineDocProjection(snapshot, 'doc_external', 'x', 10), { code: 'external-doc-operation-required' });
});

// 责任：统一 query(task) 的资格结果必须与 host 兼容 handle.query(task) 同源，且只差取数方式。
test('query(task) eligibility matches the host handle adapter for human and agent actors', async (t) => {
  const { svc, h } = await withProject(t, { name: 'Parity reader' });
  const taskId = await addTask(h, 'Parity task');
  const human = { kind: 'human', via: 'test' };
  await h.command(command('task.claim', { actor: human, taskId, expected: { entityRev: h.state.tasks[taskId].rev } }));
  const reader = createProjectReader(svc, { taskHints });
  try {
    const hostHuman = h.query('task', { taskId });
    const readerHuman = await reader.query(h.id, 'task', { taskId }, human);
    assert.deepEqual(readerHuman.allowedOps, hostHuman.allowedOps, 'human eligibility has one implementation');
    assert.deepEqual(readerHuman.lease, hostHuman.lease, 'human sees the same raw lease value');
    const agent = { kind: 'agent', sessionId: 'other-session' };
    const hostAgent = h.query('task', { taskId, sessionId: 'other-session' });
    const readerAgent = await reader.query(h.id, 'task', { taskId }, agent);
    assert.deepEqual(readerAgent.allowedOps, hostAgent.allowedOps, 'agent eligibility has one implementation');
    assert.equal(readerAgent.task.owner, null);
    assert.equal(readerAgent.lease, null);
  } finally { await reader.close(); }
});

// 责任：真实登记的外置文档与固定 Git 身份，在 live 与 cold 下都只读取值；负例保持原错误域。
test('query observes registered external docs and legacy fixed records live and cold', async (t) => {
  const repo = repository(undefined, t);
  const { svc, stateDir } = await makeService(t);
  const h = await svc.createProject({ workspacePath: repo.root, name: 'External reader' });
  const out = await h.command(command('doc.external.register', { title: 'Spec', relPath: 'docs/spec.md', kind: 'spec' }));
  const docId = out.docId;
  const created = await h.command(command('task.create', { title: 'pin', acceptance: [{ text: 'evidence' }] }));
  const taskId = created.events[0].data.id;
  const pinned = pinDocEvidence(h, docId);
  commitPinnedEvidence(h, taskId, [pinned.row], pinned.repository);
  const projectId = h.id;
  const rev = h.rev;
  let reader = createProjectReader(svc);
  try {
    const inspect = await reader.query(projectId, 'inspect', { docId, preview: true });
    assert.equal(inspect.doc.id, docId);
    assert.equal(inspect.availability, 'readable');
    assert.equal(inspect.observation.preview.text, 'version one\n');
    assert.equal(inspect.observation.cached, false);
    const cached = await reader.query(projectId, 'inspect', { docId, preview: true });
    assert.equal(cached.observation.cached, true, 'the 30 s observation cache is reused across query calls');
    const fresh = await reader.query(projectId, 'inspect', { docId, fresh: true });
    assert.equal(fresh.observation.cached, false, 'fresh bypasses the observation cache');
    const listed = await reader.query(projectId, 'list_external');
    assert.deepEqual(listed.docs.map(({ id }) => id), [docId]);
    const logBefore = fs.readFileSync(h.store.commitsFile);
    const fixed = await reader.query(projectId, 'get_fixed', { docId, fixed: pinned.row.fixed });
    assert.equal(fixed.docId, docId);
    assert.deepEqual(fixed.fixed, pinned.row.fixed);
    assert.equal(fixed.hash, pinned.row.fixed.blobContentHash);
    assert.equal(fixed.body, null);
    assert.equal(fixed.totalBytes, null);
    assert.equal(fixed.truncated, false);
    assert.equal(fixed.domain, 'git-blob-bytes');
    assert.equal(fixed.availability, 'legacy-git-record-only');
    assert.equal(fixed.provenance, 'legacy-git');
    assert.equal(fixed.deprecated, true);
    assert.equal(fixed.reverified, false);
    assert.equal(Object.hasOwn(fixed, 'workspaceComparison'), false);
    assert.equal(h.rev, rev, 'reads never write');
    assert.deepEqual(fs.readFileSync(h.store.commitsFile), logBefore, 'legacy metadata reads leave the log byte-identical');
    await assert.rejects(
      reader.query(projectId, 'get_fixed', { docId, fixed: { ...pinned.row.fixed, blobContentHash: sha('other') } }),
      (error) => ['invalid-fixed-reference', 'not-found'].includes(error.code),
    );
    const record = await reader.query(projectId, 'doc_record', { docId });
    assert.equal(record.doc.id, docId);
    assert.equal(Object.hasOwn(record, 'body'), false);
    await reader.close();
    await svc.close();
    const { svc: cold } = await makeService(t, { rootDir: stateDir });
    reader = createProjectReader(cold);
    const coldInspect = await reader.query(projectId, 'inspect', { docId });
    assert.equal(coldInspect.availability, 'readable');
    const coldFixed = await reader.query(projectId, 'get_fixed', { docId, fixed: pinned.row.fixed });
    assert.equal(coldFixed.body, null);
    assert.deepEqual(coldFixed.fixed, pinned.row.fixed);
    assert.equal(coldFixed.availability, 'legacy-git-record-only');
    assert.equal(coldFixed.deprecated, true);
    assert.equal(coldFixed.reverified, false);
    assert.equal(cold.handles.size, 0);
    assert.equal(fs.existsSync(path.join(cold.projectsDir, projectId, 'lock.json')), false);
    await reader.close();
    await cold.close();
  } finally {
    try { await reader.close(); } catch { /* already closed */ }
    try { await svc.close(); } catch { /* already closed */ }
  }
});

// 责任：health 全量审计必须离开主线程；同 rev 文件变化不能被缓存掩盖，也不改项目 rev。
test('query health audits evidence in an isolated worker and never caches at the same rev', async (t) => {
  const { svc, h, wsDir } = await withProject(t, { name: 'Health reader' });
  const taskId = await addTask(h, 'Evidence task');
  fs.writeFileSync(path.join(wsDir, 'artifact.txt'), 'original');
  const human = { kind: 'human', via: 'test' };
  await h.command(command('task.claim', { actor: human, taskId, expected: { entityRev: h.state.tasks[taskId].rev } }));
  await h.command(command('task.begin', {
    actor: human, taskId, fencingToken: h.leases.get(taskId).token,
    expected: { entityRev: h.state.tasks[taskId].rev }, summary: 'produce evidence',
  }));
  await h.command(command('task.submit', {
    actor: human, taskId, fencingToken: h.leases.get(taskId).token,
    expected: { entityRev: h.state.tasks[taskId].rev },
    evidence: [{ kind: 'file', ref: 'artifact.txt', acceptanceId: h.state.tasks[taskId].acceptance[0].id }],
  }));
  const rev = h.rev;
  const reader = createProjectReader(svc);
  const forbidden = () => { throw new Error('health ran on the main thread'); };
  t.mock.method(childProcess, 'spawnSync', forbidden);
  t.mock.method(fs, 'readFileSync', forbidden);
  t.mock.method(fs, 'statSync', forbidden);
  t.mock.method(fs, 'openSync', forbidden);
  syncBuiltinESMExports();
  try {
    const healthy = await reader.query(h.id, 'health');
    assert.equal(healthy.health.ok, true, healthy.health.warnings.join('\n'));
    assert.equal(healthy.health.evidenceAudit.status, 'complete');
    assert.equal(healthy.health.evidenceAudit.rev, rev);
    assert.equal(healthy.health.seq, rev);
    assert.equal(healthy.health.hashChain, 'ok');
    assert.ok(Array.isArray(healthy.health.checks) && healthy.health.checks.length > 0);
    assert.ok(Array.isArray(healthy.health.leases));
    assert.ok(Array.isArray(healthy.health.intents));
    assert.equal(typeof healthy.health.lastAt, 'string');
    assert.equal(healthy.health.readOnly, false);
    assert.ok(healthy.health.counts && Number.isInteger(healthy.health.counts.done));
    const concurrent = await Promise.all([reader.query(h.id, 'health'), reader.query(h.id, 'health')]);
    assert.equal(concurrent[0].health.evidenceAudit.rev, rev);
    assert.equal(concurrent[1].health.evidenceAudit.rev, rev);
    // One caller's abort must not cancel the shared audit for another caller.
    const controller = new AbortController();
    const shared = reader.query(h.id, 'health');
    const cancelled = reader.query(h.id, 'health', { signal: controller.signal });
    controller.abort();
    await assert.rejects(cancelled, { code: 'read-cancelled' });
    assert.equal((await shared).health.evidenceAudit.rev, rev);
    fs.writeFileSync(path.join(wsDir, 'artifact.txt'), 'changed');
    const drifted = await reader.query(h.id, 'health');
    assert.equal(h.rev, rev, 'reads never advance the project revision');
    assert.equal(drifted.health.ok, false);
    assert.match(drifted.health.warnings.join('\n'), /file-drift/);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  await addTask(h, 'Next revision');
  const nextRev = await reader.query(h.id, 'health');
  assert.equal(nextRev.health.evidenceAudit.rev, h.rev, 'a new revision starts a fresh audit key');
  assert.ok(h.rev > rev);
  await reader.close();
});

// 责任：发布版本在读取期间前进时必须报 read-unstable，不能把旧快照当最新发布。
test('query rejects a capture whose published revision changed before publication', async (t) => {
  const { svc, h } = await withProject(t, { name: 'Stale reader' });
  const taskId = await addTask(h, 'Stale task');
  const projectId = h.id;
  const base = svc.publishedState(projectId);
  const stale = Object.create(svc);
  stale.publishedState = () => base;
  // 在取得已提交值之后，轻量水位口观测到另一笔已提交记录。
  stale.publishedRevision = () => ({ lastSeq: base.lastSeq + 1, lastHash: 'later-published-hash' });
  const reader = createProjectReader(stale);
  try {
    await assert.rejects(reader.query(projectId, 'task', { taskId }), { code: 'read-unstable', status: 503 });
  } finally { await reader.close(); }
});

// 责任：取消与关闭都要拒绝发布结果，且不遗留在飞 worker。
test('query honours cancellation and reader close', async (t) => {
  const { svc, h, stateDir } = await withProject(t, { name: 'Cancel reader' });
  await addTask(h, 'Cancel task');
  const projectId = h.id;
  await svc.close();
  const { svc: cold } = await makeService(t, { rootDir: stateDir });
  const reader = createProjectReader(cold);
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(reader.query(projectId, 'brief', { signal: controller.signal }), { code: 'read-cancelled' });
    const pending = Promise.allSettled(Array.from({ length: 3 }, () => reader.query(projectId, 'brief')));
    await reader.close();
    const codes = (await pending).map(({ reason }) => reason?.code);
    assert.deepEqual(codes, ['closed', 'closed', 'read-busy']);
    await assert.rejects(reader.query(projectId, 'brief'), { code: 'closed' });
    assert.equal(cold.handles.size, 0);
  } finally { await reader.close(); }
});

// 责任：Prompt 同步摘要必须是纯内存投影：无 fs/Git/blob I/O，且同输入字节一致。
test('digestValue is a pure synchronous prompt projection', async (t) => {
  const { svc, h } = await withProject(t, { name: 'Prompt reader' });
  await addTask(h, 'Prompt task');
  const snapshot = { state: h.state, rev: h.rev, leases: [...h.leases.values()], now: Date.now(), readOnly: false };
  let calls = 0;
  const forbidden = () => { calls += 1; throw new Error('prompt path I/O'); };
  t.mock.method(childProcess, 'spawnSync', forbidden);
  for (const method of ['readFileSync', 'statSync', 'lstatSync', 'openSync', 'readSync', 'existsSync', 'readdirSync']) t.mock.method(fs, method, forbidden);
  syncBuiltinESMExports();
  try {
    const first = digestValue(snapshot, 'prompt-session');
    const second = digestValue(snapshot, 'prompt-session');
    assert.equal(first.digest, second.digest);
    assert.match(first.digest, /## Project: Prompt reader/);
    assert.match(first.digest, /evidence unchecked/);
    assert.equal(calls, 0);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await svc.close(); }
});

// 责任：DTO 的 invalid 必须真的抛出 400，且拒绝后不得调用业务/读端口。
test('application dto rejects malformed requests before any downstream call', async () => {
  const calls = { command: 0, query: 0 };
  const application = createApplication({
    service: {
      async command() { calls.command += 1; return { ok: true, committed: false, projectRev: 1, events: [] }; },
      publishedState() { return null; },
      async listProjectsAsync() { return []; },
    },
    reader: {
      async query() { calls.query += 1; return {}; },
      async listProjects() { throw new Error('metadata page must not serve the web project list'); },
    },
  });
  const actor = { kind: 'human', via: 'test' };
  const rejected = [
    ['not_a_project', { op: 'task.claim', cmdId: 'cmd_1', actor }],
    ['prj_ok', { op: '', cmdId: 'cmd_1', actor }],
    ['prj_ok', { op: 'task.claim', cmdId: '', actor }],
    ['prj_ok', []],
    ['prj_ok', null],
  ];
  for (const [projectId, command] of rejected) {
    await assert.rejects(application.command(projectId, command), (error) => {
      assert.equal(error.code, 'invalid-command');
      assert.equal(error.status, 400);
      return true;
    }, 'invalid command must be rejected: ' + JSON.stringify(command));
  }
  // The trusted actor is an ingress responsibility: missing is a 403, not a 400,
  // and it still must not reach the command bus.
  await assert.rejects(application.command('prj_ok', { op: 'task.claim', cmdId: 'cmd_1' }), { code: 'forbidden-role', status: 403 });
  for (const [view, params] of [['bogus', {}], ['task', null], ['task', []], ['events', 'x']]) {
    await assert.rejects(application.read('prj_ok', view, params), (error) => {
      assert.equal(error.code, 'invalid-command');
      assert.equal(error.status, 400);
      return true;
    }, 'invalid read must be rejected: ' + view);
  }
  assert.equal(calls.command, 0, 'a rejected command never reaches the service');
  assert.equal(calls.query, 0, 'a rejected read never reaches the reader');
  const accepted = await application.command('prj_ok', { op: 'task.claim', cmdId: 'cmd_ok', actor });
  assert.equal(accepted.ok, true);
  assert.equal(calls.command, 1, 'a valid command still reaches the service');
});

// 责任：Web /projects 走完整项目读值；30 条分页与窄行只属于 metadata 凭据。
test('project list read keeps full web rows instead of the metadata page', async () => {
  const rows = Array.from({ length: 31 }, (_, index) => ({
    id: 'prj_' + String(index).padStart(16, 'a'),
    name: 'Project ' + index,
    workspacePath: 'D:\\work\\project-' + index,
    phase: 'active',
    rev: 3,
    counts: { backlog: 0, ready: 1, inProgress: 0, review: 0, done: 0, canceled: 0 },
    lastAt: '2026-11-18T00:00:0' + (index % 10) + '.000Z',
    readOnly: false,
  }));
  let metadataPageCalls = 0;
  const application = createApplication({
    service: {
      publishedState() { return null; },
      async listProjectsAsync() { return rows; },
    },
    reader: {
      async query() { return {}; },
      async listProjects() { metadataPageCalls += 1; return { projects: rows.slice(0, 30), nextCursor: rows[29].id }; },
    },
  });
  const page = await application.read(null, 'projects', {}, { kind: 'human', via: 'web' });
  assert.equal(page.projects.length, 31, 'the web list is not truncated to the 30-row metadata page');
  assert.equal(metadataPageCalls, 0, 'the metadata cursor page is not reused for the web surface');
  const row = page.projects.find((entry) => entry.name === 'Project 7');
  assert.equal(row.workspacePath, 'D:\\work\\project-7');
  assert.deepEqual(row.counts, rows[7].counts);
  assert.equal(row.readOnly, false);
  assert.equal(row.lastAt, rows[7].lastAt);
});

// 责任：冷读的资格与热读共用同一个纯 provider；运行态 lease 未知不得伪装成可执行。
test('taskHints marks runtime-dependent operations unknown for a cold read', () => {
  const now = Date.parse('2026-11-18T12:00:00.000Z');
  const task = (id, state) => ({
    id, title: id, state, rev: 2, priority: 3, deps: [], evidence: [], workers: [],
    acceptance: [{ id: 'acc_1', text: 'ok', met: true }], planRef: null, requiresAudit: false,
  });
  const state = {
    project: { id: 'prj_cold', phase: 'active', policy: {} },
    tasks: { tsk_review: task('tsk_review', 'review'), tsk_work: task('tsk_work', 'in_progress') },
    bindings: {}, intents: {}, planHeads: {},
  };
  const human = { kind: 'human', via: 'web' };
  const review = taskHints({ state, leases: [], actor: human, now, readOnly: false, taskId: 'tsk_review', runtimeUnknown: true });
  const verify = review.allowedOps.find((entry) => entry.op === 'verify');
  assert.equal(verify.enabled, true, 'human verify is state/role eligibility, available cold');
  const work = taskHints({ state, leases: [], actor: human, now, readOnly: false, taskId: 'tsk_work', runtimeUnknown: true });
  for (const op of ['release', 'renew']) {
    const entry = work.allowedOps.find((item) => item.op === op);
    assert.equal(entry.enabled, false, 'a lease operation must not be offered without runtime facts: ' + op);
    assert.match(entry.reason, /runtime lease state is unknown/);
  }
  // Human block/interrupt work without a lease: persisted state is enough.
  for (const op of ['block', 'interrupt']) assert.equal(work.allowedOps.find((item) => item.op === op).enabled, true, op);
  const agent = { kind: 'agent', sessionId: 'other-session' };
  const agentReview = taskHints({ state, leases: [], actor: agent, now, readOnly: false, taskId: 'tsk_review', runtimeUnknown: true });
  assert.equal(agentReview.allowedOps.find((entry) => entry.op === 'reject').enabled, false, 'agent reject depends on an unobserved lease');
  // Hot reads keep the existing lease eligibility: the same provider, no flag.
  const hot = taskHints({ state, leases: [], actor: human, now, readOnly: false, taskId: 'tsk_work' });
  assert.equal(hot.allowedOps.find((entry) => entry.op === 'release').enabled, true, 'hot human eligibility is unchanged');
});
