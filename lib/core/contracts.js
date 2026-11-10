import { clone, openIntentFor, touchTask } from './model.js';

// Event constructors. Every commit payload is shaped here so the commands in
// service.js only decide *what* happened, never how the record is spelled —
// field order and event order stay byte-identical to the inline literals.

export function leaseEvent(type, lease) {
  return { type, taskId: lease.taskId, data: lease };
}

export function leaseGrantedEvent(lease) {
  return leaseEvent('lease/granted', lease);
}

export function leaseRevokedEvent(lease) {
  return leaseEvent('lease/revoked', lease);
}

export function leaseExpiredEvent(lease) {
  return leaseEvent('lease/expired', lease);
}

/** A task's state after it (re)enters the pool: interrupted with an open intent, ready without. */
export function taskStateEvent(task) {
  return {
    type: task.state === 'interrupted' ? 'task/interrupted' : 'task/readied',
    taskId: task.id,
    rev: task.rev,
    data: task,
  };
}

export function releasedTaskState(state, taskId) {
  return openIntentFor(state, taskId) ? 'interrupted' : 'ready';
}

/**
 * The one way a task loses its worker (lease expiry, restart recovery, session
 * detach, explicit revoke): clear the ownership fields and decide whether the
 * task is interrupted (an intent is open, so work may have happened) or ready.
 */
export function releasedTask(handle, task, at) {
  const next = clone(task);
  next.owner = null;
  next.assignee = null;
  next.work = null;
  next.state = releasedTaskState(handle.state, task.id);
  touchTask(next, at);
  return next;
}

/**
 * The lease record a cold-started writer terminates for a task that is still
 * in_progress. The runtime lease table is process state, so after a restart the
 * only durable trace of that lease is the task's persisted owner (written by the
 * grant; the historical `lease/granted` is already folded into it).
 *
 * Known fields are copied verbatim, unknown ones are omitted: renewal history
 * the owner does not carry (acquiredAt/grantedAt/renewCount/progressAt) is never
 * invented. `reason:'restart'` separates this termination from a regular expiry
 * sweep, whose record is the live lease and carries no reason.
 */
export function restartLeaseRecord(task) {
  const owner = task.owner && typeof task.owner === 'object' ? task.owner : {};
  const lease = { taskId: task.id };
  if (typeof owner.sessionId === 'string' && owner.sessionId !== '') lease.sessionId = owner.sessionId;
  if (typeof owner.agentId === 'string' && owner.agentId !== '') lease.agentId = owner.agentId;
  if (Number.isInteger(owner.epoch)) lease.epoch = owner.epoch;
  if (Number.isInteger(owner.fencingToken)) lease.token = owner.fencingToken;
  if (typeof owner.leaseUntil === 'string' && owner.leaseUntil !== '') lease.expiresAt = owner.leaseUntil;
  lease.reason = 'restart';
  return lease;
}

/**
 * Lease termination events: the lease event itself, plus the task transition
 * when the task was mid-flight. This is the four-times-duplicated block that
 * used to live in _collectExpiredLeases, recover, attach and detach.
 */
export function releaseEvents(handle, lease, at, type = 'lease/revoked') {
  const events = [leaseEvent(type, lease)];
  const task = handle.state.tasks[lease.taskId];
  if (task && task.state === 'in_progress') {
    events.push(taskStateEvent(releasedTask(handle, task, at)));
  }
  return events;
}

/**
 * Ownership ledger event. One record for every "who is on the hook" change, so
 * the read model never has to guess a cause from a bare task/readied event.
 */
export function assignmentEvent(taskId, from, to, cause, reason, actor, at) {
  const side = (value) => (value && value.sessionId
    ? { sessionId: value.sessionId, agentId: value.agentId || value.sessionId, epoch: value.epoch ?? null }
    : null);
  return {
    type: 'task/assignment',
    taskId,
    data: {
      taskId,
      from: side(from),
      to: side(to),
      cause,
      reason: String(reason || ''),
      by: actor ? { kind: actor.kind || 'system', sessionId: actor.sessionId || null } : null,
      at,
    },
  };
}
