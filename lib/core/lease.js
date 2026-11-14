import { BoardError } from './errors.js';
import { newId } from './util.js';
import { actorSystem, policyOf } from './normalize.js';
import { leaseExpiredEvent, releaseEvents, releasedTaskState } from './contracts.js';
import { applyEvent, openIntentFor, taskDepsSatisfied } from './model.js';

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
  // A task the in-command expiry just released still answers to its committed
  // rev: the caller could never have read the uncommitted one, so only that counts.
  const currentRev = handle._lapsed?.baseRevs.get(task.id) ?? task.rev;
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
  const policy = policyOf(handle.state.project);
  const graceMs = policy.leaseGraceSec * 1000;
  const hardUntil = Date.parse(lease.expiresAt) + graceMs;
  if (Number.isFinite(hardUntil) && now >= hardUntil) return true;
  const binding = handle.state.bindings[lease.sessionId];
  // A grant can precede/outlive the session event (tests, legacy logs). The lease
  // itself is still bounded by TTL+grace; missing binding is not extra liveness.
  if (!binding) return false;
  if (binding.detachedAt) return true;
  if (binding.epoch && lease.epoch && binding.epoch !== lease.epoch) return true;
  // A grant is itself activity: the new owner gets a full TTL even if its binding
  // lastSeenAt predates the grant; after that the normal lastSeen rule applies.
  const grantedAt = Date.parse(lease.grantedAt || '');
  if (Number.isFinite(grantedAt) && now - grantedAt < policy.leaseTtlSec * 1000) return false;
  // MCP sessions have no DSH heartbeat; explicit renewal is their liveness signal.
  const renewed = binding.source === 'mcp' ? Date.parse(lease.lastRenewedAt || '') : NaN;
  const seen = Date.parse(binding.lastSeenAt || binding.boundAt || '');
  const lastSeen = Number.isFinite(renewed) ? Math.max(renewed, seen) : seen;
  if (Number.isFinite(lastSeen) && now - lastSeen >= policy.leaseTtlSec * 1000 + graceMs) return true;
  return false;
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
  return null;
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
  const policy = policyOf(handle.state.project);
  const binding = handle.state.bindings[actor.sessionId];
  if (binding) binding.lastSeenAt = new Date(nowMs(handle)).toISOString();
  const token = (handle.state.counters.leaseToken || 0) + 1;
  handle.state.counters.leaseToken = token;
  const lease = {
    taskId: task.id,
    sessionId: actor.sessionId || (actor.kind === 'human' ? 'human:web' : 'unknown'),
    agentId: actor.agentId || actor.sessionId || 'human:web',
    epoch: handle.state.bindings[actor.sessionId]?.epoch || 0,
    token,
    acquiredAt: at,
    grantedAt: new Date(nowMs(handle)).toISOString(),
    expiresAt: new Date(nowMs(handle) + policy.leaseTtlSec * 1000).toISOString(),
    renewCount: 0,
    progressAt: new Date(nowMs(handle)).toISOString(),
    lastRenewedAt: null,
  };
  handle.leases.set(task.id, lease);
  return lease;
}

export function markLeaseProgress(handle, taskId) {
  const lease = handle.leases.get(taskId);
  if (!lease) return;
  lease.progressAt = new Date(nowMs(handle)).toISOString();
  lease.renewCount = 0;
  delete lease.mcpRenewals;
}

