/**
 * 测试职责：维护第三方审计门的身份独立、不可变交付范围和人工兜底验收契约。
 * 典型流程：临时 worker/auditor/human 任务 → submit/verify/reject 或篡改历史 → 对照审计、scope 与 fsck。
 * 覆盖边界：覆盖 schema3、输入白名单、独立性及冻结范围；不覆盖模型审查质量或抗会话分身真实性。
 * 外部前置：无；审计报告是自述文本，命令材料绝不执行。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectService } from '../../lib/core/service.js';
import { JsonlStore, MemoryStore, makeCommit } from '../../lib/core/store.js';
import { replay } from '../../lib/core/store/format.js';
import { applyEvent, auditIndependenceProblem, emptyState, normalizePlanHeads } from '../../lib/core/model.js';
import { appendWorker, auditEvidenceSnapshot, auditScopeDigest, auditWorkers } from '../../lib/core/audit.js';
import { checkState } from '../../lib/core/fsck.js';
import { validateToolIntake } from '../../lib/core/command-shape.js';

const worker = { kind: 'agent', sessionId: 'worker-session', agentId: 'worker-agent' };
const auditor = { kind: 'agent', sessionId: 'auditor-session', agentId: 'auditor-agent' };
const human = { kind: 'human', sessionId: 'human:test', via: 'test' };
const report = 'I inspected the recorded material and checked acceptance independently.';
let serial = 0;
async function fixture(t, { gated = true, file = false, alive = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-audit-v3-'));
  const ws = path.join(root, 'workspace');
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, 'artifact.txt'), 'original');
  const svc = await new ProjectService({ rootDir: path.join(root, 'data') }).init();
  t.after(() => svc.close());
  const h = await svc.createProject({ workspacePath: ws, actor: auditor });
  if (alive) await h.attach({ sessionId: worker.sessionId, agentId: worker.agentId });
  const send = (op, extra = {}, actor = worker) => h.command({ cmdId: 'audit-test-' + ++serial, op, actor, ...extra });
  const made = await send('task.create', { title: 'Audited work', requiresAudit: gated, acceptance: [{ text: 'artifact accepted' }] }, auditor);
  const id = made.events.find((e) => e.type === 'task/created').taskId;
  const task = () => h.state.tasks[id];
  const act = (op, extra = {}, actor = worker) => send('task.' + op, { taskId: id, expected: { entityRev: task().rev }, ...extra }, actor);
  const submit = () => act('submit', { fencingToken: h.leases.get(id).token, evidence: [{ kind: file ? 'file' : 'command', ref: file ? 'artifact.txt' : 'nonexistent-command --not-executed', acceptanceId: task().acceptance[0].id, execution: { exitCode: 17, status: 'failed' } }] });
  const review = async () => { await act('claim'); await act('begin', { summary: 'implement artifact', fencingToken: h.leases.get(id).token }); await submit(); };
  const snapshot = () => ({ state: structuredClone(h.state), leases: structuredClone([...h.leases]), rev: h.rev, commits: fs.readFileSync(h.store.commitsFile), blobs: fs.readdirSync(h.store.blobsDir) });
  const denied = async (op, extra, actor, code, reason) => {
    const before = snapshot();
    await assert.rejects(act(op, extra, actor), (error) => {
      assert.equal(error.code, code);
      if (reason) assert.equal(error.details?.reason, reason);
      return true;
    });
    assert.deepEqual(snapshot(), before, 'failure leaves events, revisions, blobs and leases unchanged');
  };
  const ops = (sessionId) => Object.fromEntries(h.query('task', { taskId: id, sessionId }).allowedOps.map((row) => [row.op, row]));
  return { h, svc, root, ws, id, task, act, send, submit, review, snapshot, denied, ops };
}

// 责任：新项目 meta/genesis/快照须均为 schema3，审计后冷开完整状态保持一致。
test('schema3 genesis, metadata, snapshot and deterministic reopen', async (t) => {
  const f = await fixture(t);
  assert.equal(f.h.state.schemaVersion, 3);
  assert.equal(f.h.state.project.schemaVersion, 3);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.h.meta.dir, 'meta.json'))).schemaVersion, 3);
  await f.review();
  await f.act('verify', { audit: { report } }, auditor);
  const before = structuredClone(f.h.state);
  f.h.store.saveSnapshot();
  const meta = f.h.meta;
  assert.equal(JSON.parse(fs.readFileSync(f.h.store.snapshotFile)).state.schemaVersion, 3);
  await f.svc.close();
  const store = new JsonlStore(meta.dir, meta);
  t.after(() => store.close());
  assert.deepEqual(store.open().state, before);
});

// 责任：v2 内存/磁盘/快照须在修尾前拒绝，明确迁移到 final3 后旧历史才可原样重放。
test('v2 memory/disk/snapshot fail closed before tail repair; migration final3 replays raw old history', () => {
  const project = { id: 'prj_legacy', phase: 'active', name: 'old', workspacePath: 'synthetic' };
  const meta = { schemaVersion: 2, project };
  const oldTask = { id: 'tsk_old', state: 'done', requiresHumanReview: true, labels: ['gate:human'] };
  const first = makeCommit(1, 'genesis', human, 'old', 0, [{ type: 'project/created', data: project }, { type: 'task/created', data: oldTask }]);
  assert.throws(() => new MemoryStore(meta, structuredClone([first])).open(), { code: 'schema-migration-required' });
  for (const snapshot of [false, true]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-audit-schema-'));
    const bytes = JSON.stringify(first);
    fs.writeFileSync(path.join(dir, 'commits.jsonl'), bytes);
    if (snapshot) {
      const state = emptyState({ ...project, schemaVersion: 2 });
      for (const event of structuredClone(first.events)) applyEvent(state, event, first);
      normalizePlanHeads(state);
      assert.equal(state.schemaVersion, 2, 'normalization never upgrades an old snapshot');
      fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify({ seq: 1, hash: first.hash, state }));
    }
    assert.throws(() => new JsonlStore(dir, meta).open(), { code: 'schema-migration-required' });
    assert.equal(fs.readFileSync(path.join(dir, 'commits.jsonl'), 'utf8'), bytes);
    assert.equal(fs.existsSync(path.join(dir, 'lock.json')), false);
  }
  const upgrade = makeCommit(2, first.hash, human, 'upgrade', 1, [
    { type: 'project/updated', data: { ...project, schemaVersion: 3 } },
    { type: 'task/updated', data: { id: 'tsk_old', state: 'done', requiresAudit: true, labels: ['gate:audit'] } },
  ]);
  const state = new MemoryStore(meta, structuredClone([first, upgrade])).open().state;
  assert.equal(state.schemaVersion, 3);
  assert.equal(state.tasks.tsk_old.requiresAudit, true);
  const incomplete = makeCommit(2, first.hash, human, 'bad-upgrade', 1, [upgrade.events[0]]);
  assert.throws(() => new MemoryStore(meta, structuredClone([first, incomplete])).open(), { code: 'schema-migration-required' });
});

// 责任：独立 agent 显式 verify 须记录 pass、scope digest、workers、下版本和审计 actor。
test('independent agent explicit verify records pass, active digest, workers, next revision and actor', async (t) => {
  const f = await fixture(t);
  await f.review();
  assert.equal(f.task().state, 'review', 'failed unsigned command material never auto-completes');
  assert.equal(f.task().createdBy.sessionId, auditor.sessionId, 'creator is eligible to audit');
  assert.equal(f.ops(auditor.sessionId).verify.enabled, true);
  assert.equal(f.ops(worker.sessionId).verify.enabled, false, 'view uses bound agentId');
  const beforeRev = f.task().rev;
  const result = await f.act('verify', { audit: { report: '  ' + report + '  ', checklist: [{ item: 'Acceptance coverage', ok: true, note: 'Recorded only; no commands executed' }] } }, auditor);
  assert.equal(f.task().state, 'done');
  assert.equal(f.task().verifiedBy, 'agent');
  assert.equal(f.task().lastAudit.verdict, 'pass');
  assert.equal(f.task().lastAudit.report, report);
  assert.equal(f.task().lastAudit.taskRev, beforeRev + 1);
  assert.deepEqual(f.task().lastAudit.evidence, auditEvidenceSnapshot(f.task()));
  assert.deepEqual(f.task().lastAudit.workers, [{ sessionId: worker.sessionId, agentId: worker.agentId }]);
  assert.equal(result.events[0].data.lastAudit.id, f.task().lastAudit.id);
  assert.equal(f.h.store.commits.at(-1).actor.sessionId, auditor.sessionId);
  assert.equal(f.h.query('board').columns.done[0].lastAudit.id, f.task().lastAudit.id);
  assert.equal(checkState(f.h.state).ok, true);
});

// 责任：普通验收保留显式状态转换和验收来源，冷开可重放，开发会话与其他会话均可通过。
test('ordinary verification accepts either the worker or another agent without an audit report', async (t) => {
  for (const actor of [worker, auditor]) {
    const f = await fixture(t, { gated: false });
    await f.denied('verify', {}, actor, 'illegal-transition');
    await f.review();
    assert.equal(f.task().state, 'review');
    assert.equal(f.ops(worker.sessionId).verify.enabled, true);
    assert.equal(f.ops(auditor.sessionId).verify.enabled, true);
    await f.denied('verify', {}, { kind: 'system' }, 'forbidden-role', 'auditor-required');
    const result = await f.act('verify', {}, actor);
    const task = f.task();
    assert.equal(task.state, 'done');
    assert.equal(task.verifiedBy, 'agent');
    assert.equal(task.lastAudit.gate, false);
    assert.equal(task.lastAudit.report, '');
    assert.equal(task.lastAudit.by.sessionId, actor.sessionId);
    assert.equal(result.events[0].type, 'task/verified');
    assert.equal(checkState(f.h.state).ok, true);
    const meta = f.h.meta;
    await f.svc.close();
    const store = new JsonlStore(meta.dir, meta);
    t.after(() => store.close());
    const reopened = store.open().state;
    assert.deepEqual(reopened.tasks[f.id], task);
    assert.equal(checkState(reopened).ok, true);
  }
});

test('ordinary verification still refuses unmet acceptance and hard drift without side effects', async (t) => {
  const f = await fixture(t, { gated: false, file: true });
  await f.review();
  f.task().acceptance[0].met = false;
  await f.denied('verify', {}, worker, 'acceptance-unmet');
  f.task().acceptance[0].met = true;
  fs.writeFileSync(path.join(f.ws, 'artifact.txt'), 'changed');
  await f.denied('verify', {}, worker, 'evidence-drift');
  await f.denied('verify', { acknowledgeDrift: true, reason: 'waive changed evidence' }, worker, 'forbidden-role', 'drift-human-only');
  await f.act('verify', { acknowledgeDrift: true, reason: 'accept changed evidence' }, human);
  assert.equal(f.task().verifiedBy, 'human');
});

// 责任：人类在 review 打开审计门后，所有 worker/证据生产者（含 superseded）均禁止自审。
test('every independence source, including superseded producers, blocks self audit on a gated task', async (t) => {
  const f = await fixture(t, { gated: false });
  await f.review();
  await f.act('gate', { requiresAudit: true }, human);
  assert.equal(f.ops(worker.sessionId).verify.enabled, false);
  await f.denied('verify', {}, auditor, 'invalid-command');
  await f.denied('verify', { audit: { report } }, worker, 'forbidden-role', 'not-independent');
  const task = { assignee: null, workers: [], evidence: [] };
  assert.equal(auditIndependenceProblem(task, auditor), 'worker-unknown');
  task.evidence.push({ producedBy: { ...worker }, supersededAt: 'yesterday' });
  assert.equal(auditIndependenceProblem(task, worker), 'not-independent');
  assert.equal(auditIndependenceProblem(task, { ...auditor, agentId: worker.agentId }), 'not-independent');
  task.evidence = [];
  task.workers = [{ ...worker }];
  assert.equal(auditIndependenceProblem(task, worker), 'not-independent');
  assert.equal(auditIndependenceProblem({ ...task, createdBy: auditor }, auditor), null);
  f.task().assignee = null;
  f.task().workers = [];
  f.task().evidence[0].producedBy = {};
  await f.denied('verify', { audit: { report } }, auditor, 'forbidden-role', 'worker-unknown');
});

// 责任：报告与 checklist 超限或 agent 夹带漂移 flags 时须原子拒绝。
test('report and checklist limits reject atomically, including explicit drift flags without drift', async (t) => {
  const f = await fixture(t);
  await f.review();
  for (const audit of [undefined, {}, { report: ' short ' }, { report: 'x'.repeat(4001) }, { report, checklist: Array(51).fill({ item: 'x', ok: true }) }, { report, checklist: [{ item: 'x'.repeat(201), ok: true }] }, { report, checklist: [{ item: 'x', ok: true, note: 'x'.repeat(501) }] }, { report, checklist: [{ item: 'x', ok: 'yes' }] }]) {
    await f.denied('verify', { audit }, auditor, 'invalid-command');
  }
  for (const field of ['refreshDrift', 'acknowledgeDrift']) for (const value of [true, false]) {
    await f.denied('verify', { audit: { report }, [field]: value }, auditor, 'forbidden-role', 'drift-human-only');
  }
  await f.act('verify', { audit: { report: 'x'.repeat(4000), checklist: Array(50).fill({ item: 'x'.repeat(200), ok: false, note: 'x'.repeat(500) }) } }, auditor);
  assert.equal(f.task().state, 'done', 'checklist content is a declaration, not an execution gate');
});

// 责任：agent 对硬漂移不得豁免/刷新，人工刷新或 override 才可写人工 pass 覆盖 fail。
test('agent hard drift cannot waive or refresh; human refresh/override writes human pass over fail', async (t) => {
  const f = await fixture(t, { file: true });
  await f.review();
  fs.writeFileSync(path.join(f.ws, 'artifact.txt'), 'changed');
  const before = f.snapshot();
  await assert.rejects(f.act('verify', { audit: { report } }, auditor), (error) => {
    assert.equal(error.code, 'evidence-drift');
    assert.equal(error.details.canAcknowledgeDrift, false);
    assert.equal(error.details.canRefresh, false);
    assert.match(error.details.next, /reject.*human/);
    return true;
  });
  assert.deepEqual(f.snapshot(), before);
  await f.act('verify', { refreshDrift: true, reason: 'Re-read and accept changed bytes' }, human);
  assert.equal(f.task().verifiedBy, 'human');
  assert.equal(f.task().lastAudit.by.kind, 'human');
  assert.equal(f.task().lastAudit.verdict, 'pass');
  assert.equal(f.task().lastAudit.taskRev, f.task().rev);
});

// 责任：无租约 review 允许任意 agent 驳回含自驳回，byKind/auditId 落盘且归属保留原 worker。
test('any agent rejects lease-free review; self-reject valid, byKind/auditId persist and assignment stays worker', async (t) => {
  const f = await fixture(t);
  await f.review();
  assert.equal(f.ops(auditor.sessionId).reject.enabled, true);
  await f.denied('reject', {}, auditor, 'invalid-command');
  await f.denied('reject', { reason: 'redo', unassign: true }, auditor, 'forbidden-role', 'unassign-human-only');
  await f.act('reject', { reason: 'Needs another acceptance check', audit: { report } }, auditor);
  assert.equal(f.task().state, 'in_progress');
  assert.equal(f.task().assignee.sessionId, worker.sessionId);
  assert.equal(f.task().rejection.byKind, 'agent');
  assert.equal(f.task().rejection.auditId, f.task().lastAudit.id);
  assert.equal(f.task().lastAudit.verdict, 'fail');
  assert.equal(f.task().lastAudit.taskRev, f.task().rev);
  assert.equal(Object.hasOwn(f.task().rejection, 'report'), false);
  const fail = structuredClone(f.task().lastAudit);
  await f.submit();
  assert.deepEqual(f.task().lastAudit, fail, 'same-attempt submit preserves prior fail');
  await f.act('reject', { reason: 'Worker withdraws own submission' }, worker);
  assert.equal(f.task().rejection.byKind, 'agent');
  assert.deepEqual(f.task().lastAudit, fail, 'reject without audit writes no new audit');
  await f.act('begin', { summary: 'new attempt', fencingToken: f.h.leases.get(f.id).token });
  assert.equal(f.task().lastAudit, null);
  await f.submit();
  await f.act('reject', { reason: 'Auditor requests human decision', audit: { report } }, auditor);
  const lastFailId = f.task().lastAudit.id;
  await f.submit();
  assert.equal(f.task().lastAudit.id, lastFailId);
  await f.act('verify', { reason: 'Human accepts revision' }, human);
  assert.notEqual(f.task().lastAudit.id, lastFailId);
  assert.equal(f.task().lastAudit.verdict, 'pass');
  assert.equal(f.task().lastAudit.by.kind, 'human');
  await f.act('reopen', { reason: 'More work' }, human);
  assert.equal(f.task().lastAudit, null);
  assert.equal(f.task().verifiedAt, null);
  assert.equal(f.task().verifiedBy, null);
});

// 责任：旧 review 仍有活租约时仅 owner/human 可驳回且需 token，死 assignee 则回 ready。
test('legacy review live lease permits owner/human only, token required; dead assignee falls back ready', async (t) => {
  const f = await fixture(t);
  await f.review();
  const lease = f.h._grantLease(f.task(), worker, new Date().toISOString());
  await f.denied('reject', { reason: 'foreign' }, auditor, 'forbidden-role');
  await f.denied('reject', { reason: 'owner' }, worker, 'fencing-stale');
  await f.act('reject', { reason: 'owner', fencingToken: lease.token }, worker);
  assert.equal(f.task().state, 'in_progress');
  await f.submit();
  await f.h.detach(worker.sessionId);
  await f.act('reject', { reason: 'dead assignee' }, auditor);
  assert.equal(f.task().state, 'ready');
  assert.equal(f.task().assignee, null);
});

// 责任：非活动计划驳回若需发租约须原子失败，人工 unassign 可避免复活非活动工作。
test('plan inactive reject grant fails atomically; human can unassign without reviving inactive work', async (t) => {
  const f = await fixture(t);
  await f.review();
  f.task().planRef = { planId: 'pln_archived' };
  f.h.state.planHeads.pln_archived = { status: 'archived' };
  await f.denied('reject', { reason: 'redo' }, auditor, 'plan-archived');
  await f.act('reject', { reason: 'handoff later', unassign: true }, human);
  assert.equal(f.task().state, 'ready');
});

// 责任：review 中 gate/update/计划修订都不能改审计门，取消权限仍须遵守人工边界。
test('review gate cannot change through gate/update/plan revision; nongated cancellation remains human-only', async (t) => {
  const f = await fixture(t, { gated: false });
  await f.review();
  for (const requiresAudit of [true, false]) await f.denied('gate', { requiresAudit }, auditor, 'forbidden-role', 'review-gate-locked');
  await f.denied('update', { requiresAudit: true }, auditor, 'forbidden-role', 'review-gate-locked');
  const lease = f.h._grantLease(f.task(), worker, new Date().toISOString());
  await f.denied('update', { requiresAudit: true, fencingToken: lease.token }, worker, 'forbidden-role', 'review-gate-locked');
  f.h.leases.delete(f.id);
  const made = await f.send('plan.publish', { title: 'Adopting plan', steps: [{ id: 's', tasks: [] }] });
  const planId = made.events.find((e) => e.type === 'plan/published').data.id;
  const before = f.snapshot();
  await assert.rejects(f.send('plan.revise', { planId, baseVersion: 1, steps: [{ id: 's', tasks: [{ key: 'a', taskId: f.id, title: 'Audited work', requiresAudit: true }] }] }, auditor), { code: 'forbidden-role' });
  assert.deepEqual(f.snapshot(), before);
  await f.act('gate', { requiresAudit: true }, human);
  await f.denied('cancel', { reason: 'cannot bypass audit' }, auditor, 'forbidden-role');
  await f.denied('block', { note: 'cannot disrupt review' }, auditor, 'forbidden-role');
  await f.act('gate', { requiresAudit: false }, human);
  await f.act('reject', { reason: 'redo' }, auditor);
  await f.denied('gate', { requiresAudit: false }, auditor, 'forbidden-role', 'gate-locked');
  await f.act('gate', { requiresAudit: true }, auditor);
  assert.equal(f.task().requiresAudit, true);
});

// 责任：交接历史须去重并限制 worker 身份数量，旧租约参与者仍须记录。
test('worker history deduplicates/caps identities and records old lease participants across handoff', async (t) => {
  const f = await fixture(t);
  await f.act('claim');
  assert.equal(f.task().workers[0].cause, 'claim');
  await f.act('release', { fencingToken: f.h.leases.get(f.id).token });
  await f.act('claim', {}, auditor);
  assert.equal(f.task().workers.length, 2);
  await f.act('begin', { summary: 'work', fencingToken: f.h.leases.get(f.id).token }, auditor);
  await f.act('submit', { fencingToken: f.h.leases.get(f.id).token, evidence: [{ kind: 'note', ref: 'record', acceptanceId: f.task().acceptance[0].id }] }, auditor);
  await f.denied('verify', { audit: { report } }, worker, 'forbidden-role', 'not-independent');
  const task = { workers: [] };
  for (let i = 0; i < 25; i++) appendWorker(task, { sessionId: 's' + i, agentId: 'a' + i }, 'now', 'claim');
  appendWorker(task, { sessionId: 's24', agentId: 'a24' }, 'later', 'reject');
  assert.equal(task.workers.length, 20);
  assert.equal(auditWorkers(task).length, 20);
});

// 责任：I23 只对 agent done 检查缺失/失败/过期/自审，不能改写旧 policy 或空来源历史。
test('I23 detects missing/failing/stale/self audits only for agent done; policy and empty provenance preserved', async (t) => {
  const f = await fixture(t);
  await f.review();
  await f.act('verify', { audit: { report } }, auditor);
  const valid = structuredClone(f.h.state);
  for (const change of [(task) => { task.lastAudit = null; }, (task) => { task.lastAudit.verdict = 'fail'; }, (task) => { task.lastAudit.taskRev = 0; }, (task) => { task.lastAudit.taskRev = task.rev + 1; }, (task) => { delete task.lastAudit.scopeDigest; }, (task) => { task.lastAudit.report = ' '; }, (task) => { task.lastAudit.workers.push(auditor); }]) {
    const state = structuredClone(valid);
    change(state.tasks[f.id]);
    assert.equal(checkState(state).ok, false);
    assert.equal(checkState(state).checks.find((row) => row.name === 'task-audit:' + f.id).ok, false);
  }
  for (const verifiedBy of ['policy', null, 'human']) {
    const state = structuredClone(valid);
    Object.assign(state.tasks[f.id], { verifiedBy, lastAudit: null });
    assert.equal(checkState(state).ok, true, 'no retroactive audit requirement for ' + verifiedBy);
  }
});

// 责任：无论持久策略 auto/manual、是否带门，submit/completed 对账都只能进入 review。
test('submit and reconcile completed always enter review under persisted auto/manual policy, gated or not', async (t) => {
  for (const gated of [true, false]) for (const verification of ['auto', 'manual']) for (const reconcile of [true, false]) {
    const f = await fixture(t, { gated });
    f.h.state.project.policy.verification = verification;
    await f.act('claim');
    await f.act('begin', { summary: 'attempt', fencingToken: f.h.leases.get(f.id).token });
    if (reconcile) {
      await f.act('interrupt', { note: 'inspect outcome', fencingToken: f.h.leases.get(f.id).token });
      await f.act('reconcile', { choice: 'completed', note: 'recorded material', evidence: [{ kind: 'test', ref: 'self-reported failing test', acceptanceId: f.task().acceptance[0].id }] });
    } else await f.submit();
    assert.equal(f.task().state, 'review');
    assert.equal(f.task().verifiedBy, undefined);
  }
});


// 责任：schema 重放校验不得在 framing 修复前修改原始 commit payload。
test('schema validation replay never mutates raw commit payloads before framing repair', async (t) => {
  const f = await fixture(t);
  await f.review();
  const commits = JSON.parse('[' + fs.readFileSync(f.h.store.commitsFile, 'utf8').trim().split('\n').join(',') + ']');
  const before = structuredClone(commits);
  const state = replay(f.h.meta, commits).state;
  assert.equal(state.schemaVersion, 3);
  assert.deepEqual(commits, before, 'provenance/revision projection cannot change historical hash input');
  await f.svc.close();
  const bytes = fs.readFileSync(f.h.store.commitsFile, 'utf8');
  fs.writeFileSync(f.h.store.commitsFile, bytes.trimEnd());
  const store = new JsonlStore(f.h.meta.dir, f.h.meta);
  t.after(() => store.close());
  store.open();
  assert.equal(fs.readFileSync(store.commitsFile, 'utf8'), bytes, 'repair changes framing only');
});

// 责任：superseded 生产者仍不得自审，软警告须有上限且摘要不混入已替代证据。
test('superseded producers remain disqualified; soft warnings are capped and digest excludes superseded rows', async (t) => {
  const f = await fixture(t);
  await f.review();
  f.task().evidence.push({ id: 'old', kind: 'command', ref: 'retired', supersededAt: 'then', producedBy: auditor });
  assert.equal(f.ops(auditor.sessionId).verify.enabled, false);
  await f.denied('verify', { audit: { report } }, auditor, 'forbidden-role', 'not-independent');
  f.task().evidence.at(-1).producedBy = worker;
  for (let i = 0; i < 25; i++) f.task().evidence.push({ id: 'warning-' + i, kind: 'file', ref: 'artifact.txt', producedBy: worker });
  const digest = auditEvidenceSnapshot(f.task());
  assert.equal(digest.count, 26);
  assert.deepEqual(auditEvidenceSnapshot({ evidence: [...f.task().evidence].reverse() }), digest, 'stored-set ordering does not change digest');
  await f.act('verify', { audit: { report: 'x'.repeat(20) } }, auditor);
  assert.equal(f.task().lastAudit.warnings.length, 20);
  assert.equal(f.task().lastAudit.evidence.count, 26);
  assert.equal(f.task().lastAudit.report.length, 20);
  const delivery = f.h.query('brief').delivery.verified[0];
  assert.equal(delivery.requiresAudit, true);
  assert.equal(delivery.lastAudit.by.kind, 'agent');
});


// 责任：adopt/release/revise/orphan 或管理元数据变动后，不可变审计 scope 必须保持有效。
test('immutable audit scope survives adopt/release/revise/orphan and administrative metadata', async (t) => {
  const f = await fixture(t);
  await f.review();
  await f.act('verify', { audit: { report } }, auditor);
  const audit = structuredClone(f.task().lastAudit);
  assert.match(audit.scopeDigest, /^[a-f0-9]{64}$/);
  const made = await f.send('plan.publish', { title: 'Administrative filing', steps: [{ id: 's', title: 'Filed', tasks: [] }] });
  const planId = made.events.find((e) => e.type === 'plan/published').data.id;
  const version = () => f.h.state.planHeads[planId].currentVersion;
  const healthy = () => { assert.deepEqual(f.task().lastAudit, audit); assert.equal(f.h.health().ok, true, f.h.health().warnings.join('\n')); };
  await f.send('plan.adopt', { planId, baseVersion: version(), stepId: 's', taskIds: [f.id] });
  healthy();
  await f.send('plan.release', { planId, baseVersion: version(), taskIds: [f.id] });
  healthy();
  await f.send('plan.revise', { planId, baseVersion: version(), steps: [{ id: 's', title: 'Renamed filing step', tasks: [{ key: 'a', taskId: f.id, title: f.task().title, priority: 4, weight: 3, labels: ['delivery'] }] }] });
  healthy();
  await f.send('plan.revise', { planId, baseVersion: version(), steps: [{ id: 's', tasks: [] }] });
  assert.equal(f.task().orphaned, true);
  healthy();
  await f.send('plan.adopt', { planId, baseVersion: version(), stepId: 's', taskIds: [f.id] });
  healthy();
  assert.ok(f.task().rev > audit.taskRev, 'anchor is immutable, not silently retagged to the filing revision');
  f.h.store.saveSnapshot();
  const meta = f.h.meta;
  await f.svc.close();
  const store = new JsonlStore(meta.dir, meta);
  t.after(() => store.close());
  const state = store.open().state;
  assert.equal(checkState(state).ok, true);
  assert.deepEqual(state.tasks[f.id].lastAudit, audit);
});

// 责任：计划 revise 不得改写 agent 已验收交付范围，人工 reopen 才能重启修改。
test('plan revise cannot rewrite agent-accepted delivery scope; human reopen is the explicit path', async (t) => {
  const f = await fixture(t);
  await f.review();
  await f.act('verify', { audit: { report } }, auditor);
  const made = await f.send('plan.publish', { title: 'Scope guard', steps: [{ id: 's', tasks: [] }] });
  const planId = made.events.find((e) => e.type === 'plan/published').data.id;
  const extra = await f.send('task.create', { title: 'Dependency target', acceptance: [{ text: 'target' }] });
  const depId = extra.events.find((e) => e.type === 'task/created').taskId;
  const changes = [ { title: 'Different delivery' }, { description: 'New scope' }, { deps: [depId] },
    { acceptance: [{ text: 'New unmet acceptance' }] },
    { acceptance: [{ text: 'artifact accepted', requiredKinds: ['file'] }] }, { requiresAudit: false } ];
  for (const change of changes) {
    const before = f.snapshot();
    await assert.rejects(f.send('plan.revise', { planId, baseVersion: 1, steps: [{ id: 's', tasks: [{ key: 'a', taskId: f.id, title: f.task().title, ...change }] }] }, human), { code: 'audit-scope-locked', status: 409 });
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.h.health().ok, true);
  }
  await f.act('reopen', { reason: 'Authorize a changed delivery' }, human);
  await f.act('release', { fencingToken: f.h.leases.get(f.id).token });
  await f.send('plan.revise', { planId, baseVersion: 1, steps: [{ id: 's', tasks: [{ key: 'a', taskId: f.id, title: 'Changed after reopen', acceptance: [{ text: 'New criterion' }] }] }] }, human);
  assert.equal(f.task().title, 'Changed after reopen');
  assert.equal(f.task().lastAudit, null);
  assert.equal(f.task().acceptance[0].met, false);
});

// 责任：I23 scope 须发现证据身份/生产者、worker 或验收要求篡改，但不误报管理字段漂移。
test('I23 scope detects evidence identity/producer, worker and requirement tampering without false metadata drift', async (t) => {
  const f = await fixture(t);
  await f.review();
  await f.act('verify', { audit: { report } }, auditor);
  const state = structuredClone(f.h.state);
  const changes = [
    (task) => { task.title += '!'; }, (task) => { task.description = 'changed'; },
    (task) => { task.deps = ['missing']; }, (task) => { task.requiresAudit = false; task.labels = []; },
    (task) => { task.acceptance[0].met = false; }, (task) => { task.acceptance[0].requiredKinds = ['file']; },
    (task) => { task.acceptance[0].evidenceIds = []; }, (task) => { task.evidence[0].ref = 'other'; },
    (task) => { task.evidence[0].hash = '0'.repeat(64); },
    (task) => { task.evidence[0].producedBy = { sessionId: 'different', agentId: 'different' }; },
    (task) => { task.workers.push({ sessionId: 'additional', agentId: 'additional' }); },
    (task) => { task.evidence[0].acceptanceId = 'other-criterion'; },
    (task) => { task.evidence[0].fixed = { blobContentHash: 'different-object' }; },
    (task) => { task.evidence[0].producedBy.callId = 'different-call'; },
    (task) => { task.lastAudit.scopeVersion = 2; },
    (task) => { task.lastAudit.scopeDigest = '0'.repeat(64); },
  ];
  for (const change of changes) {
    const copy = structuredClone(state);
    change(copy.tasks[f.id]);
    assert.equal(checkState(copy).checks.find((row) => row.name === 'task-audit:' + f.id).ok, false);
  }
  const administrative = structuredClone(state);
  Object.assign(administrative.tasks[f.id], { rev: f.task().rev + 8, priority: 2, weight: 5, orphaned: true });
  assert.equal(checkState(administrative).ok, true);
});

// 责任：任务各 intake 含未知根字段、废弃门名或非布尔开关时必须原子拒绝。
test('unknown root properties, obsolete gate intent and non-boolean switches reject every task intake atomically', async (t) => {
  const f = await fixture(t, { gated: false });
  for (const op of ['create', 'update', 'gate']) {
    const base = op === 'create' ? { title: 'Unknown intent', acceptance: [{ text: 'x' }] } : { requiresAudit: true };
    for (const bad of [{ requiresHumanReview: true }, { auditMode: 'human' }, { requiresAudit: 'true' }, { requiresAudit: null }, { labels: ['gate:human'] }, { labels: ['gate:future'] }, { labels: [...Array(20).fill('ordinary'), 'gate:human'] }]) {
      await f.denied(op, { ...base, ...bad }, worker, 'invalid-command');
    }
  }
  await f.send('task.create', { projectId: f.h.id, projectRev: f.h.rev, expected: { projectRev: f.h.rev }, title: 'Normal envelope', acceptance: [{ text: 'x' }], requiresAudit: undefined, note: 'normal', reason: 'normal' });
  await f.act('gate', { requiresAudit: true });
  assert.equal(f.task().requiresAudit, true);
});

// 责任：计划 create/publish/revise 及持久草案含未知审计意图字段时须在写入前拒绝。
test('plan create/publish/revise and persisted draft definitions reject unknown gate intent before writes', async (t) => {
  const f = await fixture(t);
  const draft = await f.send('plan.create', { title: 'Valid draft', steps: [{ id: 's', tasks: [] }] });
  const draftId = draft.events[0].data.id;
  const active = await f.send('plan.publish', { title: 'Valid active', createIfMissing: true, steps: [{ id: 's', tasks: [] }] });
  const planId = active.events.find((e) => e.type === 'plan/published').data.id;
  const variants = [{ requiresHumanReview: true }, { labels: ['gate:human'] }, { requiresAudit: 1 }, { imaginaryField: true }];
  for (const op of ['plan.create', 'plan.publish', 'plan.revise']) {
    const base = op === 'plan.revise' ? { planId, baseVersion: 1 } : { title: 'Rejected plan' };
    for (const bad of variants) {
      const before = f.snapshot();
      await assert.rejects(f.send(op, { ...base, steps: [{ id: 's', tasks: [{ key: 'a', title: 'Child task', acceptance: [{ text: 'x' }], ...bad }] }] }), { code: 'invalid-command' });
      assert.deepEqual(f.snapshot(), before);
    }
    const before = f.snapshot();
    await assert.rejects(f.send(op, { ...base, requiresHumanReview: true, steps: [{ id: 's', tasks: [] }] }), { code: 'invalid-command' });
    assert.deepEqual(f.snapshot(), before);
  }
  for (const bad of variants) {
    const before = f.snapshot();
    await assert.rejects(f.send('plan.revise', { planId: draftId, expected: { entityRev: 1 }, steps: [{ id: 's', tasks: [{ key: 'a', title: 'Draft task', ...bad }] }] }), { code: 'invalid-command' });
    assert.deepEqual(f.snapshot(), before);
  }
  // A raw historical draft cannot bypass validation at publish or inherited revise.
  f.h.state.planHeads[draftId].draft.steps = [{ id: 's', tasks: [{ key: 'a', title: 'Historical intent', acceptance: [{ text: 'x' }], requiresHumanReview: true }] }];
  for (const op of ['plan.publish', 'plan.revise']) {
    const before = f.snapshot();
    await assert.rejects(f.send(op, { planId: draftId, expected: { entityRev: 1 } }), { code: 'invalid-command' });
    assert.deepEqual(f.snapshot(), before);
  }
});


// 责任：共享 raw-tool validator 须在适配器投影丢字段前拒绝未知意图，保持公共联合类型可用。
test('shared raw-tool validator rejects unknown gate intent before adapter projection, preserving public unions', () => {
  for (const family of ['task', 'plan']) {
    const ops = family === 'task' ? ['create', 'update', 'gate'] : ['create', 'publish', 'revise'];
    for (const op of ops) {
      assert.throws(() => validateToolIntake({ op, requiresHumanReview: true }, family), { code: 'invalid-command' });
      if (family === 'task') {
        assert.throws(() => validateToolIntake({ op, labels: [' Gate:Human '] }, family), { code: 'invalid-command' });
        assert.throws(() => validateToolIntake({ op, requiresAudit: 'true' }, family), { code: 'invalid-command' });
      } else {
        assert.throws(() => validateToolIntake({ op, steps: [{ tasks: [{ requiresHumanReview: true }] }] }, family), { code: 'invalid-command' });
      }
    }
  }
  assert.doesNotThrow(() => validateToolIntake({ op: 'create', title: 'T', expectedRev: 1, projectRev: 1, fencingToken: undefined,
    requiresAudit: true, labels: ['gate:audit'], audit: undefined, evidence: [], unassign: false, intent: undefined,
    sideEffects: [], refreshDrift: false, acknowledgeDrift: false, code: 'x', choice: 'resume', summary: '',
    plannedSteps: [], expectedArtifacts: [], note: '', reason: '' }, 'task'));
  assert.doesNotThrow(() => validateToolIntake({ op: 'publish', planId: undefined, expectedRev: undefined, baseVersion: undefined,
    title: 'P', goal: '', assumptions: [], risks: [], stepId: undefined, taskIds: [],
    steps: [{ id: 's', title: 'S', tasks: [{ key: 'a', taskId: undefined, title: 'T', requiresAudit: true, labels: ['gate:audit'], acceptance: [{ text: 'criterion' }] }] }] }, 'plan'));
});


// 责任：Unicode scope 规范化须忽略行顺序、集合重复和管理字段，只冻结实质交付范围。
test('Unicode scope canonicalization ignores row order, set duplicates and administrative metadata', () => {
  const task = {
    title: '交付 É Ω 😀', description: '语义范围', requiresAudit: true, labels: ['gate:audit'], deps: ['依赖Ω', '依赖É'],
    acceptance: [{ id: '准则Ω', text: 'Unicode 文件', met: true, requiredKinds: ['file', 'command'], evidenceIds: ['证据Ω', '证据É'] }],
    evidence: [
      { id: '证据Ω', kind: 'file', ref: '资料/Ω-😀.md', hash: 'a', acceptanceId: '准则Ω', producedBy: { sessionId: '实现Ω', agentId: '代理Ω', callId: '调用Ω' } },
      { id: '证据É', kind: 'command', ref: '资料/É.md', hash: 'b', acceptanceId: '准则Ω', producedBy: { sessionId: '实现É', agentId: '代理É', callId: '调用É' } },
    ], workers: [{ sessionId: '实现Ω', agentId: '代理Ω' }, { sessionId: '实现É', agentId: '代理É' }],
  };
  const reordered = structuredClone(task);
  reordered.deps.reverse(); reordered.evidence.reverse(); reordered.workers.reverse();
  reordered.deps.push('依赖Ω'); reordered.workers.push({ sessionId: '实现Ω', agentId: '代理Ω' });
  reordered.acceptance[0].requiredKinds = ['command', 'file', 'file'];
  reordered.acceptance[0].evidenceIds = ['证据É', '证据Ω', '证据É'];
  Object.assign(reordered, { rev: 99, priority: 7, weight: 2, orphaned: true, planRef: { planId: '任意归档', version: 2 }, updatedAt: 'later' });
  assert.equal(auditScopeDigest(reordered), auditScopeDigest(task));
  assert.deepEqual(auditEvidenceSnapshot(reordered), auditEvidenceSnapshot(task));
  reordered.description += ' substantive';
  assert.notEqual(auditScopeDigest(reordered), auditScopeDigest(task));
});
