// Pure value eligibility hints. One implementation is shared by the live
// handle adapter, the published snapshot and the cold replay; projections only
// display the returned list and never decide eligibility themselves.
import { allowedOps } from '../business/task-operations.js';
import { leaseOf, previewClaimDenial } from '../lease.js';

// Operating a task needs a live runtime lease. A cold replay only has committed
// facts, so it must not present a lease-dependent operation as executable just
// because no local lease row was observed: the real command revalidates and may
// still find a different writer's lease.
const LEASE_REQUIRED = new Set(['begin', 'submit', 'release', 'renew']);
const LEASE_REQUIRED_FOR_AGENT = new Set(['reject', 'cancel']);
const UNKNOWN_RUNTIME_REASON = 'runtime lease state is unknown in a cold read; the command revalidates';

function markRuntimeUnknown(list, actor) {
  const agent = actor.kind !== 'human';
  return list.map((entry) => {
    if (!entry.enabled) return entry;
    if (!LEASE_REQUIRED.has(entry.op) && !(agent && LEASE_REQUIRED_FOR_AGENT.has(entry.op))) return entry;
    return { ...entry, enabled: false, reason: UNKNOWN_RUNTIME_REASON };
  });
}

export function taskHints({ state, leases, actor, now, readOnly = true, taskId, sessionId, runtimeUnknown = false }) {
  const leaseMap = leases instanceof Map ? leases : new Map((leases || []).map((lease) => [lease.taskId, lease]));
  const effectiveActor = actor && actor.kind
    ? actor
    : (sessionId
      ? { kind: 'agent', sessionId, agentId: state.bindings?.[sessionId]?.agentId || sessionId }
      : { kind: 'human' });
  const probe = { state, leases: leaseMap, readOnly };
  const task = state.tasks?.[taskId];
  if (!task) return { actor: effectiveActor, allowedOps: null, claimReason: null };
  const lease = leaseOf(probe, taskId, now);
  const raw = leaseMap.get(taskId) || null;
  const claimReason = previewClaimDenial(probe, task, effectiveActor, now)?.message ?? null;
  const ops = allowedOps(state, task, effectiveActor, {
    lease, lapsed: raw && !lease ? raw : null, claimReason,
  });
  return {
    actor: effectiveActor,
    claimReason,
    allowedOps: runtimeUnknown ? markRuntimeUnknown(ops, effectiveActor) : ops,
  };
}
