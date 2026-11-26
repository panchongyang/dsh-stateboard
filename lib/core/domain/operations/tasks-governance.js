import { BoardError } from '../../errors.js';
import { TASK_STATES, TERMINAL_STATES } from '../../../shared/contract.js';
import { isAuditGate, makeAuditRecord, normalizeAudit } from '../../audit.js';
import { actorRef, normalizeSideEffects } from '../../intent.js';
import { assignmentEvent, leaseGrantedEvent } from '../../contracts.js';
import { touchTask } from '../../model.js';
import { openIntentFor, taskDepsSatisfied } from '../task-facts.js';
import { assertTaskBlock, assertTaskOpen, assertTaskReject, assertTaskRelease, assertTaskUnblock,
  blockTask, cancelTask, humanOverrideTask, interruptTask, reconcileDiscardTask, reconcileResumeTask,
  rejectTask, releaseTask, reopenTask, unblockTask } from '../task-transitions.js';
import { abandonDiscardedWork, abandonWorkForRedo, abandonStoppedWork, startWorkAttempt } from '../work-transitions.js';
import { assertLapsedWorkAuthority, assertNoOpenIntent, assertRecoveryAuthority, changedTask, currentIntent, invalidOperation, modelTask,
  requireHuman, requireTaskParticipant, revokeTaskLease, taskEvent, workEvent } from './tasks-primitives.js';

// A stopped declaration is input; its audited disposition is derived only by
// the task transition that owns the intent, lease and resulting state.
function settleStoppedAttempt(work, task, declaration, closeReason, actor, lease, at) {
  const intent = openIntentFor(work.state, task.id);
  if (!intent) {
    if (declaration != null) throw invalidOperation('intent settlement is only valid while an intent is open');
    return [];
  }
  if (declaration?.outcome !== 'stopped') assertNoOpenIntent(work, task);
  currentIntent(work, task, declaration.intentId);
  const closed = abandonStoppedWork(intent, {
    closeReason, sideEffects: normalizeSideEffects(declaration.sideEffects, { required: true }), note: declaration.note,
    at, by: actorRef(actor), token: lease ? lease.token : intent.token,
  });
  return [workEvent('abandoned', closed)];
}

function returnReviewToWork(work, { taskId, reason, audit, unassign, stopped }, request) {
  const task = modelTask(work, taskId, request);
  assertTaskReject(task);
  const actor = request.actor;
  const isHuman = actor?.kind === 'human';
  const lease = work._leaseOf(task.id);
  if (!isHuman && (actor?.kind !== 'agent' || (lease && lease.sessionId !== actor.sessionId))) {
    throw new BoardError('forbidden-role', 'only an agent, live lease owner or a human can reject', { status: 403 });
  }
  if (!isHuman && lease) work._assertLease(task, request);
  if (unassign === true && !isHuman) throw new BoardError('forbidden-role', 'only a human can unassign on reject', { status: 403, details: { reason: 'unassign-human-only' } });
  if (typeof reason !== 'string' || !reason.trim()) throw invalidOperation('reject requires a reason');
  const payload = normalizeAudit(audit ?? undefined);
  const at = work.clock().toISOString();
  const next = structuredClone(task);
  const previous = task.assignee;
  const before = settleStoppedAttempt(work, task, stopped, 'rejected', actor, lease, at);
  let granted = unassign === true ? null : lease;
  if (granted) work._assertPlanActive(task);
  const denial = unassign === true ? 'unassign' : work._assigneeResumeDenial(previous);
  if (!granted && !denial) {
    work._assertPlanActive(task);
    granted = work._grantLease(task, { sessionId: previous.sessionId, agentId: previous.agentId }, at);
    before.push(leaseGrantedEvent(granted));
  }
  if (unassign === true) before.push(...revokeTaskLease(work, lease));
  next.rejection = { reason, at, by: actor?.sessionId || 'human', byKind: actor.kind };
  rejectTask(next, granted, at);
  touchTask(next, at);
  if (payload) {
    next.lastAudit = makeAuditRecord(next, actor, at, 'fail', payload, [], work.newId);
    next.rejection.auditId = next.lastAudit.id;
  }
  return { events: [...before, taskEvent('rejected', next), assignmentEvent(task.id, previous, next.assignee, granted ? 'reject' : denial, reason, actor, at)], entityRev: next.rev };
}

