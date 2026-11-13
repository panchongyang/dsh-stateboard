/**
 * 测试职责：通过本机 MCP 监听验证独立写凭据、工作会话和任务流转。
 * 典型流程：创建合成项目 → 按凭据发现工具 → 领取、提交或释放 → 核对日志与租约。
 * 覆盖边界：覆盖授权拒绝、并发重试、恢复和回滚；不覆盖日常 DSH profile 或真实数据。
 * 外部前置：需要本机回环端口及可写的合成临时目录。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { agentVerificationValid } from '../../lib/core/audit.js';
import { JsonlStore } from '../../lib/core/store.js';
import { faultFs, ioError } from '../helpers/fault-fs.mjs';
import { makeService, withProject, command } from '../helpers/service-fixture.mjs';

import { denied, ENV, listener, READ, success, WRITE } from '../helpers/mcp-fixture.mjs';

const HUMAN = { kind: 'human', via: 'test' };

async function readyTask(h, extra = {}) {
  const created = await h.command(command('task.create', {
    actor: HUMAN, title: 'Synthetic work', acceptance: [{ text: 'Check evidence', requiredKinds: ['note'] }], ...extra,
  }));
  return created.events[0].data;
}

async function startWork(mcp, projectId, task) {
  const { sessionToken } = await success(mcp, 'open_work_session', { projectId });
  return { projectId, taskId: task.id, sessionToken, expectedRev: task.rev, requestId: 'claim-1' };
}

const writes = (projectIds) => ({ enabled: true, projectIds });

// 责任：写开关、项目清单或独立凭据不满足时保留原有只读目录。
test('MCP writes require explicit opt-in, an allowlist and a distinct write bearer', { timeout: 15000 }, async (t) => {
  const { svc, h } = await withProject(t);
  const variants = [
    [undefined, ENV],
    [Object.create(writes([h.id])), ENV],
    [{ enabled: 'true', projectIds: [h.id] }, ENV],
    [writes([]), ENV],
    [writes(['../outside']), ENV],
    [writes([h.id]), { ...ENV, PROJECT_BOARD_MCP_WRITE_TOKEN: READ }],
    [writes([h.id]), { ...ENV, PROJECT_BOARD_MCP_WRITE_TOKEN: '' }],
  ];
  for (const [settings, env] of variants) {
    const mcp = await listener(t, svc, settings, env);
    try {
      const read = await mcp.post(READ, 'tools/list', {});
      assert.deepEqual(read.result.tools.map(({ name }) => name), ['list_projects', 'list_tasks', 'get_task', 'get_work_context']);
      assert.deepEqual(await mcp.post(WRITE, 'tools/list', {}), { status: 401 });
    } finally {
      await mcp.close();
    }
  }
});

// 责任：项目越权、凭据隔离、会话伪造和未知参数都在冷开 writer 前拒绝。
test('MCP authorization, session and shape denials leave cold project logs and locks untouched', { timeout: 12000 }, async (t) => {
  const { svc, h, stateDir, wsDir } = await withProject(t);
  const otherDir = path.join(wsDir, 'other');
  fs.mkdirSync(otherDir);
  const other = await svc.createProject({ workspacePath: otherDir });
  const task = await readyTask(h);
  const otherTask = await readyTask(other);
  await other.command(command('task.claim', { actor: HUMAN, taskId: otherTask.id, expected: { entityRev: otherTask.rev } }));
  const targets = [h, other].map(({ store }) => [store.commitsFile, store.lockFile, fs.readFileSync(store.commitsFile)]);
  await svc.close();
  const { svc: cold } = await makeService(t, { rootDir: stateDir });
  const mcp = await listener(t, cold, writes([h.id]));
  const claim = await startWork(mcp, h.id, task);
  const create = { projectId: h.id, sessionToken: claim.sessionToken, requestId: 'new', title: 'Follow-up', acceptance: [{ text: 'Prove it' }] };
  assert.equal((await mcp.call('claim_task', claim, READ)).error.code, -32602);
  assert.equal((await mcp.call('create_task', create, READ)).error.code, -32602);
  assert.deepEqual(await mcp.call('claim_task', claim, 'ab'.repeat(24)), { status: 401 });
  assert.equal((await mcp.call('get_task', { projectId: h.id, taskId: task.id })).error.code, -32602);
  const review = { ...claim, audit: { report: 'Independently checked the synthetic evidence.' } };
  assert.equal((await mcp.call('verify_task', review, READ)).error.code, -32602);
  assert.equal((await mcp.call('reject_task', { ...claim, reason: 'Rework required' }, READ)).error.code, -32602);
  denied(await mcp.call('verify_task', { ...review, projectId: other.id, taskId: otherTask.id }), 'project-forbidden');
  denied(await mcp.call('verify_task', { ...review, audit: { ...review.audit, by: HUMAN } }), 'invalid-command');
  denied(await mcp.call('reject_task', { ...claim, reason: 'Rework required', unassign: true }), 'invalid-command');
  denied(await mcp.call('open_work_session', { projectId: other.id }), 'project-forbidden');
  denied(await mcp.call('claim_task', { ...claim, projectId: other.id, taskId: otherTask.id }), 'project-forbidden');
  denied(await mcp.call('create_task', { ...create, projectId: other.id }), 'project-forbidden');
  denied(await mcp.call('create_task', { ...create, actor: { kind: 'human' } }), 'invalid-command');
  denied(await mcp.call('claim_task', { ...claim, actor: { kind: 'human' } }), 'invalid-command');
  denied(await mcp.call('claim_task', { ...claim, sessionId: 'forged' }), 'invalid-command');
  denied(await mcp.call('claim_task', { ...claim, expectedRev: String(task.rev) }), 'invalid-command');
  denied(await mcp.call('claim_task', { ...claim, sessionToken: claim.sessionToken.replace(/.$/, (c) => c === 'a' ? 'b' : 'a') }), 'work-session-invalid');
  await mcp.close();

  const broader = await listener(t, cold, writes([h.id, other.id]));
  const newClaim = await startWork(broader, h.id, task);
  denied(await broader.call('claim_task', { ...newClaim, projectId: other.id, taskId: otherTask.id }), 'work-session-invalid');
  denied(await broader.call('claim_task', claim), 'work-session-invalid');
  for (const [log, lock, before] of targets) {
    assert.deepEqual(fs.readFileSync(log), before);
    assert.equal(fs.existsSync(lock), false);
  }
});

// 责任：验证领取、执行意图和证据提交的既有规则，以及持久去重与审查状态。
test('MCP claim, intent and evidence submission use the existing task workflow and durable dedupe', { timeout: 12000 }, async (t) => {
  const { svc, h, stateDir } = await withProject(t);
  const task = await readyTask(h);
  const mcp = await listener(t, svc, writes([h.id]));
  const { result } = await mcp.post(WRITE, 'tools/list', {});
  assert.deepEqual(result.tools.map(({ name }) => name),
    ['open_work_session', 'create_task', 'update_task', 'ready_task', 'claim_task', 'begin_task', 'submit_task',
      'verify_task', 'reject_task', 'release_task', 'interrupt_task', 'gate_task', 'renew_task', 'block_task',
      'unblock_task', 'reconcile_task', 'cancel_task', 'manage_plan', 'manage_document',
      'checkpoint_work_session', 'handoff_work_session', 'get_project_view']);
  const claim = await startWork(mcp, h.id, task);
  const before = h.rev;
  denied(await mcp.call('claim_task', { ...claim, projectRev: h.rev + 1 }), 'stale-revision');
  assert.equal(h.rev, before);
  const got = await success(mcp, 'claim_task', claim);
  assert.equal(got.state, 'in_progress');
  assert.equal(got.taskRev, task.rev + 1);
  assert.ok(got.lease.fencingToken > 0);
  const commit = h.store.commits.at(-1);
  assert.deepEqual(commit.events.map(({ type }) => type), ['session/bound', 'lease/granted', 'task/claimed']);
  assert.equal(commit.actor.kind, 'agent');
  assert.equal(commit.actor.agentId, 'codex:mcp:' + commit.actor.sessionId.slice('mcp_'.length));
  assert.equal(commit.actor.via, 'mcp');
  assert.equal(commit.events[0].data.sessionId, commit.actor.sessionId);
  assert.equal(commit.events[0].data.autoResume, false);
  assert.equal(commit.events[1].data.epoch, commit.events[0].data.epoch);
  assert.ok(!fs.readFileSync(h.store.commitsFile, 'utf8').includes(claim.sessionToken));
  const retry = await success(mcp, 'claim_task', Object.fromEntries(Object.entries(claim).reverse()));
  assert.deepEqual(retry, { ...got, deduped: true });
  assert.equal(h.rev, before + 1);

  const begin = { ...claim, expectedRev: got.taskRev, requestId: 'begin-1', fencingToken: got.lease.fencingToken, summary: 'Prepare proof' };
  const other = await startWork(mcp, h.id, task);
  denied(await mcp.call('begin_task', { ...begin, sessionToken: other.sessionToken }), 'lease-held');
  denied(await mcp.call('begin_task', { ...begin, fencingToken: begin.fencingToken + 1 }), 'fencing-stale');
  const begun = await success(mcp, 'begin_task', begin);
  const submit = { ...claim, expectedRev: begun.taskRev, requestId: 'submit-1', fencingToken: begin.fencingToken };
  const priorSubmit = h.rev;
  denied(await mcp.call('submit_task', { ...submit, evidence: [] }), 'missing-evidence');
  denied(await mcp.call('submit_task', { ...submit, evidence: [{ kind: 'file', ref: '../outside' }] }), 'invalid-command');
  denied(await mcp.call('submit_task', { ...submit, evidence: [{ kind: 'note', ref: 'result', fixed: {} }] }), 'invalid-command');
  assert.equal(h.rev, priorSubmit);
  const args = { ...submit, evidence: [{ kind: 'note', ref: 'Checked', acceptanceId: task.acceptance[0].id }] };
  const submitted = await success(mcp, 'submit_task', args);
  assert.equal(submitted.state, 'review');
  assert.deepEqual(await success(mcp, 'submit_task', args), { ...submitted, deduped: true });
  assert.equal((await success(mcp, 'claim_task', claim)).lease, null);

  await mcp.close();
  await svc.close();
  const { svc: reopened } = await makeService(t, { rootDir: stateDir });
  const live = await reopened.open(h.id);
  assert.equal(live.state.tasks[task.id].state, 'review');
  assert.equal(live.state.tasks[task.id].acceptance[0].met, true);
});

// 责任：通过同一工作会话从建卡走到人审，复用依赖、版本、审计门与租约校验。
test('MCP task intake and work close the loop using existing agent permissions', { timeout: 12000 }, async (t) => {
  const { svc, h } = await withProject(t);
  const dependency = await readyTask(h);
  const mcp = await listener(t, svc, writes([h.id]));
  const { sessionToken } = await success(mcp, 'open_work_session', { projectId: h.id });
  const session = { projectId: h.id, sessionToken };
  const create = {
    ...session, requestId: 'create', title: 'Develop ProjectBoard',
    acceptance: [{ text: 'Provide the result', requiredKinds: ['note'] }],
    priority: -5, weight: 1.5, labels: ['self-host'], requiresAudit: true, deps: [dependency.id],
  };
  const beforeCreate = h.rev;
  denied(await mcp.call('create_task', { ...create, projectRev: beforeCreate + 1 }), 'stale-revision');
  denied(await mcp.call('create_task', { ...create, acceptance: [{ text: 'Proof', met: true }] }), 'invalid-command');
  const pair = await Promise.all([success(mcp, 'create_task', create), success(mcp, 'create_task', create)]);
  assert.equal(pair[0].taskId, pair[1].taskId);
  assert.deepEqual(pair.map(({ deduped }) => deduped).sort(), [false, true]);
  const task = pair[0];
  assert.equal(task.state, 'backlog');
  assert.equal(task.taskRev, 1);
  assert.equal(h.rev, beforeCreate + 1);
  assert.deepEqual(Object.keys(h.state.bindings), []);
  const creator = h.state.tasks[task.taskId].createdBy;
  assert.equal(creator.agentId, 'codex:mcp:' + creator.sessionId.slice('mcp_'.length));
  assert.equal(h.state.tasks[task.taskId].priority, -5);
  assert.equal(h.state.tasks[task.taskId].weight, 1.5);
  const work = { ...session, taskId: task.taskId };
  const edit = { ...work, expectedRev: task.taskRev, requestId: 'edit', description: 'Deliver', deps: [], reason: 'Scope clarified' };
  denied(await mcp.call('ready_task', { ...work, expectedRev: task.taskRev, requestId: 'ready' }), 'dependency-unmet');
  denied(await mcp.call('update_task', { ...edit, requiresAudit: false }), 'forbidden-role');
  assert.equal(h.rev, beforeCreate + 1);
  const updated = await success(mcp, 'update_task', edit);
  assert.equal(updated.state, 'backlog');
  assert.deepEqual(await success(mcp, 'update_task', edit), { ...updated, deduped: true });
  assert.equal(h.store.commits.at(-1).events.find(({ type }) => type === 'task/meta-edited').data.reason, 'Scope clarified');
  const ready = { ...work, expectedRev: updated.taskRev, requestId: 'ready' };
  denied(await mcp.call('ready_task', { ...ready, expectedRev: task.taskRev }), 'stale-revision');
  const promoted = await success(mcp, 'ready_task', ready);
  assert.equal(promoted.state, 'ready');
  assert.deepEqual(await success(mcp, 'ready_task', ready), { ...promoted, deduped: true });
  const claim = await success(mcp, 'claim_task', { ...work, expectedRev: promoted.taskRev, requestId: 'claim' });
  const other = await success(mcp, 'open_work_session', { projectId: h.id });
  const leasedEdit = { ...work, expectedRev: claim.taskRev, requestId: 'leased-edit', description: 'Delivery underway' };
  denied(await mcp.call('update_task', { ...leasedEdit, sessionToken: other.sessionToken }), 'lease-held');
  const amended = await success(mcp, 'update_task', leasedEdit);
  const fenced = { ...work, fencingToken: claim.lease.fencingToken };
  const begun = await success(mcp, 'begin_task', { ...fenced, expectedRev: amended.taskRev, requestId: 'begin', summary: 'Work' });
  const acceptanceId = h.state.tasks[task.taskId].acceptance[0].id;
  const submitted = await success(mcp, 'submit_task', {
    ...fenced, expectedRev: begun.taskRev, requestId: 'submit',
    evidence: [{ kind: 'note', ref: 'Checked', acceptanceId }],
  });
  assert.equal(submitted.state, 'review');
  await h.command(command('task.verify', {
    actor: HUMAN, taskId: task.taskId, expected: { entityRev: submitted.taskRev },
  }));
  const done = await success(mcp, 'get_task', { projectId: h.id, taskId: task.taskId }, READ);
  assert.equal(done.task.state, 'done');
  const replay = await success(mcp, 'create_task', create);
  assert.equal(replay.deduped, true);
  assert.equal(replay.taskId, task.taskId);
  assert.equal(replay.taskRev, done.task.rev);
  assert.equal(Object.keys(h.state.tasks).length, 2);
});

// 用途：提交带一条验收证据的 MCP 任务，保留提交会话用于自审与独立审查对照。
async function submitForReview(mcp, projectId, task, evidence = { kind: 'note', ref: 'Checked' }) {
  const claim = await startWork(mcp, projectId, task);
  const got = await success(mcp, 'claim_task', claim);
  const submitted = await success(mcp, 'submit_task', {
    ...claim, requestId: 'submit', expectedRev: got.taskRev, fencingToken: got.lease.fencingToken,
    evidence: [{ ...evidence, acceptanceId: task.acceptance[0].id }],
  });
  assert.equal(submitted.state, 'review');
  return { ...claim, requestId: 'review', expectedRev: submitted.taskRev };
}

// 责任：MCP 普通任务允许提交会话无报告验收，并持久化真实会话身份。
test('MCP ordinary verification accepts the authenticated submitter without an audit report', async (t) => {
  const { svc, h } = await withProject(t);
  const task = await readyTask(h);
  const mcp = await listener(t, svc, writes([h.id]));
  const review = await submitForReview(mcp, h.id, task);
  const worker = h.store.commits.at(-1).actor;
  const verified = await success(mcp, 'verify_task', review);
  assert.equal(verified.state, 'done');
  const record = h.state.tasks[task.id].lastAudit;
  assert.equal(record.gate, false);
  assert.deepEqual(record.by, worker);
  assert.equal(record.report, '');
  assert.ok(agentVerificationValid(h.state.tasks[task.id]));
});

// 责任：同一 MCP 会话不可自审，独立会话可验收，失败重试与并发只提交一次。
test('MCP gated verification uses distinct authenticated identities and commits once', { timeout: 12000 }, async (t) => {
  let faults;
  const { svc, h, stateDir } = await withProject(t, {
    storeFactory(dir, meta) {
      faults = faultFs(dir);
      return new JsonlStore(dir, meta, { fs: faults.io });
    },
  });
  const task = await readyTask(h, { requiresAudit: true });
  const mcp = await listener(t, svc, writes([h.id]));
  const review = await submitForReview(mcp, h.id, task);
  const worker = h.store.commits.at(-1).actor;
  const { sessionToken } = await success(mcp, 'open_work_session', { projectId: h.id });
  const audit = { report: 'Independently checked the submitted evidence.', checklist: [{ item: 'Evidence', ok: true }] };
  const verify = { ...review, sessionToken, audit };
  const { commitsFile } = h.store;
  const before = fs.readFileSync(commitsFile);
  denied(await mcp.call('verify_task', { ...review, audit }), 'forbidden-role');
  denied(await mcp.call('verify_task', { ...review, sessionToken }), 'invalid-command');
  denied(await mcp.call('verify_task', { ...verify, sessionId: worker.sessionId }), 'invalid-command');
  denied(await mcp.call('verify_task', { ...verify, acknowledgeDrift: false }), 'invalid-command');
  denied(await mcp.call('verify_task', { ...verify, audit: { report: '   too short   ' } }), 'invalid-command');
  faults.arm('fsyncSync', (file) => file === commitsFile, () => { throw ioError(); });
  const failed = await mcp.call('verify_task', verify);
  assert.deepEqual(failed.error, { code: -32603, message: 'Internal error' });
  faults.consumed();
  assert.deepEqual(fs.readFileSync(commitsFile), before);
  assert.equal(h.state.tasks[task.id].state, 'review');
  assert.equal(h.state.tasks[task.id].lastAudit, null);

  const pair = await Promise.all([success(mcp, 'verify_task', verify), success(mcp, 'verify_task', verify)]);
  assert.deepEqual(pair.map(({ deduped }) => deduped).sort(), [false, true]);
  assert.equal(pair[0].state, 'done');
  assert.equal(h.store.commits.at(-1).events.filter(({ type }) => type === 'task/verified').length, 1);
  const record = h.state.tasks[task.id].lastAudit;
  assert.deepEqual(record.by, h.store.commits.at(-1).actor);
  assert.equal(record.by.kind, 'agent');
  assert.equal(record.by.via, 'mcp');
  assert.notEqual(record.by.agentId, worker.agentId);
  assert.notEqual(record.by.sessionId, worker.sessionId);
  assert.deepEqual(record.checklist, audit.checklist);
  assert.ok(agentVerificationValid(h.state.tasks[task.id]));
  const log = fs.readFileSync(commitsFile, 'utf8');
  assert.ok(!log.includes(sessionToken) && !log.includes(review.sessionToken));

  await mcp.close();
  await svc.close();
  const { svc: reopened } = await makeService(t, { rootDir: stateDir });
  const replayed = (await reopened.open(h.id)).state.tasks[task.id];
  assert.deepEqual(replayed.lastAudit, record);
  assert.ok(agentVerificationValid(replayed));
});

// 责任：兼容旧 MCP 归因；漂移由 core 拦截；驳回按原规则返工且不发放 MCP 租约。
test('MCP review handles legacy attribution and sends drift back for rework', { timeout: 12000 }, async (t) => {
  const { svc, h } = await withProject(t);
  const task = await readyTask(h, { requiresAudit: true, acceptance: [{ text: 'Check bytes', requiredKinds: ['file'] }] });
  const worker = { kind: 'agent', sessionId: 'mcp_legacy_fixture', agentId: 'codex:mcp', via: 'mcp' };
  const claimed = await h.command(command('task.claim', {
    actor: worker, taskId: task.id, expected: { entityRev: task.rev },
  }), { claimSessionSource: 'mcp' });
  const artifact = path.join(h.workspacePath, 'artifact.txt');
  fs.writeFileSync(artifact, 'original');
  const submitted = await h.command(command('task.submit', {
    actor: worker, taskId: task.id, expected: { entityRev: claimed.entityRev }, fencingToken: h.leases.get(task.id).token,
    evidence: [{ kind: 'file', ref: 'artifact.txt', acceptanceId: task.acceptance[0].id }],
  }));
  const mcp = await listener(t, svc, writes([h.id]));
  const { sessionToken } = await success(mcp, 'open_work_session', { projectId: h.id });
  const review = { projectId: h.id, taskId: task.id, sessionToken, expectedRev: submitted.entityRev };
  const audit = { report: 'The evidence content changed after submission.' };
  fs.writeFileSync(artifact, 'changed');
  const before = fs.readFileSync(h.store.commitsFile);
  const failure = await mcp.call('verify_task', { ...review, requestId: 'verify', audit });
  denied(failure, 'evidence-drift');
  assert.ok(!JSON.stringify(failure).includes('artifact.txt'));
  assert.deepEqual(fs.readFileSync(h.store.commitsFile), before);

  const reject = { ...review, requestId: 'reject', reason: 'Evidence changed. Please rerun the check.', audit };
  const receipt = await success(mcp, 'reject_task', reject);
  assert.equal(receipt.state, 'ready');
  assert.deepEqual(await success(mcp, 'reject_task', reject), { ...receipt, deduped: true });
  const record = h.state.tasks[task.id].lastAudit;
  assert.equal(record.verdict, 'fail');
  assert.equal(record.by.kind, 'agent');
  assert.equal(record.workers[0].agentId, 'codex:mcp');
  assert.equal(h.state.tasks[task.id].rejection.reason, reject.reason);
  assert.equal(h.leases.has(task.id), false);
  denied(await mcp.call('verify_task', { ...review, requestId: 'stale', audit }), 'stale-revision');
});

// 责任：普通任务可由 MCP 驳回，人类验收仍可在不提供报告的情况下通过。
test('an ungated review keeps human acceptance and MCP rejection', { timeout: 12000 }, async (t) => {
  const { svc, h } = await withProject(t);
  const task = await readyTask(h);
  const mcp = await listener(t, svc, writes([h.id]));
  const review = await submitForReview(mcp, h.id, task);
  const { sessionToken } = await success(mcp, 'open_work_session', { projectId: h.id });
  const independent = { ...review, sessionToken };
  const rejected = await success(mcp, 'reject_task', { ...independent, reason: 'More evidence needed' });
  assert.equal(rejected.state, 'ready');
  assert.equal(h.state.tasks[task.id].lastAudit, null);
  const resubmitted = await submitForReview(mcp, h.id, h.state.tasks[task.id]);
  await h.command(command('task.verify', {
    actor: HUMAN, taskId: task.id, expected: { entityRev: resubmitted.expectedRev },
  }));
  assert.equal(h.state.tasks[task.id].verifiedBy, 'human');
});

// 责任：遗留 review 若有活动租约，MCP 驳回仍走 core 持有者和 fencing 守卫。
test('a legacy review lease fences MCP rejection to the owner and current token', { timeout: 12000 }, async (t) => {
  const { svc, h } = await withProject(t);
  const task = await readyTask(h);
  const mcp = await listener(t, svc, writes([h.id]));
  const review = await submitForReview(mcp, h.id, task);
  // 正常 submit 撤销租约。合成活动租约仅用于命中原生防御分支。
  const { sessionId, agentId, epoch } = h.state.tasks[task.id].assignee;
  const token = h.state.counters.leaseToken;
  h.leases.set(task.id, {
    taskId: task.id, sessionId, agentId, epoch, token, expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });
  const { sessionToken } = await success(mcp, 'open_work_session', { projectId: h.id });
  const reject = { ...review, reason: 'Rework required' };
  const before = fs.readFileSync(h.store.commitsFile);
  denied(await mcp.call('reject_task', { ...reject, sessionToken, fencingToken: token }), 'forbidden-role');
  denied(await mcp.call('reject_task', reject), 'fencing-stale');
  denied(await mcp.call('reject_task', { ...reject, fencingToken: token + 1 }), 'fencing-stale');
  assert.deepEqual(fs.readFileSync(h.store.commitsFile), before);
  const receipt = await success(mcp, 'reject_task', { ...reject, fencingToken: token });
  assert.equal(receipt.state, 'in_progress');
  assert.equal(h.leases.get(task.id).token, token);
});

// 责任：并发领取只产生一枚有效租约，重试不能返回后续授予的 token。
test('concurrent claims fence sessions and replay cannot recover a newer grant', { timeout: 12000 }, async (t) => {
  const { svc, h } = await withProject(t);
  const task = await readyTask(h);
  const mcp = await listener(t, svc, writes([h.id]));
  const attempts = await Promise.all([startWork(mcp, h.id, task), startWork(mcp, h.id, task)]);
  const replies = await Promise.all(attempts.map((claim) => mcp.call('claim_task', claim)));
  const winner = replies.findIndex((reply) => !reply.result.isError);
  assert.notEqual(winner, -1);
  denied(replies[1 - winner], 'lease-held');
  const claimed = replies[winner].result.structuredContent;
  const claim = attempts[winner];
  const leaseArgs = { ...claim, fencingToken: claimed.lease.fencingToken };
  const begun = await success(mcp, 'begin_task', { ...leaseArgs, expectedRev: claimed.taskRev, requestId: 'begin', summary: 'Record work' });
  const release = { ...leaseArgs, expectedRev: begun.taskRev, requestId: 'release' };
  denied(await mcp.call('release_task', release), 'intent-unresolved');
  const ready = await success(mcp, 'release_task', { ...release, intent: { outcome: 'stopped', sideEffects: [] } });
  assert.equal(ready.state, 'ready');
  const newer = { ...claim, expectedRev: ready.taskRev, requestId: 'claim-2' };
  const same = await Promise.all([success(mcp, 'claim_task', newer), success(mcp, 'claim_task', newer)]);
  assert.deepEqual(same.map(({ deduped }) => deduped).sort(), [false, true]);
  assert.deepEqual(same[0].lease, same[1].lease);
  assert.ok(same[0].lease.fencingToken > claimed.lease.fencingToken);
  const old = await success(mcp, 'claim_task', claim);
  assert.equal(old.deduped, true);
  assert.equal(old.lease, null);
});

// 责任：人工驳回后任务可重新领取，宿主重启也不向旧会话隐式授予租约。
test('rejecting MCP work leaves a claimable task both live and after restart', { timeout: 12000 }, async (t) => {
  for (const restart of [false, true]) {
    const { svc, h, stateDir } = await withProject(t);
    const task = await readyTask(h);
    const mcp = await listener(t, svc, writes([h.id]));
    const claim = await startWork(mcp, h.id, task);
    const got = await success(mcp, 'claim_task', claim);
    const submit = {
      ...claim, fencingToken: got.lease.fencingToken, expectedRev: got.taskRev, requestId: 'submit',
      evidence: [{ kind: 'note', ref: 'Checked', acceptanceId: task.acceptance[0].id }],
    };
    const submitted = await success(mcp, 'submit_task', submit);
    let handle = h;
    let active = mcp;
    if (restart) {
      await mcp.close();
      await svc.close();
      const { svc: cold } = await makeService(t, { rootDir: stateDir });
      handle = await cold.open(h.id);
      active = await listener(t, cold, writes([h.id]));
    }
    const rejected = await handle.command(command('task.reject', {
      actor: HUMAN, taskId: task.id, expected: { entityRev: submitted.taskRev }, reason: 'Redo with better evidence',
    }));
    assert.equal(rejected.events.find(({ type }) => type === 'task/rejected').data.state, 'ready');
    assert.equal(rejected.events.find(({ type }) => type === 'task/assignment').data.cause, 'explicit-claim');
    assert.equal(rejected.events.some(({ type }) => type === 'lease/granted'), false);
    const next = await startWork(active, h.id, handle.state.tasks[task.id]);
    const reclaimed = await success(active, 'claim_task', next);
    assert.ok(reclaimed.lease.fencingToken > got.lease.fencingToken);
  }
});

// 责任：同一会话再次领取时保留完整宽限期和历史提交内容。
test('a later grant refreshes the same MCP session and gets its full grace period', { timeout: 12000 }, async (t) => {
  let now = Date.parse('2026-01-01T00:00:00Z');
  const { svc, h } = await withProject(t, { clock: () => new Date(now) });
  const task = await readyTask(h);
  const mcp = await listener(t, svc, writes([h.id]));
  const claim = await startWork(mcp, h.id, task);
  const first = await success(mcp, 'claim_task', claim);
  const firstCommit = h.store.commits.at(-1);
  const frozenCommit = structuredClone(firstCommit);
  const release = { ...claim, requestId: 'release-1', expectedRev: first.taskRev, fencingToken: first.lease.fencingToken };
  const ready = await success(mcp, 'release_task', release);
  now += 31 * 60 * 1000;
  const later = { ...claim, expectedRev: ready.taskRev, requestId: 'claim-2' };
  const second = await success(mcp, 'claim_task', later);
  assert.deepEqual(firstCommit, frozenCommit);
  now = Date.parse(second.lease.expiresAt) + 1;
  const freed = await success(mcp, 'release_task', {
    ...later, requestId: 'release-2', expectedRev: second.taskRev, fencingToken: second.lease.fencingToken,
  });
  assert.equal(freed.state, 'ready');
});

// 责任：同步失败时原子回滚会话绑定和租约，原样重试只提交一次。
test('a failed claim append rolls back both session binding and lease before an exact retry', { timeout: 12000 }, async (t) => {
  let faults;
  const { svc, h } = await withProject(t, {
    storeFactory(dir, meta) {
      faults = faultFs(dir);
      return new JsonlStore(dir, meta, { fs: faults.io });
    },
  });
  const task = await readyTask(h);
  const mcp = await listener(t, svc, writes([h.id]));
  const args = await startWork(mcp, h.id, task);
  const { commitsFile } = h.store;
  const before = fs.readFileSync(commitsFile);
  const bindingCount = Object.keys(h.state.bindings).length;
  const rev = h.rev;
  faults.arm('fsyncSync', (file) => file === commitsFile, () => { throw ioError(); });
  const failed = await mcp.call('claim_task', args);
  assert.deepEqual(failed.error, { code: -32603, message: 'Internal error' });
  faults.consumed();
  assert.deepEqual(fs.readFileSync(commitsFile), before);
  assert.equal(Object.keys(h.state.bindings).length, bindingCount);
  assert.equal(h.leases.size, 0);
  assert.equal(h.rev, rev);
  const retried = await success(mcp, 'claim_task', args);
  assert.equal(retried.deduped, false);
  assert.equal(retried.state, 'in_progress');
  assert.equal(h.rev, rev + 1);
});

// 责任：过期与重启后保留执行意图，旧会话或旧租约不能重新取得写权限。
test('lease expiry, unknown work and restart preserve intent semantics', { timeout: 12000 }, async (t) => {
  let now = Date.parse('2026-01-01T00:00:00Z');
  const clock = () => new Date(now);
  const { svc, h, stateDir } = await withProject(t, { clock });
  const task = await readyTask(h);
  const mcp = await listener(t, svc, writes([h.id]));
  const claim = await startWork(mcp, h.id, task);
  const granted = await success(mcp, 'claim_task', claim);
  const fence = { ...claim, fencingToken: granted.lease.fencingToken };
  const begun = await success(mcp, 'begin_task', { ...fence, expectedRev: granted.taskRev, requestId: 'begin', summary: 'Start' });
  now += 31 * 60 * 1000;
  assert.equal((await success(mcp, 'claim_task', claim)).lease, null);
  denied(await mcp.call('release_task', { ...fence, expectedRev: begun.taskRev, requestId: 'release' }), 'lease-expired');
  const interrupted = await success(mcp, 'interrupt_task', { ...fence, expectedRev: begun.taskRev, requestId: 'interrupt', note: 'Outcome unknown' });
  assert.equal(interrupted.state, 'interrupted');
  assert.equal(Object.values(h.state.intents)[0].status, 'open');
  const other = await readyTask(h);
  const held = await startWork(mcp, h.id, other);
  const second = await success(mcp, 'claim_task', held);
  await mcp.close();
  await svc.close();

  const { svc: cold } = await makeService(t, { rootDir: stateDir, clock });
  const restarted = await listener(t, cold, writes([h.id]));
  denied(await restarted.call('claim_task', held), 'work-session-invalid');
  assert.equal(cold.lookupLiveWriter(h.id), null);
  const live = await cold.open(h.id);
  assert.equal(live.state.tasks[other.id].state, 'ready');
  assert.equal(live.state.tasks[task.id].state, 'interrupted');
  assert.ok(live.store.commits.at(-1).events.some(({ type, data }) => type === 'lease/expired'
    && data.reason === 'restart' && data.token === second.lease.fencingToken));
  const expiring = await startWork(restarted, h.id, live.state.tasks[other.id]);
  now += 24 * 60 * 60 * 1000;
  const rev = live.rev;
  denied(await restarted.call('claim_task', expiring), 'work-session-invalid');
  assert.equal(live.rev, rev);
});
