import { allowedOps, currentPlan, isAuditGate, nextPriority, openIntentFor, progressOf } from './model.js';
import { sanitizeField } from './digest.js';
import { externalOperationRequired, isExternal } from './documents/external-model.js';
import { policyOf } from './normalize.js';
import { BoardError } from './errors.js';
import { leaseOf, nowMs, previewClaimDenial } from './lease.js';
import { stageWorkOf } from './plan-stages.js';

function byPriority(a, b) {
  return (a.priority ?? 100) - (b.priority ?? 100) || String(a.updatedAt).localeCompare(String(b.updatedAt));
}

function activeIntentSummary(state, task) {
  if (task.state !== 'in_progress') return null;
  const linked = state.intents[task.work?.intentId];
  const intent = linked?.taskId === task.id && linked.status === 'open'
    ? linked
    : openIntentFor(state, task.id);
  return intent ? { summary: sanitizeField(intent.summary, 160), startedAt: intent.startedAt ?? null } : null;
}

function cardOf(state, task) {
  const total = Array.isArray(task.acceptance) ? task.acceptance.length : 0;
  const met = Array.isArray(task.acceptance) ? task.acceptance.filter((item) => item.met).length : 0;
  return {
    id: task.id,
    title: task.title,
    state: task.state,
    rev: task.rev,
    priority: task.priority,
    labels: task.labels || [],
    deps: Array.isArray(task.deps) ? [...task.deps] : [],
    requiresAudit: isAuditGate(task),
    lastAudit: task.lastAudit || null,
    planRef: task.planRef || null,
    owner: task.owner || null,
    intent: activeIntentSummary(state, task),
    assignee: task.assignee || null,
    acceptance: { total, met },
    evidenceCount: Array.isArray(task.evidence) ? task.evidence.length : 0,
    blocked: task.blocker || null,
    createdBy: task.createdBy || null,
    updatedAt: task.updatedAt,
    verifiedAt: task.verifiedAt ?? null,
    verifiedBy: task.verifiedBy ?? null,
  };
}

function planProgress(state, plan) {
  if (!plan) return { total: 0, done: 0, percent: 0 };
  const ids = new Set((plan.steps || []).flatMap((step) => step.taskIds || []));
  const tasks = [...ids].map((id) => state.tasks[id]).filter(Boolean);
  const total = tasks.filter((task) => task.state !== 'canceled').length;
  const done = tasks.filter((task) => task.state === 'done').length;
  return { total, done, percent: total === 0 ? 0 : done / total };
}

/**
 * Documents associated with one task. doc.links is the single stored
 * direction, so the task side is derived here instead of duplicated.
 */