function parkForBlocker(work, { taskId, code, note, stopped }, request) {
  const task = modelTask(work, taskId, request);
  assertTaskBlock(task);
  const lease = work._leaseOf(task.id);
  requireTaskParticipant(request.actor);
  if (request.actor.kind !== 'human') {
    if (!lease) throw new BoardError('forbidden-role', 'only the lease owner or a human can block', { status: 403 });
    work._assertLease(task, request);
  }
  const at = work.clock().toISOString();
  const settled = settleStoppedAttempt(work, task, stopped, 'blocked', request.actor, lease, at);
  const next = blockTask(structuredClone(task), { code: String(code || 'blocked'), note: String(note || ''), since: at });
  return changedTask('blocked', next, at, [...settled, ...revokeTaskLease(work, lease)]);
}

function flagInterruptedWork(work, { taskId, note, sideEffects }, request) {
  const task = modelTask(work, taskId, request);
  if (task.state === 'interrupted') throw new BoardError('illegal-transition', 'task is already interrupted', { status: 409 });
  if (typeof note !== 'string' || !note.trim()) throw invalidOperation('interrupt requires a note');
  const actor = request.actor;
  const isHuman = actor?.kind === 'human';
  const hasOpenIntent = Boolean(openIntentFor(work.state, task.id));
  requireTaskParticipant(actor);
  if (!isHuman) {
    const reclaimed = work._lapsed?.reclaimed;
    if (reclaimed?.taskId === task.id && !work._leaseOf(task.id)) assertLapsedWorkAuthority(work, task, request, reclaimed);
    else work._assertLease(task, request);
  }
  const at = work.clock().toISOString();
  const next = interruptTask(structuredClone(task), { at, by: actorRef(actor), note: note.slice(0, 2000), sideEffects: normalizeSideEffects(sideEffects) },
    { humanRepair: isHuman, hasOpenIntent });
  return changedTask('interrupted', next, at, revokeTaskLease(work, work._leaseOf(task.id)));
}

function clearBlocker(work, { taskId, reason }, request) {
  const task = modelTask(work, taskId, request);
  assertTaskUnblock(task);
  const legacyIntent = openIntentFor(work.state, task.id);
  if (legacyIntent) throw new BoardError('intent-unresolved', 'blocked task still has an open intent; use task.interrupt before unblocking', {
    status: 409, details: { taskId: task.id, intentId: legacyIntent.id, hint: 'use task.interrupt, then task.reconcile', allowedOps: ['task.interrupt'] },
  });
  const at = work.clock().toISOString();
  const previous = task.assignee;
  let granted = null;
  if (task.blocker?.resumeTo !== 'review' && !work._assigneeResumeDenial(previous)) {
    work._assertPlanActive(task);
    granted = work._grantLease(task, { sessionId: previous.sessionId, agentId: previous.agentId }, at);
  }
  const next = unblockTask(structuredClone(task), granted, at);
  return changedTask('unblocked', next, at, granted ? [leaseGrantedEvent(granted)] : [],
    [assignmentEvent(task.id, previous, next.assignee, 'unblock', reason, request.actor, at)]);
}

function returnHeldWorkToPool(work, { taskId, stopped }, request) {
  const task = modelTask(work, taskId, request);
  const lease = work._assertLease(task, request);
  assertTaskRelease(task);
  requireTaskParticipant(request.actor);
  const at = work.clock().toISOString();
  const settled = settleStoppedAttempt(work, task, stopped, 'released', request.actor, lease, at);
  return changedTask('released', releaseTask(structuredClone(task)), at, [...settled, ...revokeTaskLease(work, lease)]);
}

function resolveInterruptedAttempt(work, task, note, actor, at, abandon) {
  if (typeof note !== 'string' || !note.trim()) throw invalidOperation('reconcile requires a note');
  const intent = openIntentFor(work.state, task.id);
  return intent ? [workEvent('abandoned', abandon(intent, note, actorRef(actor), at))] : [];
}

function resumeInterruptedWork(work, { taskId, intentId, note }, request) {
  const task = modelTask(work, taskId, request);
  assertRecoveryAuthority(work, task, request);
  if (Object.hasOwn(work.state.intents, intentId)) throw invalidOperation('intent identifier already exists');
  work._assertPlanActive(task);
  const at = work.clock().toISOString();
  const settled = resolveInterruptedAttempt(work, task, note, request.actor, at, abandonWorkForRedo);
  const lease = work._grantLease(task, request.actor, at);
  // Redo creates one new attempt linked to the live generation and makes its
  // worker the owner. Neither a held lease nor a detached intent is a result.
  const intent = startWorkAttempt(task, lease, { intentId, summary: note }, at, request.actor);
  const next = reconcileResumeTask(structuredClone(task), lease, intent, at);
  return changedTask('reconciled', next, at, [...settled, leaseGrantedEvent(lease), workEvent('intent', intent)]);
}

