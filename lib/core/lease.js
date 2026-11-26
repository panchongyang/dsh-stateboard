import { BoardError } from './errors.js';
import { leaseReclaimable, renewalExpiry } from './business/lease-policy.js';
import { grantRuntimeLease, leaseGrantDenial, markRuntimeLeaseProgress, renewRuntimeLease, expireRuntimeLease } from './domain/lease-transitions.js';
import { policyOf } from './normalize.js';
import { leaseExpiredEvent, releaseEvents, releasedTaskState } from './contracts.js';
import { openIntentFor, taskDepsSatisfied } from './model.js';

// Lease and guard helpers. They take the ProjectHandle as their first argument
// instead of living on it, so the handle keeps its public surface while the
// lease arithmetic — and its injected-clock edge cases — sit in one file.

export function nowMs(handle) {
  return handle.clock().getTime();
}

function archivedPlanDenial(state, task) {
  const head = task.planRef && state.planHeads?.[task.planRef.planId];
  if (head?.status !== 'archived') return null;
  return new BoardError('plan-archived', 'the plan of this task is archived; unarchive it before entering work', {
    status: 409,
    details: { taskId: task.id, planId: task.planRef.planId },
  });
}

/** Every path that enters in_progress must check the task's plan is not archived. */
export function assertPlanActive(handle, task) {
  const denial = archivedPlanDenial(handle.state, task);
  if (denial) throw denial;
}

export function requireTask(handle, cmd) {
  if (typeof cmd.taskId !== 'string' || cmd.taskId === '') throw new BoardError('invalid-command', 'taskId is required', { status: 400 });
  const task = handle.state.tasks[cmd.taskId];
  if (!task) throw new BoardError('not-found', 'task not found: ' + cmd.taskId, { status: 404 });
  return task;
}

function revisionDenial(handle, task, cmd) {
  const expected = cmd.expected?.entityRev;
  // Only the exact revision produced by the preparatory sweep aliases the public one.
  // After any independent task edit the working revision must stand on its own.
  const anchor = handle._lapsed?.baseRevs.get(task.id);
  const currentRev = anchor && task.rev === anchor.prepared ? anchor.committed : task.rev;
  if (Number.isInteger(expected) && expected === currentRev) return null;
  return new BoardError('stale-revision', 'task ' + task.id + ' rev is ' + currentRev + (Number.isInteger(expected) ? ', expected ' + expected : '; expectedRev is required'), {
    status: 409,
    details: { currentRev, taskId: task.id },
  });
}

export function assertRev(handle, task, cmd) {
  const denial = revisionDenial(handle, task, cmd);
  if (denial) throw denial;
}

/** True when the lease may be reclaimed: detached/moved binding, stale lastSeen, or past grace. */
export function isLeaseReclaimable(handle, lease, now = nowMs(handle)) {
  return leaseReclaimable(handle.state, lease, policyOf(handle.state.project), now);
}

/** All lease arithmetic goes through the injected clock: tests can move time by hand. */
export function leaseOf(handle, taskId, now) {
  const lease = handle.leases.get(taskId) || null;
  // Expired is not dead: a live binding may still renew inside the grace window.
  // Reclaimable means the lease must be swept (dead binding, epoch moved, or past grace).
  if (lease && isLeaseReclaimable(handle, lease, now)) return null;
  return lease;
}

/** Why core cannot grant a new lease to the previous assignee without a claim. */
export function assigneeResumeDenial(handle, assignee) {
  if (!assignee) return 'no-assignee';
  if (typeof assignee.sessionId !== 'string' || assignee.sessionId === '') return 'assignee-gone';
  const binding = handle.state.bindings[assignee.sessionId];
  if (!binding || binding.detachedAt) return 'assignee-gone';
  if (assignee.epoch != null && binding.epoch != null && assignee.epoch !== binding.epoch) return 'assignee-gone';
  if (binding.autoResume === false) return 'explicit-claim';
  const policy = policyOf(handle.state.project);
  const now = nowMs(handle);
  const lastSeen = Date.parse(binding.lastSeenAt || binding.boundAt || '');
  if (Number.isFinite(lastSeen) && now - lastSeen >= policy.leaseTtlSec * 1000 + policy.leaseGraceSec * 1000) return 'assignee-gone';
  if (sessionLeaseCount(handle, assignee.sessionId, now) >= policy.maxPerSession) return 'assignee-busy';
  return null;
}

