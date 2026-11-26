// Model operations on private task drafts. No I/O, clocks, IDs or caller services.
// A replay installs historical facts separately; it does not call these operations.
import { BoardError } from '../errors.js';
import { ACTIVE_STATES, TASK_STATES, TERMINAL_STATES } from '../../shared/contract.js';
import { appendWorker } from '../audit.js';

function from(task, states, message) {
  if (!states.includes(task.state)) throw new BoardError('illegal-transition', message || ('task is ' + task.state), { status: 409 });
}
function ownership(task, lease, at, cause, withCause = false) {
  if (!lease || lease.taskId !== task.id || !Number.isInteger(lease.token)) throw new BoardError('illegal-transition', 'entering work requires a lease for this task', { status: 409 });
  task.owner = { sessionId: lease.sessionId, agentId: lease.agentId, epoch: lease.epoch, fencingToken: lease.token, leaseUntil: lease.expiresAt };
  task.assignee = { sessionId: lease.sessionId, agentId: lease.agentId, epoch: lease.epoch, at, ...(withCause ? { cause } : {}) };
  appendWorker(task, lease, at, cause);
}
function pooled(task, state) {
  task.state = state;
  task.owner = null;
  task.assignee = null;
}

export function createTask(fields, dependenciesSatisfied) {
  if (Object.hasOwn(fields, 'state')) throw new BoardError('invalid-command', 'task creation does not accept a state', { status: 400 });
  return { ...fields, state: dependenciesSatisfied ? 'ready' : 'backlog' };
}
export function assertTaskBegin(task) { from(task, ['in_progress']); }
export function assertTaskSubmit(task) { from(task, ['in_progress']); }
export function assertTaskVerify(task) { from(task, ['review']); }
export function assertTaskReject(task) { from(task, ['review']); }
export function assertTaskBlock(task) { from(task, ['in_progress', 'review']); }
export function assertTaskRelease(task) { from(task, ['in_progress']); }
export function assertTaskUnblock(task) { from(task, ['blocked']); }
export function assertTaskReconcile(task) { from(task, ['interrupted'], 'task is ' + task.state + ', not interrupted'); }
export function assertTaskReady(task) { from(task, ['backlog'], 'task is ' + task.state + ', not backlog'); }
export function assertTaskOpen(task) {
  if (!ACTIVE_STATES.includes(task.state)) throw new BoardError('illegal-transition', 'task is already ' + task.state, { status: 409 });
}
export function claimTask(task, lease, at) {
  from(task, ['ready'], 'task is ' + task.state + ', not ready');
  ownership(task, lease, at, 'claim', true);
  task.state = 'in_progress';
  task.work = null;
  return task;
}
export function beginTaskAttempt(task, intent, lease, at) {
  assertTaskBegin(task);
  if (intent.taskId !== task.id || intent.status !== 'open' || lease.taskId !== task.id || intent.token !== lease.token
    || intent.attempt !== (task.work?.attempt || 0) + 1) {
    throw new BoardError('illegal-transition', 'work requires the new intent for the current lease', { status: 409 });
  }
  for (const evidence of task.evidence || []) {
    if (!evidence.supersededAt) {
      evidence.supersededAt = at;
      evidence.supersededBy = intent.id;
    }
  }
  for (const acceptance of task.acceptance) {
    acceptance.met = task.evidence.some(row => !row.supersededAt && row.acceptanceId === acceptance.id);
  }
  task.work = { intentId: intent.id, startedAt: at, attempt: intent.attempt };
  task.lastAudit = null;
  return task;
}