/** Shared ceiling for implicit touch and explicit renew; neither is progress. */
export function leaseRenewalExpiry(handle, lease, now = nowMs(handle)) {
  const policy = policyOf(handle.state.project);
  if ((lease.renewCount || 0) >= policy.maxRenewalsWithoutProgress) return null;
  const progress = Date.parse(lease.progressAt || lease.grantedAt || lease.acquiredAt || '');
  const ttlMs = policy.leaseTtlSec * 1000;
  const deadline = progress + (1 + policy.maxRenewalsWithoutProgress) * ttlMs;
  if (!Number.isFinite(deadline) || now >= deadline) return null;
  return Math.min(now + ttlMs, deadline);
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
  const isMcp = cmd.actor?.via === 'mcp';
  const duplicate = isMcp && (lease.mcpRenewals ?? []).includes(cmd.cmdId);
  const expiry = duplicate ? Date.parse(lease.expiresAt) : leaseRenewalExpiry(handle, lease, now);
  if (expiry === null) {
    throw new BoardError('lease-expired', 'renewal count or no-progress deadline reached; submit or reconcile', {
      status: 409,
      details: { taskId: task.id, renewCount: lease.renewCount, max, reason: 'renewal-limit', hint: 'submit-or-reconcile' },
    });
  }
  if (!duplicate) {
    lease.renewCount += 1;
    lease.lastRenewedAt = new Date(now).toISOString();
    lease.expiresAt = new Date(expiry).toISOString();
    if (isMcp) (lease.mcpRenewals ??= []).push(cmd.cmdId);
  }
  const { mcpRenewals, ...receipt } = lease;
  return {
    events: [],
    memoryOnly: true,
    result: {
      taskId: task.id,
      lease: receipt,
      ...(duplicate ? { deduped: true } : {}),
      renewCount: lease.renewCount,
      maxRenewalsWithoutProgress: max,
    },
  };
}

export function expireLeases(handle) {
  if (handle.readOnly) return;
  if (handle.state.project.phase === 'archived') return;
  const events = collectExpiredLeases(handle);
  if (events.length > 0) handle._appendEvents(events, actorSystem(), 'cmd_expire_' + newId('x'), handle.rev);
}

export function collectExpiredLeases(handle) {
  const events = [];
  const at = new Date().toISOString();
  const now = nowMs(handle);
  for (const lease of [...handle.leases.values()]) {
    if (!isLeaseReclaimable(handle, lease, now)) continue;
    handle.leases.delete(lease.taskId);
    events.push(...releaseEvents(handle, lease, at, 'lease/expired'));
  }
  return events;
}

const RECOVERY_OPS = new Set(['task.interrupt', 'task.reconcile']);

/**
 * Apply every reclaimable lease's expiry to the command's working projection
 * BEFORE the command reads it, so no business snapshot can be computed from the
 * pre-expiry task and overwrite the release. Returns the expiry events; the
 * caller commits them in front of the command's own events (or drops them all).
 *
 * interrupt/reconcile on the expired task itself is the recovery path. An agent
 * may take it only with an open intent, the expired lease's fencing token, and
 * the same session at the same live binding epoch. interrupt then performs the
 * task transition itself, so the expiry contributes only `lease/expired`.
 */
export function normalizeExpiredLeases(handle, cmd) {
  const lapsed = { expired: new Map(), baseRevs: new Map(), reclaimed: null };
  handle._lapsed = lapsed;
  const events = [];
  const at = new Date().toISOString();
  const now = nowMs(handle);
  for (const lease of [...handle.leases.values()]) {
    if (!isLeaseReclaimable(handle, lease, now)) continue;
    const task = handle.state.tasks[lease.taskId];
    lapsed.expired.set(lease.taskId, lease);
    if (task && task.state === 'in_progress' && RECOVERY_OPS.has(cmd?.op) && cmd.taskId === task.id) {
      assertRecoverable(handle, task, lease, cmd);
      lapsed.reclaimed = lease;
      if (cmd.op === 'task.interrupt') {
        handle.leases.delete(lease.taskId);
        events.push(leaseExpiredEvent(lease));
        continue;
      }
    }
    handle.leases.delete(lease.taskId);
    const released = releaseEvents(handle, lease, at, 'lease/expired');
    if (task && released.length > 1) lapsed.baseRevs.set(task.id, task.rev);
    for (const event of released) applyEvent(handle.state, structuredClone(event));
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
