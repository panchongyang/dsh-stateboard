/**
 * 测试职责：验证宿主工具从计划发布到任务交付、历史文档读取和会话事件的集成接线。
 * 典型流程：合成 ctx 注册插件并播种旧文档 → 依次执行工具及事件回调 → 对照响应、渲染和状态。
 * 覆盖边界：覆盖 工具主流程、错误码、摘要、绑定与恢复；不覆盖真实宿主进程或浏览器。
 * 外部前置：需要 DSH peer 可导入；store 和证据文件均为临时数据。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../../lib/index.js';
import { ProjectService } from '../../lib/core/service.js';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-state-'));
const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-ws-'));
fs.writeFileSync(path.join(wsDir, 'artifact.txt'), 'hello tool');

const tools = new Map();
const disposers = [];
const eventHandlers = new Map();
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  tools: { register(tool) { tools.set(tool.name, tool); } },
  systemPrompt: { section() { return () => {}; }, getSectionOrder() { return 9000; } },
  agents: { list() { return []; } },
  on(event, handler) {
    const list = eventHandlers.get(event) || [];
    list.push(handler);
    eventHandlers.set(event, list);
    return () => {};
  },
  effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return () => {}; },
  get() { return undefined; },
};

const exec = {
  agent: { id: 'session-tool-test', session: { header: { cwd: wsDir } } },
  callId: 'call-tool-test',
};

try {
  // 分段职责：以 fixture 播种历史内嵌记录，为只读工具兼容覆盖准备数据。
  // Seed a legacy inline row through the constructor-only internal path; the
  // tool surface itself is archive-only and must reject doc.put.
  const seedSvc = new ProjectService({ rootDir: stateDir, privilegedInlineWrites: true });
  await seedSvc.init();
  const seedHandle = await seedSvc.createProject({ workspacePath: wsDir });
  const seeded = await seedHandle.command({
    cmdId: 'cmd_seed_' + Math.random().toString(36).slice(2), actor: { kind: 'system', via: 'system' },
    op: 'doc.put', title: 'Seeded inline', kind: 'note', body: 'seeded body',
  });
  const seededDocId = seeded.events[0].docId;
  await seedSvc.close();

  apply(ctx, { rootDir: stateDir });
  await new Promise((resolve) => setTimeout(resolve, 30));

  // 分段职责：通过真实工具发布计划再领取/开始任务，响应渲染须带任务、验收和 token。
  const planTool = tools.get('project_plan');
  const published = await planTool.execute({
    op: 'publish',
    title: 'Tool plan',
    steps: [{
      id: 's1', title: 'one',
      tasks: [{ key: 't1', title: 'Tool task', acceptance: [{ text: 'artifact exists' }] }],
    }],
  }, exec);
  assert.equal(published.ok, true);
  assert.ok(published.plan && published.steps && published.steps.length === 1);
  const taskId = published.steps[0].tasks[0].id;
  assert.ok(taskId);
  const planText = planTool.output.render({ op: 'publish' }, published)[0].text;
  assert.ok(planText.includes(taskId), 'plan render includes task id');

  const taskTool = tools.get('project_task');
  const claimed = await taskTool.execute({ op: 'claim', taskId, expectedRev: 1 }, exec);
  assert.equal(claimed.ok, true);
  const rev = claimed.task.task.rev;
  const token = claimed.task.lease.token;
  assert.ok(token);
  const claimText = taskTool.output.render({ op: 'claim' }, claimed)[0].text;
  assert.ok(claimText.includes('token ' + token), 'claim render includes lease token');
  assert.ok(claimText.includes(claimed.task.task.acceptance[0].id), 'claim render includes acceptance id');

  const begun = await taskTool.execute({ op: 'begin', taskId, expectedRev: rev, fencingToken: token, summary: 'do it' }, exec);
  assert.equal(begun.ok, true);
  const begunRev = begun.task.task.rev;
  const acceptanceId = begun.task.task.acceptance[0].id;

  const submitted = await taskTool.execute({
    op: 'submit', taskId, expectedRev: begunRev, fencingToken: token,
    note: 'artifact',
    evidence: [{ kind: 'file', ref: 'artifact.txt', summary: 'artifact', acceptanceId }],
  }, exec);
  assert.equal(submitted.ok, true);
  assert.equal(submitted.task.task.state, 'review');

  // 分段职责：command/test ref 只记录材料不能执行，也不能伪造宿主 execution。
  // Valid command/test refs are materials, never executable instructions.
  for (const op of ['submit', 'reconcile']) {
    for (const kind of ['command', 'test']) {
      const created = await taskTool.execute({ op: 'create', title: op + kind, acceptance: [{ text: 'record', requiredKinds: [kind] }] }, exec);
      const id = created.task.task.id;
      const claim = await taskTool.execute({ op: 'claim', taskId: id, expectedRev: created.task.task.rev }, exec);
      const token = claim.task.lease.token;
      const begin = await taskTool.execute({ op: 'begin', taskId: id, expectedRev: claim.task.task.rev, fencingToken: token, summary: 'record' }, exec);
      let rev = begin.task.task.rev;
      if (op === 'reconcile') {
        const interrupted = await taskTool.execute({ op: 'interrupt', note: 'interrupted for reconciliation', taskId: id, expectedRev: rev, fencingToken: token }, exec);
        rev = interrupted.task.task.rev;
      }
      const result = await taskTool.execute({ op, taskId: id, expectedRev: rev, fencingToken: token, choice: 'completed', note: 'recorded', evidence: [{ kind, ref: 'node -e "require(\'fs\').writeFileSync(\'tool-executed\',\'bad\')"', acceptanceId: begin.task.task.acceptance[0].id }] }, exec);
      assert.equal(result.task.task.state, 'review');
      assert.equal(result.task.task.evidence[0].execution, null);
      assert.equal(fs.existsSync(path.join(wsDir, 'tool-executed')), false);
    }
  }

  // 分段职责：错误版本及缺任务须失败且无副作用，不能因工具转译放宽核心守卫。
  // Invalid revisions and missing tasks still fail without side effects.
  const marker = path.join(wsDir, 'should-not-exist.txt');
  fs.rmSync(marker, { force: true });
  const missing = await taskTool.execute({
    op: 'submit',
    taskId: 'tsk_missing',
    expectedRev: 1,
    evidence: [{ kind: 'command', ref: 'node -e "require(\'fs\').writeFileSync(\'should-not-exist.txt\',\'x\')"', acceptanceId }],
  }, exec).then(() => null, (error) => error);
  assert.ok(missing, 'missing task submit must fail');
  assert.equal(missing.code, 'not-found');
  assert.equal(fs.existsSync(marker), false, 'command evidence must not run before validation');

  const boardTool = tools.get('project_board');
  const board = await boardTool.execute({ view: 'board' }, exec);
  assert.equal(board.ok, true);
  assert.equal(board.project.name, path.basename(wsDir));
  assert.equal(board.columns.review.length, 5);
  const boardText = boardTool.output.render({ view: 'board' }, board)[0].text;
  assert.ok(boardText.includes(taskId), 'board render includes task id');
  const taskView = await boardTool.execute({ view: 'task', taskId }, exec);
  const taskViewText = boardTool.output.render({ view: 'task' }, taskView)[0].text;
  assert.ok(taskViewText.includes(taskView.task.acceptance[0].id), 'task render includes acceptance id');

  const brief = await boardTool.execute({ view: 'brief' }, exec);
  assert.equal(brief.ok, true);
  assert.ok(brief.digest.includes('Project:'));
  assert.ok(brief.digest.includes('plans:'), 'digest mentions multi-plan rules');

  // 分段职责：草案生命周期、收录/移出和计划列表须正确转译，focus 仍只准人工。
  // plan v2 host surface: draft lifecycle, adopt/release, plans view, human-only focus
  const draft = await planTool.execute({
    op: 'create',
    title: 'Draft plan',
    goal: 'created before tasks',
    steps: [{ id: 'd1', title: 'draft step', tasks: [{ key: 'k1', title: 'Draft task', acceptance: [{ text: 'x' }] }] }],
  }, exec);
  assert.equal(draft.ok, true);
  assert.equal(draft.plan.status, 'draft');
  assert.equal(draft.plan.version, 0);
  const draftId = draft.plan.id;
  const draftView = await boardTool.execute({ view: 'plan', planId: draftId }, exec);
  assert.equal(draftView.plan.status, 'draft');
  assert.equal(draftView.steps.length, 1);
  const renamed = await planTool.execute({ op: 'rename', planId: draftId, expectedRev: 1, title: 'Draft plan renamed' }, exec);
  assert.equal(renamed.plan.title, 'Draft plan renamed');
  const publishedDraft = await planTool.execute({ op: 'publish', planId: draftId, expectedRev: 2 }, exec);
  assert.equal(publishedDraft.plan.status, 'published');
  assert.equal(publishedDraft.steps[0].tasks.length, 1);

  const loose = await taskTool.execute({ op: 'create', title: 'Loose task', acceptance: [{ text: 'x' }] }, exec);
  const looseId = loose.task.task.id;
  const adopted = await planTool.execute({ op: 'adopt', planId: draftId, baseVersion: 1, taskIds: [looseId], stepId: 'd1' }, exec);
  assert.equal(adopted.ok, true);
  assert.equal(adopted.plan.version, 2);
  const released = await planTool.execute({ op: 'release', planId: draftId, baseVersion: 2, taskIds: [looseId] }, exec);
  assert.equal(released.plan.version, 3);

  const plansView = await boardTool.execute({ view: 'plans' }, exec);
  assert.equal(plansView.ok, true);
  assert.ok(plansView.plans.length >= 2, 'multiple plans are listed');
  assert.ok(plansView.plans.some((plan) => plan.status === 'active'));
  assert.ok(plansView.focusPlanId);
  const plansText = boardTool.output.render({ view: 'plans' }, plansView)[0].text;
  assert.ok(plansText.includes(draftId), 'plans render includes plan id');
  const boardPlans = await boardTool.execute({ view: 'board' }, exec);
  assert.ok(Array.isArray(boardPlans.plans));
  assert.equal(boardPlans.focusPlanId, plansView.focusPlanId);

  const archived = await planTool.execute({ op: 'archive', planId: draftId, expectedRev: 5 }, exec);
  assert.equal(archived.head.status, 'archived');
  const unarchived = await planTool.execute({ op: 'unarchive', planId: draftId, expectedRev: 6 }, exec);
  assert.equal(unarchived.head.status, 'active');
  const focusDenied = await planTool.execute({ op: 'focus', planId: draftId }, exec).then(() => null, (error) => error);
  assert.ok(focusDenied);
  assert.equal(focusDenied.code, 'forbidden-role');

  // 分段职责：多计划错误须按契约返回，工具层不能吞掉版本/归属冲突。
  // plan v2 error codes through the tool surface (T1)
  const toolPlanId = published.plan.id;
  const reviseNoPlan = await planTool.execute({ op: 'revise', title: 'x' }, exec).then(() => null, (error) => error);
  assert.ok(reviseNoPlan);
  assert.equal(reviseNoPlan.code, 'invalid-command', 'revise without planId is refused');
  const draftTaskId = publishedDraft.steps[0].tasks[0].id;
  const staleRevise = await planTool.execute({
    op: 'revise', planId: draftId, baseVersion: 1,
    steps: [{ id: 'd1', title: 'd1', tasks: [{ key: 'k1', taskId: draftTaskId, title: 'x', acceptance: [{ text: 'x' }] }] }],
  }, exec).then(() => null, (error) => error);
  assert.equal(staleRevise.code, 'stale-revision');
  assert.equal(JSON.parse(staleRevise.message).details.currentVersion, 3, 'the wrapped error carries the current version');
  const publishActiveErr = await planTool.execute({ op: 'publish', planId: draftId, expectedRev: 6 }, exec).then(() => null, (error) => error);
  assert.equal(publishActiveErr.code, 'plan-not-draft');
  const adoptBadStep = await planTool.execute({ op: 'adopt', planId: draftId, baseVersion: 3, stepId: 'nope', taskIds: [looseId] }, exec).then(() => null, (error) => error);
  assert.equal(adoptBadStep.code, 'plan-step-not-found');
  const adoptForeign = await planTool.execute({ op: 'adopt', planId: draftId, baseVersion: 3, stepId: 'd1', taskIds: [taskId] }, exec).then(() => null, (error) => error);
  assert.equal(adoptForeign.code, 'plan-task-in-use');
  const releaseForeignErr = await planTool.execute({ op: 'release', planId: draftId, baseVersion: 3, taskIds: [taskId] }, exec).then(() => null, (error) => error);
  assert.equal(releaseForeignErr.code, 'invalid-command');
  const titleTaken = await planTool.execute({ op: 'create', title: 'Tool plan' }, exec).then(() => null, (error) => error);
  assert.equal(titleTaken.code, 'plan-title-taken');
  // 分段职责：草案修订须校验 expectedRev 并只推进 head，不物化新版本。
  // draft revise path: expectedRev CAS, no version bump
  const draft2 = await planTool.execute({ op: 'create', title: 'Draft two' }, exec);
  const draft2Id = draft2.plan.id;
  const draftRevise = await planTool.execute({ op: 'revise', planId: draft2Id, expectedRev: 1, title: 'Draft two renamed', goal: 'g2' }, exec);
  assert.equal(draftRevise.plan.title, 'Draft two renamed');
  assert.equal(draftRevise.plan.version, 0, 'a draft revise never creates a version');
  // 分段职责：有活工作不能归档，成功归档后列表仍须保留对应 head。
  // archive refuses live work, and the plans view keeps the archived head
  const claimedDraftTask = await taskTool.execute({ op: 'claim', taskId: draftTaskId, expectedRev: 1 }, exec);
  assert.equal(claimedDraftTask.ok, true);
  const archiveLiveErr = await planTool.execute({ op: 'archive', planId: draftId, expectedRev: 7 }, exec).then(() => null, (error) => error);
  assert.equal(archiveLiveErr.code, 'plan-has-live-work');
  const releasedDraftTask = await taskTool.execute({
    op: 'release', taskId: draftTaskId, expectedRev: claimedDraftTask.task.task.rev, fencingToken: claimedDraftTask.task.lease.token,
  }, exec);
  assert.equal(releasedDraftTask.ok, true);
  const archivedAgain = await planTool.execute({ op: 'archive', planId: draftId, expectedRev: 7 }, exec);
  assert.equal(archivedAgain.head.status, 'archived');
  const plansWithArchived = await boardTool.execute({ view: 'plans' }, exec);
  assert.ok(plansWithArchived.plans.length >= 3, 'plans view lists draft + active + archived');
  assert.ok(plansWithArchived.plans.some((plan) => plan.status === 'archived'));
  assert.equal(plansWithArchived.focusPlanId, toolPlanId, 'denied agent focus never changed the focus');
  const unarchivedAgain = await planTool.execute({ op: 'unarchive', planId: draftId, expectedRev: 8 }, exec);
  assert.equal(unarchivedAgain.head.status, 'active');

  const emptyWs = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-empty-'));
  const emptyExec = { agent: { id: 'session-empty-test', session: { header: { cwd: emptyWs } } }, callId: 'call-empty' };
  const sessionTool = tools.get('project_session');
  const init = await sessionTool.execute({ op: 'init', name: 'Empty board' }, emptyExec);
  assert.equal(init.ok, true);
  assert.equal(init.project.name, 'Empty board');
  const emptyBoard = await boardTool.execute({ view: 'board' }, emptyExec);
  assert.equal(emptyBoard.columns.ready.length, 0);
  assert.equal(emptyBoard.counts.total, 0);
  assert.equal(emptyBoard.plan, null);
  const gate = await taskTool.execute({ op: 'create', title: 'Gate task', acceptance: [{ text: 'x' }], requiresAudit: true }, emptyExec);
  assert.equal(gate.ok, true);
  assert.equal(gate.task.task.requiresAudit, true);
  assert.ok(gate.task.task.labels.includes('gate:audit'));
  const gateOff = await taskTool.execute({ op: 'gate', taskId: gate.task.task.id, expectedRev: 1, requiresAudit: false }, emptyExec).then(() => null, (reason) => reason);
  assert.ok(gateOff);
  assert.equal(gateOff.code, 'forbidden-role');

  const docTool = tools.get('project_doc');
  const put = await docTool.execute({ op: 'put', title: 'Runbook', kind: 'runbook', body: '# hello\nworld' }, exec)
    .then(() => null, (reason) => reason);
  assert.equal(put.code, 'inline-write-disabled');
  const docId = seededDocId;
  const got = await docTool.execute({ op: 'get', docId }, exec);
  assert.equal(got.ok, true);
  assert.ok(got.body.includes('seeded'));

  // 分段职责：同版本重复读取须去重并缩短上下文，新写入后不得沿用旧摘要。
  // ---- context-cost dedupe (CONTRACT §3.4.2)
  const plainText = taskTool.output.render({ op: 'create', title: 'Loose task' }, loose)[0].text;
  assert.ok(!plainText.includes('audit:'), 'the default gate is no longer printed on every task render');
  assert.ok(plainText.includes('lease:'), 'lease line kept');
  assert.ok(plainText.includes('evidence:'), 'evidence line kept');
  assert.ok(plainText.includes('allowed:'), 'allowed line kept');
  const gatedTask = await taskTool.execute({ op: 'create', title: 'Gated task', acceptance: [{ text: 'x' }], requiresAudit: true }, exec);
  const gatedText = taskTool.output.render({ op: 'create' }, gatedTask)[0].text;
  assert.ok(gatedText.includes('audit=1: human or independent agent acceptance required'), 'a human gate still prints');

  const hasRules = (text) => text.split(String.fromCharCode(10)).some((line) => line.trim() === 'RULES');
  const withSection = {
    id: 'session-with-section',
    session: { header: { cwd: wsDir } },
    ctx: { inject() { return { dispose() {} }; } },
  };
  for (const handler of eventHandlers.get('agent/created') || []) await handler({ agent: withSection, source: 'test' });
  const briefPlain = await boardTool.execute({ view: 'brief' }, exec);
  const briefLean = await boardTool.execute({ view: 'brief' }, { agent: withSection, callId: 'call-with-section' });
  assert.ok(hasRules(briefPlain.digest), 'a session without the prompt section still gets the rules');
  assert.ok(!hasRules(briefLean.digest), 'a session with the prompt section does not get a second copy');
  assert.ok(briefLean.digest.includes('Project:') && briefLean.digest.includes('SESSION'), 'the rest of the digest survives');

  const dedupeMarker = await taskTool.execute({ op: 'create', title: 'Board dedupe marker', acceptance: [{ text: 'x' }] }, exec);
  assert.equal(dedupeMarker.ok, true);
  const firstBoard = await boardTool.execute({ view: 'board' }, exec);
  const firstText = boardTool.output.render({ view: 'board' }, firstBoard)[0].text;
  assert.ok(firstText.includes('Board dedupe marker'), 'the first read after a change prints in full');
  const secondBoard = await boardTool.execute({ view: 'board' }, exec);
  const secondText = boardTool.output.render({ view: 'board' }, secondBoard)[0].text;
  assert.match(secondText, /^board rev \d+ unchanged since \d+/, 'an unchanged board collapses to one line');
  assert.ok(secondText.length <= 64, 'the stand-in line stays short: ' + secondText.length);
  assert.ok(!secondText.includes('Board dedupe marker'), 'the stand-in carries no card text');
  const freshBoard = await boardTool.execute({ view: 'board', fresh: true }, exec);
  const freshText = boardTool.output.render({ view: 'board', fresh: true }, freshBoard)[0].text;
  assert.ok(freshText.includes('Board dedupe marker'), 'fresh=true always reprints the full view');
  const changedBoard = await taskTool.execute({ op: 'create', title: 'Board changed again', acceptance: [{ text: 'x' }] }, exec);
  assert.equal(changedBoard.ok, true);
  const thirdBoard = await boardTool.execute({ view: 'board' }, exec);
  const thirdText = boardTool.output.render({ view: 'board' }, thirdBoard)[0].text;
  assert.ok(thirdText.includes('Board changed again'), 'a changed board prints in full again');

  // 分段职责：走真实工具到 core 完成第三方审计流程，而非仅检查传参替身。
  // Audit gate: exercise the real tool -> core path, not just payload stubs.
  const auditor = { agent: { id: 'session-independent-auditor', session: { header: { cwd: wsDir } } }, callId: 'audit-call' };
  const audit = { report: 'Independently reviewed the submitted note and acceptance scope; no evidence command was executed.', checklist: [{ item: 'Scope and submitted material', ok: true }] };
  const auditCreated = await taskTool.execute({ op: 'create', title: 'Audit lifecycle', acceptance: [{ text: 'record' }], requiresAudit: true }, exec);
  const auditId = auditCreated.task.task.id;
  const auditClaimed = await taskTool.execute({ op: 'claim', taskId: auditId, expectedRev: auditCreated.task.task.rev }, exec);
  const auditBegun = await taskTool.execute({ op: 'begin', taskId: auditId, expectedRev: auditClaimed.task.task.rev, fencingToken: auditClaimed.task.lease.token, summary: 'record synthetic material' }, exec);
  const auditSubmitted = await taskTool.execute({ op: 'submit', taskId: auditId, expectedRev: auditBegun.task.task.rev, fencingToken: auditClaimed.task.lease.token, evidence: [{ kind: 'note', ref: 'synthetic note', acceptanceId: auditBegun.task.task.acceptance[0].id }] }, exec);
  assert.equal(auditSubmitted.task.task.state, 'review');
  const auditView = await boardTool.execute({ view: 'task', taskId: auditId }, auditor);
  assert.equal(auditView.allowedOps.find(row => row.op === 'verify').enabled, true);
  assert.equal(auditView.allowedOps.find(row => row.op === 'gate').enabled, false, 'review agent cannot enable or disable gate');
  const selfDenied = await taskTool.execute({ op: 'verify', taskId: auditId, expectedRev: auditSubmitted.task.task.rev, audit }, exec).then(() => null, error => error);
  assert.equal(JSON.parse(selfDenied.message).details.reason, 'not-independent');
  const flagsDenied = await taskTool.execute({ op: 'verify', taskId: auditId, expectedRev: auditSubmitted.task.task.rev, audit, refreshDrift: false }, auditor).then(() => null, error => error);
  assert.equal(JSON.parse(flagsDenied.message).details.reason, 'drift-human-only');
  const verifiedAudit = await taskTool.execute({ op: 'verify', taskId: auditId, expectedRev: auditSubmitted.task.task.rev, audit }, auditor);
  assert.equal(verifiedAudit.task.task.state, 'done');
  assert.equal(verifiedAudit.task.task.lastAudit.by.kind, 'agent');
  assert.equal(verifiedAudit.task.task.lastAudit.taskRev, verifiedAudit.task.task.rev);
  const auditText = taskTool.output.render({ op: 'verify' }, verifiedAudit)[0].text;
  assert.match(auditText, /AI审计（自述）/);
  assert.match(auditText, /by.kind=agent/);
  const unassignDenied = await taskTool.execute({ op: 'reject', taskId, expectedRev: submitted.task.task.rev, reason: 'rework synthetic evidence', unassign: true }, auditor).then(() => null, error => error);
  assert.equal(JSON.parse(unassignDenied.message).details.reason, 'unassign-human-only');
  const rejectedAudit = await taskTool.execute({ op: 'reject', taskId, expectedRev: submitted.task.task.rev, reason: 'rework synthetic evidence', audit }, auditor);
  assert.equal(rejectedAudit.task.task.rejection.byKind, 'agent');
  assert.equal(rejectedAudit.task.task.lastAudit.verdict, 'fail');
  assert.equal(rejectedAudit.task.task.lastAudit.by.sessionId, auditor.agent.id);

  const ordinaryClaimed = rejectedAudit.task.lease ? rejectedAudit
    : await taskTool.execute({ op: 'claim', taskId, expectedRev: rejectedAudit.task.task.rev }, exec);
  const fencingToken = ordinaryClaimed.task.lease.token;
  const ordinaryBegun = await taskTool.execute({ op: 'begin', taskId, expectedRev: ordinaryClaimed.task.task.rev, fencingToken, summary: 'ordinary rework' }, exec);
  const ordinarySubmitted = await taskTool.execute({ op: 'submit', taskId, expectedRev: ordinaryBegun.task.task.rev, fencingToken,
    evidence: [{ kind: 'note', ref: 'reworked evidence', acceptanceId: ordinaryBegun.task.task.acceptance[0].id }] }, exec);
  const verifiedOrdinary = await taskTool.execute({ op: 'verify', taskId, expectedRev: ordinarySubmitted.task.task.rev }, exec);
  assert.equal(verifiedOrdinary.task.task.state, 'done');
  assert.equal(verifiedOrdinary.task.task.lastAudit.by.sessionId, exec.agent.id);
  assert.match(taskTool.output.render({ op: 'verify' }, verifiedOrdinary)[0].text, /AI验收（自述）/);

  console.log('PASS host-tools: plan/claim/begin/submit/board/doc/audit/agent-reject');
} finally {
  for (const dispose of disposers) { try { dispose(); } catch { /* ignore */ } }
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(wsDir, { recursive: true, force: true });
}
