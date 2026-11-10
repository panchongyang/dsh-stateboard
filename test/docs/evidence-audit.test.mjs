/**
 * 测试职责：约束证据材料、跨尝试替代、内容漂移与人工验收的真实性边界。
 * 典型流程：临时任务提交文件/内嵌文档/自报命令 → 编辑内容、驳回或重开 → 审计及 verify。
 * 覆盖边界：覆盖 当前证据覆盖、历史 @rev、漂移确认/刷新与零自动执行；不覆盖真实命令执行证明或 UI。
 * 外部前置：无；内嵌样例通过 fixture 特权播种，签名仅用于兼容反例。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectService } from '../../lib/core/service.js';
import { signExecution } from '../fixtures/legacy-execution.mjs';
import { auditEvidence } from '../../lib/core/evidence.js';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
}

function cmd(op, extra = {}) {
  return { cmdId: 'cmd_' + crypto.randomUUID(), actor: { kind: 'agent', sessionId: 's1' }, op, ...extra };
}

function humanCmd(op, extra = {}) {
  return { cmdId: 'cmd_' + crypto.randomUUID(), actor: { kind: 'human', via: 'test' }, op, ...extra };
}

function execution(task, ref, exitCode = 0) {
  const record = {
    executor: 'host',
    status: exitCode === 0 ? 'ok' : 'failed',
    exitCode,
    stdoutHash: 'a'.repeat(64),
    stderrHash: 'b'.repeat(64),
    commandHash: crypto.createHash('sha256').update(ref).digest('hex'),
    outputBytes: 12,
    executedAt: new Date().toISOString(),
    timedOut: false,
    taskId: task.id,
    attempt: task.work?.attempt || 0,
    intentId: task.work?.intentId || null,
    token: null,
  };
  record.proof = signExecution(record);
  return record;
}

async function setup({ verification = 'manual' } = {}) {
  const svc = new ProjectService({ rootDir: tmp('pb-evidence-state'), privilegedInlineWrites: true });
  await svc.init();
  const wsDir = tmp('pb-evidence-ws');
  const h = await svc.createProject({ workspacePath: wsDir, name: 'Evidence' });
  await h.attach({ sessionId: 's1', agentId: 's1', source: 'test', role: 'worker' });
  assert.equal(h.query('board').project.policy.verification, 'manual');
  const created = await h.command(cmd('task.create', { title: 'Audited', acceptance: [{ text: 'artifact' }] }));
  const id = created.events.find((event) => event.type === 'task/created').taskId;
  return { svc, h, wsDir, id };
}

async function claimBegin(h, id) {
  await h.command(cmd('task.claim', { taskId: id, expected: { entityRev: h.state.tasks[id].rev } }));
  await h.command(cmd('task.begin', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    fencingToken: h.leases.get(id).token,
    summary: 'work',
  }));
}

// 责任：自报 execution 即使带签名但 attempt 错误，也不得被新命令认成宿主观测。
test('new command metadata cannot claim host observation even with a signed wrong attempt', async () => {
  const { svc, h, id } = await setup({ verification: 'auto' });
  await claimBegin(h, id);
  const wrong = execution(h.state.tasks[id], 'node -v', 0);
  wrong.attempt += 1;
  delete wrong.proof;
  wrong.proof = signExecution(wrong);
  const result = await h.command(cmd('task.submit', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    fencingToken: h.leases.get(id).token,
    evidence: [{ kind: 'command', ref: 'node -v', acceptanceId: h.state.tasks[id].acceptance[0].id, execution: wrong }],
  }));
  assert.deepEqual(result.warnings || [], []);
  assert.equal(h.state.tasks[id].evidence[0].execution, null);
  assert.equal(h.state.tasks[id].state, 'review');
  await svc.close();
});

// 责任：重新 submit 未重交已漂移证据时须拒绝，不能保留旧快照蒙混。
test('submit rejects drift in evidence that was not resubmitted', async () => {
  const { svc, h, wsDir, id } = await setup({ verification: 'auto' });
  const acceptanceId = h.state.tasks[id].acceptance[0].id;
  fs.writeFileSync(path.join(wsDir, 'artifact.txt'), 'v1');
  await claimBegin(h, id);
  await h.command(cmd('task.submit', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    fencingToken: h.leases.get(id).token,
    evidence: [{ kind: 'file', ref: 'artifact.txt', acceptanceId }],
  }));
  assert.equal(h.state.tasks[id].state, 'review');
  await h.command(humanCmd('task.verify', { taskId: id, expected: { entityRev: h.state.tasks[id].rev } }));

  fs.writeFileSync(path.join(wsDir, 'artifact.txt'), 'v2');
  fs.writeFileSync(path.join(wsDir, 'other.txt'), 'other');
  await h.command(humanCmd('task.reopen', { taskId: id, expected: { entityRev: h.state.tasks[id].rev }, reason: 'redo' }));
  if (h.state.tasks[id].state !== 'in_progress') {
    await h.command(cmd('task.claim', { taskId: id, expected: { entityRev: h.state.tasks[id].rev } }));
  }
  const revBefore = h.state.tasks[id].rev;
  const evidenceBefore = h.state.tasks[id].evidence.length;
  const error = await h.command(cmd('task.submit', {
    taskId: id,
    expected: { entityRev: revBefore },
    fencingToken: h.leases.get(id).token,
    evidence: [{ kind: 'file', ref: 'other.txt', acceptanceId }],
  })).then(() => null, (err) => err);
  assert.equal(error.code, 'evidence-drift');
  assert.equal(error.details.stage, 'submit');
  assert.equal(error.details.warnings.some((warning) => warning.code === 'file-drift'), true);
  assert.equal(h.state.tasks[id].state, 'in_progress');
  assert.equal(h.state.tasks[id].rev, revBefore, 'rejected submit wrote nothing');
  assert.equal(h.state.tasks[id].evidence.length, evidenceBefore);
  assert.ok(h.leases.get(id), 'the worker keeps the lease and can fix it');

  await h.command(cmd('task.submit', {
    taskId: id,
    expected: { entityRev: revBefore },
    fencingToken: h.leases.get(id).token,
    evidence: [{ kind: 'file', ref: 'artifact.txt', acceptanceId }],
  }));
  assert.equal(h.state.tasks[id].state, 'review', 'resubmitted evidence retires the drifted row');
  await svc.close();
});

// 责任：开始新 attempt 后旧尝试证据须 superseded，不再参加当前覆盖审计。
test('a new begin supersedes prior-attempt evidence for audit', async () => {
  const { svc, h, wsDir, id } = await setup({ verification: 'auto' });
  fs.writeFileSync(path.join(wsDir, 'artifact.txt'), 'v1');
  await claimBegin(h, id);
  await h.command(cmd('task.submit', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    fencingToken: h.leases.get(id).token,
    evidence: [{ kind: 'file', ref: 'artifact.txt', acceptanceId: h.state.tasks[id].acceptance[0].id }],
  }));
  assert.equal(h.state.tasks[id].state, 'review');
  await h.command(humanCmd('task.verify', { taskId: id, expected: { entityRev: h.state.tasks[id].rev } }));

  fs.writeFileSync(path.join(wsDir, 'artifact.txt'), 'v2');
  await h.command(humanCmd('task.reopen', { taskId: id, expected: { entityRev: h.state.tasks[id].rev }, reason: 'redo' }));
  await h.command(cmd('task.begin', { taskId: id, expected: { entityRev: h.state.tasks[id].rev }, fencingToken: h.leases.get(id).token, summary: 'redo' }));
  const old = h.state.tasks[id].evidence[0];
  assert.ok(old.supersededAt, 'begin marks prior evidence superseded');
  await h.command(cmd('task.submit', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    fencingToken: h.leases.get(id).token,
    evidence: [{ kind: 'file', ref: 'artifact.txt', acceptanceId: h.state.tasks[id].acceptance[0].id }],
  }));
  assert.equal(h.state.tasks[id].state, 'review');
  await svc.close();
});

// 责任：伪造 host execution 且无内部 proof 时，不能获得强证据身份。
test('a forged host execution without the internal proof is not strong evidence', async () => {
  const { svc, h, id } = await setup({ verification: 'auto' });
  await claimBegin(h, id);
  const forged = execution(h.state.tasks[id], 'node -v', 0);
  forged.proof = null;
  await h.command(cmd('task.submit', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    fencingToken: h.leases.get(id).token,
    evidence: [{ kind: 'command', ref: 'node -v', acceptanceId: h.state.tasks[id].acceptance[0].id, execution: forged }],
  }));
  assert.equal(h.state.tasks[id].state, 'review');
  await svc.close();
});

// 责任：调用者提供成功 execution 也不得自动验收，任务只能进入 review。
test('a supplied successful execution never auto-verifies', async () => {
  const { svc, h, id } = await setup({ verification: 'auto' });
  await claimBegin(h, id);
  await h.command(cmd('task.submit', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    fencingToken: h.leases.get(id).token,
    evidence: [{
      kind: 'command',
      ref: 'node -v',
      acceptanceId: h.state.tasks[id].acceptance[0].id,
      execution: execution(h.state.tasks[id], 'node -v', 0),
    }],
  }));
  assert.equal(h.state.tasks[id].state, 'review');
  await svc.close();
});

// 责任：失败命令仍可作为材料记录，系统不得执行 ref 或代判其正确性。
test('a failed command is accepted as material without executing or judging it', async () => {
  const { svc, h, id } = await setup();
  const acceptanceId = h.state.tasks[id].acceptance[0].id;
  await claimBegin(h, id);
  const revBefore = h.state.tasks[id].rev;
  const token = h.leases.get(id).token;
  const result = await h.command(cmd('task.submit', {
    taskId: id,
    expected: { entityRev: revBefore },
    fencingToken: token,
    evidence: [{
      kind: 'command',
      ref: 'false',
      acceptanceId,
      execution: execution(h.state.tasks[id], 'false', 1),
    }],
  }));
  assert.deepEqual(result.warnings || [], []);
  assert.equal(h.state.tasks[id].state, 'review');
  assert.equal(h.state.tasks[id].evidence[0].execution, null);
  assert.equal(h.leases.has(id), false);
  await svc.close();
});

// 责任：文件提交后被编辑时 health 须暴露 drift，verify 必须被阻止。
test('file drift is exposed by health and blocks verify', async () => {
  const { svc, h, wsDir, id } = await setup();
  fs.writeFileSync(path.join(wsDir, 'artifact.txt'), 'v1');
  await claimBegin(h, id);
  await h.command(cmd('task.submit', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    fencingToken: h.leases.get(id).token,
    evidence: [{ kind: 'file', ref: 'artifact.txt', acceptanceId: h.state.tasks[id].acceptance[0].id }],
  }));
  assert.equal(h.health().warnings.some((line) => line.includes('file-drift')), false);
  fs.writeFileSync(path.join(wsDir, 'artifact.txt'), 'v2');
  assert.equal(h.health().warnings.some((line) => line.includes('file-drift')), true);
  const error = await h.command(humanCmd('task.verify', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
  })).then(() => null, (err) => err);
  assert.equal(error.code, 'evidence-drift');
  await svc.close();
});

// 责任：人工带 acknowledgeDrift 和理由可豁免漂移，并保留明确审计记录。
test('a human can waive file drift with acknowledgeDrift and a reason', async () => {
  const { svc, h, wsDir, id } = await setup();
  fs.writeFileSync(path.join(wsDir, 'artifact.txt'), 'v1');
  await claimBegin(h, id);
  await h.command(cmd('task.submit', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    fencingToken: h.leases.get(id).token,
    evidence: [{ kind: 'file', ref: 'artifact.txt', acceptanceId: h.state.tasks[id].acceptance[0].id }],
  }));
  fs.writeFileSync(path.join(wsDir, 'artifact.txt'), 'v2');

  const blocked = await h.command(humanCmd('task.verify', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    acknowledgeDrift: true,
  })).then(() => null, (err) => err);
  assert.equal(blocked.code, 'invalid-command', 'waiver requires a reason');

  const result = await h.command(humanCmd('task.verify', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    acknowledgeDrift: true,
    reason: '设计稿提交后有注释修订，内容已人工复核',
  }));
  const task = h.state.tasks[id];
  assert.equal(task.state, 'done');
  assert.equal(task.waivedDrift.reason, '设计稿提交后有注释修订，内容已人工复核');
  assert.equal(task.waivedDrift.warnings.some((warning) => warning.code === 'file-drift'), true);
  const verified = result.events.find((event) => event.type === 'task/verified');
  assert.equal(verified.data.waivedDrift.warnings.some((warning) => warning.code === 'file-drift'), true, 'waiver persists in the event');
  await svc.close();
});

// 责任：仅给理由而无 acknowledgeDrift 仍须拒绝漂移验收。
test('without acknowledgeDrift, drift still blocks verify', async () => {
  const { svc, h, wsDir, id } = await setup();
  fs.writeFileSync(path.join(wsDir, 'artifact.txt'), 'v1');
  await claimBegin(h, id);
  await h.command(cmd('task.submit', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    fencingToken: h.leases.get(id).token,
    evidence: [{ kind: 'file', ref: 'artifact.txt', acceptanceId: h.state.tasks[id].acceptance[0].id }],
  }));
  fs.writeFileSync(path.join(wsDir, 'artifact.txt'), 'v2');
  const error = await h.command(humanCmd('task.verify', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    reason: 'not enough without the flag',
  })).then(() => null, (err) => err);
  assert.equal(error.code, 'evidence-drift');
  assert.equal(h.state.tasks[id].state, 'review');
  assert.equal(h.state.tasks[id].waivedDrift, undefined);
  await svc.close();
});

// 责任：自报 command 材料不得生成假装判定正确性的 warning。
test('reported command evidence carries no correctness warning', async () => {
  const { svc, h, id } = await setup();
  await claimBegin(h, id);
  await h.command(cmd('task.submit', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    fencingToken: h.leases.get(id).token,
    evidence: [{ kind: 'command', ref: 'node -v', acceptanceId: h.state.tasks[id].acceptance[0].id }],
  }));
  assert.equal(h.state.tasks[id].state, 'review');
  const result = await h.command(humanCmd('task.verify', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
  }));
  assert.equal(h.state.tasks[id].state, 'done');
  assert.equal((result.warnings || []).some((warning) => warning.code === 'command-self-reported'), false);
  await svc.close();
});

// 责任：无 proof 的 execution 须忽略，但人工仍可验收该普通材料。
test('supplied execution without proof is ignored and remains human-verifiable', async () => {
  const { svc, h, id } = await setup();
  await claimBegin(h, id);
  const legacy = execution(h.state.tasks[id], 'node -v', 0);
  delete legacy.proof;
  await h.command(cmd('task.submit', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    fencingToken: h.leases.get(id).token,
    evidence: [{
      kind: 'command',
      ref: 'node -v',
      acceptanceId: h.state.tasks[id].acceptance[0].id,
      execution: legacy,
    }],
  }));
  assert.equal(h.state.tasks[id].state, 'review');
  const audit = auditEvidence(h, h.state.tasks[id]);
  assert.equal(audit.some((warning) => warning.code === 'command-legacy-no-proof' && warning.severity === 'warning'), false);
  const result = await h.command(humanCmd('task.verify', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
  }));
  assert.equal(h.state.tasks[id].state, 'done');
  assert.equal((result.warnings || []).some((warning) => warning.code === 'command-legacy-no-proof'), false);
  await svc.close();
});

// 责任：过时 proof 须忽略，不应阻断普通材料的人工验收。
test('a supplied obsolete proof is ignored and remains human-verifiable', async () => {
  const { svc, h, id } = await setup();
  await claimBegin(h, id);
  const legacy = execution(h.state.tasks[id], 'node -v', 0);
  legacy.proof = signExecution(legacy, crypto.randomBytes(32)); // old per-process key
  await h.command(cmd('task.submit', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    fencingToken: h.leases.get(id).token,
    evidence: [{
      kind: 'command',
      ref: 'node -v',
      acceptanceId: h.state.tasks[id].acceptance[0].id,
      execution: legacy,
    }],
  }));
  assert.equal(h.state.tasks[id].state, 'review');
  const audit = auditEvidence(h, h.state.tasks[id]);
  assert.equal(audit.some((warning) => warning.code === 'command-legacy-proof' && warning.severity === 'warning'), false);
  const result = await h.command(humanCmd('task.verify', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
  }));
  assert.equal(h.state.tasks[id].state, 'done');
  assert.equal((result.warnings || []).some((warning) => warning.code === 'command-legacy-proof'), false);
  await svc.close();
});

// 责任：新 begin 须重置 acceptance.met，submit 必须为每条验收点提供当前有效证据。
test('a new begin resets acceptance met and submit requires active evidence for every acceptance', async () => {
  const { svc, h, wsDir } = await setup({ verification: 'auto' });
  const created = await h.command(cmd('task.create', {
    title: 'Two acceptances',
    acceptance: [{ text: 'a' }, { text: 'b' }],
  }));
  const id = created.events.find((event) => event.type === 'task/created').taskId;
  await claimBegin(h, id);
  fs.writeFileSync(path.join(wsDir, 'a.txt'), 'a1');
  fs.writeFileSync(path.join(wsDir, 'b.txt'), 'b1');
  const [a1, a2] = h.state.tasks[id].acceptance.map((item) => item.id);
  await h.command(cmd('task.submit', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    fencingToken: h.leases.get(id).token,
    evidence: [
      { kind: 'file', ref: 'a.txt', acceptanceId: a1 },
      { kind: 'file', ref: 'b.txt', acceptanceId: a2 },
    ],
  }));
  assert.equal(h.state.tasks[id].state, 'review');
  await h.command(humanCmd('task.verify', { taskId: id, expected: { entityRev: h.state.tasks[id].rev } }));

  await h.command(humanCmd('task.reopen', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    reason: 'redo',
  }));
  if (h.state.tasks[id].state !== 'in_progress') {
    await h.command(cmd('task.claim', { taskId: id, expected: { entityRev: h.state.tasks[id].rev } }));
  }
  const token = h.leases.get(id).token;
  await h.command(cmd('task.begin', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    fencingToken: token,
    summary: 'attempt 2',
  }));
  assert.equal(h.state.tasks[id].acceptance.every((item) => item.met === false), true, 'begin resets acceptance met');

  const revBefore = h.state.tasks[id].rev;
  const error = await h.command(cmd('task.submit', {
    taskId: id,
    expected: { entityRev: revBefore },
    fencingToken: token,
    evidence: [{ kind: 'file', ref: 'a.txt', acceptanceId: a1 }],
  })).then(() => null, (err) => err);
  assert.equal(error.code, 'missing-evidence');
  assert.equal(h.state.tasks[id].state, 'in_progress');
  assert.equal(h.state.tasks[id].rev, revBefore, 'rejected submit wrote nothing');

  await h.command(cmd('task.submit', {
    taskId: id,
    expected: { entityRev: revBefore },
    fencingToken: token,
    evidence: [
      { kind: 'file', ref: 'a.txt', acceptanceId: a1 },
      { kind: 'file', ref: 'b.txt', acceptanceId: a2 },
    ],
  }));
  assert.equal(h.state.tasks[id].state, 'review');
  await svc.close();
});

// 责任：内嵌文档 @rev 证据在 head 前进后仍须有效，不跟随最新正文。
test('a pinned doc revision stays valid after the doc head moves', async () => {
  const { svc, h, id } = await setup();
  const created = await h.command(cmd('doc.put', { title: 'Pinned', body: 'pinned v1', kind: 'note' }));
  const docId = created.events.find((event) => event.type === 'doc/created').docId;
  await claimBegin(h, id);
  await h.command(cmd('task.submit', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    fencingToken: h.leases.get(id).token,
    evidence: [{ kind: 'doc', ref: docId + '@1', acceptanceId: h.state.tasks[id].acceptance[0].id }],
  }));
  assert.equal(h.state.tasks[id].state, 'review');

  await h.command(cmd('doc.put', { docId, baseRev: 1, title: 'Pinned', body: 'pinned v2' }));
  assert.equal(h.state.docs[docId].rev, 2);
  const audit = auditEvidence(h, h.state.tasks[id]);
  assert.equal(audit.some((warning) => warning.code === 'doc-drift'), false, 'a pinned revision is not drift when head moves');
  assert.equal(audit.some((warning) => warning.severity === 'error'), false);

  await h.command(humanCmd('task.verify', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
  }));
  assert.equal(h.state.tasks[id].state, 'done');
  await svc.close();
});

// 责任：驳回后不重新 begin 也可重交 doc@rev，人工 verify 须通过。
test('reject + re-submit doc@rev passes verify without begin', async () => {
  const { svc, h, id } = await setup();
  const created = await h.command(cmd('doc.put', { title: 'Iterated', body: 'iterated v1', kind: 'note' }));
  const docId = created.events.find((event) => event.type === 'doc/created').docId;
  await claimBegin(h, id);
  await h.command(cmd('task.submit', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    fencingToken: h.leases.get(id).token,
    evidence: [{ kind: 'doc', ref: docId + '@1', acceptanceId: h.state.tasks[id].acceptance[0].id }],
  }));

  await h.command(cmd('doc.put', { docId, baseRev: 1, title: 'Iterated', body: 'iterated v2' }));
  await h.command(humanCmd('task.reject', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    reason: '文档小改',
    unassign: true,
  }));
  await h.command(cmd('task.claim', { taskId: id, expected: { entityRev: h.state.tasks[id].rev } }));
  await h.command(cmd('task.submit', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    fencingToken: h.leases.get(id).token,
    evidence: [{ kind: 'doc', ref: docId + '@2', acceptanceId: h.state.tasks[id].acceptance[0].id }],
  }));
  assert.equal(h.state.tasks[id].state, 'review');
  const audit = auditEvidence(h, h.state.tasks[id]);
  assert.equal(audit.some((warning) => warning.severity === 'error'), false, 'old doc@1 evidence must not block the new revision');

  await h.command(humanCmd('task.verify', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
  }));
  assert.equal(h.state.tasks[id].state, 'done', 'no begin is needed when every pinned doc revision is intact');
  await svc.close();
});

// 责任：历史固定内嵌 blob 丢失仍须被审计为错误，不能因带 @rev 放行。
test('a missing pinned doc blob is still an error', async () => {
  const { svc, h, id } = await setup();
  const created = await h.command(cmd('doc.put', { title: 'Lost', body: 'lost v1', kind: 'note' }));
  const docId = created.events.find((event) => event.type === 'doc/created').docId;
  await claimBegin(h, id);
  await h.command(cmd('task.submit', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    fencingToken: h.leases.get(id).token,
    evidence: [{ kind: 'doc', ref: docId + '@1', acceptanceId: h.state.tasks[id].acceptance[0].id }],
  }));
  const pinned = h.state.tasks[id].evidence[0];
  await h.command(cmd('doc.put', { docId, baseRev: 1, title: 'Lost', body: 'lost v2' }));
  fs.rmSync(path.join(h.store.blobsDir, pinned.hash));

  const error = await h.command(humanCmd('task.verify', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
  })).then(() => null, (err) => err);
  assert.equal(error.code, 'evidence-drift');
  assert.equal(error.details.warnings.some((warning) => warning.code === 'doc-blob-missing'), true);
  assert.equal(h.state.tasks[id].state, 'review');
  await svc.close();
});

// 责任：未带 @rev 的文档证据须跟随 head，正文前进后应触发漂移。
test('an unpinned doc evidence still tracks the head', async () => {
  const { svc, h, id } = await setup();
  const created = await h.command(cmd('doc.put', { title: 'Head', body: 'head v1', kind: 'note' }));
  const docId = created.events.find((event) => event.type === 'doc/created').docId;
  await claimBegin(h, id);
  await h.command(cmd('task.submit', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    fencingToken: h.leases.get(id).token,
    evidence: [{ kind: 'doc', ref: docId, acceptanceId: h.state.tasks[id].acceptance[0].id }],
  }));
  await h.command(cmd('doc.put', { docId, baseRev: 1, title: 'Head', body: 'head v2' }));
  const error = await h.command(humanCmd('task.verify', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
  })).then(() => null, (err) => err);
  assert.equal(error.code, 'evidence-drift');
  assert.equal(error.details.warnings.some((warning) => warning.code === 'doc-drift'), true);
  await svc.close();
});

async function resubmitFile(h, id, acceptanceId, ref) {
  return h.command(cmd('task.submit', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    fencingToken: h.leases.get(id).token,
    evidence: [{ kind: 'file', ref, acceptanceId }],
  }));
}

async function rejectUnassign(h, id, reason) {
  await h.command(humanCmd('task.reject', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    reason,
    unassign: true,
  }));
}

async function reclaim(h, id) {
  await h.command(cmd('task.claim', { taskId: id, expected: { entityRev: h.state.tasks[id].rev } }));
}

// 责任：不新 begin 重交修改后文件时须替代旧快照，避免旧漂移继续阻塞。
test('resubmitting a changed file supersedes the old snapshot without begin', async () => {
  const { svc, h, wsDir, id } = await setup();
  const acceptanceId = h.state.tasks[id].acceptance[0].id;
  fs.writeFileSync(path.join(wsDir, 'artifact.txt'), 'v1');
  await claimBegin(h, id);
  await resubmitFile(h, id, acceptanceId, 'artifact.txt');
  fs.writeFileSync(path.join(wsDir, 'artifact.txt'), 'v2');
  await rejectUnassign(h, id, '内容改了');
  await reclaim(h, id);
  await resubmitFile(h, id, acceptanceId, 'artifact.txt');

  const task = h.state.tasks[id];
  assert.equal(task.state, 'review');
  const [oldRow, newRow] = task.evidence;
  assert.ok(oldRow.supersededAt, 'old snapshot is retired');
  assert.equal(oldRow.supersededBy, newRow.id);
  assert.equal(oldRow.supersedeReason, 'resubmitted');
  assert.equal(task.evidence.filter((evidence) => !evidence.supersededAt).length, 1);
  await h.command(humanCmd('task.verify', { taskId: id, expected: { entityRev: task.rev } }));
  assert.equal(h.state.tasks[id].state, 'done');
  await svc.close();
});

// 责任：重交若会让另一验收点失去有效证据须在写入前拒绝。
test('a resubmit that would strand another acceptance fails before writing', async () => {
  const { svc, h, wsDir } = await setup();
  const created = await h.command(cmd('task.create', {
    title: 'Shared file',
    acceptance: [{ text: 'a' }, { text: 'b' }],
  }));
  const id = created.events.find((event) => event.type === 'task/created').taskId;
  const [a1, a2] = h.state.tasks[id].acceptance.map((item) => item.id);
  fs.writeFileSync(path.join(wsDir, 'shared.txt'), 'v1');
  await claimBegin(h, id);
  await h.command(cmd('task.submit', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    fencingToken: h.leases.get(id).token,
    evidence: [
      { kind: 'file', ref: 'shared.txt', acceptanceId: a1 },
      { kind: 'file', ref: 'shared.txt', acceptanceId: a2 },
    ],
  }));
  fs.writeFileSync(path.join(wsDir, 'shared.txt'), 'v2');
  await rejectUnassign(h, id, '改文件');
  await reclaim(h, id);

  const revBefore = h.state.tasks[id].rev;
  const evidenceBefore = h.state.tasks[id].evidence.length;
  const error = await h.command(cmd('task.submit', {
    taskId: id,
    expected: { entityRev: revBefore },
    fencingToken: h.leases.get(id).token,
    evidence: [{ kind: 'file', ref: 'shared.txt', acceptanceId: a1 }],
  })).then(() => null, (err) => err);
  assert.equal(error.code, 'missing-evidence');
  assert.equal(error.details.acceptanceId, a2);
  assert.match(error.details.hint, /same submit|new attempt/);
  assert.equal(h.state.tasks[id].rev, revBefore, 'rejected submit wrote nothing');
  assert.equal(h.state.tasks[id].state, 'in_progress');
  assert.equal(h.state.tasks[id].evidence.length, evidenceBefore);
  assert.equal(h.state.tasks[id].evidence.every((evidence) => !evidence.supersededAt), true);
  await svc.close();
});

// 责任：一次 submit 为两个验收点替换同文件须保留双重覆盖，不丢任一关联。
test('one submit can replace the same file for two acceptances', async () => {
  const { svc, h, wsDir } = await setup();
  const created = await h.command(cmd('task.create', {
    title: 'Shared file twice',
    acceptance: [{ text: 'a' }, { text: 'b' }],
  }));
  const id = created.events.find((event) => event.type === 'task/created').taskId;
  const [a1, a2] = h.state.tasks[id].acceptance.map((item) => item.id);
  fs.writeFileSync(path.join(wsDir, 'shared.txt'), 'v1');
  await claimBegin(h, id);
  await h.command(cmd('task.submit', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    fencingToken: h.leases.get(id).token,
    evidence: [
      { kind: 'file', ref: 'shared.txt', acceptanceId: a1 },
      { kind: 'file', ref: 'shared.txt', acceptanceId: a2 },
    ],
  }));
  fs.writeFileSync(path.join(wsDir, 'shared.txt'), 'v2');
  await rejectUnassign(h, id, '改文件');
  await reclaim(h, id);
  await h.command(cmd('task.submit', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    fencingToken: h.leases.get(id).token,
    evidence: [
      { kind: 'file', ref: 'shared.txt', acceptanceId: a1 },
      { kind: 'file', ref: 'shared.txt', acceptanceId: a2 },
    ],
  }));
  const task = h.state.tasks[id];
  assert.equal(task.state, 'review');
  assert.equal(task.evidence.filter((evidence) => !evidence.supersededAt).length, 2);
  assert.equal(task.evidence.filter((evidence) => evidence.supersededAt).length, 2);
  await h.command(humanCmd('task.verify', { taskId: id, expected: { entityRev: task.rev } }));
  assert.equal(h.state.tasks[id].state, 'done');
  await svc.close();
});

// 责任：重交字节完全相同的文件后只能有一个有效快照，不能重复堆积 active 证据。
test('resubmitting identical content keeps one active snapshot', async () => {
  const { svc, h, wsDir, id } = await setup();
  const acceptanceId = h.state.tasks[id].acceptance[0].id;
  fs.writeFileSync(path.join(wsDir, 'artifact.txt'), 'same');
  await claimBegin(h, id);
  await resubmitFile(h, id, acceptanceId, 'artifact.txt');
  await rejectUnassign(h, id, '重提');
  await reclaim(h, id);
  await resubmitFile(h, id, acceptanceId, 'artifact.txt');
  const task = h.state.tasks[id];
  assert.equal(task.evidence.filter((evidence) => !evidence.supersededAt).length, 1);
  assert.equal(task.evidence.length, 2);
  await h.command(humanCmd('task.verify', { taskId: id, expected: { entityRev: task.rev } }));
  assert.equal(h.state.tasks[id].state, 'done');
  await svc.close();
});

// 责任：人工 verify 显式 refreshDrift 后须刷新内容快照并记录验收。
test('a human can refresh content drift at verify', async () => {
  const { svc, h, wsDir, id } = await setup();
  const acceptanceId = h.state.tasks[id].acceptance[0].id;
  fs.writeFileSync(path.join(wsDir, 'artifact.txt'), 'v1');
  await claimBegin(h, id);
  await resubmitFile(h, id, acceptanceId, 'artifact.txt');
  fs.writeFileSync(path.join(wsDir, 'artifact.txt'), 'v2');

  const result = await h.command(humanCmd('task.verify', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    refreshDrift: true,
    reason: '构建后仅有空白变化，已人工复核',
  }));
  const task = h.state.tasks[id];
  assert.equal(result.ok, true);
  assert.equal(task.state, 'done');
  assert.equal(task.refreshedDrift.items.length, 1);
  assert.notEqual(task.refreshedDrift.items[0].oldHash, task.refreshedDrift.items[0].newHash);
  assert.equal(task.evidence.filter((evidence) => !evidence.supersededAt).length, 1);
  assert.equal(h.health().warnings.some((line) => line.includes('file-drift')), false);
  await svc.close();
});

// 责任：refreshDrift 缺理由或文件已缺失时必须拒绝，不能凭空刷新。
test('refreshDrift needs a reason and cannot refresh a missing file', async () => {
  const { svc, h, wsDir, id } = await setup();
  const acceptanceId = h.state.tasks[id].acceptance[0].id;
  fs.writeFileSync(path.join(wsDir, 'artifact.txt'), 'v1');
  await claimBegin(h, id);
  await resubmitFile(h, id, acceptanceId, 'artifact.txt');
  fs.writeFileSync(path.join(wsDir, 'artifact.txt'), 'v2');

  const noReason = await h.command(humanCmd('task.verify', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    refreshDrift: true,
  })).then(() => null, (err) => err);
  assert.equal(noReason.code, 'invalid-command');

  fs.rmSync(path.join(wsDir, 'artifact.txt'));
  const missing = await h.command(humanCmd('task.verify', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    refreshDrift: true,
    reason: '人工复核内容变更',
  })).then(() => null, (err) => err);
  assert.equal(missing.code, 'evidence-drift');
  assert.equal(missing.details.warnings.some((warning) => warning.code === 'file-missing'), true);
  assert.equal(missing.details.canRefresh, false);
  assert.equal(h.state.tasks[id].state, 'review');
  await svc.close();
});

// 责任：普通自报 command 提交后须 review 且无正确性 warning。
test('reported command evidence reaches review without correctness warnings', async () => {
  const { svc, h, id } = await setup();
  const acceptanceId = h.state.tasks[id].acceptance[0].id;
  await claimBegin(h, id);
  const result = await h.command(cmd('task.submit', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    fencingToken: h.leases.get(id).token,
    evidence: [{ kind: 'command', ref: 'node --version', acceptanceId }],
  }));
  assert.equal(h.state.tasks[id].state, 'review');
  assert.equal((result.warnings || []).some((warning) => warning.code === 'command-self-reported'), false);
  await svc.close();
});

// 责任：completed 对账重交修改文件须替代旧快照并重新计算验收覆盖。
test('reconcile(completed) supersedes a changed file and recomputes coverage', async () => {
  const { svc, h, wsDir, id } = await setup();
  const acceptanceId = h.state.tasks[id].acceptance[0].id;
  fs.writeFileSync(path.join(wsDir, 'artifact.txt'), 'v1');
  await claimBegin(h, id);
  await resubmitFile(h, id, acceptanceId, 'artifact.txt');
  await rejectUnassign(h, id, '中断重做');
  await reclaim(h, id);
  await h.command(cmd('task.interrupt', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    fencingToken: h.leases.get(id).token,
    note: '收尾前中断',
  }));
  fs.writeFileSync(path.join(wsDir, 'artifact.txt'), 'v2');
  // reconcile(completed) is another review boundary: stale evidence is rejected
  // while the caller can still fix it.
  const revBefore = h.state.tasks[id].rev;
  const rejected = await h.command(cmd('task.reconcile', {
    taskId: id,
    expected: { entityRev: revBefore },
    choice: 'completed',
    note: '直接收尾',
  })).then(() => null, (err) => err);
  assert.equal(rejected.code, 'evidence-drift');
  assert.equal(rejected.details.stage, 'reconcile');
  assert.equal(h.state.tasks[id].state, 'interrupted');
  assert.equal(h.state.tasks[id].rev, revBefore, 'rejected reconcile wrote nothing');

  await h.command(cmd('task.reconcile', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    choice: 'completed',
    note: '以新内容收尾',
    evidence: [{ kind: 'file', ref: 'artifact.txt', acceptanceId }],
  }));
  const task = h.state.tasks[id];
  assert.equal(task.state, 'review');
  assert.equal(task.evidence.length, 2);
  assert.ok(task.evidence[0].supersededAt);
  assert.equal(task.acceptance[0].met, true);
  await h.command(humanCmd('task.verify', { taskId: id, expected: { entityRev: task.rev } }));
  assert.equal(h.state.tasks[id].state, 'done');
  await svc.close();
});

// 责任：重新提交文档证据须 supersede 旧版本，不让旧 head 漂移继续参加审计。
test('resubmitting a doc evidence supersedes the old revision', async () => {
  const { svc, h, id } = await setup();
  const acceptanceId = h.state.tasks[id].acceptance[0].id;
  const created = await h.command(cmd('doc.put', { title: 'D', body: 'doc v1', kind: 'note' }));
  const docId = created.events.find((event) => event.type === 'doc/created').docId;
  await claimBegin(h, id);
  await h.command(cmd('task.submit', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    fencingToken: h.leases.get(id).token,
    evidence: [{ kind: 'doc', ref: docId + '@1', acceptanceId }],
  }));
  await h.command(cmd('doc.put', { docId, baseRev: 1, title: 'D', body: 'doc v2' }));
  await rejectUnassign(h, id, 'doc 小改');
  await reclaim(h, id);
  await h.command(cmd('task.submit', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    fencingToken: h.leases.get(id).token,
    evidence: [{ kind: 'doc', ref: docId + '@2', acceptanceId }],
  }));
  const task = h.state.tasks[id];
  assert.equal(task.state, 'review');
  assert.equal(task.evidence.length, 2);
  assert.ok(task.evidence[0].supersededAt);
  assert.equal(task.evidence[1].supersededAt, undefined);
  await h.command(humanCmd('task.verify', { taskId: id, expected: { entityRev: task.rev } }));
  assert.equal(h.state.tasks[id].state, 'done');
  await svc.close();
});
