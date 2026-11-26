import { openIntentFor, taskDepsSatisfied } from './domain/task-facts.js';
export { openIntentFor, taskDepsSatisfied } from './domain/task-facts.js';
export { independenceProblem as auditIndependenceProblem, isAuditGate } from './audit.js';
import { ACTIVE_STATES, TASK_STATES, TERMINAL_STATES } from '../shared/contract.js';
import { assertEventSupported } from './domain/commit-envelope.js';
export { assertEventSupported } from './domain/commit-envelope.js';
import { BoardError } from './errors.js';
import { readyTask } from './domain/task-transitions.js';
import { applyExternalDocEvent, assertInlineDocEvent, EXTERNAL_EVENTS } from './documents/external-model.js';
import { applyContentFixed, assertFixedCommit } from './documents/fixed-reference.js';
import { applyRetainedVersionEvent, WORKSPACE_RETAINED_EVENT } from './domain/workspace-record.js';
import { applyDocumentRelationEvent, RELATION_EVENTS } from './domain/document-relations.js';

export { ACTIVE_STATES, TASK_STATES, TERMINAL_STATES };

export function emptyState(project) {
  return {
    schemaVersion: project.schemaVersion ?? 3,
    project: { focusPlanId: null, ...project, rev: 0 },
    tasks: {},
    plans: {},
    currentPlans: {},
    planHeads: {},
    docs: {},
    workspaceVersions: {},
    bindings: {},
    intents: {},
    audit: [],
    drifts: [],
    counters: { leaseToken: 0, taskSeq: 0, planSeq: 0, docSeq: 0, workspaceVersionSeq: 0 },
    lastSeq: 0,
    lastHash: 'genesis',
  };
}

export function planKey(id, version) {
  return id + '@' + version;
}

export function currentPlan(state) {
  const project = state.project || {};
  const id = project.focusPlanId || project.currentPlanId;
  if (!id) return null;
  const version = state.currentPlans[id];
  return version ? state.plans[planKey(id, version)] || null : null;
}

// Creation provenance is guaranteed by the commit actor, including older logs.
function authorshipOf(commit) {
  if (!commit || !commit.actor) return null;
  const actor = commit.actor;
  return {
    kind: actor.kind || 'system',
    sessionId: actor.sessionId || null,
    agentId: actor.agentId || null,
    at: commit.at || null,
  };
}

function stampCreatedBy(data, commit) {
  if (!data || typeof data !== 'object' || data.createdBy) return data;
  const by = authorshipOf(commit);
  if (by) data.createdBy = by;
  return data;
}

export function applyEvent(state, event, commit = null) {
  const data = event && event.data;
  // Fail closed: an event this build does not understand must not be guessed at.
  // Additive events are explicitly safe to ignore (a companion event in the
  // same commit carries the state); everything else refuses the whole open.
  const compatibility = assertEventSupported(state, event, commit);
  if (compatibility === 'additive') return;
  if (event.type === 'doc/content-fixed' || event.data?.evidence?.some((row) => Object.hasOwn(row, 'fixed'))) assertFixedCommit(state, commit || { events: [event] });
  // Defensive: replay may start from a snapshot written by an older schema.
  if (!state.planHeads) state.planHeads = {};
  if (!state.currentPlans) state.currentPlans = {};
  if (!state.workspaceVersions || typeof state.workspaceVersions !== 'object') state.workspaceVersions = {};
  if (!Number.isInteger(state.counters?.workspaceVersionSeq)) state.counters = { ...(state.counters || {}), workspaceVersionSeq: 0 };
  // Dispatch only after the registry check; unknown events never reach a
  // family handler, while explicitly registered audit events remain no-ops.
  const type = event.type;
  if (type.startsWith('plan/')) return applyPlanEvent(state, event, data, commit);
  if (type.startsWith('task/')) return applyTaskEvent(state, event, data, commit);
  if (type.startsWith('project/')) return applyProjectEvent(state, event, data);
  if (type.startsWith('doc/')) return applyDocEvent(state, event, data, commit);
  if (type.startsWith('session/')) return applySessionEvent(state, event, data);
  if (type.startsWith('work/')) return applyWorkEvent(state, event, data);
  if (type.startsWith('lease/')) return applyLeaseEvent(state, event, data);
  if (type === 'override/applied') return applyOverrideEvent(state, data);
}

