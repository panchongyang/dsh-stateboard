// Task intake: create, edit, gate and promote a task to ready.
//
// Guards, error codes and event order are load-bearing: every body below is a verbatim
// move from service.js with `this` rebound to the handle.

import { BoardError } from '../errors.js';
import { TERMINAL_STATES, clone, isAuditGate, taskDepsSatisfied, touchTask } from '../model.js';
import { ensureAcyclic, mergeAcceptance, newAcceptance, resolveAuditGate } from '../normalize.js';
import { newId } from '../util.js';
import { taskStateEvent } from '../contracts.js';

export function taskCreate(handle, cmd) {
  if (!cmd.title || String(cmd.title).trim() === '') throw new BoardError('invalid-command', 'task title is required', { status: 400 });
  const acceptance = newAcceptance(cmd.acceptance);
  if (acceptance.length === 0) throw new BoardError('invalid-command', 'task needs at least one acceptance criterion', { status: 400 });
  const deps = Array.isArray(cmd.deps) ? cmd.deps.slice() : [];
  for (const dep of deps) {
    if (!handle.state.tasks[dep]) throw new BoardError('invalid-command', 'unknown dependency ' + dep, { status: 400 });
    if (dep === cmd.taskId) throw new BoardError('invalid-command', 'task cannot depend on itself', { status: 400 });
  }
  const at = new Date().toISOString();
  const task = {
    id: newId('tsk'),
    rev: 1,
    title: String(cmd.title).trim(),
    description: typeof cmd.description === 'string' ? cmd.description : '',
    state: deps.every((dep) => handle.state.tasks[dep].state === 'done') && deps.length > 0 ? 'ready' : (deps.length === 0 ? 'ready' : 'backlog'),
    priority: Number.isInteger(cmd.priority) ? cmd.priority : 100,
    weight: typeof cmd.weight === 'number' && cmd.weight > 0 ? cmd.weight : 1,
    labels: resolveAuditGate(cmd, null, cmd.actor).labels,
    requiresAudit: resolveAuditGate(cmd, null, cmd.actor).gate,
    deps,
    acceptance,
    evidence: [],
    workers: [],
    lastAudit: null,
    planRef: cmd.planRef || null,
    owner: null,
    assignee: null,
    work: null,
    blocker: null,
    createdAt: at,
    updatedAt: at,
  };
  return { events: [{ type: 'task/created', taskId: task.id, rev: 1, data: task }], entityRev: 1 };
}

export function taskGate(handle, cmd) {
  const task = handle._requireTask(cmd);
  handle._assertRev(task, cmd);
  if (TERMINAL_STATES.includes(task.state)) throw new BoardError('illegal-transition', 'task is already ' + task.state, { status: 409 });
  if (typeof cmd.requiresAudit !== 'boolean') {
    throw new BoardError('invalid-command', 'requiresAudit must be a boolean', { status: 400 });
  }
  const current = isAuditGate(task);
  if (cmd.actor?.kind !== 'human' && (task.state === 'review' || !cmd.requiresAudit)) {
    throw new BoardError('forbidden-role', 'agents cannot disable the audit gate; a human must do it', { status: 403, details: { gateLocked: true, reason: task.state === 'review' ? 'review-gate-locked' : 'gate-locked' } });
  }
  if (current === cmd.requiresAudit) return { events: [] };
  const next = clone(task);
  const gate = resolveAuditGate({ requiresAudit: cmd.requiresAudit }, task, cmd.actor);
  next.requiresAudit = gate.gate;
  next.labels = gate.labels;
  touchTask(next, new Date().toISOString());
  return { events: [{ type: 'task/updated', taskId: next.id, rev: next.rev, data: next }], entityRev: next.rev };
}

// Fields an edit without a lease may touch. They are the whole surface the op
// already exposes, so the list doubles as documentation for the audit event.
const META_FIELDS = ['title', 'description', 'priority', 'weight', 'deps', 'acceptance', 'labels', 'requiresAudit'];
const META_EDITABLE_STATES = new Set(['backlog', 'ready']);

