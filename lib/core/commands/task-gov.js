// Task governance: block/unblock, release, reconcile, cancel, reopen and the
// human-only override.
//
// Reconcile and reopen both decide whether to re-grant a lease; the grant conditions
// are copied verbatim, including the maxPerSession policy check.

import { BoardError } from '../errors.js';
import { appendWorker } from '../audit.js';
import { TERMINAL_STATES, TASK_STATES, clone, isAuditGate, openIntentFor, taskDepsSatisfied, touchTask } from '../model.js';
import { assignmentEvent, leaseGrantedEvent, leaseRevokedEvent } from '../contracts.js';
import { newId } from '../util.js';
import { actorRef, normalizeSideEffects, settleOpenIntent } from '../intent.js';
import { fixedEvents } from '../documents/fixed-auto.js';
import { assertAcceptanceEvidence, assertEvidenceReadyForReview, supersedeResubmitted } from '../evidence.js';

export function taskBlock(handle, cmd) {
  const task = handle._requireTask(cmd);
  handle._assertRev(task, cmd);
  if (!['in_progress', 'review'].includes(task.state)) throw new BoardError('illegal-transition', 'task is ' + task.state, { status: 409 });
  const lease = handle._leaseOf(task.id);
  const isHuman = cmd.actor?.kind === 'human';
  if (!isHuman) {
    if (!lease) throw new BoardError('forbidden-role', 'only the lease owner or a human can block', { status: 403 });
    // block is a state transition: a stale token from the same session after a
    // re-claim must not stop the current attempt.
    handle._assertLease(task, cmd);
  }
  const at = new Date().toISOString();
  const events = [];
  const settlement = settleOpenIntent(handle, task, cmd, 'blocked', at, lease);
  if (settlement) events.push(settlement);
  const next = clone(task);
  next.blocker = { code: String(cmd.code || 'blocked'), note: String(cmd.note || ''), since: at, resumeTo: task.state };
  next.state = 'blocked';
  next.owner = null;
  touchTask(next, at);
  if (lease) {
    handle.leases.delete(task.id);
    events.push(leaseRevokedEvent(lease));
  }
  events.push({ type: 'task/blocked', taskId: next.id, rev: next.rev, data: next });
  return { events, entityRev: next.rev };
}

export function taskInterrupt(handle, cmd) {
  const task = handle._requireTask(cmd);
  handle._assertRev(task, cmd);
  if (task.state === 'interrupted') throw new BoardError('illegal-transition', 'task is already interrupted', { status: 409 });
  const note = String(cmd.note || '').trim();
  if (note === '') throw new BoardError('invalid-command', 'interrupt requires a note', { status: 400 });
  const intent = openIntentFor(handle.state, task.id);
  const isHuman = cmd.actor?.kind === 'human';
  const legacyRepair = Boolean(intent) && !TERMINAL_STATES.includes(task.state);
  if (task.state !== 'in_progress' && !(isHuman && legacyRepair)) {
    throw new BoardError('illegal-transition', 'interrupt is only valid for in_progress, or a human repairing an open intent in another non-terminal state', { status: 409 });
  }
  const lease = handle._leaseOf(task.id);
  if (!isHuman) {
    if (task.state !== 'in_progress') throw new BoardError('forbidden-role', 'only a human can interrupt a task outside in_progress', { status: 403 });
    // The expired lease's own session already passed its recovery check.
    if (handle._lapsed?.reclaimed?.taskId !== task.id) handle._assertLease(task, cmd);
  }
  const at = new Date().toISOString();
  const sideEffects = normalizeSideEffects(cmd.sideEffects, { required: false });
  const events = [];
  if (lease) {
    handle.leases.delete(task.id);
    events.push(leaseRevokedEvent(lease));
  }
  const next = clone(task);
  next.state = 'interrupted';
  next.owner = null;
  next.assignee = null;
  next.interrupt = {
    at,
    by: actorRef(cmd.actor),
    note: note.slice(0, 2000),
    sideEffects,
    previousState: task.state,
    previousAssignee: task.assignee || null,
    previousBlocker: task.blocker || null,
  };
  next.blocker = null;
  touchTask(next, at);
  events.push({ type: 'task/interrupted', taskId: next.id, rev: next.rev, data: next });
  return { events, entityRev: next.rev };
}