// Exact projected types after the compatibility guard. Audit-only types are
// explicitly additive in the shared registry, never inferred from a prefix.
const TASK_EVENTS = new Set([
  'task/created', 'task/updated', 'task/readied', 'task/claimed', 'task/released',
  'task/submitted', 'task/verified', 'task/rejected', 'task/blocked', 'task/unblocked',
  'task/interrupted', 'task/reconciled', 'task/canceled', 'task/reopened', 'task/orphaned',
]);
const WORK_EVENTS = new Set(['work/intent', 'work/result', 'work/abandoned']);

function applyProjectEvent(state, event, data) {
  if (event.type === 'project/created' || event.type === 'project/updated') {
    state.project = data;
    if (Number.isInteger(data.schemaVersion)) state.schemaVersion = data.schemaVersion;
    else if (event.type === 'project/created') state.schemaVersion = 2;
  }
}

function applyPlanEvent(state, event, data, commit) {
  if (event.type === 'plan/created' || event.type === 'plan/published' || event.type === 'plan/revised') {
    stampCreatedBy(data, commit);
  }
  switch (event.type) {
    case 'plan/published':
    case 'plan/revised':
      state.plans[planKey(data.id, data.version)] = data;
      state.currentPlans[data.id] = data.version;
      if (event.head) {
        // New-style events carry the authoritative head snapshot. Old logs do
        // not, and normalizePlanHeads derives the head from plans instead.
        state.planHeads[data.id] = event.head;
      } else if (data.status === 'published') {
        state.project.currentPlanId = data.id;
      }
      break;
    case 'plan/created':
    case 'plan/updated':
    case 'plan/unarchived':
      state.planHeads[data.id] = data;
      break;
    case 'plan/archived':
      state.planHeads[data.id] = data;
      if (state.project.focusPlanId === data.id) state.project.focusPlanId = null;
      break;
    case 'plan/focused':
      state.project.focusPlanId = data.planId ?? null;
      break;
    case 'plan/superseded':
      state.plans[planKey(data.id, data.version)] = data;
      break;
    default:
      break;
  }
}

function applyTaskEvent(state, event, data, commit) {
  if (!TASK_EVENTS.has(event.type)) return;
  if (event.type === 'task/created') stampCreatedBy(data, commit);
  state.tasks[data.id] = data;
}

function applyDocEvent(state, event, data, commit) {
  if (event.type === 'doc/content-fixed') return applyContentFixed(state, event);
  if (event.type === WORKSPACE_RETAINED_EVENT) return applyRetainedVersionEvent(state, event, commit);
  if (RELATION_EVENTS.has(event.type)) return applyDocumentRelationEvent(state, event, commit);
  if (EXTERNAL_EVENTS.includes(event.type)) return applyExternalDocEvent(state, event, data, commit);
  if (event.type === 'doc/drift') state.drifts.push(data);
  else if (event.type === 'doc/created' || event.type === 'doc/updated') {
    assertInlineDocEvent(state, event, data, commit);
    state.docs[data.id] = data;
  }
}

function applySessionEvent(state, event, data) {
  if (event.type === 'session/bound' || event.type === 'session/detached') state.bindings[data.sessionId] = data;
}

function applyWorkEvent(state, event, data) {
  if (WORK_EVENTS.has(event.type)) state.intents[data.id] = data;
}

function applyLeaseEvent(state, event, data) {
  if (event.type !== 'lease/granted') return;
  state.counters.leaseToken = Math.max(state.counters.leaseToken, data.token || 0);
}

function applyOverrideEvent(state, data) {
  state.project.rev = data.projectRev ?? state.project.rev;
  state.audit.push(data);
}

/**
 * Derive planHeads for projects whose log predates the v2 head events, and
 * derive planHeads and focusPlanId without upgrading the store schema.
 * Pure and idempotent: replay, snapshot load and standalone opens all funnel
 * through this function; it emits no events and rewrites no history.
 */
