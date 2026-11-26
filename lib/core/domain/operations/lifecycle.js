// Private model operations for lifecycle and offline maintenance. Entry adapters
// choose names and parameters; only the model derives and installs their facts.
import { BoardError } from '../../errors.js';
import { releaseEvents, restartLeaseRecord } from '../../contracts.js';
import { collectExpiredLeases, isLeaseReclaimable, leaseRenewalExpiry, normalizeExpiredLeases } from '../../lease.js';
import { activityRuntimeLease } from '../lease-transitions.js';
import { actorSystem, policyOf } from '../../normalize.js';

function fields(args, allowed) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !allowed.includes(key))) {
    throw new BoardError('invalid-command', 'unsupported lifecycle operation arguments', { status: 400 });
  }
}
function sessionIdOf(args) {
  if (typeof args.sessionId !== 'string' || !args.sessionId) throw new BoardError('invalid-command', 'sessionId is required', { status: 400 });
  return args.sessionId;
}
function ephemeral(work) { return work.readOnly || work.state.project.phase === 'archived'; }

export function sessionBinding(work, sessionId, { source, role, agentId } = {}) {
  const at = work.clock().toISOString();
  const existing = work.state.bindings[sessionId];
  return { sessionId, agentId: agentId || existing?.agentId || sessionId, projectId: work.id,
    role: role || existing?.role || 'worker', epoch: (existing?.epoch || 0) + 1,
    boundAt: at, lastSeenAt: at, source: source || 'startup' };
}
function releaseSession(work, sessionId, at) {
  const events = [];
  for (const lease of [...work.leases.values()]) {
    if (lease.sessionId !== sessionId) continue;
    work.leases.delete(lease.taskId);
    events.push(...releaseEvents(work, lease, at));
  }
  return events;
}
function attach(work, args) {
  fields(args, ['sessionId', 'source', 'role', 'agentId']);
  const sessionId = sessionIdOf(args);
  const binding = sessionBinding(work, sessionId, args);
  if (ephemeral(work)) {
    work.setRuntimeBinding(sessionId, binding);
    return { events: [], memoryOnly: true, result: { binding } };
  }
  return { events: [...releaseSession(work, sessionId, binding.boundAt), { type: 'session/bound', data: binding }], result: { binding } };
}
function detach(work, args) {
  fields(args, ['sessionId', 'reason']);
  const sessionId = sessionIdOf(args);
  const binding = work.state.bindings[sessionId];
  const at = work.clock().toISOString();
  const next = binding && { ...binding, detachedAt: at, lastSeenAt: at, reason: args.reason || 'session-closed' };
  if (ephemeral(work)) {
    if (next) work.setRuntimeBinding(sessionId, next);
    return { events: [], memoryOnly: true };
  }
  const events = releaseSession(work, sessionId, at);
  if (next) events.push({ type: 'session/detached', data: next });
  return { events };
}
function restartFacts(work, args, preparing = false) {
  fields(args, []);
  if (ephemeral(work)) return { events: [] };
  const events = [], at = work.clock().toISOString();
  for (const task of Object.values(work.state.tasks)) {
    if (task.state !== 'in_progress' || (preparing && work.leases.has(task.id))) continue;
    const rows = releaseEvents(work, restartLeaseRecord(task), at, 'lease/expired');
    if (preparing) {
      // 公共 CAS 锚定调用者实际见过的版本，不能要求它预知草稿的恢复版本。
      work._lapsed.baseRevs.set(task.id, { committed: task.rev, prepared: rows[1].rev });
      for (const row of rows) row.actor = actorSystem();
    }
    events.push(...rows);
    work.leases.delete(task.id);
  }
  return { events };
}
function recover(work, args) { return restartFacts(work, args); }
function recoverBeforeCommand(work, args) { return restartFacts(work, args, true); }
function sweep(work, args) {
  fields(args, []);
  return { events: ephemeral(work) ? [] : collectExpiredLeases(work) };
}
function activity(work, args) {
  fields(args, ['sessionId']);
  const sessionId = sessionIdOf(args), binding = work.state.bindings[sessionId];
  if (ephemeral(work) || !binding || binding.detachedAt) return { events: [] };
  const now = work.clock().getTime();
  const leases = [...work.leases.values()].filter(lease => lease.sessionId === sessionId);
  // A refresh must not erase the stale binding that already invalidated a token.
  // Keep that anchor until a normal transaction records the pending expiry. Do
  // not remove the lease here: interrupt/reconcile still need its audit identity.
  if (leases.some(lease => isLeaseReclaimable(work, lease, now))) return { events: [] };
  for (const lease of leases) {
    const expiry = leaseRenewalExpiry(work, lease, now);
    activityRuntimeLease(work.state, lease, { now, expiry, sessionId, token: lease.token,
      max: policyOf(work.state.project).maxRenewalsWithoutProgress });
  }
  work.setRuntimeBinding(sessionId, { ...binding, lastSeenAt: new Date(now).toISOString() });
  return { events: [], memoryOnly: true };
}
function bootstrap(work, args) {
  fields(args, []);
  if (work.rev !== 0 || work.state.lastSeq !== 0) throw new BoardError('illegal-transition', 'bootstrap requires an empty project log', { status: 409 });
  return { events: [{ type: 'project/created', data: structuredClone(work.state.project) }] };
}
export function validateAcceptanceRepair(request) {
  if (!request || Object.keys(request).some(key => !['expectedRev', 'expectedHash', 'taskIds'].includes(key))
      || !Number.isSafeInteger(request.expectedRev) || request.expectedRev < 0
      || typeof request.expectedHash !== 'string' || !request.expectedHash
      || !Array.isArray(request.taskIds) || request.taskIds.some(id => typeof id !== 'string' || !id)) {
    throw new BoardError('invalid-command', 'repair requires only expectedRev, expectedHash and taskIds', { status: 400 });
  }
  return { expectedRev: request.expectedRev, expectedHash: request.expectedHash, taskIds: [...new Set(request.taskIds)] };
}
function restoreAcceptance(work, args) {
  const { expectedRev, expectedHash, taskIds } = validateAcceptanceRepair(args);
  if (work.rev !== expectedRev || work.state.lastHash !== expectedHash) {
    throw new BoardError('stale-revision', 'project changed since repair inventory', {
      status: 409, details: { currentRev: work.rev, currentHash: work.state.lastHash },
    });
  }
  if (work.state.project.phase === 'archived') throw new BoardError('project-archived', 'unarchive before maintenance', { status: 409 });
  for (const id of taskIds) if (!work.state.tasks[id]) throw new BoardError('not-found', 'repair task not found: ' + id, { status: 404 });
  const wanted = taskIds.filter(id => !work.state.tasks[id].acceptance?.length);
  const history = work.historicalAcceptance(wanted), at = work.clock().toISOString();
  const events = [...history].map(([id, acceptance]) => ({ type: 'task/updated', taskId: id,
    data: { ...structuredClone(work.state.tasks[id]), acceptance: structuredClone(acceptance), rev: work.state.tasks[id].rev + 1, updatedAt: at } }));
  return { events, result: { count: events.length } };
}
function firstCommandBinding(work, args, request, explicitGrantOnly) {
  fields(args, ['source']);
  const { sessionId, agentId } = request.actor || {};
  if (typeof args.source !== 'string' || !args.source.trim() || request.actor?.kind !== 'agent'
    || typeof sessionId !== 'string' || !sessionId.trim()) return { events: [] };
  // Presence is intentional: even an explicitly detached binding must remain
  // detached until a separately authorized lifecycle attach creates a new epoch.
  if (Object.hasOwn(work.state.bindings, sessionId)) return { events: [] };
  const binding = sessionBinding(work, sessionId, { source: args.source, agentId });
  // 普通工作会话沿用受派者的返工资格。仅显式领租模式不能据此自动接回工作。
  if (explicitGrantOnly) binding.autoResume = false;
  return { events: [{ type: 'session/bound', data: binding }] };
}
function bindForCommand(work, args, request) { return firstCommandBinding(work, args, request, false); }
function bindBeforeGrant(work, args, request) {
  fields(args, ['source']);
  const { sessionId } = request.actor || {};
  if (request.actor?.kind !== 'agent' || !sessionId) throw new BoardError('invalid-command', 'work session binding requires an explicit agent lease grant', { status: 400 });
  return firstCommandBinding(work, args, request, true);
}