export function sessionLeaseCount(handle, sessionId, now) {
  // Expired-but-renewable leases still hold a WIP slot; reclaimable ones do not.
  return [...handle.leases.values()].filter((lease) => lease.sessionId === sessionId && leaseOf(handle, lease.taskId, now)).length;
}

/**
 * Command callers pass the request and use the already-swept working state.
 * Read callers preview the same expiry for eligibility and have no CAS input.
 */
function claimDenial(handle, task, actor, now, command) {
  const state = handle.state;
  const phase = state.project.phase;
  if (handle.readOnly) return new BoardError('read-only', 'another process holds this project lock', { status: 503 });
  if (phase !== 'active') return new BoardError('project-inactive', 'project is ' + phase, { status: 409 });
  if (leaseOf(handle, task.id, now)) return new BoardError('lease-held', 'task is already leased', { status: 409 });
  const denial = archivedPlanDenial(state, task) || (command && revisionDenial(handle, task, command));
  if (denial) return denial;

  const releases = (item) => {
    if (command || item.state !== 'in_progress') return false;
    const lease = handle.leases.get(item.id);
    return Boolean(lease && isLeaseReclaimable(handle, lease, now));
  };
  const claimState = releases(task) ? releasedTaskState(state, task.id) : task.state;
  if (claimState !== 'ready') return new BoardError('illegal-transition', 'task is ' + claimState + ', not ready', { status: 409 });
  if (!taskDepsSatisfied(state, task)) return new BoardError('dependency-unmet', 'dependencies are not done', { status: 409 });
  const policy = policyOf(state.project);
  const inProgress = Object.values(state.tasks).filter((item) => item.state === 'in_progress' && !releases(item)).length;
  if (inProgress >= policy.maxInProgress) return new BoardError('illegal-transition', 'project WIP limit reached (' + policy.maxInProgress + ')', { status: 409 });
  if (actor?.kind !== 'human' && sessionLeaseCount(handle, actor?.sessionId, now) >= policy.maxPerSession) {
    return new BoardError('illegal-transition', 'session WIP limit reached (' + policy.maxPerSession + ')', { status: 409 });
  }
  return leaseGrantDenial(state, task.id, actor);
}

export function assertClaimAllowed(handle, task, cmd) {
  const denial = claimDenial(handle, task, cmd.actor, nowMs(handle), cmd);
  if (denial) throw denial;
}

export function previewClaimDenial(handle, task, actor, now) {
  return claimDenial(handle, task, actor, now, null);
}

/** The binding that took a lease is still the same live session generation. */
export function leaseBindingCurrent(state, lease) {
  const binding = state.bindings[lease.sessionId];
  return Boolean(binding && !binding.detachedAt && (binding.epoch ?? 0) === (lease.epoch ?? 0));
}

/** Who may recover a lapsed lease with interrupt/reconcile: a human, or its own session generation. */
export function canRecoverLapsed(state, lease, actor = {}) {
  if (actor.kind === 'human') return true;
  return actor.sessionId === lease.sessionId && leaseBindingCurrent(state, lease);
}

function lapsedLease(handle, taskId) {
  const lapsed = handle._lapsed?.expired.get(taskId);
  if (lapsed) return lapsed;
  const raw = handle.leases.get(taskId);
  return raw && isLeaseReclaimable(handle, raw) ? raw : null;
}

