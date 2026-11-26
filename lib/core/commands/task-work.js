// Observe evidence at the command boundary; request narrowly named model actions.
import { BoardError } from '../errors.js';
import { openIntentFor } from '../domain/task-facts.js';
import { assertTaskBegin, assertTaskSubmit, assertTaskVerify, assertTaskReject } from '../domain/task-transitions.js';
import { refreshTaskFiles } from '../domain/work-transitions.js';
import { beginDecision, submissionDecision, verificationDecision, assertDriftDecision, rejectionDecision } from '../business/task-policy.js';
import { normalizeAudit } from '../audit.js';
import { policyOf } from '../normalize.js';
import { stoppedIntent } from './task-gov.js';
import { observeReviewEvidence } from './task-evidence.js';
import { requireTaskParticipant } from '../domain/task-authority.js';

export function taskClaim(read, cmd) {
  const task = read._requireTask(cmd);
  read._assertClaimAllowed(task, cmd);
  return { operations: [{ kind: 'task.claimReadyWork', args: { taskId: task.id } }] };
}

export function taskRenew(read, cmd) {
  const task = read._requireTask(cmd);
  return { operations: [{ kind: 'lease.extendHeldTask', args: { taskId: task.id } }] };
}

export function taskBegin(read, cmd) {
  const task = read._requireTask(cmd);
  read._assertRev(task, cmd);
  read._assertLease(task, cmd);
  assertTaskBegin(task);
  const { summary } = beginDecision(openIntentFor(read.state, task.id), cmd.summary);
  const intentId = read.newId('int');
  const args = { taskId: task.id, intentId };
  return { operations: [
    { kind: 'work.openAttempt', args: { ...args, summary, plannedSteps: cmd.plannedSteps, expectedArtifacts: cmd.expectedArtifacts } },
    { kind: 'task.beginAttempt', args },
  ] };
}

export function taskSubmit(read, cmd) {
  const task = read._requireTask(cmd);
  requireTaskParticipant(cmd.actor);
  read._assertRev(task, cmd);
  read._assertLease(task, cmd);
  assertTaskSubmit(task);
  const intent = openIntentFor(read.state, task.id);
  const { rawEvidence } = submissionDecision(intent, policyOf(read.state.project), cmd.evidence);
  const review = observeReviewEvidence(read, task, rawEvidence, cmd.actor, 'submit');
  const args = { taskId: task.id };
  return { operations: [
    { kind: 'evidence.stageSubmission', args: { ...args, ...review } },
    ...(intent ? [{ kind: 'work.completeSubmission', args: { ...args, intentId: intent.id } }] : []),
    { kind: 'task.enterReviewFromWork', args },
    { kind: 'lease.releaseSubmittedWork', args },
  ] };
}

function observeRefreshedFiles(read, task, drift, at, actor) {
  const groups = new Map();
  for (const warning of drift) {
    const row = task.evidence.find(item => item.id === warning.evidenceId);
    if (!row) continue;
    const key = (read.evidence.identity(row) || row.ref) + '|' + (row.acceptanceId || '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map(rows => {
    const first = rows[0];
    const observed = read.evidence.normalize(task, {
      kind: 'file', ref: first.ref, acceptanceId: first.acceptanceId || undefined, summary: first.summary,
    }, at, actor);
    return { newEvidenceId: observed.id, hash: observed.hash, evidenceIds: rows.map(row => row.id) };
  });
}

export function taskVerify(read, cmd) {
  const task = read._requireTask(cmd);
  read._assertRev(task, cmd);
  assertTaskVerify(task);
  const { payload } = verificationDecision(task, cmd);
  const at = read.clock().toISOString();
  const reason = typeof cmd.reason === 'string' ? cmd.reason.trim() : '';
  const audit = read.evidence.audit(task);
  const drift = audit.filter(warning => warning.severity === 'error' && warning.code === 'file-drift');
  let observations = [];
  if (cmd.refreshDrift === true && drift.length) {
    if (reason.length < 4) throw new BoardError('invalid-command', 'refreshDrift requires a reason (at least 4 characters)', { status: 400 });
    observations = observeRefreshedFiles(read, task, drift, at, cmd.actor);
  }
  const warnings = observations.length ? read.evidence.audit(refreshTaskFiles(task, observations, at, cmd.actor).next) : audit;
  assertDriftDecision(warnings, cmd, reason);
  const args = { taskId: task.id };
  return { operations: [
    ...(observations.length ? [{ kind: 'evidence.stageHumanRefresh', args: { ...args, observations, reason } }] : []),
    { kind: 'task.acceptReview', args: { ...args, reason, warnings, audit: payload, note: cmd.note, acknowledgeDrift: cmd.acknowledgeDrift === true } },
    { kind: 'task.promoteVerifiedDependents', args },
  ] };
}

export function taskReject(read, cmd) {
  const task = read._requireTask(cmd);
  read._assertRev(task, cmd);
  assertTaskReject(task);
  const lease = read._leaseOf(task.id);
  const { reason, isHuman } = rejectionDecision(cmd, lease);
  if (!isHuman && lease) read._assertLease(task, cmd);
  if (cmd.unassign === true && !isHuman) throw new BoardError('forbidden-role', 'only a human can unassign on reject', { status: 403, details: { reason: 'unassign-human-only' } });
  const audit = normalizeAudit(cmd.audit);
  return { operations: [
    { kind: 'task.returnReviewToWork', args: { taskId: task.id, reason, audit, stopped: stoppedIntent(read, cmd, task, 'rejected'), unassign: cmd.unassign === true } },
  ] };
}