export function docsForTask(state, taskId) {
  const out = [];
  for (const doc of Object.values(state.docs || {})) {
    const ids = doc.links && Array.isArray(doc.links.taskIds) ? doc.links.taskIds : [];
    if (!ids.includes(taskId)) continue;
    out.push({ id: doc.id, rev: doc.rev, title: doc.title, kind: doc.kind, source: isExternal(doc) ? 'external' : 'inline', updatedAt: doc.updatedAt });
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return out;
}

const PLAN_STATUS_ORDER = { active: 0, draft: 1, archived: 2 };

function planSummary(state, head) {
  const version = head.currentVersion > 0 ? state.plans[head.id + '@' + head.currentVersion] : null;
  const steps = version ? (version.steps || []) : ((head.draft && head.draft.steps) || []);
  const ids = version ? steps.flatMap((step) => step.taskIds || []) : [];
  const tasks = ids.map((id) => state.tasks[id]).filter(Boolean);
  const total = tasks.filter((task) => task.state !== 'canceled').length;
  const done = tasks.filter((task) => task.state === 'done').length;
  return {
    id: head.id,
    title: head.title,
    status: head.status,
    rev: head.rev,
    currentVersion: head.currentVersion,
    focus: state.project.focusPlanId === head.id,
    stepCount: steps.length,
    taskCount: total,
    progress: { total, done, percent: total === 0 ? 0 : done / total },
    steps: steps.map((step) => ({
      id: step.id,
      title: step.title,
      taskIds: version ? [...(step.taskIds || [])] : [],
    })),
    archivedFrom: head.archivedFrom || null,
    createdBy: (version && version.createdBy) || head.createdBy || null,
    createdAt: head.createdAt || null,
    updatedAt: head.updatedAt || null,
  };
}

export function plansView(handle, params = {}) {
  const state = handle.state;
  const includeArchived = params.includeArchived !== false;
  const plans = Object.values(state.planHeads || {})
    .filter((head) => includeArchived || head.status !== 'archived')
    .map((head) => planSummary(state, head))
    .sort((a, b) => (PLAN_STATUS_ORDER[a.status] ?? 9) - (PLAN_STATUS_ORDER[b.status] ?? 9) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return { plans, focusPlanId: state.project.focusPlanId || null, rev: handle.rev };
}

export function boardView(handle) {
  const state = handle.state;
  const tasks = Object.values(state.tasks);
  // Offline salvage supplies a snapshot without a runtime clock or lease table.
  const now = typeof handle.clock === 'function' ? nowMs(handle) : null;
  const columns = { backlog: [], ready: [], in_progress: [], review: [], done: [] };
  const attention = { blocked: [], interrupted: [] };
  for (const task of tasks) {
    const column = columns[task.state] || attention[task.state];
    if (!column) continue;
    const card = cardOf(state, task);
    if (task.state === 'in_progress') {
      // Touch/renew can extend this time without updating the stored owner.
      const expiresAt = handle.leases?.get(task.id)?.expiresAt;
      const expiry = Date.parse(expiresAt || '');
      const known = Number.isFinite(expiry);
      column.push({
        ...card,
        leaseExpiresAt: known ? expiresAt : null,
        leaseExpired: known && now !== null ? expiry <= now : null,
      });
    } else {
      column.push(card);
    }
  }
  for (const key of Object.keys(columns)) columns[key].sort(byPriority);
  attention.blocked.sort(byPriority);
  attention.interrupted.sort(byPriority);
  const plans = Object.values(state.planHeads || {})
    .filter((head) => head.status === 'active')
    .map((head) => planSummary(state, head))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return {
    project: { ...state.project, policy: policyOf(state.project) },
    plan: currentPlan(state),
    focusPlanId: state.project.focusPlanId || null,
    plans,
    columns,
    attention,
    readyOrder: nextPriority(tasks, Infinity).map((task) => task.id),
    counts: progressOf(state),
    rev: handle.rev,
  };
}

export function taskView(handle, taskId, sessionId) {
  const state = handle.state;
  const task = state.tasks[taskId];
  if (!task) throw new BoardError('not-found', 'task not found: ' + taskId, { status: 404 });
  const raw = handle.leases.get(taskId) || null;
  const now = nowMs(handle);
  const lease = leaseOf(handle, taskId, now);
  const actor = sessionId ? { kind: 'agent', sessionId, agentId: state.bindings[sessionId]?.agentId || sessionId } : { kind: 'human' };
  const timeline = handle.timeline
    .filter((event) => event.taskId === taskId)
    .slice(-30);
  const plan = task.planRef
    ? state.plans[task.planRef.planId + '@' + task.planRef.version] || null
    : currentPlan(state);
  return {
    task,
    acceptance: task.acceptance || [],
    linkedDocs: docsForTask(state, taskId),
    evidence: task.evidence || [],
    timeline,
    plan,
    allowedOps: allowedOps(state, task, actor, { lease, lapsed: raw && !lease ? raw : null, claimReason: previewClaimDenial(handle, task, actor, now)?.message ?? null }),
    lease: raw,
    rev: handle.rev,
  };
}

export function planView(handle, planId) {
  const state = handle.state;
  let plan = null;
  if (planId) {
    const head = state.planHeads[planId];
    if (head && head.status === 'draft') {
      const draft = head.draft || {};
      // Draft steps keep their task definitions until publish. The editor needs
      // them to edit existing tasks; hiding them made a draft save replace the
      // whole task list with an empty one.
      const draftSteps = (draft.steps || []).map((step) => {
        const tasks = (step.tasks || []).map((task) => ({ ...task }));
        return {
          id: step.id,
          title: step.title,
          taskIds: tasks.map((task) => task.key).filter(Boolean),
          tasks,
        };
      });
      return {
        plan: {
          id: head.id, version: 0, status: 'draft', title: head.title,
          goal: draft.goal || '', assumptions: draft.assumptions || [], risks: draft.risks || [],
          steps: draftSteps, createdAt: head.createdAt, publishedAt: null,
        },
        head: planSummary(state, head),
        steps: draftSteps,
        progress: { total: 0, done: 0, percent: 0 },
        rev: handle.rev,
      };
    }
    const version = state.currentPlans[planId];
    plan = version ? state.plans[planId + '@' + version] || null : null;
    if (!plan) {
      const candidates = Object.values(state.plans).filter((item) => item.id === planId);
      candidates.sort((a, b) => b.version - a.version);
      plan = candidates[0] || null;
    }
  } else {
    plan = currentPlan(state);
  }
  if (!plan) return { plan: null, steps: [], progress: { total: 0, done: 0, percent: 0 }, rev: handle.rev };
  const steps = (plan.steps || []).map((step) => ({
    ...step,
    tasks: (step.taskIds || []).map((id) => state.tasks[id]).filter(Boolean).map((task) => cardOf(state, task)),
  }));
  const head = state.planHeads[plan.id] || null;
  return { plan, head: head ? planSummary(state, head) : null, steps, progress: planProgress(state, plan), rev: handle.rev };
}

function deliveryView(handle, state) {
  const commits = handle.store && Array.isArray(handle.store.commits) ? handle.store.commits : [];
  let checkpoint = null;
  const verified = [];
  for (let i = commits.length - 1; i >= 0; i -= 1) {
    if (checkpoint && verified.length >= 3) break;
    const commit = commits[i];
    for (const event of commit.events || []) {
      if (!checkpoint && event.type === 'session/checkpoint') {
        const data = event.data || {};
        checkpoint = { seq: commit.seq, at: String(data.at || commit.at || ''), note: String(data.note || '') };
      } else if (verified.length < 3 && event.type === 'task/verified') {
        const data = event.data || {};
        verified.push({ seq: commit.seq, taskId: String(data.id || event.taskId || ''), title: String(data.title || ''), requiresAudit: Boolean(data.requiresAudit), lastAudit: data.lastAudit || null });
      }
    }
  }
  const focusPlanId = state.project && state.project.focusPlanId;
  const head = focusPlanId && state.planHeads ? state.planHeads[focusPlanId] : null;
  const plan = head && head.currentVersion > 0 ? state.plans[head.id + '@' + head.currentVersion] : null;
  const progress = plan ? planProgress(state, plan) : null;
  return {
    checkpoint,
    verified,
    focusPlan: plan ? { id: plan.id, title: plan.title, version: head.currentVersion, percent: progress.percent } : null,
  };
}

export function briefView(handle, sessionId) {
  const state = handle.state;
  const tasks = Object.values(state.tasks);
  const counts = progressOf(state);
  const binding = sessionId ? state.bindings[sessionId] || null : null;
  const leases = sessionId ? [...handle.leases.values()].filter((lease) => lease.sessionId === sessionId) : [];
  const focusTask = leases.length > 0
    ? state.tasks[leases[0].taskId]
    : tasks.find((task) => task.state === 'review' && sessionId && task.owner && task.owner.sessionId === sessionId)
      || null;
  const attention = tasks
    .filter((task) => task.state === 'blocked' || task.state === 'interrupted')
    .sort(byPriority)
    .map((task) => cardOf(state, task));
  const heads = Object.values(state.planHeads || {});
  const health = handle.healthSummary();
  return {
    project: { ...state.project, policy: policyOf(state.project) },
    plans: {
      active: heads.filter((head) => head.status === 'active').length,
      draft: heads.filter((head) => head.status === 'draft').length,
      archived: heads.filter((head) => head.status === 'archived').length,
      focusPlanId: state.project.focusPlanId || null,
    },
    counts,
    session: { binding, leases },
    focus: focusTask ? { ...cardOf(state, focusTask), linkedDocs: docsForTask(state, focusTask.id) } : null,
    // The brief is a summary: a board with 2000 tasks must not ship every card
    // and every health warning just to show the next few.
    attention: attention.slice(0, 5),
    next: nextPriority(tasks).map((task) => cardOf(state, task)),
    stageWork: stageWorkOf(state, focusTask),
    delivery: deliveryView(handle, state),
    health: {
      ok: health.ok,
      evidenceAudit: health.evidenceAudit,
      total: health.total,
      warnings: health.warnings.slice(0, 5),
    },
    rev: handle.rev,
  };
}

export function docsView(handle) {
  // The list is metadata only: external rows keep their record shape (no body
  // hash or size) and every row names its source so old clients can ignore the
  // field while new ones route reads to the right endpoint.
  const docs = Object.values(handle.state.docs)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .map((doc) => ({ ...structuredClone(doc), source: isExternal(doc) ? 'external' : 'inline' }));
  return { docs, rev: handle.rev };
}

export function docView(handle, docId, maxBytes) {
  const doc = handle.state.docs[docId];
  if (!doc) throw new BoardError('not-found', 'doc not found: ' + docId, { status: 404 });
  if (isExternal(doc)) throw externalOperationRequired(docId, 'the inline doc view');
  const body = handle.store.readBlob(doc.hash);
  if (body === null) throw new BoardError('hash-chain-broken', 'document blob missing: ' + doc.hash, { status: 503 });
  const limit = Number.isInteger(maxBytes) ? maxBytes : 262144;
  const truncated = body.length > limit;
  return { doc, body: truncated ? body.slice(0, limit) : body, truncated, rev: handle.rev };
}

export function eventsView(handle, after, limit) {
  const start = Number.isInteger(after) ? after : 0;
  const count = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 500)) : 100;
  const events = handle.timeline.filter((event) => event.seq > start).slice(-count);
  return { events, rev: handle.rev };
}

export function healthView(handle) {
  return handle.health();
}
