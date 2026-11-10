// Task work: claim, begin, submit, verify and reject.
//
// Submission is the one path that normalizes evidence; it stays a thin call into
// evidence.js through the handle. Event order (intent/result, lease, task) is frozen.

import { BoardError } from '../errors.js';
import { assignmentEvent, leaseGrantedEvent, leaseRevokedEvent } from '../contracts.js';
import { cascadeReady, clone, openIntentFor, touchTask } from '../model.js';
import { newId } from '../util.js';
import { appendWorker, isAuditGate, makeAuditRecord, normalizeAudit, verificationRoleProblem } from '../audit.js';
import { policyOf } from '../normalize.js';
import { assertClaimAllowed } from '../lease.js';
import { settleOpenIntent } from '../intent.js';
import { fixedEvents } from '../documents/fixed-auto.js';
import { assertEvidenceReadyForReview, auditEvidence, assertAcceptanceEvidence, evidenceIdentity, supersedeResubmitted } from '../evidence.js';

export function taskClaim(handle, cmd) {
  const task = handle._requireTask(cmd);
  assertClaimAllowed(handle, task, cmd);
  const at = new Date().toISOString();
  const lease = handle._grantLease(task, cmd.actor || {}, at);
  const next = clone(task);
  next.state = 'in_progress';
  next.owner = { sessionId: lease.sessionId, agentId: lease.agentId, epoch: lease.epoch, fencingToken: lease.token, leaseUntil: lease.expiresAt };
  next.assignee = { sessionId: lease.sessionId, agentId: lease.agentId, epoch: lease.epoch, at, cause: 'claim' };
  appendWorker(next, lease, at, 'claim');
  next.work = null;
  touchTask(next, at);
  return {
    events: [
      leaseGrantedEvent(lease),
      { type: 'task/claimed', taskId: next.id, rev: next.rev, data: next },
    ],
    entityRev: next.rev,
  };
}

export function taskBegin(handle, cmd) {
  const task = handle._requireTask(cmd);
  handle._assertRev(task, cmd);
  const lease = handle._assertLease(task, cmd);
  if (task.state !== 'in_progress') throw new BoardError('illegal-transition', 'task is ' + task.state, { status: 409 });
  if (openIntentFor(handle.state, task.id)) throw new BoardError('illegal-transition', 'an intent is already open', { status: 409 });
  const summary = typeof cmd.summary === 'string' ? cmd.summary.trim() : '';
  if (summary === '') throw new BoardError('invalid-command', 'begin requires a summary', { status: 400 });
  handle._markLeaseProgress(task.id);
  const at = new Date().toISOString();
  const intent = {
    id: newId('int'),
    taskId: task.id,
    token: lease.token,
    summary,
    plannedSteps: Array.isArray(cmd.plannedSteps) ? cmd.plannedSteps.map(String) : [],
    expectedArtifacts: Array.isArray(cmd.expectedArtifacts) ? cmd.expectedArtifacts.map(String) : [],
    status: 'open',
    attempt: (task.work?.attempt || 0) + 1,
    startedAt: at,
    actor: cmd.actor || {},
  };
  const next = clone(task);
  // A new explicit attempt supersedes evidence from earlier attempts: keep the
  // history, but audits/auto-verify must judge only the current evidence set.
  for (const evidence of next.evidence || []) {
    if (!evidence.supersededAt) {
      evidence.supersededAt = at;
      evidence.supersededBy = intent.id;
    }
  }
  // Acceptance coverage follows the active evidence set: superseded evidence is
  // history, so the new attempt must submit fresh evidence for every item.
  for (const acceptance of next.acceptance) {
    acceptance.met = next.evidence.some((evidence) => !evidence.supersededAt && evidence.acceptanceId === acceptance.id);
  }
  next.work = { intentId: intent.id, startedAt: at, attempt: intent.attempt };
  next.lastAudit = null;
  touchTask(next, at);
  return {
    events: [
      { type: 'work/intent', taskId: task.id, data: intent },
      { type: 'task/updated', taskId: next.id, rev: next.rev, data: next },
    ],
    entityRev: next.rev,
  };
}