/** lease-expired with a next step the caller can actually run. */
export function leaseExpiredError(handle, task, cmd, reason = 'no-live-lease') {
  const lapsed = lapsedLease(handle, task.id);
  const intent = openIntentFor(handle.state, task.id);
  const details = { taskId: task.id, reason };
  let message;
  if (lapsed && intent && canRecoverLapsed(handle.state, lapsed, cmd.actor)) {
    details.hint = 'interrupt-or-reconcile';
    details.next = 'The lease expired with an open intent. Recover with op=interrupt (note) or op=reconcile (choice), passing the expired lease\'s fencingToken; renew cannot revive it.';
    message = 'lease for ' + task.id + ' expired with open intent ' + intent.id + '; recover it with task.interrupt or task.reconcile and the expired fencing token';
  } else if (lapsed && intent) {
    details.hint = 'human-interrupt';
    details.next = 'Only the session generation that held the expired lease, or a human, can interrupt or reconcile this task. Ask the human to interrupt it in the UI.';
    message = 'lease for ' + task.id + ' expired with an open intent held by another session generation';
  } else if (task.state === 'interrupted') {
    details.hint = 'reconcile';
    details.next = 'The task is interrupted. Run op=reconcile with choice=resume|completed|discard.';
    message = 'task ' + task.id + ' is interrupted; reconcile it';
  } else {
    details.hint = 'claim';
    details.next = 'No live lease and no open intent: claim the task again once it is ready.';
    message = 'no live lease for ' + task.id + '; claim it again';
  }
  return new BoardError('lease-expired', message, { status: 409, details });
}

export function assertLease(handle, task, cmd, { allowHuman = true, requireToken = true } = {}) {
  const lease = leaseOf(handle, task.id);
  if (!lease) throw leaseExpiredError(handle, task, cmd);
  if (requireToken && Number.isInteger(cmd.fencingToken) && cmd.fencingToken !== lease.token) {
    throw new BoardError('fencing-stale', 'fencing token is stale for ' + task.id, {
      status: 409,
      details: { currentToken: lease.token, supplied: cmd.fencingToken },
    });
  }
  if (requireToken && !Number.isInteger(cmd.fencingToken)) {
    throw new BoardError('fencing-stale', 'fencingToken is required; read the task/board first', { status: 409, details: { currentToken: lease.token } });
  }
  const actor = cmd.actor || {};
  if (actor.kind !== 'human' || !allowHuman) {
    if (actor.sessionId !== lease.sessionId) {
      throw new BoardError('lease-held', 'task ' + task.id + ' is leased by ' + lease.sessionId, { status: 409 });
    }
  }
  return lease;
}

export function grantLease(handle, task, actor, at) {
  return grantRuntimeLease(handle.state, handle.leases, task, actor, {
    at, now: nowMs(handle), ttlSec: policyOf(handle.state.project).leaseTtlSec,
  });
}

export function markLeaseProgress(handle, taskId) {
  return markRuntimeLeaseProgress(handle.leases, taskId, nowMs(handle));
}

/** Shared ceiling for implicit touch and explicit renew; neither is progress. */
export function leaseRenewalExpiry(handle, lease, now = nowMs(handle)) {
  return renewalExpiry(lease, policyOf(handle.state.project), now);
}

/**
 * Explicit in-memory renewal. No commit: the lease table is process state, and
 * the log only records grant/revoke/expire. Returns a result payload for the
 * command bus's memory-only path.
 */