export function taskUnblock(handle, cmd) {
  const task = handle._requireTask(cmd);
  handle._assertRev(task, cmd);
  if (task.state !== 'blocked') throw new BoardError('illegal-transition', 'task is ' + task.state, { status: 409 });
  const legacyIntent = openIntentFor(handle.state, task.id);
  if (legacyIntent) {
    throw new BoardError('intent-unresolved', 'blocked task still has an open intent; use task.interrupt before unblocking', {
      status: 409,
      details: { taskId: task.id, intentId: legacyIntent.id, hint: 'use task.interrupt, then task.reconcile', allowedOps: ['task.interrupt'] },
    });
  }
  const at = new Date().toISOString();
  const next = clone(task);
  const events = [];
  const previous = task.assignee ? { ...task.assignee } : null;
  const resumeTo = task.blocker?.resumeTo;
  const reason = String(cmd.note || cmd.reason || '').trim();
  let granted = null;
  if (resumeTo !== 'review' && !handle._assigneeResumeDenial(previous)) {
    handle._assertPlanActive(task);
    granted = handle._grantLease(next, { sessionId: previous.sessionId, agentId: previous.agentId }, at);
    events.push(leaseGrantedEvent(granted));
  }
  if (granted) {
    next.state = 'in_progress';
    appendWorker(next, granted, at, 'unblock');
    next.assignee = { sessionId: granted.sessionId, agentId: granted.agentId, epoch: granted.epoch, at };
    next.owner = { sessionId: granted.sessionId, agentId: granted.agentId, epoch: granted.epoch, fencingToken: granted.token, leaseUntil: granted.expiresAt };
  } else if (resumeTo === 'review') {
    next.state = 'review';
    next.owner = null;
    next.assignee = previous;
  } else {
    next.state = 'ready';
    next.owner = null;
    next.assignee = null;
  }
  next.blocker = null;
  touchTask(next, at);
  events.push({ type: 'task/unblocked', taskId: next.id, rev: next.rev, data: next });
  events.push(assignmentEvent(next.id, previous, next.assignee, 'unblock', reason, cmd.actor, at));
  return { events, entityRev: next.rev };
}

export function taskRelease(handle, cmd) {
  const task = handle._requireTask(cmd);
  handle._assertRev(task, cmd);
  const lease = handle._assertLease(task, cmd);
  if (task.state !== 'in_progress') throw new BoardError('illegal-transition', 'task is ' + task.state, { status: 409 });
  const at = new Date().toISOString();
  const events = [];
  const settlement = settleOpenIntent(handle, task, cmd, 'released', at, lease);
  if (settlement) events.push(settlement);
  const next = clone(task);
  handle.leases.delete(task.id);
  events.push(leaseRevokedEvent(lease));
  next.state = 'ready';
  next.owner = null;
  next.assignee = null;
  next.work = null;
  touchTask(next, at);
  events.push({ type: 'task/released', taskId: next.id, rev: next.rev, data: next });
  return { events, entityRev: next.rev };
}

