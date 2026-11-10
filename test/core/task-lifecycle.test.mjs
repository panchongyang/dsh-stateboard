/**
 * 测试职责：约束任务发布、领取、交付、驳回与归属恢复的集成生命周期。
 * 典型流程：构造合成临时项目或状态 → 执行领域操作 → 比较原始断言与副作用。
 * 覆盖边界：覆盖 任务状态、证据提交和读模型关系；不覆盖 日志完整性、计划成员或性能预算。
 * 外部前置：需要可写临时目录；历史执行签名由合成 fixture 提供。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import test from 'node:test';
import { buildDigest } from '../../lib/core/digest.js';
import { signExecution } from '../fixtures/legacy-execution.mjs';
import { cmd, humanCmd, PLAN, setup, publish, taskByTitle, tokenOf } from '../helpers/core-lifecycle-fixture.mjs';

async function reachReview(h, taskId, sessionId = 's1') {
  await h.attach({ sessionId, agentId: sessionId, source: 'test', role: 'worker' });
  // Exercise assignment handoff on an audit-gated review task.
  if (!h.state.tasks[taskId].requiresAudit) {
    await h.command(cmd('task.gate', { taskId, expected: { entityRev: h.state.tasks[taskId].rev }, requiresAudit: true }));
  }
  await h.command({ ...cmd('task.claim', { taskId, expected: { entityRev: h.state.tasks[taskId].rev } }), actor: { kind: 'agent', sessionId } });
  await h.command({
    ...cmd('task.begin', { taskId, expected: { entityRev: h.state.tasks[taskId].rev }, fencingToken: h.leases.get(taskId).token, summary: 'do the work' }),
    actor: { kind: 'agent', sessionId },
  });
  await h.command({
    ...cmd('task.submit', {
      taskId,
      expected: { entityRev: h.state.tasks[taskId].rev },
      fencingToken: h.leases.get(taskId).token,
      evidence: [{ kind: 'command', ref: 'node -v', summary: 'ran', acceptanceId: h.state.tasks[taskId].acceptance[0].id }],
    }),
    actor: { kind: 'agent', sessionId },
  });
  return h.state.tasks[taskId];
}

// 责任：发布两步依赖计划后，前置任务须 ready、后继 backlog，计划与看板计数一致。
test('publish creates ready/backlog tasks and a plan', async () => {
  const { h, svc } = await setup();
  await publish(h);
  const t1 = taskByTitle(h, 'T1');
  const t2 = taskByTitle(h, 'T2');
  assert.equal(t1.state, 'ready');
  assert.equal(t2.state, 'backlog');
  const plan = h.query('plan', {});
  assert.equal(plan.plan.status, 'published');
  assert.equal(plan.plan.version, 1);
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.progress.total, 2);
  const board = h.query('board', {});
  assert.equal(board.columns.ready.length, 1);
  assert.equal(board.columns.backlog.length, 1);
  await svc.close();
});

// 责任：计划任务携带 labels 和 requiresAudit 时，物化任务须保留标签并补 gate:audit。
test('plan.publish carries labels and the audit switch', async () => {
  const { h, svc } = await setup();
  await h.command(cmd('plan.publish', {
    title: 'Labeled plan',
    steps: [{ id: 's1', title: 'one', tasks: [{ key: 't1', title: 'Gated', acceptance: [{ text: 'x' }], labels: ['urgent'], requiresAudit: true }] }],
  }));
  const task = Object.values(h.state.tasks)[0];
  assert.equal(task.requiresAudit, true);
  assert.deepEqual(task.labels, ['urgent', 'gate:audit']);
  await svc.close();
});

// 责任：首个会话领取后第二个领取须报 lease-held，任务只保留首份租约。
test('claim is exclusive: second claim gets lease-held', async () => {
  const { h, svc } = await setup();
  await publish(h);
  const t1 = taskByTitle(h, 'T1');
  const first = await h.command(cmd('task.claim', { taskId: t1.id, expected: { entityRev: t1.rev } }));
  assert.equal(first.ok, true);
  assert.equal(h.state.tasks[t1.id].state, 'in_progress');
  assert.ok(h.leases.get(t1.id));
  const second = await h.command({
    cmdId: 'cmd-second',
    actor: { kind: 'agent', sessionId: 's2' },
    op: 'task.claim',
    taskId: t1.id,
    expected: { entityRev: h.state.tasks[t1.id].rev },
  }).then(() => null, (error) => error);
  assert.ok(second);
  assert.equal(second.code, 'lease-held');
  await svc.close();
});

// 责任：agent 取消无租约任务可直接进入 canceled，不得为了取消额外发放租约。
test('an agent can cancel an unleased task without claiming it first', async () => {
  const { h, svc } = await setup();
  await publish(h);
  const t1 = taskByTitle(h, 'T1');
  const result = await h.command(cmd('task.cancel', { taskId: t1.id, expected: { entityRev: t1.rev }, reason: 'placeholder removed' }));
  assert.equal(result.ok, true);
  assert.equal(h.state.tasks[t1.id].state, 'canceled');
  assert.equal(h.leases.has(t1.id), false);
  assert.equal(result.events.some((event) => event.type === 'lease/granted'), false);
  await svc.close();
});

// 责任：切换状态和调用者后 allowedOps 的 enabled/reason 必须与实际守卫权限一致。
test('allowedOps reasons match the guards that reject each op', async () => {
  const { h, svc } = await setup();
  await publish(h);
  const t1 = taskByTitle(h, 'T1');
  const opsOf = (sessionId) => Object.fromEntries(h.query('task', { taskId: t1.id, sessionId }).allowedOps.map((op) => [op.op, op]));

  const readyForAgent = opsOf('s2');
  assert.equal(readyForAgent.cancel.enabled, true);
  assert.equal(readyForAgent.update.enabled, false);
  assert.equal(readyForAgent.update.reason, 'you do not hold the lease');
  assert.equal(readyForAgent.reopen.reason, 'task is not terminal');

  await h.command(cmd('task.claim', { taskId: t1.id, expected: { entityRev: t1.rev }, actor: { kind: 'agent', sessionId: 's1' } }));
  const claimed = h.state.tasks[t1.id];
  const other = opsOf('s2');
  assert.equal(other.cancel.enabled, false);
  assert.equal(other.cancel.reason, 'only the lease owner or a human can cancel');
  assert.equal(other.release.reason, 'you do not hold the lease');
  assert.equal(other.block.reason, 'you do not hold the lease');

  const owner = opsOf('s1');
  assert.equal(owner.release.enabled, true);
  assert.equal(owner.block.enabled, true);

  await h.command({
    cmdId: 'cmd-block-check',
    actor: { kind: 'agent', sessionId: 's1' },
    op: 'task.block',
    taskId: t1.id,
    expected: { entityRev: claimed.rev },
    fencingToken: h.leases.get(t1.id).token,
    code: 'external-dependency',
    note: 'waiting',
  });
  const blocked = opsOf('s2');
  assert.equal(blocked.unblock.enabled, true);
  assert.equal(blocked.unblock.reason, null);

  const created = await h.command(cmd('task.create', { title: 'Temp', acceptance: [{ text: 'cleanup' }] }));
  const tempId = created.events.find((event) => event.type === 'task/created').taskId;
  await h.command(cmd('task.cancel', { taskId: tempId, expected: { entityRev: 1 }, reason: 'cleanup' }));
  const terminalForAgent = h.query('task', { taskId: tempId, sessionId: 's2' }).allowedOps.reduce((acc, op) => { acc[op.op] = op; return acc; }, {});
  assert.equal(terminalForAgent.cancel.enabled, false);
  assert.equal(terminalForAgent.cancel.reason, 'terminal task');
  assert.equal(terminalForAgent.reopen.enabled, false);
  assert.equal(terminalForAgent.reopen.reason, 'human only');
  const terminalForHuman = h.query('task', { taskId: tempId }).allowedOps.reduce((acc, op) => { acc[op.op] = op; return acc; }, {});
  assert.equal(terminalForHuman.reopen.enabled, true);
  await svc.close();
});

// 责任：领取时传过期实体版本须 stale-revision，任务快照不得改变。
test('stale expectedRev is rejected without state change', async () => {
  const { h, svc } = await setup();
  await publish(h);
  const t1 = taskByTitle(h, 'T1');
  const before = structuredClone(h.state.tasks[t1.id]);
  const error = await h.command(cmd('task.claim', { taskId: t1.id, expected: { entityRev: 999 } })).then(() => null, (e) => e);
  assert.ok(error);
  assert.equal(error.code, 'stale-revision');
  assert.deepEqual(h.state.tasks[t1.id], before);
  await svc.close();
});

// 责任：重复同一发布 cmdId 须 deduped，不能再物化一套任务。
test('duplicate cmdId is idempotent', async () => {
  const { h, svc } = await setup();
  await publish(h, PLAN, 'same-plan-cmd');
  const count = Object.keys(h.state.tasks).length;
  const again = await h.command({ ...cmd('plan.publish', { title: PLAN.title, steps: PLAN.steps }), cmdId: 'same-plan-cmd' });
  assert.equal(again.deduped, true);
  assert.equal(Object.keys(h.state.tasks).length, count);
  await svc.close();
});

// 责任：提交文件证据只进入 review；人工 verify 后才 done 并解锁后继任务。
test('submit records file material; only human verify cascades ready', async () => {
  const { h, wsDir, svc } = await setup();
  fs.writeFileSync(path.join(wsDir, 'artifact.txt'), 'hello');
  await publish(h);
  const t1 = taskByTitle(h, 'T1');
  await h.command(cmd('task.claim', { taskId: t1.id, expected: { entityRev: t1.rev } }));
  const claim = h.state.tasks[t1.id];
  await h.command({ ...cmd('task.begin', { taskId: t1.id, expected: { entityRev: claim.rev }, fencingToken: tokenOf(h, t1.id), summary: 'create artifact' }) });
  const begun = h.state.tasks[t1.id];
  const evidence = [{ kind: 'file', ref: 'artifact.txt', summary: 'artifact', acceptanceId: begun.acceptance[0].id }];
  const result = await h.command({ ...cmd('task.submit', { taskId: t1.id, expected: { entityRev: begun.rev }, fencingToken: tokenOf(h, t1.id), evidence }) });
  assert.equal(result.ok, true);
  assert.equal(h.state.tasks[t1.id].state, 'review');
  assert.equal(h.state.tasks[taskByTitle(h, 'T2').id].state, 'backlog');
  await h.command(humanCmd('task.verify', { taskId: t1.id, expected: { entityRev: h.state.tasks[t1.id].rev } }));
  assert.equal(h.state.tasks[t1.id].state, 'done');
  assert.equal(h.state.tasks[t1.id].verifiedBy, 'human');
  assert.equal(h.state.tasks[taskByTitle(h, 'T2').id].state, 'ready');
  const board = h.query('board', {});
  assert.equal(board.counts.done, 1);
  assert.equal(board.counts.percent, 0.5);
  await svc.close();
});

// 责任：带 gate:audit 的任务 submit 后须保持 review，显式人工验收才完成。
test('gate:audit submit stays review until explicit human verify', async () => {
  const { h, wsDir, svc } = await setup();
  fs.writeFileSync(path.join(wsDir, 'gate.txt'), 'gate');
  const created = await h.command(cmd('task.create', { title: 'Needs human', acceptance: [{ text: 'file exists' }], labels: ['gate:audit'] }));
  const taskId = created.events.find((event) => event.type === 'task/created').taskId;
  const task = h.state.tasks[taskId];
  assert.deepEqual(task.labels, ['gate:audit']);
  await h.command(cmd('task.claim', { taskId, expected: { entityRev: task.rev } }));
  const claimed = h.state.tasks[taskId];
  await h.command({ ...cmd('task.begin', { taskId, expected: { entityRev: claimed.rev }, fencingToken: h.leases.get(taskId).token, summary: 'do it' }) });
  const begun = h.state.tasks[taskId];
  await h.command({ ...cmd('task.submit', {
    taskId,
    expected: { entityRev: begun.rev },
    fencingToken: h.leases.get(taskId).token,
    evidence: [{ kind: 'file', ref: 'gate.txt', summary: 'gate', acceptanceId: begun.acceptance[0].id }],
  }) });
  assert.equal(h.state.tasks[taskId].state, 'review');
  const verified = await h.command(humanCmd('task.verify', { taskId, expected: { entityRev: h.state.tasks[taskId].rev } }));
  assert.equal(verified.ok, true);
  assert.equal(h.state.tasks[taskId].state, 'done');
  await svc.close();
});

// 责任：agent 可开启审计门但不能关闭，人工关闭时须同步去掉 gate:audit 标签。
test('requiresAudit switch: agent may turn it on, only a human may turn it off', async () => {
  const { h, svc } = await setup();
  const created = await h.command(cmd('task.create', { title: 'Switch gated', acceptance: [{ text: 'x' }] }));
  const taskId = created.events.find((event) => event.type === 'task/created').taskId;
  assert.equal(h.state.tasks[taskId].requiresAudit, false);

  await h.command(cmd('task.gate', { taskId, expected: { entityRev: 1 }, requiresAudit: true }));
  assert.equal(h.state.tasks[taskId].requiresAudit, true);
  assert.ok(h.state.tasks[taskId].labels.includes('gate:audit'));

  const error = await h.command(cmd('task.gate', {
    taskId,
    expected: { entityRev: h.state.tasks[taskId].rev },
    requiresAudit: false,
  })).then(() => null, (e) => e);
  assert.ok(error);
  assert.equal(error.code, 'forbidden-role');
  assert.equal(h.state.tasks[taskId].requiresAudit, true);

  await h.command({ ...humanCmd('task.gate', { taskId, expected: { entityRev: h.state.tasks[taskId].rev }, requiresAudit: false }) });
  assert.equal(h.state.tasks[taskId].requiresAudit, false);
  assert.equal(h.state.tasks[taskId].labels.includes('gate:audit'), false);
  await svc.close();
});

// 责任：审计门任务的 agent cancel 须被拒绝，人工取消才可转 canceled。
test('a gated task can only be canceled by a human', async () => {
  const { h, svc } = await setup();
  const created = await h.command(cmd('task.create', { title: 'Protected', acceptance: [{ text: 'x' }], requiresAudit: true }));
  const taskId = created.events.find((event) => event.type === 'task/created').taskId;
  const agentOps = h.query('task', { taskId, sessionId: 's2' }).allowedOps.reduce((acc, op) => { acc[op.op] = op; return acc; }, {});
  assert.equal(agentOps.cancel.enabled, false);
  assert.equal(agentOps.cancel.reason, 'only a human can cancel a gated task');
  const error = await h.command(cmd('task.cancel', { taskId, expected: { entityRev: 1 }, reason: 'nope' })).then(() => null, (e) => e);
  assert.ok(error);
  assert.equal(error.code, 'forbidden-role');
  assert.equal(h.state.tasks[taskId].state, 'ready');
  await h.command({ ...humanCmd('task.cancel', { taskId, expected: { entityRev: 1 }, reason: 'human says no' }) });
  assert.equal(h.state.tasks[taskId].state, 'canceled');
  await svc.close();
});

// 责任：人工更新标签或 requiresAudit 时，审计开关与 gate:audit 标签须双向同步。
test('task.update can add and remove the gate:audit label', async () => {
  const { h, svc } = await setup();
  const created = await h.command(cmd('task.create', { title: 'Plain', acceptance: [{ text: 'x' }] }));
  const taskId = created.events.find((event) => event.type === 'task/created').taskId;
  const plain = h.state.tasks[taskId];
  await h.command({ ...humanCmd('task.update', { taskId, expected: { entityRev: plain.rev }, labels: ['gate:audit'] }) });
  assert.deepEqual(h.state.tasks[taskId].labels, ['gate:audit']);
  assert.equal(h.state.tasks[taskId].requiresAudit, true);
  await h.command({ ...humanCmd('task.update', { taskId, expected: { entityRev: h.state.tasks[taskId].rev }, requiresAudit: false }) });
  assert.deepEqual(h.state.tasks[taskId].labels, []);
  assert.equal(h.state.tasks[taskId].requiresAudit, false);
  await svc.close();
});

// 责任：开始工作后空证据 submit 须报 missing-evidence，任务仍为 in_progress。
test('submit without evidence is rejected', async () => {
  const { h, svc } = await setup();
  await publish(h);
  const t1 = taskByTitle(h, 'T1');
  await h.command(cmd('task.claim', { taskId: t1.id, expected: { entityRev: t1.rev } }));
  const claim = h.state.tasks[t1.id];
  await h.command({ ...cmd('task.begin', { taskId: t1.id, expected: { entityRev: claim.rev }, fencingToken: tokenOf(h, t1.id), summary: 'x' }) });
  const begun = h.state.tasks[t1.id];
  const error = await h.command({ ...cmd('task.submit', { taskId: t1.id, expected: { entityRev: begun.rev }, fencingToken: tokenOf(h, t1.id), evidence: [] }) }).then(() => null, (e) => e);
  assert.ok(error);
  assert.equal(error.code, 'missing-evidence');
  assert.equal(h.state.tasks[t1.id].state, 'in_progress');
  await svc.close();
});

// 责任：文件证据自报错误哈希须报 missing-evidence，不能把任务送进 review。
test('file evidence hash mismatch is rejected', async () => {
  const { h, wsDir, svc } = await setup();
  fs.writeFileSync(path.join(wsDir, 'artifact.txt'), 'hello');
  await publish(h);
  const t1 = taskByTitle(h, 'T1');
  await h.command(cmd('task.claim', { taskId: t1.id, expected: { entityRev: t1.rev } }));
  const claim = h.state.tasks[t1.id];
  await h.command({ ...cmd('task.begin', { taskId: t1.id, expected: { entityRev: claim.rev }, fencingToken: tokenOf(h, t1.id), summary: 'x' }) });
  const begun = h.state.tasks[t1.id];
  const error = await h.command({ ...cmd('task.submit', {
    taskId: t1.id,
    expected: { entityRev: begun.rev },
    fencingToken: tokenOf(h, t1.id),
    evidence: [{ kind: 'file', ref: 'artifact.txt', hash: 'deadbeef', summary: 'bad', acceptanceId: begun.acceptance[0].id }],
  }) }).then(() => null, (e) => e);
  assert.ok(error);
  assert.equal(error.code, 'missing-evidence');
  assert.equal(h.state.tasks[t1.id].state, 'in_progress');
  await svc.close();
});

// 责任：同时发起十次领取只能有一次成功，不能给同任务发放多个活租约。
test('ten concurrent claims: exactly one succeeds', async () => {
  const { h, svc } = await setup();
  await publish(h);
  const t1 = taskByTitle(h, 'T1');
  const attempts = [];
  for (let i = 0; i < 10; i++) {
    attempts.push(h.command({
      cmdId: 'cmd-claim-' + i,
      actor: { kind: 'agent', sessionId: 's' + i },
      op: 'task.claim',
      taskId: t1.id,
      expected: { entityRev: t1.rev },
    }));
  }
  const results = await Promise.allSettled(attempts);
  const ok = results.filter((result) => result.status === 'fulfilled').length;
  const rejected = results.filter((result) => result.status === 'rejected');
  assert.equal(ok, 1);
  assert.equal(rejected.length, 9);
  assert.ok(rejected.every((result) => result.reason.code === 'lease-held'));
  await svc.close();
});

// 责任：关联文档后任务视图与 digest 须同时可见链接，不得在读模型丢关系。
test('task view lists linked docs and the digest surfaces them', async () => {
  const { h, svc } = await setup();
  await publish(h);
  const t1 = taskByTitle(h, 'T1');
  const created = await h.command(cmd('doc.put', { title: 'Design doc', kind: 'design', body: 'why', links: { taskIds: [t1.id, t1.id] } }));
  const doc = created.events[0].data;
  assert.deepEqual(doc.links.taskIds, [t1.id], 'duplicate ids collapse');
  const view = h.query('task', { taskId: t1.id });
  assert.equal(view.linkedDocs.length, 1);
  assert.equal(view.linkedDocs[0].id, doc.id);
  assert.equal(view.linkedDocs[0].kind, 'design');
  const text = buildDigest({
    project: { name: 'Demo', phase: 'active' },
    rev: 7,
    counts: {},
    session: { binding: null, leases: [] },
    focus: { id: t1.id, state: t1.state, rev: t1.rev, title: t1.title, acceptance: { met: 0, total: 1 }, evidenceCount: 0, linkedDocs: view.linkedDocs },
    next: [],
    attention: [],
    health: { warnings: [] },
  }, 's1');
  assert.ok(text.includes('docs: ' + doc.id + ' r1 "Design doc"'), text);
  await svc.close();
});

// 责任：链接指向未知任务或不存在计划版本时必须拒绝，不留下悬空关联。
test('doc links reject unknown tasks and plan versions', async () => {
  const { h, svc } = await setup();
  await publish(h);
  const t1 = taskByTitle(h, 'T1');
  const badTask = await h.command(cmd('doc.put', { title: 'Bad', body: 'x', links: { taskIds: [t1.id, 'tsk_missing'] } })).then(() => null, (error) => error);
  assert.ok(badTask, 'unknown task id is rejected');
  assert.equal(badTask.code, 'invalid-command');
  assert.deepEqual(badTask.details.unknownTaskIds, ['tsk_missing']);
  const created = await h.command(cmd('doc.put', { title: 'Good', body: 'x', links: { taskIds: [t1.id] } }));
  const docId = created.events[0].docId;
  const badPlan = await h.command(cmd('doc.link', { docId, links: { taskIds: [t1.id], planRefs: [{ planId: 'pln_missing', version: 1 }] } })).then(() => null, (error) => error);
  assert.ok(badPlan, 'unknown plan version is rejected');
  assert.equal(badPlan.code, 'invalid-command');
  assert.equal(h.state.docs[docId].links.planRefs.length, 0, 'a rejected write leaves the document untouched');
  await svc.close();
});

// 责任：人为制造悬空文档关联后 health 须报警，但普通读取不得因此被阻断。
test('health flags dangling doc links without blocking reads', async () => {
  const { h, svc } = await setup();
  await publish(h);
  const t1 = taskByTitle(h, 'T1');
  const created = await h.command(cmd('doc.put', { title: 'Legacy', body: 'x', links: { taskIds: [t1.id] } }));
  const doc = h.state.docs[created.events[0].docId];
  doc.links.taskIds.push('tsk_gone');
  const health = h.health();
  assert.ok(health.warnings.some((warning) => warning.includes('doc-link-task:' + doc.id)), JSON.stringify(health.warnings));
  assert.equal(h.query('task', { taskId: t1.id }).linkedDocs.length, 1, 'reads still work');
  await svc.close();
});

// 责任：原会话仍存在时驳回须把任务交回该会话，而非直接放回公共 ready。
test('reject keeps the task with the original session instead of sending it to ready', async () => {
  const { h, svc } = await setup();
  await publish(h);
  const t1 = taskByTitle(h, 'T1');
  const review = await reachReview(h, t1.id);
  assert.equal(review.state, 'review');
  assert.equal(review.owner, null, 'submit releases the lease');
  assert.equal(review.assignee.sessionId, 's1', 'submit keeps the assignee');
  assert.equal(h.leases.has(t1.id), false);
  const board = h.query('board', {});
  const reviewCard = board.columns.review.find((card) => card.id === t1.id);
  assert.equal(reviewCard.assignee.sessionId, 's1', 'review cards still show who is on the hook');

  const rejected = await h.command(humanCmd('task.reject', { taskId: t1.id, expected: { entityRev: review.rev }, reason: 'needs rework' }));
  const after = h.state.tasks[t1.id];
  assert.equal(after.state, 'in_progress');
  assert.equal(after.owner.sessionId, 's1');
  assert.equal(after.assignee.sessionId, 's1');
  assert.equal(h.leases.get(t1.id).sessionId, 's1', 'a fresh lease goes to the same session');
  const assignment = rejected.events.find((event) => event.type === 'task/assignment');
  assert.ok(assignment, 'reject writes an assignment record');
  assert.equal(assignment.data.cause, 'reject');
  assert.equal(assignment.data.from.sessionId, 's1');
  assert.equal(assignment.data.to.sessionId, 's1');
  assert.equal(assignment.data.reason, 'needs rework');

  const ops = Object.fromEntries(h.query('task', { taskId: t1.id, sessionId: 's1' }).allowedOps.map((op) => [op.op, op]));
  assert.equal(ops.begin.enabled, true, 'no re-claim needed before working again');
  assert.equal(ops.claim.enabled, false);
  await svc.close();
});

// 责任：原会话已离开时驳回须回退 ready，不能挂在失效 owner 下。
test('reject falls back to ready when the assigned session is gone', async () => {
  const { h, svc } = await setup();
  await publish(h);
  const t1 = taskByTitle(h, 'T1');
  const review = await reachReview(h, t1.id);
  await h.detach('s1', 'session-closed');

  const rejected = await h.command(humanCmd('task.reject', { taskId: t1.id, expected: { entityRev: review.rev }, reason: 'needs rework' }));
  const after = h.state.tasks[t1.id];
  assert.equal(after.state, 'ready');
  assert.equal(after.owner, null);
  assert.equal(after.assignee, null);
  assert.equal(h.leases.has(t1.id), false);
  const assignment = rejected.events.find((event) => event.type === 'task/assignment');
  assert.equal(assignment.data.cause, 'assignee-gone');
  assert.equal(assignment.data.from.sessionId, 's1');
  assert.equal(assignment.data.to, null);
  await svc.close();
});

// 责任：重开终态任务须重新考虑依赖，仅在原会话仍存在时恢复其归属。
test('reopen respects dependencies and restores the assignee when it still exists', async () => {
  const { h, svc } = await setup();
  await publish(h);
  const t1 = taskByTitle(h, 'T1');
  const t2 = taskByTitle(h, 'T2');
  await h.command(humanCmd('task.cancel', { taskId: t1.id, expected: { entityRev: t1.rev }, reason: 'dropped' }));
  assert.equal(h.state.tasks[t2.id].state, 'backlog');
  await h.command(humanCmd('task.cancel', { taskId: t2.id, expected: { entityRev: h.state.tasks[t2.id].rev }, reason: 'park' }));
  await h.command(humanCmd('task.reopen', { taskId: t2.id, expected: { entityRev: h.state.tasks[t2.id].rev }, reason: 'redo' }));
  assert.equal(h.state.tasks[t2.id].state, 'backlog', 'a dependency on a canceled task must not become ready');
  const blockedOps = Object.fromEntries(h.query('task', { taskId: t2.id, sessionId: 's1' }).allowedOps.map((op) => [op.op, op]));
  assert.equal(blockedOps.claim.enabled, false, 'nothing to claim while the dependency is dead');

  const created = await h.command(cmd('task.create', { title: 'Redo me', acceptance: [{ text: 'artifact' }] }));
  const id = created.events.find((event) => event.type === 'task/created').taskId;
  await h.attach({ sessionId: 's1', agentId: 's1', source: 'test', role: 'worker' });
  await h.command(cmd('task.claim', { taskId: id, expected: { entityRev: h.state.tasks[id].rev } }));
  await h.command(cmd('task.begin', { taskId: id, expected: { entityRev: h.state.tasks[id].rev }, fencingToken: h.leases.get(id).token, summary: 'work' }));
  const taskNow = h.state.tasks[id];
  const execRecord = {
    executor: 'host',
    status: 'ok',
    exitCode: 0,
    stdoutHash: '0'.repeat(64),
    stderrHash: '0'.repeat(64),
    commandHash: crypto.createHash('sha256').update('node -v').digest('hex'),
    outputBytes: 8,
    executedAt: new Date().toISOString(),
    timedOut: false,
    taskId: id,
    attempt: taskNow.work?.attempt || 0,
    intentId: taskNow.work?.intentId || null,
    token: h.leases.get(id).token,
  };
  execRecord.proof = signExecution(execRecord);
  await h.command(cmd('task.submit', {
    taskId: id,
    expected: { entityRev: h.state.tasks[id].rev },
    fencingToken: h.leases.get(id).token,
    evidence: [{
      kind: 'command',
      ref: 'node -v',
      summary: 'ran',
      acceptanceId: h.state.tasks[id].acceptance[0].id,
      execution: execRecord,
    }],
  }));
  assert.equal(h.state.tasks[id].state, 'review');
  await h.command(humanCmd('task.verify', { taskId: id, expected: { entityRev: h.state.tasks[id].rev } }));
  await h.command(humanCmd('task.reopen', { taskId: id, expected: { entityRev: h.state.tasks[id].rev }, reason: 'redo the visual polish' }));
  const after = h.state.tasks[id];
  assert.equal(after.state, 'in_progress', 'reopen puts the same session back to work');
  assert.equal(after.owner.sessionId, 's1');
  assert.equal(after.assignee.sessionId, 's1');
  assert.equal(h.leases.get(id).sessionId, 's1');
  await svc.close();
});

// 责任：缺 reason 的 reject 必须拒绝，任务须继续停留 review。
test('reject without a reason is refused and leaves the task in review', async () => {
  const { h, svc } = await setup();
  await publish(h);
  const t1 = taskByTitle(h, 'T1');
  const review = await reachReview(h, t1.id);
  const error = await h.command(humanCmd('task.reject', { taskId: t1.id, expected: { entityRev: review.rev } })).then(() => null, (err) => err);
  assert.ok(error, 'missing reason must fail');
  assert.equal(error.code, 'invalid-command');
  assert.equal(error.status, 400);
  assert.equal(h.state.tasks[t1.id].state, 'review');
  assert.equal(h.leases.has(t1.id), false, 'a refused reject grants no lease');
  await svc.close();
});

// 责任：阻塞任务 unblock 后须回到原会话，而非无故换 owner。
test('unblock returns the task to the same session', async () => {
  const { h, svc } = await setup();
  await publish(h);
  const t1 = taskByTitle(h, 'T1');
  await h.attach({ sessionId: 's1', agentId: 's1', source: 'test', role: 'worker' });
  await h.command(cmd('task.claim', { taskId: t1.id, expected: { entityRev: t1.rev } }));
  await h.command(cmd('task.block', {
    taskId: t1.id,
    expected: { entityRev: h.state.tasks[t1.id].rev },
    fencingToken: h.leases.get(t1.id).token,
    code: 'waiting-human',
    note: 'need a decision',
  }));
  assert.equal(h.state.tasks[t1.id].state, 'blocked');
  assert.equal(h.state.tasks[t1.id].assignee.sessionId, 's1', 'blocking keeps the assignee');
  await h.command(cmd('task.unblock', { taskId: t1.id, expected: { entityRev: h.state.tasks[t1.id].rev }, note: 'decided' }));
  const after = h.state.tasks[t1.id];
  assert.equal(after.state, 'in_progress');
  assert.equal(after.owner.sessionId, 's1');
  assert.equal(h.leases.get(t1.id).sessionId, 's1');
  await svc.close();
});

// 责任：人工 reject 显式 unassign 后须清空归属，不沿用原会话。
test('a human can explicitly unassign on reject', async () => {
  const { h, svc } = await setup();
  await publish(h);
  const t1 = taskByTitle(h, 'T1');
  const review = await reachReview(h, t1.id);
  const rejected = await h.command(humanCmd('task.reject', { taskId: t1.id, expected: { entityRev: review.rev }, reason: 'someone else should own it', unassign: true }));
  const after = h.state.tasks[t1.id];
  assert.equal(after.state, 'ready');
  assert.equal(after.assignee, null);
  assert.equal(after.owner, null);
  const assignment = rejected.events.find((event) => event.type === 'task/assignment');
  assert.equal(assignment.data.cause, 'unassign');
  assert.equal(assignment.data.from.sessionId, 's1');
  assert.equal(assignment.data.to, null);
  await svc.close();
});
