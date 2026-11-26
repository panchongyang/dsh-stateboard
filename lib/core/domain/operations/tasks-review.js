import { BoardError } from '../../errors.js';
import { isExternal } from '../../documents/external-model.js';
import { applyRetainedVersionEvent } from '../workspace-record.js';
import { retainVersion } from './documents-workspace.js';
import { isAuditGate, makeAuditRecord, normalizeAudit, verificationRoleProblem } from '../../audit.js';
import { actorRef } from '../../intent.js';
import { touchTask } from '../../model.js';
import { policyOf } from '../../normalize.js';
import { openIntentFor, taskDepsSatisfied } from '../task-facts.js';
import { assertTaskSubmit, assertTaskVerify, readyTask, reconcileCompletedTask, submitTask, verifyTask } from '../task-transitions.js';
import { closeRecoveredWork, closeSubmittedWork, evidenceForReview, refreshTaskFiles } from '../work-transitions.js';
import { assertNoOpenIntent, assertRecoveryAuthority, changedTask, clearTaskTransition, currentIntent, invalidOperation, modelTask,
  pendingTaskTransition, requireHuman, requireTaskParticipant, stageTaskTransition, taskEvent, workEvent } from './tasks-primitives.js';

const submittedDraft = Symbol('staged submission evidence');
const recoveredDraft = Symbol('staged recovered evidence');
const releaseAfterReview = Symbol('release submitted lease');
const refreshDraft = Symbol('human file refresh');
const verifiedTask = Symbol('verified task pending dependent promotion');

function readWarnings(warnings) {
  if (!Array.isArray(warnings) || warnings.some(warning => !warning || typeof warning !== 'object' || Array.isArray(warning))) {
    throw invalidOperation('operation requires evidence audit observations');
  }
  return structuredClone(warnings);
}

function attachWorkspaceVersions(work, materials, captures) {
  if (!Array.isArray(captures)) throw invalidOperation('review requires capture observations');
  // Plan multiple independent retentions against one provisional ledger; the
  // real transaction applies these events only when review can also commit.
  const state = { ...work.state, workspaceVersions: { ...work.state.workspaceVersions }, counters: { ...work.state.counters } };
  const events = [];
  const versions = new Map();
  for (const sample of captures) {
    if (!sample || typeof sample !== 'object' || Object.keys(sample).sort().join(',') !== 'contentHash,docId,size') {
      throw invalidOperation('invalid workspace capture observation');
    }
    const { docId, contentHash, size } = sample;
    const doc = state.docs[docId];
    if (!isExternal(doc) || doc.unregistered || versions.has(docId)
      || !materials.some(row => row.kind === 'doc' && row.ref === docId && row.hash === contentHash && !row.fixedState)) {
      throw invalidOperation('workspace capture must describe an observed evidence document');
    }
    const retention = retainVersion({ state, clock: work.clock }, { docId, locator: doc.locator, contentHash, size });
    for (const event of retention.events) applyRetainedVersionEvent(state, event);
    versions.set(docId, retention.result.versionRef);
    events.push(...retention.events);
  }
  return { events, materials: materials.map(row => {
    if (Object.hasOwn(row, 'workspaceVersion')) throw invalidOperation('review evidence version is assigned from its capture');
    if (row.kind !== 'doc' || row.fixedState || !isExternal(state.docs[row.ref])) return row;
    const workspaceVersion = versions.get(row.ref);
    if (!workspaceVersion || row.hash !== workspaceVersion.contentHash) throw invalidOperation('external evidence requires workspace capture or explicit current-only state');
    return { ...row, workspaceVersion };
  }) };
}

function stageReview(work, task, facts, actor, phase, stage, settlement) {
  if (!Array.isArray(facts.materials) || facts.materials.some(item => !item || typeof item !== 'object' || Array.isArray(item))
      || !facts.fileIdentities || typeof facts.fileIdentities !== 'object' || Array.isArray(facts.fileIdentities)) {
    throw invalidOperation('review requires evidence materials and file identities');
  }
  const at = work.clock().toISOString();
  const { materials, events } = attachWorkspaceVersions(work, facts.materials, facts.captures);
  const { next } = evidenceForReview(task, materials, facts.fileIdentities, at, actor);
  const warnings = readWarnings(facts.warnings);
  const hard = warnings.filter(warning => warning.severity === 'error');
  if (hard.length) throw new BoardError('evidence-drift', 'evidence failed the pre-review audit: ' + hard.map(warning => warning.code).join(', '), {
    status: 409, details: { warnings: hard, stage, canAcknowledgeDrift: false, canRefresh: false },
  });
  stageTaskTransition(work, phase, task, { evidence: next.evidence, acceptance: next.acceptance, warnings, ...settlement });
  return { events };
}