export function submitTask(task) {
  assertTaskSubmit(task);
  task.state = 'review';
  task.owner = null;
  task.work = task.work || null;
  return task;
}
export function verifyTask(task, at, byKind) {
  assertTaskVerify(task);
  task.state = 'done';
  task.owner = null;
  task.verifiedAt = at;
  task.verifiedBy = byKind;
  return task;
}
export function rejectTask(task, lease, at) {
  assertTaskReject(task);
  if (lease) { ownership(task, lease, at, 'reject'); task.state = 'in_progress'; }
  else pooled(task, 'ready');
  return task;
}
export function blockTask(task, blocker) {
  assertTaskBlock(task);
  task.blocker = { ...blocker, resumeTo: task.state };
  task.state = 'blocked';
  task.owner = null;
  return task;
}
export function interruptTask(task, interrupt, { humanRepair = false, hasOpenIntent = false } = {}) {
  if (task.state !== 'in_progress' && !(humanRepair && hasOpenIntent && ACTIVE_STATES.includes(task.state) && task.state !== 'interrupted')) {
    throw new BoardError('illegal-transition', 'interrupt is only valid for in_progress, or a human repairing an open intent in another non-terminal state', { status: 409 });
  }
  task.interrupt = { ...interrupt, previousState: task.state, previousAssignee: task.assignee || null, previousBlocker: task.blocker || null };
  pooled(task, 'interrupted');
  task.blocker = null;
  return task;
}
export function unblockTask(task, lease, at) {
  assertTaskUnblock(task);
  const resumeTo = task.blocker?.resumeTo;
  if (lease && resumeTo === 'review') throw new BoardError('illegal-transition', 'a review blocker must return to review without a lease', { status: 409 });
  if (lease) { ownership(task, lease, at, 'unblock'); task.state = 'in_progress'; }
  else if (resumeTo === 'review') { task.state = 'review'; task.owner = null; }
  else pooled(task, 'ready');
  task.blocker = null;
  return task;
}
export function releaseTask(task) {
  assertTaskRelease(task);
  pooled(task, 'ready');
  task.work = null;
  return task;
}
export function reconcileResumeTask(task, lease, intent, at) {
  assertTaskReconcile(task);
  ownership(task, lease, at, 'resume', true);
  task.state = 'in_progress';
  task.work = { intentId: intent.id, startedAt: at, attempt: intent.attempt };
  task.lastAudit = null;
  task.interrupt = null;
  return task;
}
export function reconcileCompletedTask(task, assignee) {
  assertTaskReconcile(task);
  task.state = 'review';
  task.owner = null;
  task.assignee = assignee;
  task.work = task.work || null;
  task.interrupt = null;
  return task;
}
export function reconcileDiscardTask(task) {
  assertTaskReconcile(task);
  pooled(task, 'ready');
  task.work = null;
  task.interrupt = null;
  return task;
}
export function cancelTask(task) {
  assertTaskOpen(task);
  task.state = 'canceled';
  task.owner = null;
  task.work = null;
  return task;
}
export function reopenTask(task, lease, depsOk, at) {
  if (!TERMINAL_STATES.includes(task.state)) throw new BoardError('illegal-transition', 'task is not terminal', { status: 409 });
  if (lease) {
    if (!depsOk) throw new BoardError('dependency-unmet', 'dependencies are not done', { status: 409 });
    ownership(task, lease, at, 'reopen'); task.state = 'in_progress';
  } else pooled(task, depsOk ? 'ready' : 'backlog');
  task.lastAudit = null;
  task.verifiedAt = null;
  task.verifiedBy = null;
  task.work = null;
  task.blocker = null;
  task.canceledReason = null;
  task.rejection = null;
  return task;
}
export function readyTask(task) { assertTaskReady(task); task.state = 'ready'; return task; }
export function deferTaskForDependencies(task) {
  from(task, ['ready']); task.state = 'backlog'; return task;
}
// Explicit repair escape hatch; deliberately not the normal transition interface.
export function humanOverrideTask(task, toState, actor) {
  if (actor?.kind !== 'human') throw new BoardError('forbidden-role', 'override is human only', { status: 403 });
  if (!TASK_STATES.includes(toState)) throw new BoardError('invalid-command', 'invalid target state', { status: 400 });
  task.state = toState;
  if (toState !== 'in_progress') { task.owner = null; task.assignee = null; }
  return task;
}
export function recoverReleasedTask(task, hasOpenIntent) {
  from(task, ['in_progress']);
  const next = structuredClone(task);
  pooled(next, hasOpenIntent ? 'interrupted' : 'ready');
  next.work = null;
  return next;
}