export function taskSubmit(handle, cmd) {
  const task = handle._requireTask(cmd);
  handle._assertRev(task, cmd);
  const lease = handle._assertLease(task, cmd);
  if (task.state !== 'in_progress') throw new BoardError('illegal-transition', 'task is ' + task.state, { status: 409 });
  handle._markLeaseProgress(task.id);
  const intent = openIntentFor(handle.state, task.id);
  const policy = policyOf(handle.state.project);
  if (!intent && policy.requireIntentFor === 'all') {
    throw new BoardError('illegal-transition', 'begin an intent before submitting', { status: 409 });
  }
  const rawEvidence = Array.isArray(cmd.evidence) ? cmd.evidence : [];
  if (rawEvidence.length === 0) throw new BoardError('missing-evidence', 'submit requires at least one evidence item', { status: 422 });
  const at = new Date().toISOString();
  const next = clone(task);
  const added = [];
  for (const raw of rawEvidence) {
    added.push(handle._normalizeEvidence(next, raw, at, cmd.actor || {}));
  }
  // A resubmission replaces the active snapshot of the same file/doc/command.
  // Old rows stay as superseded history; the coverage guard runs before any
  // evidence is appended, so a partial replacement cannot be committed.
  supersedeResubmitted(handle, next, added, at);
  for (const evidence of added) {
    next.evidence.push(evidence);
    if (evidence.acceptanceId) {
      const acceptance = next.acceptance.find((item) => item.id === evidence.acceptanceId);
      if (acceptance) {
        acceptance.met = true;
        if (!acceptance.evidenceIds.includes(evidence.id)) acceptance.evidenceIds.push(evidence.id);
      }
    }
  }
  assertAcceptanceEvidence(next);
  // One audit at the review boundary, not per evidence item: the worker still
  // holds the lease here, so a drifted file can be fixed and
  // resubmitted instead of waiting for a human to press verify and reject.
  // Build the fixed events first: an automatic repository approval is staged on
  // the working state so the pre-review audit below can already see it.
  const events = fixedEvents(handle, added);
  const audit = assertEvidenceReadyForReview(handle, next, 'submit');
  if (intent) {
    const closed = { ...intent, status: 'closed', closedAt: at, token: lease.token };
    events.push({ type: 'work/result', taskId: task.id, data: closed });
  }
  next.state = 'review';
  next.owner = null;
  next.work = next.work || null;
  touchTask(next, at);
  events.push({ type: 'task/submitted', taskId: next.id, rev: next.rev, data: next });
  handle.leases.delete(task.id);
  handle.state.tasks[next.id] = next;
  return { events, entityRev: next.rev, warnings: audit };
}

/** Re-hash the drifted file evidence of this task. Human verify only. */
function refreshFileDrift(handle, next, hard, at, actor) {
  const drifted = hard.filter((warning) => warning.code === 'file-drift');
  if (drifted.length === 0) return [];
  const groups = new Map();
  for (const warning of drifted) {
    const old = (next.evidence || []).find((evidence) => evidence.id === warning.evidenceId);
    if (!old) continue;
    const key = (evidenceIdentity(handle, old) || old.ref) + '|' + (old.acceptanceId || '');
    if (!groups.has(key)) groups.set(key, { acceptanceId: old.acceptanceId || null, rows: [] });
    groups.get(key).rows.push(old);
  }
  const refreshed = [];
  for (const group of groups.values()) {
    const first = group.rows[0];
    const replacement = handle._normalizeEvidence(next, {
      kind: 'file',
      ref: first.ref,
      acceptanceId: group.acceptanceId || undefined,
      summary: first.summary,
    }, at, actor);
    for (const old of group.rows) {
      old.supersededAt = at;
      old.supersededBy = replacement.id;
      old.supersedeReason = 'verify-refresh';
    }
    next.evidence.push(replacement);
    if (replacement.acceptanceId) {
      const acceptance = next.acceptance.find((item) => item.id === replacement.acceptanceId);
      if (acceptance) {
        acceptance.met = true;
        if (!acceptance.evidenceIds.includes(replacement.id)) acceptance.evidenceIds.push(replacement.id);
      }
    }
    refreshed.push({
      evidenceId: replacement.id,
      supersededIds: group.rows.map((old) => old.id),
      ref: first.ref,
      oldHash: first.hash,
      newHash: replacement.hash,
    });
  }
  return refreshed;
}