export function normalizePlanHeads(state) {
  if (!state) return state;
  if (!state.planHeads || typeof state.planHeads !== 'object' || Array.isArray(state.planHeads)) {
    state.planHeads = {};
  }
  const project = state.project || (state.project = {});
  if (project.focusPlanId === undefined) project.focusPlanId = null;
  // A log that carried no head events at all is legacy; only such a state may
  // inherit focus from currentPlanId. An explicit null (plan.archive) must stay null.
  const headsWereEmpty = Object.keys(state.planHeads).length === 0;

  const versionsById = new Map();
  for (const key of Object.keys(state.plans || {})) {
    const at = key.lastIndexOf('@');
    if (at <= 0) continue;
    const pid = key.slice(0, at);
    const version = Number(key.slice(at + 1));
    if (!Number.isInteger(version)) continue;
    if (!versionsById.has(pid)) versionsById.set(pid, []);
    versionsById.get(pid).push(version);
  }
  for (const [pid, versions] of versionsById) {
    const head = state.planHeads[pid];
    if (head && Number.isInteger(head.currentVersion) && state.plans[planKey(pid, head.currentVersion)]) {
      continue; // existing head is already consistent with the version log
    }
    versions.sort((a, b) => a - b);
    const max = versions[versions.length - 1];
    const candidates = versions.map((v) => state.plans[planKey(pid, v)]).filter(Boolean);
    const newest = state.plans[planKey(pid, max)];
    const earliest = candidates.reduce((a, b) => (Date.parse(a.createdAt || 0) <= Date.parse(b.createdAt || 0) ? a : b), candidates[0] || newest);
    state.planHeads[pid] = {
      id: pid,
      title: (newest && newest.title) || pid,
      status: 'active',
      rev: 1,
      currentVersion: max,
      draft: null,
      archivedFrom: null,
      createdAt: (earliest && earliest.createdAt) || (newest && newest.createdAt) || null,
      updatedAt: (newest && newest.publishedAt) || (newest && newest.createdAt) || null,
    };
  }
  if (!project.focusPlanId && headsWereEmpty && project.currentPlanId) {
    const legacyHead = state.planHeads[project.currentPlanId];
    if (legacyHead && legacyHead.status === 'active') project.focusPlanId = project.currentPlanId;
  }
  if (project.focusPlanId) {
    const focusHead = state.planHeads[project.focusPlanId];
    // Heal the known archive artifact (old normalize resurrected an archived pointer).
    // Other invalid focus states stay visible to fsck/I18 instead of being silently fixed.
    if (focusHead && focusHead.status === 'archived') project.focusPlanId = null;
  }
  return state;
}

export function touchTask(task, at) {
  task.rev += 1;
  task.updatedAt = at;
  return task;
}



export function cascadeReady(state, events, at) {
  for (const task of Object.values(state.tasks)) {
    if (task.state !== 'backlog') continue;
    if (!taskDepsSatisfied(state, task)) continue;
    if (!Array.isArray(task.acceptance) || task.acceptance.length === 0) continue;
    const next = structuredClone(task);
    readyTask(next);
    touchTask(next, at);
    state.tasks[next.id] = next;
    events.push({ type: 'task/readied', taskId: next.id, rev: next.rev, data: next });
  }
}

export function addTaskEvent(events, type, task) {
  events.push({ type, taskId: task.id, rev: task.rev, data: task });
}

export function progressOf(state) {
  const tasks = Object.values(state.tasks);
  const counts = {
    total: tasks.length,
    backlog: 0,
    ready: 0,
    inProgress: 0,
    review: 0,
    done: 0,
    blocked: 0,
    interrupted: 0,
    canceled: 0,
  };
  let weightTotal = 0;
  let weightDone = 0;
  for (const task of tasks) {
    const key = task.state === 'in_progress' ? 'inProgress' : task.state;
    counts[key] = (counts[key] || 0) + 1;
    if (task.state !== 'canceled') {
      const weight = typeof task.weight === 'number' && task.weight > 0 ? task.weight : 1;
      weightTotal += weight;
      if (task.state === 'done') weightDone += weight;
    }
  }
  const percent = weightTotal === 0 ? 0 : weightDone / weightTotal;
  const doneTasks = tasks.filter((task) => task.state === 'done');
  const verified = doneTasks.filter((task) => task.verifiedAt).length;
  return {
    ...counts,
    weightTotal,
    weightDone,
    percent,
    verifiedPercent: doneTasks.length === 0 ? 0 : verified / doneTasks.length,
    attention: counts.interrupted + counts.blocked,
  };
}

export function evidenceKindOk(kind, requiredKinds) {
  if (!Array.isArray(requiredKinds) || requiredKinds.length === 0) return true;
  return requiredKinds.includes(kind);
}

export function nextPriority(tasks, limit = 3) {
  return tasks
    .filter((task) => task.state === 'ready')
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100) || String(a.createdAt).localeCompare(String(b.createdAt)))
    .slice(0, limit);
}

export function clone(value) {
  return structuredClone(value);
}

export function timestamp(instant) {
  return instant.toISOString();
}

export function id(prefix, allocateId) {
  return allocateId(prefix);
}

/** Model-local staging for the atomic verification + dependent promotion batch. */
export function stageVerifiedTask(state, task) {
  const previous = state.tasks[task.id];
  if (!previous || previous.state !== 'review' || task.state !== 'done' || task.owner) throw new BoardError('illegal-transition', 'verification must complete review without an owner', { status: 409 });
  state.tasks[task.id] = task;
}