function discardInterruptedWork(work, { taskId, note }, request) {
  const task = modelTask(work, taskId, request);
  assertRecoveryAuthority(work, task, request);
  const at = work.clock().toISOString();
  const settled = resolveInterruptedAttempt(work, task, note, request.actor, at, abandonDiscardedWork);
  return changedTask('reconciled', reconcileDiscardTask(structuredClone(task)), at, settled);
}

function cancelOpenWork(work, { taskId, reason, stopped }, request) {
  const task = modelTask(work, taskId, request);
  assertTaskOpen(task);
  const actor = request.actor;
  if (actor?.kind !== 'human' && isAuditGate(task)) throw new BoardError('forbidden-role', 'only a human can cancel a gated task', { status: 403, details: { gateLocked: true } });
  const lease = work._leaseOf(task.id);
  if (!actor || (actor.kind !== 'human' && lease && lease.sessionId !== actor.sessionId)) throw new BoardError('forbidden-role', 'only the lease owner or a human can cancel', { status: 403 });
  if (actor.kind !== 'human' && lease) work._assertLease(task, request);
  requireTaskParticipant(actor);
  const at = work.clock().toISOString();
  const settled = settleStoppedAttempt(work, task, stopped, 'canceled', actor, lease, at);
  const next = cancelTask(structuredClone(task));
  next.canceledReason = String(reason || '');
  return changedTask('canceled', next, at, [...settled, ...revokeTaskLease(work, lease)]);
}

function reopenClosedWork(work, { taskId, reason }, request) {
  const task = modelTask(work, taskId, request);
  requireHuman(request.actor, 'reopen');
  if (!TERMINAL_STATES.includes(task.state)) throw new BoardError('illegal-transition', 'task is not terminal', { status: 409 });
  const at = work.clock().toISOString();
  const previous = task.assignee;
  const depsOk = taskDepsSatisfied(work.state, task);
  const note = String(reason || '').trim();
  let granted = null;
  if (depsOk && !work._assigneeResumeDenial(previous)) {
    work._assertPlanActive(task);
    granted = work._grantLease(task, { sessionId: previous.sessionId, agentId: previous.agentId }, at);
  }
  const next = reopenTask(structuredClone(task), granted, depsOk, at);
  next.reopenedReason = note;
  return changedTask('reopened', next, at, granted ? [leaseGrantedEvent(granted)] : [],
    [assignmentEvent(task.id, previous, next.assignee, depsOk ? 'reopen' : 'reopen-deps-unmet', note, request.actor, at)]);
}

function applyHumanOverride(work, { taskId, toState, reason, stopped }, request) {
  requireHuman(request.actor, 'override');
  const task = modelTask(work, taskId, request);
  if (!TASK_STATES.includes(toState)) throw invalidOperation('invalid target state');
  if (toState === 'in_progress') work._assertPlanActive(task);
  const at = work.clock().toISOString();
  const next = humanOverrideTask(structuredClone(task), toState, request.actor);
  const lease = work._leaseOf(task.id);
  const before = settleStoppedAttempt(work, task, stopped, 'override', request.actor, lease, at);
  if (toState !== 'in_progress') before.push(...revokeTaskLease(work, lease));
  return changedTask('updated', next, at, before, [{
    type: 'override/applied', data: { op: 'task.force', taskId, toState, reason: String(reason || ''), actor: request.actor, at },
  }]);
}

export const TASK_GOVERNANCE_OPERATIONS = Object.freeze({
  'task.returnReviewToWork': returnReviewToWork,
  'task.parkForBlocker': parkForBlocker,
  'task.flagInterruptedWork': flagInterruptedWork,
  'task.clearBlocker': clearBlocker,
  'task.returnHeldWorkToPool': returnHeldWorkToPool,
  'task.resumeInterruptedWork': resumeInterruptedWork,
  'task.discardInterruptedWork': discardInterruptedWork,
  'task.cancelOpenWork': cancelOpenWork,
  'task.reopenClosedWork': reopenClosedWork,
  'task.applyHumanOverride': applyHumanOverride,
});