function metaFieldsOf(cmd) {
  const fields = META_FIELDS.filter((field) => cmd[field] !== undefined);
  return fields;
}

function sameJson(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function taskUpdate(handle, cmd) {
  const task = handle._requireTask(cmd);
  handle._assertRev(task, cmd);
  // A terminal task is a closed record: editing it would rewrite history that
  // done/cancel already froze (reopen is the human-only way back).
  if (TERMINAL_STATES.includes(task.state)) {
    throw new BoardError('illegal-transition', 'task is already ' + task.state, { status: 409 });
  }
  const gate = resolveAuditGate(cmd, task, cmd.actor);
  const lease = handle._leaseOf(task.id);
  const humanNoLease = cmd.actor?.kind === 'human' && !lease;
  // Nobody owns backlog/ready work yet, so an agent may re-order the queue and
  // re-wire its dependencies without claiming it first. in_progress / review /
  // blocked still require the lease: there an edit races with live work.
  const metaNoLease = !lease && META_EDITABLE_STATES.has(task.state);
  if (!(humanNoLease || metaNoLease)) {
    handle._assertLease(task, cmd, { allowHuman: true, requireToken: false });
  }
  const next = clone(task);
  if (typeof cmd.title === 'string' && cmd.title.trim() !== '') next.title = cmd.title.trim();
  if (typeof cmd.description === 'string') next.description = cmd.description;
  if (Number.isInteger(cmd.priority)) next.priority = cmd.priority;
  if (typeof cmd.weight === 'number' && cmd.weight > 0) next.weight = cmd.weight;
  if (Array.isArray(cmd.deps)) {
    for (const dep of cmd.deps) if (!handle.state.tasks[dep]) throw new BoardError('invalid-command', 'unknown dependency ' + dep, { status: 400 });
    next.deps = cmd.deps.slice();
  }
  if (Array.isArray(cmd.acceptance)) next.acceptance = mergeAcceptance(task.acceptance, cmd.acceptance);
  ensureAcyclic(Object.values(handle.state.tasks).map((item) => ({ key: item.id, deps: item.id === task.id ? next.deps : item.deps })));
  next.labels = gate.labels;
  next.requiresAudit = gate.gate;
  // Deferring a ready task (a new unmet dependency) must not leave it claiming to
  // be ready. Promotion the other way stays manual: task.ready also checks acceptance.
  if (next.state === 'ready' && !taskDepsSatisfied(handle.state, next)) next.state = 'backlog';
  const at = new Date().toISOString();
  touchTask(next, at);
  const changed = metaFieldsOf(cmd).filter((field) => !sameJson(task[field], next[field]));
  if (!sameJson(task.state, next.state)) changed.push('state');
  const events = [{ type: 'task/updated', taskId: next.id, rev: next.rev, data: next }];
  if (changed.length > 0) {
    events.push({
      type: 'task/meta-edited',
      taskId: next.id,
      rev: next.rev,
      data: {
        taskId: next.id,
        by: { kind: cmd.actor?.kind || 'system', sessionId: cmd.actor?.sessionId || null, agentId: cmd.actor?.agentId || null },
        fields: changed,
        reason: typeof cmd.reason === 'string' ? cmd.reason : '',
        at,
      },
    });
  }
  return { events, entityRev: next.rev };
}

export function taskReady(handle, cmd) {
  const task = handle._requireTask(cmd);
  handle._assertRev(task, cmd);
  if (task.state !== 'backlog') throw new BoardError('illegal-transition', 'task is ' + task.state + ', not backlog', { status: 409 });
  if (!taskDepsSatisfied(handle.state, task)) throw new BoardError('dependency-unmet', 'dependencies are not done', { status: 409 });
  if (!Array.isArray(task.acceptance) || task.acceptance.length === 0) throw new BoardError('acceptance-unmet', 'task has no acceptance criteria', { status: 422 });
  const next = clone(task);
  next.state = 'ready';
  touchTask(next, new Date().toISOString());
  return { events: [taskStateEvent(next)], entityRev: next.rev };
}