export function taskReconcile(handle, cmd) {
  const task = handle._requireTask(cmd);
  handle._assertRev(task, cmd);
  if (task.state !== 'interrupted') throw new BoardError('illegal-transition', 'task is ' + task.state + ', not interrupted', { status: 409 });
  const note = String(cmd.note || '').trim();
  if (note === '') throw new BoardError('invalid-command', 'reconcile requires a note', { status: 400 });
  const choice = cmd.choice;
  if (!['resume', 'completed', 'discard'].includes(choice)) throw new BoardError('invalid-command', 'choice must be resume|completed|discard', { status: 400 });
  const at = new Date().toISOString();
  const next = clone(task);
  next.interrupt = null;
  const events = [];
  let warnings = [];
  const intent = openIntentFor(handle.state, task.id);
  const closedBy = actorRef(cmd.actor);
  if (choice === 'resume') {
    if (intent) events.push({ type: 'work/abandoned', taskId: task.id, data: { ...intent, status: 'abandoned', closeReason: 'reconcile-resume', resolution: 'redo', resolutionNote: note, closedAt: at, closedBy } });
    handle._assertPlanActive(task);
    const lease = handle._grantLease(task, cmd.actor || {}, at);
    events.push(leaseGrantedEvent(lease));
    const newIntent = {
      id: newId('int'),
      taskId: task.id,
      token: lease.token,
      summary: note,
      plannedSteps: [],
      expectedArtifacts: [],
      status: 'open',
      attempt: (task.work?.attempt || 0) + 1,
      startedAt: at,
      actor: cmd.actor || {},
    };
    events.push({ type: 'work/intent', taskId: task.id, data: newIntent });
    next.state = 'in_progress';
    appendWorker(next, lease, at, 'resume');
    next.owner = { sessionId: lease.sessionId, agentId: lease.agentId, epoch: lease.epoch, fencingToken: lease.token, leaseUntil: lease.expiresAt };
    next.assignee = { sessionId: lease.sessionId, agentId: lease.agentId, epoch: lease.epoch, at, cause: 'resume' };
    next.work = { intentId: newIntent.id, startedAt: at, attempt: newIntent.attempt };
    next.lastAudit = null;
  } else if (choice === 'completed') {
    const evidenceInput = Array.isArray(cmd.evidence) ? cmd.evidence : [];
    if (evidenceInput.length > 0) {
      const added = evidenceInput.map((raw) => handle._normalizeEvidence(next, raw, at, cmd.actor || {}));
      events.push(...fixedEvents(handle, added));
      // Reconciled evidence follows the same replacement rule as submit: a new
      // snapshot retires the active row for the same file/doc/command.
      supersedeResubmitted(handle, next, added, at);
      for (const evidence of added) {
        next.evidence.push(evidence);
        if (evidence.acceptanceId) {
          const acceptance = next.acceptance.find((item) => item.id === evidence.acceptanceId);
          if (acceptance) { acceptance.met = true; if (!acceptance.evidenceIds.includes(evidence.id)) acceptance.evidenceIds.push(evidence.id); }
        }
      }
    }
    // Coverage follows the active set: a superseded row must be re-asserted
    // before verify can pass, otherwise completion would rest on retired evidence.
    assertAcceptanceEvidence(next);
    // The same single audit as submit, because reconcile(completed) is another
    // path into review while the caller still holds the lease.
    warnings = assertEvidenceReadyForReview(handle, next, 'reconcile');
    if (intent) events.push({ type: 'work/result', taskId: task.id, data: { ...intent, status: 'closed', resolution: 'applied', resolutionNote: note, closedAt: at, closedBy } });
    next.state = 'review';
    next.owner = null;
    const held = handle._leaseOf(task.id);
    next.assignee = cmd.actor?.sessionId
      ? { sessionId: cmd.actor.sessionId, agentId: cmd.actor.agentId || cmd.actor.sessionId, epoch: held ? held.epoch : null, at, cause: 'reconcile' }
      : null;
    next.work = next.work || null;
  } else {
    if (intent) events.push({ type: 'work/abandoned', taskId: task.id, data: { ...intent, status: 'abandoned', closeReason: 'reconcile-discard', resolution: 'discarded', resolutionNote: note, closedAt: at, closedBy } });
    next.state = 'ready';
    next.owner = null;
    next.assignee = null;
    next.work = null;
  }
  touchTask(next, at);
  events.push({ type: 'task/reconciled', taskId: next.id, rev: next.rev, data: next });
  return { events, entityRev: next.rev, warnings };
}

export function taskCancel(handle, cmd) {
  const task = handle._requireTask(cmd);
  handle._assertRev(task, cmd);
  if (TERMINAL_STATES.includes(task.state)) throw new BoardError('illegal-transition', 'task is already ' + task.state, { status: 409 });
  if (cmd.actor?.kind !== 'human' && isAuditGate(task)) {
    throw new BoardError('forbidden-role', 'only a human can cancel a gated task', { status: 403, details: { gateLocked: true } });
  }
  const lease = handle._leaseOf(task.id);
  if (!cmd.actor || (cmd.actor.kind !== 'human' && lease && lease.sessionId !== cmd.actor.sessionId)) {
    throw new BoardError('forbidden-role', 'only the lease owner or a human can cancel', { status: 403 });
  }
  if (cmd.actor?.kind !== 'human' && lease) handle._assertLease(task, cmd);
  const at = new Date().toISOString();
  const next = clone(task);
  const events = [];
  const settlement = settleOpenIntent(handle, task, cmd, 'canceled', at, lease);
  if (settlement) events.push(settlement);
  if (lease) {
    handle.leases.delete(task.id);
    events.push(leaseRevokedEvent(lease));
  }
  next.state = 'canceled';
  next.owner = null;
  next.work = null;
  next.canceledReason = String(cmd.reason || '');
  touchTask(next, at);
  events.push({ type: 'task/canceled', taskId: next.id, rev: next.rev, data: next });
  return { events, entityRev: next.rev };
}

