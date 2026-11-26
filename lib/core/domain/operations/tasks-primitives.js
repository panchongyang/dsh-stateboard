import { BoardError } from '../../errors.js';
import { openIntentFor } from '../task-facts.js';
import { requireTaskParticipant } from '../task-authority.js';
export { requireTaskParticipant, assertLapsedWorkAuthority, assertRecoveryAuthority } from '../task-authority.js';
import { leaseRevokedEvent } from '../../contracts.js';
import { touchTask } from '../../model.js';

export function invalidOperation(message) {
  return new BoardError('invalid-command', message, { status: 400 });
}

// A paired task transition owns this scratch slot until another operation
// consumes it. The executor refuses to publish a batch with leftover scratch.
const transitionSlot = Symbol('unfinished task transition');

export function pendingTaskTransition(work) { return work.scratch.get(transitionSlot); }
export function stageTaskTransition(work, phase, task, facts) {
  work.scratch.set(transitionSlot, { ...facts, phase, taskId: task.id, rev: task.rev });
}
export function clearTaskTransition(work) { work.scratch.delete(transitionSlot); }

export function requireTaskActor(actor) {
  if (actor?.kind === 'human' || actor?.kind === 'system') return;
  requireTaskParticipant(actor);
}

export function modelTask(work, taskId, request, { checkRev = true, phase } = {}) {
  if (taskId !== request.taskId) throw invalidOperation('operation task does not match request');
  const task = work._requireTask({ taskId });
  requireTaskActor(request.actor);
  if (checkRev) work._assertRev(task, request);
  const pending = pendingTaskTransition(work);
  if (pending && (pending.phase !== phase || pending.taskId !== task.id || pending.rev !== task.rev)) {
    throw invalidOperation('task operation conflicts with an unfinished transition');
  }
  return task;
}

export function requireHuman(actor, operation) {
  if (actor?.kind !== 'human') throw new BoardError('forbidden-role', operation + ' is human only', { status: 403 });
}

export function currentIntent(work, task, intentId) {
  const intent = openIntentFor(work.state, task.id);
  if (!intent || intent.id !== intentId) throw invalidOperation('operation requires the current open intent');
  return intent;
}

export function assertNoOpenIntent(work, task) {
  const intent = openIntentFor(work.state, task.id);
  if (intent) throw new BoardError('intent-unresolved', 'open intent ' + intent.id + ' must be settled', {
    status: 409, details: { taskId: task.id, intentId: intent.id },
  });
}

export function taskEvent(type, task) {
  return { type: 'task/' + type, taskId: task.id, rev: task.rev, data: task };
}

export function workEvent(type, intent) {
  return { type: 'work/' + type, taskId: intent.taskId, data: intent };
}

export function changedTask(type, next, at, before = [], after = []) {
  touchTask(next, at);
  return { events: [...before, taskEvent(type, next), ...after], entityRev: next.rev };
}

export function revokeTaskLease(work, lease) {
  if (!lease) return [];
  work.leases.delete(lease.taskId);
  return [leaseRevokedEvent(lease)];
}