function requireReviewDraft(work, phase) {
  const draft = pendingTaskTransition(work);
  if (draft?.phase !== phase) {
    throw invalidOperation('review requires staged evidence for this task revision');
  }
  return draft;
}

function takeReviewDraft(work, task, phase) {
  const { evidence, acceptance, warnings } = requireReviewDraft(work, phase);
  clearTaskTransition(work);
  return { next: { ...structuredClone(task), evidence, acceptance }, warnings };
}

function stageSubmission(work, { taskId, materials, fileIdentities, captures, warnings }, request) {
  const task = modelTask(work, taskId, request);
  requireTaskParticipant(request.actor);
  const lease = work._assertLease(task, request);
  assertTaskSubmit(task);
  const intent = openIntentFor(work.state, task.id);
  if (policyOf(work.state.project).requireIntentFor === 'all' && !intent) {
    throw new BoardError('illegal-transition', 'begin an intent before submitting', { status: 409 });
  }
  if (!Array.isArray(materials) || !materials.length) throw new BoardError('missing-evidence', 'submit requires at least one evidence item', { status: 422 });
  return stageReview(work, task, { materials, fileIdentities, captures, warnings }, request.actor, submittedDraft, 'submit', { intentId: intent?.id ?? null, token: lease.token, settled: false });
}

function completeSubmission(work, { taskId, intentId }, request) {
  const task = modelTask(work, taskId, request, { phase: submittedDraft });
  requireTaskParticipant(request.actor);
  const lease = work._assertLease(task, request);
  assertTaskSubmit(task);
  const draft = requireReviewDraft(work, submittedDraft);
  const intent = currentIntent(work, task, intentId);
  if (draft.intentId !== intent.id || draft.token !== lease.token || draft.settled) {
    throw invalidOperation('submission must settle the attempt for the staged lease');
  }
  if (intent.token !== lease.token) {
    throw new BoardError('fencing-stale', 'open intent belongs to a different lease generation', { status: 409 });
  }
  draft.settled = true;
  return { events: [workEvent('result', closeSubmittedWork(intent, lease, work.clock().toISOString()))] };
}

function enterReviewFromWork(work, { taskId }, request) {
  const task = modelTask(work, taskId, request, { phase: submittedDraft });
  const lease = work._assertLease(task, request);
  assertTaskSubmit(task);
  assertNoOpenIntent(work, task);
  const draft = requireReviewDraft(work, submittedDraft);
  if (draft.token !== lease.token || (draft.intentId !== null && !draft.settled)) {
    throw invalidOperation('review requires settlement of the staged work attempt');
  }
  const { next, warnings } = takeReviewDraft(work, task, submittedDraft);
  submitTask(next);
  const result = changedTask('submitted', next, work.clock().toISOString());
  stageTaskTransition(work, releaseAfterReview, next, { token: lease.token });
  return { ...result, warnings };
}

function releaseSubmittedWork(work, { taskId }, request) {
  const task = modelTask(work, taskId, request, { checkRev: false, phase: releaseAfterReview });
  const lease = work._assertLease(task, request);
  const pending = pendingTaskTransition(work);
  if (pending?.phase !== releaseAfterReview || pending.token !== lease.token || task.state !== 'review' || task.owner) {
    throw invalidOperation('lease release requires this transaction to submit the held task');
  }
  clearTaskTransition(work);
  // Historical task/submitted is the durable indication of release, not a second revoke event.
  work.leases.delete(task.id);
  return { memoryOnly: true };
}

function stageRecoveredWork(work, { taskId, materials, fileIdentities, captures, warnings, note }, request) {
  const task = modelTask(work, taskId, request);
  assertRecoveryAuthority(work, task, request);
  if (typeof note !== 'string' || !note.trim()) throw invalidOperation('reconcile requires a note');
  const intent = openIntentFor(work.state, task.id);
  return stageReview(work, task, { materials, fileIdentities, captures, warnings }, request.actor, recoveredDraft, 'reconcile', { intentId: intent?.id ?? null, note });
}

function enterReviewFromRecovery(work, { taskId }, request) {
  const task = modelTask(work, taskId, request, { phase: recoveredDraft });
  assertRecoveryAuthority(work, task, request);
  const { intentId, note } = requireReviewDraft(work, recoveredDraft);
  const { next, warnings } = takeReviewDraft(work, task, recoveredDraft);
  const at = work.clock().toISOString();
  const actor = request.actor;
  const before = [];
  if (intentId === null) assertNoOpenIntent(work, task);
  else before.push(workEvent('result', closeRecoveredWork(currentIntent(work, task, intentId), note, actorRef(actor), at)));
  const held = work._leaseOf(task.id);
  const assignee = actor?.sessionId
    ? { sessionId: actor.sessionId, agentId: actor.agentId || actor.sessionId, epoch: held ? held.epoch : null, at, cause: 'reconcile' }
    : null;
  reconcileCompletedTask(next, assignee);
  return { ...changedTask('reconciled', next, at, before), warnings };
}

