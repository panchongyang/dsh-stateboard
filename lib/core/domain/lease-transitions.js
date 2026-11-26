// Runtime model operations. Accepted renewal is a fact, not a query projection.
import { BoardError } from '../errors.js';
import { leaseReclaimable, leaseRecipientDetached } from '../../shared/lease-facts.js';
import { policyOf } from '../normalize.js';

export function leaseGrantDenial(state, taskId, actor) {
  return leaseRecipientDetached(state, actor)
    ? new BoardError('lease-expired', 'session is detached; attach it again before requesting a work lease', {
      status: 409, details: { taskId, reason: 'session-detached', next: 'Attach the session again before requesting a work lease.' },
    })
    : null;
}

export function grantRuntimeLease(state, leases, task, actor, { at, now, ttlSec }) {
  const denial = leaseGrantDenial(state, task.id, actor);
  if (denial) throw denial;
  const binding = state.bindings[actor.sessionId];
  const token = (state.counters.leaseToken || 0) + 1;
  const lease = { taskId: task.id,
    sessionId: actor.sessionId || (actor.kind === 'human' ? 'human:web' : 'unknown'),
    agentId: actor.agentId || actor.sessionId || 'human:web', epoch: binding?.epoch || 0,
    token, acquiredAt: at, grantedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlSec * 1000).toISOString(), renewCount: 0,
    progressAt: new Date(now).toISOString(), lastRenewedAt: null };
  leases.set(task.id, lease);
  return lease;
}
export function markRuntimeLeaseProgress(leases, taskId, now) {
  const lease = leases.get(taskId);
  if (!lease) return;
  lease.progressAt = new Date(now).toISOString();
  lease.renewCount = 0;
}
export function renewRuntimeLease(state, lease, { now, expiry, actor, token, max }) {
  if (!lease || token !== lease.token) throw new BoardError('fencing-stale', 'renewal requires the current fencing token', { status: 409 });
  if (actor?.kind !== 'human' && actor?.sessionId !== lease.sessionId) throw new BoardError('lease-held', 'renewal requires the lease owner', { status: 409 });
  const binding = state.bindings[lease.sessionId];
  if (binding && (binding.detachedAt || (binding.epoch || 0) !== (lease.epoch || 0))) throw new BoardError('lease-expired', 'renewal cannot revive another session generation', { status: 409 });
  if (!Number.isFinite(expiry) || expiry <= now || (lease.renewCount || 0) >= max) throw new BoardError('lease-expired', 'renewal count or no-progress deadline reached; submit or reconcile', { status: 409 });
  lease.renewCount = (lease.renewCount || 0) + 1;
  lease.lastRenewedAt = new Date(now).toISOString();
  lease.expiresAt = new Date(expiry).toISOString();
  return lease;
}
export function expireRuntimeLease(leases, lease) {
  const current = leases.get(lease.taskId);
  if (current && current.token === lease.token) leases.delete(lease.taskId);
}

/** Trusted activity extends the current generation without spending explicit renewals.
 * All policy observations are supplied by the lifecycle command, never a query. */
export function activityRuntimeLease(state, lease, { now, expiry, sessionId, token, max, policy = policyOf(state.project) }) {
  if (!lease || token !== lease.token || sessionId !== lease.sessionId) return false;
  if (leaseReclaimable(state, lease, policy, now)) return false;
  const binding = state.bindings[sessionId];
  if (!binding || binding.detachedAt || (binding.epoch || 0) !== (lease.epoch || 0)) return false;
  if (!Number.isFinite(expiry) || expiry <= now || (lease.renewCount || 0) >= max) return false;
  lease.expiresAt = new Date(expiry).toISOString();
  return true;
}
