import { BoardError } from '../errors.js';
import { canRecoverLapsed, leaseExpiredError } from '../lease.js';
import { openIntentFor } from './task-facts.js';
import { assertTaskReconcile } from './task-transitions.js';

export function requireTaskParticipant(actor) {
  if (actor?.kind !== 'human' && !(actor?.kind === 'agent' && typeof actor.sessionId === 'string' && actor.sessionId.trim())) {
    throw new BoardError('forbidden-role', 'a human or an identified agent is required', { status: 403 });
  }
}

export function assertLapsedWorkAuthority(work, task, request, lease) {
  if (request.actor.kind === 'human') return;
  const reason = !openIntentFor(work.state, task.id) ? 'no-open-intent'
    : !canRecoverLapsed(work.state, lease, request.actor) ? 'not-lease-session'
      : request.fencingToken !== lease.token ? 'fencing-token' : null;
  if (reason) throw leaseExpiredError(work, task, request, reason);
}

export function assertRecoveryAuthority(work, task, request) {
  requireTaskParticipant(request.actor);
  assertTaskReconcile(task);
  // A previously committed interrupted task retains the legacy authorization,
  // even if synthetic or historical data still contains a runtime lease.
  // If the interruption is provisional expiry, independently recheck its authority.
  const expired = work._lapsed?.expired.get(task.id);
  if (expired) assertLapsedWorkAuthority(work, task, request, expired);
}