export function taskReopen(handle, cmd) {
  const task = handle._requireTask(cmd);
  handle._assertRev(task, cmd);
  if (!cmd.actor || cmd.actor.kind !== 'human') throw new BoardError('forbidden-role', 'reopen is human only', { status: 403 });
  if (!TERMINAL_STATES.includes(task.state)) throw new BoardError('illegal-transition', 'task is not terminal', { status: 409 });
  const at = new Date().toISOString();
  const next = clone(task);
  const events = [];
  const previous = task.assignee ? { ...task.assignee } : null;
  const reason = String(cmd.reason || '').trim();
  // A redone task must never land in ready with unmet dependencies: that is a
  // card nobody can claim. Dependencies win over the assignee.
  const depsOk = taskDepsSatisfied(handle.state, task);
  let granted = null;
  if (depsOk && !handle._assigneeResumeDenial(previous)) {
    handle._assertPlanActive(task);
    granted = handle._grantLease(next, { sessionId: previous.sessionId, agentId: previous.agentId }, at);
    events.push(leaseGrantedEvent(granted));
  }
  if (granted) {
    next.state = 'in_progress';
    appendWorker(next, granted, at, 'reopen');
    next.assignee = { sessionId: granted.sessionId, agentId: granted.agentId, epoch: granted.epoch, at };
    next.owner = { sessionId: granted.sessionId, agentId: granted.agentId, epoch: granted.epoch, fencingToken: granted.token, leaseUntil: granted.expiresAt };
  } else {
    next.state = depsOk ? 'ready' : 'backlog';
    next.owner = null;
    next.assignee = null;
  }
  next.lastAudit = null;
  next.verifiedAt = null;
  next.verifiedBy = null;
  next.work = null;
  next.blocker = null;
  next.canceledReason = null;
  next.rejection = null;
  next.reopenedReason = reason;
  touchTask(next, at);
  events.push({ type: 'task/reopened', taskId: next.id, rev: next.rev, data: next });
  events.push(assignmentEvent(next.id, previous, next.assignee, depsOk ? 'reopen' : 'reopen-deps-unmet', reason, cmd.actor, at));
  return { events, entityRev: next.rev };
}

export function override(handle, cmd) {
  if (!cmd.actor || cmd.actor.kind !== 'human') throw new BoardError('forbidden-role', 'override is human only', { status: 403 });
  const task = handle._requireTask(cmd);
  handle._assertRev(task, cmd);
  if (!TASK_STATES.includes(cmd.toState)) throw new BoardError('invalid-command', 'invalid target state', { status: 400 });
  const at = new Date().toISOString();
  const lease = handle._leaseOf(task.id);
  const events = [];
  const settlement = settleOpenIntent(handle, task, cmd, 'override', at, lease);
  if (settlement) events.push(settlement);
  if (cmd.toState === 'in_progress') handle._assertPlanActive(task);
  const next = clone(task);
  next.state = cmd.toState;
  if (cmd.toState !== 'in_progress') next.owner = null;
  if (cmd.toState !== 'in_progress') next.assignee = null;
  touchTask(next, at);
  if (lease && cmd.toState !== 'in_progress') {
    handle.leases.delete(task.id);
    events.push(leaseRevokedEvent(lease));
  }
  events.push({ type: 'task/updated', taskId: next.id, rev: next.rev, data: next });
  events.push({ type: 'override/applied', data: { op: 'task.force', taskId: task.id, toState: cmd.toState, reason: String(cmd.reason || ''), actor: cmd.actor, at } });
  return { events, entityRev: next.rev };
}
