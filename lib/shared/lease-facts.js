// Pure lease facts over supplied state, policy, generation and clock values.
// No writer, business admission, I/O or ambient time is consulted.
export function leaseRecipientDetached(state, actor) {
  // Automatic reassignment supplies an identity without an actor kind. Only a
  // known detachment bars an agent grant; an absent binding is not detachment.
  return actor?.kind !== 'human' && typeof actor?.sessionId === 'string' && actor.sessionId !== ''
    && Boolean(state.bindings?.[actor.sessionId]?.detachedAt);
}

export function leaseReclaimable(state, lease, policy, now) {
  const graceMs = policy.leaseGraceSec * 1000;
  const hardUntil = Date.parse(lease.expiresAt) + graceMs;
  if (Number.isFinite(hardUntil) && now >= hardUntil) return true;
  const binding = state.bindings[lease.sessionId];
  if (!binding) return false;
  if (binding.detachedAt) return true;
  if (binding.epoch && lease.epoch && binding.epoch !== lease.epoch) return true;
  const grantedAt = Date.parse(lease.grantedAt || '');
  if (Number.isFinite(grantedAt) && now - grantedAt < policy.leaseTtlSec * 1000) return false;
  const lastSeen = Date.parse(binding.lastSeenAt || binding.boundAt || '');
  return Number.isFinite(lastSeen) && now - lastSeen >= policy.leaseTtlSec * 1000 + graceMs;
}
export function renewalExpiry(lease, policy, now) {
  if ((lease.renewCount || 0) >= policy.maxRenewalsWithoutProgress) return null;
  const progress = Date.parse(lease.progressAt || lease.grantedAt || lease.acquiredAt || '');
  const ttlMs = policy.leaseTtlSec * 1000;
  const deadline = progress + (1 + policy.maxRenewalsWithoutProgress) * ttlMs;
  if (!Number.isFinite(deadline) || now >= deadline) return null;
  return Math.min(now + ttlMs, deadline);
}
