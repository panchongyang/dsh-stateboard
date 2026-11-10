// Session commands and the event records attach/detach append.
//
// sessionNote is a verbatim move from service.js. The binding/release event
// construction lives here so ProjectHandle keeps only the lifecycle choreography
// (ensure-open, exclusive section, append). Event order is load-bearing.

import { BoardError } from '../errors.js';
import { releaseEvents } from '../contracts.js';
import { applyEvent } from '../model.js';

export function sessionNote(handle, cmd, type) {
  const sessionId = cmd.actor?.sessionId;
  if (!sessionId) throw new BoardError('forbidden-role', 'session note requires an agent session', { status: 403 });
  const note = String(cmd.note || '').trim();
  if (note === '') throw new BoardError('invalid-command', 'note is required', { status: 400 });
  const data = {
    sessionId,
    projectId: handle.id,
    note,
    nextActions: Array.isArray(cmd.nextActions) ? cmd.nextActions.map(String) : [],
    at: new Date().toISOString(),
  };
  return { events: [{ type, data }], entityRev: undefined };
}

export function sessionBinding(handle, sessionId, { source, role, agentId } = {}) {
  const at = handle.clock().toISOString();
  const existing = handle.state.bindings[sessionId];
  return {
    sessionId,
    agentId: agentId || existing?.agentId || sessionId,
    projectId: handle.id,
    role: role || existing?.role || 'worker',
    epoch: (existing?.epoch || 0) + 1,
    boundAt: at,
    lastSeenAt: at,
    source: source || 'startup',
  };
}

export function sessionBoundEvents(handle, sessionId, binding) {
  const at = binding.boundAt;
  const events = [];
  for (const lease of [...handle.leases.values()]) {
    if (lease.sessionId !== sessionId) continue;
    handle.leases.delete(lease.taskId);
    events.push(...releaseEvents(handle, lease, at));
  }
  events.push({ type: 'session/bound', data: binding });
  return events;
}

/** Bind a newly issued work session on the same working copy as its first claim. */
export function stageClaimBinding(handle, cmd, source, events) {
  const { sessionId, agentId } = cmd.actor ?? {};
  if (cmd.op !== 'task.claim' || cmd.actor?.kind !== 'agent' || !sessionId) {
    throw new BoardError('invalid-command', 'work session binding requires an agent claim', { status: 400 });
  }
  if (Object.hasOwn(handle.state.bindings, sessionId)) return;
  const data = { ...sessionBinding(handle, sessionId, { source, agentId }), autoResume: false };
  const event = { type: 'session/bound', data };
  applyEvent(handle.state, event);
  events.push(event);
}

export function sessionDetachedEvents(handle, sessionId, reason) {
  const at = handle.clock().toISOString();
  const binding = handle.state.bindings[sessionId];
  const events = [];
  for (const lease of [...handle.leases.values()]) {
    if (lease.sessionId !== sessionId) continue;
    handle.leases.delete(lease.taskId);
    events.push(...releaseEvents(handle, lease, at));
  }
  if (binding) {
    const next = { ...binding, detachedAt: at, lastSeenAt: at, reason };
    events.push({ type: 'session/detached', data: next });
  }
  return { at, binding, events };
}

export function sessionCheckpoint(handle, cmd) {
  return sessionNote(handle, cmd, 'session/checkpoint');
}

export function sessionHandoff(handle, cmd) {
  return sessionNote(handle, cmd, 'session/handoff');
}

export const SESSION_HANDLERS = {
  'session.checkpoint': sessionCheckpoint,
  'session.handoff': sessionHandoff,
};