export function renewLease(handle, cmd) {
  const task = requireTask(handle, cmd);
  if (lapsedLease(handle, task.id)) throw leaseExpiredError(handle, task, cmd, 'lapsed');
  if (task.state !== 'in_progress') {
    throw new BoardError('lease-expired', 'task ' + task.id + ' is ' + task.state + '; there is no lease to renew', {
      status: 409,
      details: { taskId: task.id, state: task.state, hint: task.state === 'interrupted' ? 'reconcile' : 'claim-or-reconcile' },
    });
  }
  assertRev(handle, task, cmd);
  const raw = handle.leases.get(task.id);
  if (!raw || isLeaseReclaimable(handle, raw)) {
    throw new BoardError('lease-expired', 'lease for ' + task.id + ' is reclaimable; reconcile or claim it again', { status: 409, details: { taskId: task.id, hint: 'reconcile' } });
  }
  const lease = assertLease(handle, task, cmd);
  const policy = policyOf(handle.state.project);
  const max = policy.maxRenewalsWithoutProgress;
  const now = nowMs(handle);
  const expiry = leaseRenewalExpiry(handle, lease, now);
  if (expiry === null) {
    throw new BoardError('lease-expired', 'renewal count or no-progress deadline reached; submit or reconcile', {
      status: 409,
      details: { taskId: task.id, renewCount: lease.renewCount, max, reason: 'renewal-limit', hint: 'submit-or-reconcile' },
    });
  }
  renewRuntimeLease(handle.state, lease, { now, expiry, actor: cmd.actor, token: cmd.fencingToken, max });
  return {
    events: [],
    memoryOnly: true,
    result: {
      taskId: task.id,
      lease: { ...lease },
      renewCount: lease.renewCount,
      maxRenewalsWithoutProgress: max,
    },
  };
}

export function collectExpiredLeases(handle) {
  const events = [];
  const at = handle.clock().toISOString();
  const now = nowMs(handle);
  for (const lease of [...handle.leases.values()]) {
    if (!isLeaseReclaimable(handle, lease, now)) continue;
    expireRuntimeLease(handle.leases, lease);
    events.push(...releaseEvents(handle, lease, at, 'lease/expired'));
  }
  return events;
}

/**
 * Derive every reclaimable lease's expiry from the private command draft.
 * The engine installs the returned facts before command assembly observes the
 * state; this helper never applies persistent state or publishes a partial write.
 *
 * An explicit recovery target needs the lapsed token and matching generation (or a human).
 * The batch may take responsibility for disposing of that task instead of the sweep.
 */
export function normalizeExpiredLeases(handle, identity, { recoverTaskId, deferDisposition = false } = {}) {
  const lapsed = { expired: new Map(), baseRevs: new Map(), reclaimed: null, pendingDisposition: null };
  handle._lapsed = lapsed;
  const events = [];
  const at = handle.clock().toISOString();
  const now = nowMs(handle);
  for (const lease of [...handle.leases.values()]) {
    if (!isLeaseReclaimable(handle, lease, now)) continue;
    const task = handle.state.tasks[lease.taskId];
    lapsed.expired.set(lease.taskId, lease);
    if (task && task.state === 'in_progress' && recoverTaskId === task.id) {
      assertRecoverable(handle, task, lease, identity);
      lapsed.reclaimed = lease;
      if (deferDisposition) {
        lapsed.pendingDisposition = task.id;
        expireRuntimeLease(handle.leases, lease);
        events.push(leaseExpiredEvent(lease));
        continue;
      }
    }
    expireRuntimeLease(handle.leases, lease);
    const released = releaseEvents(handle, lease, at, 'lease/expired');
    const transition = released.find(row => row.taskId === task?.id && (row.type === 'task/interrupted' || row.type === 'task/readied'));
    if (transition) lapsed.baseRevs.set(task.id, { committed: task.rev, prepared: transition.rev });
    events.push(...released);
  }
  return events;
}

function assertRecoverable(handle, task, lease, cmd) {
  const actor = cmd.actor || {};
  if (actor.kind === 'human') return;
  const recoverable = openIntentFor(handle.state, task.id)
    && canRecoverLapsed(handle.state, lease, actor)
    && Number.isInteger(cmd.fencingToken) && cmd.fencingToken === lease.token;
  if (recoverable) return;
  const reason = !openIntentFor(handle.state, task.id) ? 'no-open-intent'
    : (!canRecoverLapsed(handle.state, lease, actor) ? 'not-lease-session' : 'fencing-token');
  throw leaseExpiredError(handle, task, cmd, reason);
}
