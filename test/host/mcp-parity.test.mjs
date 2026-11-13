/**
 * 测试职责：通过回环 HTTP 验证 MCP 新增任务、计划、文档和会话操作。
 * 典型流程：创建合成项目并授权 → 调用新增工具 → 比较事件、回执和读取结果。
 * 覆盖边界：覆盖 凭据隔离、去重、冷读及文件边界；不覆盖 真实用户项目和浏览器。
 * 外部前置：需要本机回环端口、可写临时目录及用于合成固定内容的 Git。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { denied, listener, READ, success } from '../helpers/mcp-fixture.mjs';
import { command, makeService, withProject } from '../helpers/service-fixture.mjs';

const write = (...projectIds) => ({ enabled: true, projectIds });
const human = { kind: 'human', via: 'test' };

async function session(mcp, projectId) {
  const { sessionToken } = await success(mcp, 'open_work_session', { projectId });
  return { projectId, sessionToken };
}

async function createTask(mcp, scope, requestId) {
  return success(mcp, 'create_task', { ...scope, requestId, title: requestId, acceptance: [{ text: 'Check outcome' }] });
}

function taskArgs(scope, task, requestId) {
  return { ...scope, taskId: task.taskId, expectedRev: task.taskRev, requestId };
}

// 责任：检查同一续租请求的并发去重，以及阻塞和取消的租约与审计门约束。
test('MCP renewal is replay-safe and block/unblock uses the same fenced intent rules', async (t) => {
  let now = Date.now();
  const { svc, h } = await withProject(t, { clock: () => new Date(now) });
  const mcp = await listener(t, svc, write(h.id));
  const scope = await session(mcp, h.id);
  const other = await session(mcp, h.id);
  const created = await createTask(mcp, scope, 'blockable');
  const gated = await success(mcp, 'gate_task', { ...taskArgs(scope, created, 'gate'), requiresAudit: true });
  const beforeGateDenials = h.rev;
  denied(await mcp.call('gate_task', { ...taskArgs(scope, gated, 'disable'), requiresAudit: false }), 'forbidden-role');
  denied(await mcp.call('cancel_task', taskArgs(scope, gated, 'cancel-gated')), 'forbidden-role');
  assert.equal(h.rev, beforeGateDenials);
  const claimed = await success(mcp, 'claim_task', taskArgs(scope, gated, 'claim'));
  const fencingToken = claimed.lease.fencingToken;
  const renew = { ...taskArgs(scope, claimed, 'renew'), fencingToken };
  const beforeRenew = h.rev;
  now += 1000;
  const [first, second] = await Promise.all([success(mcp, 'renew_task', renew), success(mcp, 'renew_task', renew)]);
  assert.deepEqual([first.deduped, second.deduped].sort(), [false, true]);
  assert.equal(first.lease.expiresAt, second.lease.expiresAt);
  assert.ok(first.lease.expiresAt > claimed.lease.expiresAt);
  assert.equal(h.rev, beforeRenew);
  denied(await mcp.call('renew_task', { ...renew, ...other }), 'lease-held');
  const initialExpiry = Date.parse(claimed.lease.expiresAt);
  const renewedExpiry = Date.parse(first.lease.expiresAt);
  assert.ok(renewedExpiry > initialExpiry);
  const begun = await success(mcp, 'begin_task', { ...taskArgs(scope, claimed, 'begin'), fencingToken, summary: 'Do work' });
  const block = { ...taskArgs(scope, begun, 'block'), fencingToken, code: 'dependency' };
  denied(await mcp.call('block_task', block), 'intent-unresolved');
  const blocked = await success(mcp, 'block_task', { ...block, intent: { outcome: 'stopped', sideEffects: [] } });
  assert.equal(blocked.state, 'blocked');
  const unblocked = await success(mcp, 'unblock_task', taskArgs(other, blocked, 'unblock'));
  assert.equal(unblocked.state, 'ready');
  assert.equal(h.leases.size, 0);
  const ordinary = await createTask(mcp, scope, 'cancelable');
  const canceled = await success(mcp, 'cancel_task', taskArgs(scope, ordinary, 'cancel'));
  assert.equal(canceled.state, 'canceled');
});

// 责任：检查对账恢复在同一提交中绑定工作会话，且重试只返回仍有效的租约。
test('MCP reconcile can bind a new session atomically, recover its live lease and finish interrupted work', async (t) => {
  const { svc, h } = await withProject(t);
  const mcp = await listener(t, svc, write(h.id));
  const worker = await session(mcp, h.id);
  const recovery = await session(mcp, h.id);
  const created = await createTask(mcp, worker, 'interrupted');
  const claimed = await success(mcp, 'claim_task', taskArgs(worker, created, 'claim'));
  const begun = await success(mcp, 'begin_task', {
    ...taskArgs(worker, claimed, 'begin'), fencingToken: claimed.lease.fencingToken, summary: 'Record intent',
  });
  const interrupted = await success(mcp, 'interrupt_task', {
    ...taskArgs(worker, begun, 'interrupt'), fencingToken: claimed.lease.fencingToken, note: 'Unknown result',
  });
  const resume = { ...taskArgs(recovery, interrupted, 'resume'), choice: 'resume', note: 'Repeat work' };
  const resumed = await success(mcp, 'reconcile_task', resume);
  assert.equal(resumed.state, 'in_progress');
  assert.ok(resumed.lease.fencingToken > claimed.lease.fencingToken);
  const resumedCommit = h.store.commits.at(-1);
  assert.equal(resumedCommit.events[0].type, 'session/bound');
  assert.equal(resumedCommit.events[0].data.autoResume, false);
  assert.deepEqual(await success(mcp, 'reconcile_task', resume), { ...resumed, deduped: true });
  const second = await success(mcp, 'interrupt_task', {
    ...taskArgs(recovery, resumed, 'interrupt-again'), fencingToken: resumed.lease.fencingToken, note: 'Observed outcome',
  });
  const acceptanceId = h.state.tasks[second.taskId].acceptance[0].id;
  const review = await success(mcp, 'reconcile_task', {
    ...taskArgs(worker, second, 'complete'), choice: 'completed', note: 'Accounted for work', evidence: [{ kind: 'note', ref: 'fixture', acceptanceId }],
  });
  assert.equal(review.state, 'review');
  assert.equal((await success(mcp, 'reconcile_task', resume)).lease, null);
});

// 责任：检查草稿发布、计划归属和版本冲突沿用已有领域命令。
test('MCP plans reuse revision and stage guards with durable creation receipts', async (t) => {
  const { svc, h } = await withProject(t);
  const mcp = await listener(t, svc, write(h.id));
  const scope = await session(mcp, h.id);
  const view = (name, args = {}) => success(mcp, 'get_project_view', { ...scope, view: name, ...args });
  const manage = (op, args) => success(mcp, 'manage_plan', { ...scope, op, ...args });
  const steps = [{ id: 'prepare', title: 'Prepare', tasks: [{ key: 'note', title: 'Note', acceptance: [{ text: 'Check note' }] }] }];
  const input = { requestId: 'draft', title: 'Synthetic plan', steps };
  assert.equal((await mcp.call('manage_plan', { ...scope, ...input, op: 'create' }, READ)).error.code, -32602);
  const draft = await manage('create', input);
  assert.equal(draft.status, 'draft');
  assert.deepEqual(await manage('create', input), { ...draft, deduped: true });
  assert.equal((await view('plan', { planId: draft.planId })).plan.steps[0].tasks[0].key, 'note');
  denied(await mcp.call('manage_plan', { ...scope, op: 'publish', planId: draft.planId, expectedRev: 99, requestId: 'stale' }), 'stale-revision');
  const published = await manage('publish', { planId: draft.planId, expectedRev: draft.planRev, requestId: 'publish' });
  assert.equal(published.version, 1);
  const active = await view('plan', { planId: draft.planId });
  const taskId = active.steps[0].taskIds[0];
  const standalone = await createTask(mcp, scope, 'standalone');
  const adopted = await manage('adopt', { planId: draft.planId, baseVersion: 1, stepId: active.steps[0].id, taskIds: [standalone.taskId], requestId: 'adopt' });
  const released = await manage('release', { planId: draft.planId, baseVersion: adopted.version, taskIds: [taskId], requestId: 'release' });
  assert.equal(released.version, 3);
  assert.equal(h.state.tasks[taskId].planRef, null);
  const archived = await manage('archive', { planId: draft.planId, expectedRev: released.planRev, requestId: 'archive' });
  assert.equal(archived.status, 'archived');
  const restored = await manage('unarchive', { planId: draft.planId, expectedRev: archived.planRev, requestId: 'unarchive' });
  assert.equal(restored.status, 'active');
  assert.equal((await view('plans')).plans.length, 1);
  denied(await mcp.call('manage_plan', { ...scope, op: 'focus', planId: draft.planId, requestId: 'focus' }), 'invalid-command');
});

// 责任：检查授权视图和文档登记，以及冷读不取得写锁或改动日志。
test('MCP authorized views are lock-free on cold projects and omit host-only lease and binding fields', async (t) => {
  const { svc, h, stateDir, wsDir } = await withProject(t);
  const projectId = h.id;
  const docFile = path.join(wsDir, 'note.md');
  fs.writeFileSync(docFile, 'Synthetic external document');
  const mcp = await listener(t, svc, write(projectId));
  const scope = await session(mcp, projectId);
  const read = (view, args = {}) => success(mcp, 'get_project_view', { ...scope, view, ...args });
  const register = { ...scope, op: 'register', requestId: 'register', relPath: 'note.md', title: 'Fixture' };
  denied(await mcp.call('manage_document', { ...register, relPath: '../outside.md' }), 'security-rejected');
  const doc = await success(mcp, 'manage_document', register);
  assert.deepEqual(await success(mcp, 'manage_document', register), { ...doc, deduped: true });
  denied(await mcp.call('manage_document', { ...scope, op: 'put', requestId: 'put', title: 'Inline', body: 'Archive' }), 'inline-write-disabled');
  const inspected = await read('inspect', { docId: doc.docId, preview: true });
  assert.equal(inspected.observation.preview.text, 'Synthetic external document');
  assert.equal(Object.hasOwn(inspected.observation.context, 'root'), false);
  const confirm = { ...scope, op: 'confirm', docId: doc.docId, expectedMetaRev: doc.docRev, requestId: 'confirm', expectedContentHash: inspected.observation.contentHash };
  const confirmed = await success(mcp, 'manage_document', confirm);
  assert.equal(confirmed.docRev, 2);
  denied(await mcp.call('manage_document', { ...confirm, requestId: 'confirm-stale' }), 'stale-revision');
  const task = await createTask(mcp, scope, 'task-for-views');
  const claimed = await success(mcp, 'claim_task', taskArgs(scope, task, 'claim'));
  const taskView = await read('task', { taskId: task.taskId });
  assert.equal(taskView.lease.expiresAt, claimed.lease.expiresAt);
  assert.equal(Object.hasOwn(taskView.task.owner, 'fencingToken'), false);
  assert.equal(taskView.allowedOps.find(({ op }) => op === 'begin').enabled, true);
  assert.equal(Object.hasOwn((await read('board')).project, 'workspacePath'), false);
  const checkpoint = { ...scope, requestId: 'checkpoint', note: 'Synthetic checkpoint', nextActions: ['Continue'] };
  const saved = await success(mcp, 'checkpoint_work_session', checkpoint);
  assert.deepEqual(await success(mcp, 'checkpoint_work_session', checkpoint), { ...saved, deduped: true });
  await success(mcp, 'handoff_work_session', { ...checkpoint, requestId: 'handoff' });
  assert.equal((await read('brief')).delivery.checkpoint.note, checkpoint.note);
  assert.equal((await read('events')).events.at(-1).type, 'session/handoff');
  assert.equal((await read('health')).evidenceAudit.status, 'complete');
  const { commitsFile, lockFile } = h.store;
  const original = fs.readFileSync(commitsFile);
  await mcp.close();
  await svc.close();
  const { svc: cold } = await makeService(t, { rootDir: stateDir });
  const next = await listener(t, cold, write(projectId));
  const coldScope = await session(next, projectId);
  denied(await next.call('get_project_view', { ...scope, view: 'board' }), 'work-session-invalid');
  const coldTask = await success(next, 'get_project_view', { ...coldScope, view: 'task', taskId: task.taskId });
  assert.equal(coldTask.task.state, 'in_progress');
  assert.equal(coldTask.allowedOps, null);
  assert.equal((await success(next, 'get_project_view', { ...coldScope, view: 'list_external' })).docs.length, 1);
  assert.deepEqual(fs.readFileSync(commitsFile), original);
  assert.equal(fs.existsSync(lockFile), false);
  assert.equal(cold.lookupLiveWriter(projectId), null);
});

// 责任：检查固定内容受项目绑定限制，且大文档仍能返回有标记的预览。
test('MCP fixed reads use the authorized binding and reject an enclosing repository', async (t) => {
  const { svc, h, wsDir } = await withProject(t);
  const git = (...args) => execFileSync('git', args, { cwd: wsDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  fs.writeFileSync(path.join(wsDir, 'note.md'), 'Committed content\n');
  const nested = path.join(wsDir, 'nested');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, 'other.md'), 'Nested project document');
  fs.writeFileSync(path.join(wsDir, 'large.md'), '中'.repeat(100_000));
  git('add', 'note.md', 'nested/other.md', 'large.md');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Fixture');
  const commitOid = git('rev-parse', 'HEAD');
  const other = await svc.createProject({ workspacePath: nested });
  const mcp = await listener(t, svc, write(h.id, other.id));
  const scope = await session(mcp, h.id);
  const nestedScope = await session(mcp, other.id);
  const reg = (ctx, relPath) => success(mcp, 'manage_document', {
    ...ctx, op: 'register', requestId: 'reg', title: relPath, relPath,
  });
  const own = await reg(scope, 'note.md');
  const outsider = await reg(nestedScope, 'other.md');
  const args = { view: 'get_fixed', commitOid, pathAtCommit: 'note.md' };
  const result = await success(mcp, 'get_project_view', { ...scope, ...args, docId: own.docId });
  assert.equal(result.body, 'Committed content\n');
  const large = await reg(scope, 'large.md');
  const fixed = await success(mcp, 'get_project_view', { ...scope, ...args, docId: large.docId, pathAtCommit: 'large.md' });
  const observed = await success(mcp, 'get_project_view', { ...scope, view: 'inspect', docId: large.docId, preview: true });
  for (const preview of [fixed, { ...observed.observation.preview, body: observed.observation.preview.text }]) {
    assert.equal(Buffer.byteLength(preview.body), 24 * 1024);
    assert.equal(preview.truncated, true);
    assert.equal(preview.totalBytes, 300_000);
  }
  denied(await mcp.call('get_project_view', { ...nestedScope, ...args, docId: outsider.docId }), 'outside-root');
});

// 责任：检查内嵌档案禁写策略在冷开前生效，已提交重试仍返回原回执。
test('MCP cold inline writes reuse archive policy before acquiring a writer', async (t) => {
  const { svc, h, stateDir } = await withProject(t);
  const projectId = h.id;
  await h.command(command('doc.inline_policy', { actor: human, disabled: false, authorized: true, expected: { projectRev: h.rev } }));
  const mcp = await listener(t, svc, write(projectId));
  const scope = await session(mcp, projectId);
  const put = { ...scope, op: 'put', requestId: 'inline', title: 'Archive', body: 'Fixture inline content' };
  const saved = await success(mcp, 'manage_document', put);
  assert.deepEqual(await success(mcp, 'manage_document', put), { ...saved, deduped: true });
  const linked = await success(mcp, 'manage_document', { ...scope, op: 'link', requestId: 'links', docId: saved.docId, links: { taskIds: [] } });
  assert.equal(linked.docRev, 2);
  const view = await success(mcp, 'get_project_view', { ...scope, view: 'doc', docId: saved.docId, maxBytes: 7 });
  assert.equal(view.body, 'Fixture');
  assert.equal(view.truncated, true);
  await h.command(command('doc.inline_policy', { actor: human, disabled: true, authorized: true, expected: { projectRev: h.rev } }));
  const replayed = await success(mcp, 'manage_document', put);
  assert.equal(replayed.deduped, true);
  assert.equal(replayed.docId, saved.docId);
  denied(await mcp.call('manage_document', { ...put, requestId: 'new-put' }), 'inline-write-disabled');
  const { commitsFile, lockFile } = h.store;
  const before = fs.readFileSync(commitsFile);
  await mcp.close();
  await svc.close();
  const { svc: cold } = await makeService(t, { rootDir: stateDir });
  const next = await listener(t, cold, write(projectId));
  const newScope = await session(next, projectId);
  denied(await next.call('manage_document', { ...put, ...newScope }), 'inline-write-disabled');
  assert.deepEqual(fs.readFileSync(commitsFile), before);
  assert.equal(fs.existsSync(lockFile), false);
});