export const LIFECYCLE_OPERATIONS = Object.freeze({
  'lifecycle.attach': attach,
  'lifecycle.detach': detach,
  'lifecycle.recover': recover,
  'lifecycle.sweep': sweep,
  'lifecycle.activity': activity,
  'lifecycle.bootstrap': bootstrap,
  'lifecycle.restoreAcceptance': restoreAcceptance,
});

function normalizeDue(work, args, identity) {
  fields(args, ['recoverTaskId', 'deferDisposition']);
  if ((args.recoverTaskId !== undefined && (typeof args.recoverTaskId !== 'string' || !args.recoverTaskId || args.recoverTaskId !== identity.taskId))
    || (args.deferDisposition !== undefined && (typeof args.deferDisposition !== 'boolean' || !args.recoverTaskId))) {
    throw new BoardError('invalid-command', 'lease recovery must identify the transaction target', { status: 400 });
  }
  return { events: normalizeExpiredLeases(work, identity, args) };
}

// These operations prepare a private transaction; they cannot be submitted as standalone lifecycle signals.
export const PREPARATION_OPERATIONS = Object.freeze({
  'lease.normalizeBeforeCommand': normalizeDue,
  'lifecycle.recoverBeforeCommand': recoverBeforeCommand,
  'session.bindBeforeGrant': bindBeforeGrant,
  'session.bindForCommand': bindForCommand,
});