export function taskVerify(handle, cmd) {
  const task = handle._requireTask(cmd);
  handle._assertRev(task, cmd);
  if (task.state !== 'review') throw new BoardError('illegal-transition', 'task is ' + task.state, { status: 409 });
  const isHuman = cmd.actor?.kind === 'human';
  const problem = verificationRoleProblem(task, cmd.actor);
  if (problem) throw new BoardError('forbidden-role', 'verification requires a human or an authorized agent; audit gates require independence', { status: 403, details: { reason: problem } });
  if (!isHuman && (Object.hasOwn(cmd, 'refreshDrift') || Object.hasOwn(cmd, 'acknowledgeDrift'))) throw new BoardError('forbidden-role', 'drift refresh and acknowledgement are human only', { status: 403, details: { reason: 'drift-human-only' } });
  if (!task.acceptance.every((acceptance) => acceptance.met)) throw new BoardError('acceptance-unmet', 'acceptance is not fully met', { status: 422 });
  const payload = normalizeAudit(cmd.audit, { required: !isHuman && isAuditGate(task) });
  const at = new Date().toISOString();
  const reason = typeof cmd.reason === 'string' ? cmd.reason.trim() : '';
  const next = clone(task);
  const audit = auditEvidence(handle, task);
  let refreshed = [];
  if (cmd.refreshDrift === true && audit.some((warning) => warning.severity === 'error' && warning.code === 'file-drift')) {
    if (reason.length < 4) {
      throw new BoardError('invalid-command', 'refreshDrift requires a reason (at least 4 characters)', { status: 400 });
    }
    refreshed = refreshFileDrift(handle, next, audit, at, cmd.actor);
  }
  const after = refreshed.length > 0 ? auditEvidence(handle, next) : audit;
  const hard = after.filter((warning) => warning.severity === 'error');
  let waiver = null;
  if (hard.length > 0) {
    // A human is the final authority: after refreshing what can be refreshed,
    // the remaining drift can be waived explicitly, with a written reason.
    if (!isHuman || cmd.acknowledgeDrift !== true) {
      throw new BoardError('evidence-drift', 'evidence no longer matches the workspace; fix or re-submit before verify', {
        status: 409,
        details: {
          warnings: hard,
          canAcknowledgeDrift: isHuman,
          canRefresh: isHuman && hard.some((warning) => warning.code === 'file-drift'),
          next: isHuman ? 'refresh or acknowledge drift with a reason' : 'reject for rework, or ask a human to handle the drift',
        },
      });
    }
    if (reason.length < 4) {
      throw new BoardError('invalid-command', 'acknowledgeDrift requires a reason (at least 4 characters)', { status: 400 });
    }
    waiver = {
      at,
      by: cmd.actor.sessionId || cmd.actor.via || 'human',
      reason,
      warnings: hard.map(({ evidenceId, code, message }) => ({ evidenceId, code, message })),
    };
  }
  next.state = 'done';
  next.verifiedAt = at;
  next.verifiedBy = isHuman ? 'human' : 'agent';
  next.waivedDrift = waiver;
  next.refreshedDrift = refreshed.length > 0
    ? { at, by: cmd.actor.sessionId || cmd.actor.via || 'human', reason, items: refreshed }
    : null;
  next.owner = null;
  touchTask(next, at);
  next.lastAudit = makeAuditRecord(next, cmd.actor, at, 'pass', payload || { report: reason || String(cmd.note || '').trim() }, after);
  const events = [{ type: 'task/verified', taskId: next.id, rev: next.rev, data: next }];
  handle.state.tasks[next.id] = next;
  const cascade = [];
  cascadeReady(handle.state, cascade, at);
  for (const event of cascade) events.push(event);
  return { events, entityRev: next.rev, warnings: after, waivedDrift: waiver, refreshedDrift: next.refreshedDrift };
}

export function taskReject(handle, cmd) {
  const task = handle._requireTask(cmd);
  handle._assertRev(task, cmd);
  if (task.state !== 'review') throw new BoardError('illegal-transition', 'task is ' + task.state, { status: 409 });
  const reason = typeof cmd.reason === 'string' ? cmd.reason.trim() : '';
  if (reason === '') throw new BoardError('invalid-command', 'reject requires a reason', { status: 400 });
  const lease = handle._leaseOf(task.id);
  const isHuman = cmd.actor?.kind === 'human';
  if (!isHuman && (cmd.actor?.kind !== 'agent' || (lease && lease.sessionId !== cmd.actor?.sessionId))) throw new BoardError('forbidden-role', 'only an agent, live lease owner or a human can reject', { status: 403 });
  if (!isHuman && lease) handle._assertLease(task, cmd);
  if (cmd.unassign === true && !isHuman) throw new BoardError('forbidden-role', 'only a human can unassign on reject', { status: 403, details: { reason: 'unassign-human-only' } });
  const payload = normalizeAudit(cmd.audit);
  const at = new Date().toISOString();
  const next = clone(task);
  const events = [];
  const settlement = settleOpenIntent(handle, task, cmd, 'rejected', at, lease);
  if (settlement) events.push(settlement);
  const previous = task.assignee ? { ...task.assignee } : null;
  next.rejection = { reason, at, by: cmd.actor?.sessionId || 'human', byKind: cmd.actor.kind };
  let granted = cmd.unassign === true ? null : lease;
  if (granted) handle._assertPlanActive(task);
  const denial = cmd.unassign === true ? 'unassign' : handle._assigneeResumeDenial(previous);
  if (!granted && !denial) {
    handle._assertPlanActive(task);
    granted = handle._grantLease(next, { sessionId: previous.sessionId, agentId: previous.agentId }, at);
    events.push(leaseGrantedEvent(granted));
  }
  if (cmd.unassign === true && lease) {
    handle.leases.delete(next.id);
    events.push(leaseRevokedEvent(lease));
  }
  if (granted) {
    next.state = 'in_progress';
    appendWorker(next, granted, at, 'reject');
    next.assignee = { sessionId: granted.sessionId, agentId: granted.agentId, epoch: granted.epoch, at };
    next.owner = { sessionId: granted.sessionId, agentId: granted.agentId, epoch: granted.epoch, fencingToken: granted.token, leaseUntil: granted.expiresAt };
  } else {
    next.state = 'ready';
    next.owner = null;
    next.assignee = null;
  }
  touchTask(next, at);
  if (payload) {
    next.lastAudit = makeAuditRecord(next, cmd.actor, at, 'fail', payload);
    next.rejection.auditId = next.lastAudit.id;
  }
  events.push({ type: 'task/rejected', taskId: next.id, rev: next.rev, data: next });
  events.push(assignmentEvent(next.id, previous, next.assignee, granted ? 'reject' : denial, reason, cmd.actor, at));
  return { events, entityRev: next.rev };
}