function stageHumanRefresh(work, { taskId, observations, reason }, request) {
  requireHuman(request.actor, 'drift refresh');
  const task = modelTask(work, taskId, request);
  assertTaskVerify(task);
  if (typeof reason !== 'string' || reason.trim().length < 4) throw invalidOperation('refreshDrift requires a reason (at least 4 characters)');
  if (!Array.isArray(observations) || !observations.length) throw invalidOperation('file refresh requires fresh observations');
  const { next, refreshed } = refreshTaskFiles(task, observations, work.clock().toISOString(), request.actor);
  stageTaskTransition(work, refreshDraft, task, { evidence: next.evidence, acceptance: next.acceptance, refreshed, reason });
  return {};
}

function acceptReview(work, { taskId, audit, warnings, reason, note, acknowledgeDrift }, request) {
  const task = modelTask(work, taskId, request, { phase: refreshDraft });
  assertTaskVerify(task);
  const actor = request.actor;
  const problem = verificationRoleProblem(task, actor);
  if (problem) throw new BoardError('forbidden-role', 'verification requires a human or an authorized agent; audit gates require independence', { status: 403, details: { reason: problem } });
  assertNoOpenIntent(work, task);
  if (work._leaseOf(task.id)) throw new BoardError('illegal-transition', 'verification requires review without a live lease', { status: 409 });
  if (!task.acceptance.every(item => item.met)) throw new BoardError('acceptance-unmet', 'acceptance is not fully met', { status: 422 });
  const human = actor.kind === 'human';
  if (!human && acknowledgeDrift === true) throw new BoardError('forbidden-role', 'drift acknowledgement is human only', { status: 403, details: { reason: 'drift-human-only' } });
  const payload = normalizeAudit(audit ?? undefined, { required: !human && isAuditGate(task) });
  const observed = readWarnings(warnings);
  const errors = observed.filter(warning => warning.severity === 'error');
  const at = work.clock().toISOString();
  const by = actor.sessionId || actor.via || 'human';
  const next = structuredClone(task);
  const refreshed = pendingTaskTransition(work);
  if (refreshed) {
    next.evidence = refreshed.evidence;
    next.acceptance = refreshed.acceptance;
    clearTaskTransition(work);
  }
  if (errors.length && (!human || acknowledgeDrift !== true)) throw new BoardError('evidence-drift', 'evidence no longer matches the workspace; fix or re-submit before verify', { status: 409, details: { warnings: errors } });
  if (errors.length && (typeof reason !== 'string' || reason.trim().length < 4)) throw invalidOperation('acknowledgeDrift requires a reason (at least 4 characters)');
  verifyTask(next, at, human ? 'human' : 'agent');
  next.waivedDrift = errors.length ? { at, by, reason,
    warnings: errors.map(({ evidenceId, code, message }) => ({ evidenceId, code, message })),
  } : null;
  next.refreshedDrift = refreshed ? { at, by, reason: refreshed.reason, items: refreshed.refreshed } : null;
  touchTask(next, at);
  next.lastAudit = makeAuditRecord(next, actor, at, 'pass', payload || { report: reason || String(note || '').trim() }, observed, work.newId);
  stageTaskTransition(work, verifiedTask, next);
  return { events: [taskEvent('verified', next)], entityRev: next.rev, warnings: observed };
}

function promoteVerifiedDependents(work, { taskId }, request) {
  const verified = modelTask(work, taskId, request, { checkRev: false, phase: verifiedTask });
  const pending = pendingTaskTransition(work);
  if (verified.state !== 'done' || pending?.phase !== verifiedTask) {
    throw invalidOperation('dependent promotion requires this transaction to complete verification');
  }
  clearTaskTransition(work);
  const at = work.clock().toISOString();
  const events = [];
  // Verification historically rechecks all backlog entries, including legacy
  // tasks that already satisfied their dependencies before this verification.
  for (const task of Object.values(work.state.tasks)) {
    if (task.state !== 'backlog' || !taskDepsSatisfied(work.state, task) || !task.acceptance?.length) continue;
    events.push(...changedTask('readied', readyTask(structuredClone(task)), at).events);
  }
  return { events };
}

export const TASK_REVIEW_OPERATIONS = Object.freeze({
  'evidence.stageSubmission': stageSubmission,
  'work.completeSubmission': completeSubmission,
  'task.enterReviewFromWork': enterReviewFromWork,
  'lease.releaseSubmittedWork': releaseSubmittedWork,
  'evidence.stageRecoveredWork': stageRecoveredWork,
  'task.enterReviewFromRecovery': enterReviewFromRecovery,
  'evidence.stageHumanRefresh': stageHumanRefresh,
  'task.acceptReview': acceptReview,
  'task.promoteVerifiedDependents': promoteVerifiedDependents,
});
