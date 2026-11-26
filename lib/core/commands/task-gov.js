// Governance policy decides who may request each transition and supplies the
// intent declaration, not an abandoned-intent record or replacement task.
import { BoardError } from '../errors.js';
import { TERMINAL_STATES, TASK_STATES } from '../../shared/contract.js';
import { openIntentFor } from '../domain/task-facts.js';
import { assertTaskBlock, assertTaskUnblock, assertTaskRelease, assertTaskReconcile, assertTaskOpen } from '../domain/task-transitions.js';
import { cancelDecision, stoppedIntentDecision } from '../business/task-policy.js';
import { normalizeSideEffects } from '../intent.js';
import { observeReviewEvidence } from './task-evidence.js';
import { assertRecoveryAuthority } from '../domain/task-authority.js';

export function stoppedIntent(read, cmd, task, closeReason) {
  return stoppedIntentDecision(task, openIntentFor(read.state, task.id), cmd, closeReason);
}

function currentTask(read, cmd) {
  const task = read._requireTask(cmd);
  read._assertRev(task, cmd);
  return task;
}

export function taskBlock(read, cmd) {
  const task = currentTask(read, cmd);
  assertTaskBlock(task);
  if (cmd.actor?.kind !== 'human') {
    if (!read._leaseOf(task.id)) throw new BoardError('forbidden-role', 'only the lease owner or a human can block', { status: 403 });
    read._assertLease(task, cmd);
  }
  return { operations: [
    { kind: 'task.parkForBlocker', args: { taskId: task.id, stopped: stoppedIntent(read, cmd, task, 'blocked'), code: cmd.code, note: cmd.note } },
  ] };
}

export function taskInterrupt(read, cmd) {
  const task = currentTask(read, cmd);
  if (task.state === 'interrupted') throw new BoardError('illegal-transition', 'task is already interrupted', { status: 409 });
  const note = String(cmd.note || '').trim();
  if (!note) throw new BoardError('invalid-command', 'interrupt requires a note', { status: 400 });
  const isHuman = cmd.actor?.kind === 'human';
  const legacyRepair = openIntentFor(read.state, task.id) && !TERMINAL_STATES.includes(task.state);
  if (task.state !== 'in_progress' && !(isHuman && legacyRepair)) {
    throw new BoardError('illegal-transition', 'interrupt is only valid for in_progress, or a human repairing an open intent in another non-terminal state', { status: 409 });
  }
  if (!isHuman && read._lapsed?.reclaimed?.taskId !== task.id) read._assertLease(task, cmd);
  return { operations: [{ kind: 'task.flagInterruptedWork', args: { taskId: task.id, note, sideEffects: normalizeSideEffects(cmd.sideEffects) } }] };
}

export function taskUnblock(read, cmd) {
  const task = currentTask(read, cmd);
  assertTaskUnblock(task);
  return { operations: [{ kind: 'task.clearBlocker', args: { taskId: task.id, reason: String(cmd.note || cmd.reason || '').trim() } }] };
}

export function taskRelease(read, cmd) {
  const task = currentTask(read, cmd);
  read._assertLease(task, cmd);
  assertTaskRelease(task);
  return { operations: [
    { kind: 'task.returnHeldWorkToPool', args: { taskId: task.id, stopped: stoppedIntent(read, cmd, task, 'released') } },
  ] };
}

export function taskReconcile(read, cmd) {
  const task = currentTask(read, cmd);
  assertTaskReconcile(task);
  const note = String(cmd.note || '').trim();
  if (!note) throw new BoardError('invalid-command', 'reconcile requires a note', { status: 400 });
  const args = { taskId: task.id, note };
  if (cmd.choice === 'completed') {
    assertRecoveryAuthority(read, task, cmd);
    const review = observeReviewEvidence(read, task, Array.isArray(cmd.evidence) ? cmd.evidence : [], cmd.actor, 'reconcile');
    return { operations: [
      { kind: 'evidence.stageRecoveredWork', args: { ...args, ...review } },
      { kind: 'task.enterReviewFromRecovery', args: { taskId: task.id } },
    ] };
  }
  if (cmd.choice === 'resume') return { operations: [
    { kind: 'task.resumeInterruptedWork', args: { ...args, intentId: read.newId('int') } },
  ] };
  if (cmd.choice === 'discard') return { operations: [
    { kind: 'task.discardInterruptedWork', args },
  ] };
  throw new BoardError('invalid-command', 'choice must be resume|completed|discard', { status: 400 });
}

export function taskCancel(read, cmd) {
  const task = currentTask(read, cmd);
  assertTaskOpen(task);
  // Gate authorization precedes lease observation.
  cancelDecision(task, cmd.actor, null);
  const lease = read._leaseOf(task.id);
  cancelDecision(task, cmd.actor, lease);
  if (cmd.actor?.kind !== 'human' && lease) read._assertLease(task, cmd);
  return { operations: [
    { kind: 'task.cancelOpenWork', args: { taskId: task.id, stopped: stoppedIntent(read, cmd, task, 'canceled'), reason: cmd.reason } },
  ] };
}

export function taskReopen(read, cmd) {
  const task = currentTask(read, cmd);
  if (cmd.actor?.kind !== 'human') throw new BoardError('forbidden-role', 'reopen is human only', { status: 403 });
  return { operations: [{ kind: 'task.reopenClosedWork', args: { taskId: task.id, reason: cmd.reason } }] };
}

export function override(read, cmd) {
  if (cmd.actor?.kind !== 'human') throw new BoardError('forbidden-role', 'override is human only', { status: 403 });
  const task = currentTask(read, cmd);
  if (!TASK_STATES.includes(cmd.toState)) throw new BoardError('invalid-command', 'invalid target state', { status: 400 });
  return { operations: [
    { kind: 'task.applyHumanOverride', args: { taskId: task.id, stopped: stoppedIntent(read, cmd, task, 'override'), toState: cmd.toState, reason: cmd.reason } },
  ] };
}
