// Read-side policy hints, using the same facts and role decisions as commands.
import { ACTIVE_STATES, TERMINAL_STATES } from '../../shared/contract.js';
import { isAuditGate, verificationRoleProblem } from '../audit.js';
import { openIntentFor, taskDepsSatisfied } from '../../shared/value-facts.js';

/**
 * `lapsed` is a reclaimable lease still in the runtime table: the next write
 * expires it first, so only ops that remain valid after that expiry are offered.
 */
export function allowedOps(state, task, actor, { lease, lapsed, claimReason }) {
  const sessionId = actor.sessionId;
  const isHuman = actor.kind === 'human';
  const humanLease = Boolean(isHuman && lease && String(lease.sessionId || '').startsWith('human'));
  const ownsLease = Boolean(lease && ((sessionId && lease.sessionId === sessionId) || humanLease));
  const open = openIntentFor(state, task.id);
  const list = [];
  const add = (op, enabled, reason = null) => list.push({ op, enabled: Boolean(enabled), reason: enabled ? null : reason });
  const expired = Boolean(lapsed) && task.state === 'in_progress';
  const recoverer = expired && Boolean(open) && (isHuman || (sessionId === lapsed.sessionId
    && Boolean(state.bindings[sessionId]) && !state.bindings[sessionId].detachedAt
    && (state.bindings[sessionId].epoch ?? 0) === (lapsed.epoch ?? 0)));

  add('claim', claimReason === null, claimReason);
  add('begin', task.state === 'in_progress' && ownsLease && !open, expired ? 'the lease expired' : task.state !== 'in_progress' ? 'task is not in progress' : (!ownsLease ? 'you do not hold the lease' : 'an intent is already open'));
  add('submit', task.state === 'in_progress' && ownsLease, expired ? 'the lease expired' : task.state !== 'in_progress' ? 'task is not in progress' : 'you do not hold the lease');

  const blockable = (task.state === 'in_progress' && !expired) || task.state === 'review';
  const blockReason = expired ? 'the lease expired' : !blockable ? 'only in_progress/review can be blocked'
    : (isHuman ? null : (task.state === 'in_progress' ? 'you do not hold the lease' : 'human or lease owner only'));
  add('release', task.state === 'in_progress' && !expired && (ownsLease || isHuman), expired ? 'the lease expired' : task.state !== 'in_progress' ? 'task is not in progress' : 'you do not hold the lease');
  add('renew', task.state === 'in_progress' && !expired && (ownsLease || isHuman), expired ? 'the lease expired' : task.state !== 'in_progress' ? 'task is not in progress' : 'you do not hold the lease');
  add('block', blockable && (ownsLease || isHuman), blockReason);
  const interruptable = expired
    ? (isHuman || recoverer)
    : task.state === 'in_progress'
      ? (ownsLease || isHuman)
      : (Boolean(open) && isHuman && !TERMINAL_STATES.includes(task.state));
  const interruptReason = interruptable ? null
    : (expired ? 'the lease expired'
    : task.state === 'in_progress' ? 'you do not hold the lease'
    : (open ? 'human only for a legacy open intent' : 'task is not in progress'));
  add('interrupt', interruptable, interruptReason);
  add('unblock', task.state === 'blocked', 'task is not blocked');
  const gated = isAuditGate(task);
  const gateable = !TERMINAL_STATES.includes(task.state);
  add('gate', gateable && (isHuman || (actor.kind === 'agent' && task.state !== 'review' && !gated)), !gateable ? 'terminal task' : 'human only in review or to disable a gate');
  add('reconcile', task.state === 'interrupted' || recoverer, expired && open ? 'human or lease owner only' : 'task is not interrupted');
  const verifyProblem = task.state === 'review' ? verificationRoleProblem(task, actor) : 'task is not in review';
  add('verify', verifyProblem === null, verifyProblem);
  add('reject', task.state === 'review' && (isHuman || (actor.kind === 'agent' && (!lease || ownsLease))), task.state !== 'review' ? 'task is not in review' : 'human or live lease owner only');

  const cancelable = ACTIVE_STATES.includes(task.state);
  const cancelReason = !cancelable ? 'terminal task'
    : (gated && !isHuman ? 'only a human can cancel a gated task'
    : (lease && !ownsLease && !isHuman ? 'only the lease owner or a human can cancel' : null));
  add('cancel', cancelable && (ownsLease || isHuman || !lease) && !(gated && !isHuman), cancelReason);
  add('reopen', TERMINAL_STATES.includes(task.state) && isHuman, TERMINAL_STATES.includes(task.state) ? 'human only' : 'task is not terminal');

  const updatable = !TERMINAL_STATES.includes(task.state);
  add('update', updatable && (ownsLease || isHuman), !updatable ? 'terminal task' : (isHuman ? null : 'you do not hold the lease'));
  add('ready', task.state === 'backlog' && (isHuman || taskDepsSatisfied(state, task)), task.state !== 'backlog' ? 'not backlog' : 'deps are not done');
  add('override', isHuman, 'human only');
  return list;
}
