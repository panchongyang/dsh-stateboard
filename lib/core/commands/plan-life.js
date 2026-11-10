// Plan lifecycle: create, publish, revise, rename, archive/unarchive and focus.
//
// Membership commands live in plan-members.js; revisions preserve completed audit scope.

import { BoardError } from '../errors.js';
import { assertAuditScopeUnchanged } from '../audit.js';
import { clone, currentPlan, planKey, touchTask } from '../model.js';
import { ensureAcyclic, keyToIdHasValue, mergeAcceptance, normalizeSteps, resolveAuditGate } from '../normalize.js';
import { newId } from '../util.js';

export function planCreate(handle, cmd) {
  const title = String(cmd.title || '').trim();
  if (title === '') throw new BoardError('invalid-command', 'plan title is required', { status: 400 });
  assertTitleUnique(handle, title);
  const at = new Date().toISOString();
  const draft = {
    goal: typeof cmd.goal === 'string' ? cmd.goal : '',
    assumptions: Array.isArray(cmd.assumptions) ? cmd.assumptions.map(String) : [],
    risks: Array.isArray(cmd.risks) ? cmd.risks.map(String) : [],
    steps: Array.isArray(cmd.steps) ? cmd.steps : [],
  };
  return { events: [{ type: 'plan/created', data: draftHead(newId('pln'), title, draft, at) }], entityRev: 1 };
}

export function planPublish(handle, cmd) {
  const at = new Date().toISOString();
  const input = resolvePublishInput(handle, cmd, at);
  const steps = normalizeSteps(input.draftSteps);
  const defs = flattenDefs(steps);
  ensureAcyclic(defs);
  const keyToId = new Map();
  for (const def of defs) keyToId.set(def.key, newId('tsk'));
  const plan = planVersionPayload({
    id: input.planId,
    version: 1,
    title: input.title,
    goal: input.goal,
    assumptions: input.assumptions,
    risks: input.risks,
    steps: planStepIds(steps, keyToId),
    createdAt: input.head ? input.head.createdAt : at,
    publishedAt: at,
  });
  const nextHead = publishedHead(input, at);
  const events = [];
  if (input.createdHead) events.push({ type: 'plan/created', data: input.createdHead });
  events.push({ type: 'plan/published', data: plan, head: nextHead });
  appendCreatedTasks(events, defs, { keyToId, planId: input.planId, version: 1, cmd, at });
  appendAutoFocus(events, handle, input.planId, at);
  return { events, entityRev: nextHead.rev };
}

export function planRevise(handle, cmd) {
  const { planId, head } = resolveReviseHead(handle, cmd);
  const at = new Date().toISOString();
  if (head.status === 'draft') return reviseDraft(handle, cmd, head, at);
  return reviseActive(handle, cmd, planId, head, at);
}

// ---------------------------------------------------------------- shared shape

function draftHead(id, title, draft, at) {
  return { id, title, status: 'draft', rev: 1, currentVersion: 0, draft, archivedFrom: null, createdAt: at, updatedAt: at };
}
function flattenDefs(steps) {
  return steps.flatMap((step) => step.tasks.map((task) => ({ ...task, stepId: step.id })));
}
function planStepIds(steps, keyToId) {
  return steps.map((step) => ({
    id: step.id,
    title: step.title,
    taskIds: step.tasks.map((task) => keyToId.get(task.key)),
  }));
}
function planVersionPayload(fields) {
  const { id, version, title, goal, assumptions, risks, steps, createdAt, publishedAt, supersedes } = fields;
  const plan = {
    id,
    version,
    status: 'published',
    title,
    goal,
    assumptions,
    risks,
    steps,
    createdAt,
    publishedAt,
  };
  // A revise records the version it replaces; a first publish has nothing to name.
  if (supersedes !== undefined) plan.supersedes = supersedes;
  return plan;
}
function newTaskPayload(def, ctx) {
  const { id, deps, gate, planRef, at } = ctx;
  return {
    id,
    rev: 1,
    title: def.title,
    description: typeof def.description === 'string' ? def.description : '',
    state: deps.length === 0 ? 'ready' : 'backlog',
    priority: def.priority,
    weight: def.weight,
    labels: gate.labels,
    requiresAudit: gate.gate,
    deps,
    acceptance: def.acceptance,
    evidence: [],
    workers: [],
    lastAudit: null,
    planRef,
    owner: null,
    assignee: null,
    work: null,
    blocker: null,
    createdAt: at,
    updatedAt: at,
  };
}
function appendAutoFocus(events, handle, planId, at) {
  if (handle.state.project.focusPlanId) return;
  const project = clone(handle.state.project);
  project.focusPlanId = planId;
  project.updatedAt = at;
  events.push({ type: 'plan/focused', data: { planId, projectRev: handle.rev + 1 } });
  events.push({ type: 'project/updated', data: project });
}

// -------------------------------------------------------------------- publish

function resolvePublishInput(handle, cmd, at) {
  if (typeof cmd.planId === 'string' && cmd.planId !== '') {
    // Draft → active: materialize head.draft into version 1.
    const head = handle.state.planHeads[cmd.planId] || null;
    if (!head) throw new BoardError('plan-not-found', 'plan not found: ' + cmd.planId, { status: 404 });
    if (head.status === 'archived') throw new BoardError('plan-archived', 'plan is archived', { status: 409 });
    if (head.status !== 'draft') throw new BoardError('plan-not-draft', 'plan is ' + head.status + ', not draft', { status: 409 });
    assertHeadRev(handle, head, cmd);
    const draft = head.draft || {};
    return {
      head,
      planId: head.id,
      title: head.title,
      goal: typeof draft.goal === 'string' ? draft.goal : '',
      assumptions: Array.isArray(draft.assumptions) ? draft.assumptions.map(String) : [],
      risks: Array.isArray(draft.risks) ? draft.risks.map(String) : [],
      draftSteps: Array.isArray(draft.steps) ? draft.steps : [],
      createdHead: null,
    };
  }
  // Legacy behavior = create + publish in one commit; no more 409.
  const title = String(cmd.title || '').trim();
  if (title === '') throw new BoardError('invalid-command', 'plan title is required', { status: 400 });
  assertTitleUnique(handle, title);
  const planId = newId('pln');
  const goal = typeof cmd.goal === 'string' ? cmd.goal : '';
  const assumptions = Array.isArray(cmd.assumptions) ? cmd.assumptions.map(String) : [];
  const risks = Array.isArray(cmd.risks) ? cmd.risks.map(String) : [];
  const draftSteps = Array.isArray(cmd.steps) ? cmd.steps : [];
  return {
    head: null,
    planId,
    title,
    goal,
    assumptions,
    risks,
    draftSteps,
    createdHead: draftHead(planId, title, { goal, assumptions, risks, steps: draftSteps }, at),
  };
}
function publishedHead(input, at) {
  const { planId, title, head } = input;
  return {
    id: planId,
    title,
    status: 'active',
    rev: head ? head.rev + 1 : 2,
    currentVersion: 1,
    draft: null,
    archivedFrom: null,
    createdAt: head ? head.createdAt : at,
    updatedAt: at,
  };
}
function appendCreatedTasks(events, defs, ctx) {
  const { keyToId, planId, version, cmd, at } = ctx;
  for (const def of defs) {
    const deps = (def.deps || []).map((dep) => {
      if (!keyToId.has(dep)) throw new BoardError('invalid-command', 'unknown dependency key ' + dep, { status: 400 });
      return keyToId.get(dep);
    });
    const task = newTaskPayload(def, {
      id: keyToId.get(def.key),
      deps,
      gate: resolveAuditGate(def, null, cmd.actor),
      planRef: { planId, version, stepId: def.stepId },
      at,
    });
    events.push({ type: 'task/created', taskId: task.id, rev: 1, data: task });
  }
}

// --------------------------------------------------------------------- revise

function resolveReviseHead(handle, cmd) {
  let planId = typeof cmd.planId === 'string' && cmd.planId !== '' ? cmd.planId : null;
  if (!planId) {
    const legacy = currentPlan(handle.state);
    planId = legacy ? legacy.id : null;
  }
  const head = planId ? handle.state.planHeads[planId] || null : null;
  if (!planId || !head) throw new BoardError('plan-not-found', 'plan not found: ' + (cmd.planId || ''), { status: 404 });
  if (head.status === 'archived') throw new BoardError('plan-archived', 'plan is archived', { status: 409 });
  return { planId, head };
}
function reviseDraft(handle, cmd, head, at) {
  // Draft revise only rewrites head.draft; no version is created.
  assertHeadRev(handle, head, cmd);
  let nextTitle = head.title;
  if (typeof cmd.title === 'string' && cmd.title.trim() !== '') {
    nextTitle = cmd.title.trim();
    if (nextTitle.toLowerCase() !== String(head.title || '').toLowerCase()) assertTitleUnique(handle, nextTitle, head.id);
  }
  const draft = head.draft || {};
  const next = {
    ...head,
    title: nextTitle,
    rev: head.rev + 1,
    updatedAt: at,
    draft: {
      goal: typeof cmd.goal === 'string' ? cmd.goal : ((head.draft && head.draft.goal) || ''),
      assumptions: Array.isArray(cmd.assumptions) ? cmd.assumptions.map(String) : (Array.isArray(draft.assumptions) ? draft.assumptions : []),
      risks: Array.isArray(cmd.risks) ? cmd.risks.map(String) : (Array.isArray(draft.risks) ? draft.risks : []),
      steps: Array.isArray(cmd.steps) ? cmd.steps : (Array.isArray(draft.steps) ? draft.steps : []),
    },
  };
  return { events: [{ type: 'plan/updated', data: next }], entityRev: next.rev };
}
function revisedTitle(handle, cmd, head, oldPlan) {
  const nextTitle = typeof cmd.title === 'string' && cmd.title.trim() !== '' ? cmd.title.trim() : oldPlan.title;
  if (nextTitle.toLowerCase() !== String(head.title || '').toLowerCase()) assertTitleUnique(handle, nextTitle, head.id);
  return nextTitle;
}
function mapRevisedTaskIds(handle, defs) {
  const keyToId = new Map();
  for (const def of defs) {
    if (def.taskId) {
      // A revise only re-files tasks of this project. Silently minting a new id
      // for an unknown taskId made a typo look like a successful revision.
      if (!handle.state.tasks[def.taskId]) {
        throw new BoardError('invalid-command', 'taskId ' + def.taskId + ' is not in this project', { status: 400 });
      }
      keyToId.set(def.key, def.taskId);
    } else {
      keyToId.set(def.key, newId('tsk'));
    }
  }
  return keyToId;
}
function revisedDeps(handle, def, keyToId) {
  return (def.deps || []).map((dep) => {
    if (keyToId.has(dep)) return keyToId.get(dep);
    if (handle.state.tasks[dep]) return dep;
    throw new BoardError('invalid-command', 'unknown dependency ' + dep, { status: 400 });
  });
}
function reviseActive(handle, cmd, planId, head, at) {
  // Active revise: baseVersion must match head.currentVersion.
  const oldPlan = handle.state.plans[planKey(planId, head.currentVersion)];
  if (!oldPlan) throw new BoardError('not-found', 'plan version missing: ' + planKey(planId, head.currentVersion), { status: 404 });
  if (!Number.isInteger(cmd.baseVersion) || cmd.baseVersion !== head.currentVersion) {
    throw new BoardError('stale-revision', 'plan version is ' + head.currentVersion + ', expected ' + cmd.baseVersion, { status: 409, details: { currentVersion: head.currentVersion } });
  }
  const version = head.currentVersion + 1;
  const steps = normalizeSteps(cmd.steps);
  const defs = flattenDefs(steps);
  const keyToId = mapRevisedTaskIds(handle, defs);
  const planKeys = new Set(defs.map((def) => def.key));
  ensureAcyclic(defs.map((def) => ({ ...def, deps: (def.deps || []).filter((dep) => planKeys.has(dep)) })));
  const nextTitle = revisedTitle(handle, cmd, head, oldPlan);
  const plan = planVersionPayload({
    id: planId,
    version,
    title: nextTitle,
    goal: typeof cmd.goal === 'string' ? cmd.goal : oldPlan.goal,
    assumptions: Array.isArray(cmd.assumptions) ? cmd.assumptions.map(String) : oldPlan.assumptions,
    risks: Array.isArray(cmd.risks) ? cmd.risks.map(String) : oldPlan.risks,
    steps: planStepIds(steps, keyToId),
    createdAt: oldPlan.createdAt,
    publishedAt: at,
    supersedes: head.currentVersion,
  });
  const nextHead = { ...head, title: nextTitle, rev: head.rev + 1, currentVersion: version, updatedAt: at };
  const events = [];
  const oldNext = { ...oldPlan, status: 'superseded', supersededBy: { planId: plan.id, version } };
  events.push({ type: 'plan/superseded', data: oldNext });
  events.push({ type: 'plan/revised', data: plan, head: nextHead });
  const referenced = new Set();
  reviseTaskEvents(events, referenced, handle, cmd, defs, { keyToId, plan, version, at });
  appendOrphans(events, handle, oldPlan, referenced, keyToId, at);
  return { events, entityRev: version };
}
function reviseTaskEvents(events, referenced, handle, cmd, defs, ctx) {
  const { keyToId, plan, version, at } = ctx;
  for (const def of defs) {
    const id = keyToId.get(def.key);
    const deps = revisedDeps(handle, def, keyToId);
    const existing = handle.state.tasks[id];
    if (existing) {
      referenced.add(id);
      const next = clone(existing);
      next.title = def.title;
      next.description = typeof def.description === 'string' ? def.description : existing.description;
      next.priority = def.priority;
      next.weight = def.weight;
      const gate = resolveAuditGate(def, existing, cmd.actor);
      next.labels = gate.labels;
      next.requiresAudit = gate.gate;
      next.deps = deps;
      next.acceptance = mergeAcceptance(existing.acceptance, def.acceptance);
      assertAuditScopeUnchanged(existing, next);
      next.planRef = { planId: plan.id, version, stepId: def.stepId };
      if (next.state === 'backlog' && deps.every((dep) => handle.state.tasks[dep]?.state === 'done') && next.acceptance.length > 0) next.state = 'ready';
      touchTask(next, at);
      events.push({ type: 'task/updated', taskId: next.id, rev: next.rev, data: next });
    } else {
      if (def.acceptance.length === 0) {
        throw new BoardError('invalid-command', 'task "' + def.title + '" references taskId ' + def.taskId + ', which is not in this project; give it an acceptance criterion', { status: 400 });
      }
      const task = newTaskPayload(def, {
        id,
        deps,
        gate: resolveAuditGate(def, null, cmd.actor),
        planRef: { planId: plan.id, version, stepId: def.stepId },
        at,
      });
      events.push({ type: 'task/created', taskId: task.id, rev: 1, data: task });
    }
  }
}
function appendOrphans(events, handle, oldPlan, referenced, keyToId, at) {
  for (const taskId of oldPlan.steps.flatMap((step) => step.taskIds)) {
    if (referenced.has(taskId) || keyToIdHasValue(keyToId, taskId)) continue;
    const task = handle.state.tasks[taskId];
    if (!task) continue;
    const next = clone(task);
    next.orphaned = true;
    touchTask(next, at);
    events.push({ type: 'task/orphaned', taskId: next.id, rev: next.rev, data: next });
  }
}

export function planRename(handle, cmd) {
  const head = requireHead(handle, cmd);
  if (head.status === 'archived') throw new BoardError('plan-archived', 'plan is archived', { status: 409 });
  assertHeadRev(handle, head, cmd);
  const title = String(cmd.title || '').trim();
  if (title === '') throw new BoardError('invalid-command', 'plan title is required', { status: 400 });
  assertTitleUnique(handle, title, head.id);
  const at = new Date().toISOString();
  const next = { ...head, title, rev: head.rev + 1, updatedAt: at };
  return { events: [{ type: 'plan/updated', data: next }], entityRev: next.rev };
}

export function planArchive(handle, cmd) {
  const head = requireHead(handle, cmd);
  if (head.status === 'archived') throw new BoardError('plan-archived', 'plan is already archived', { status: 409 });
  assertHeadRev(handle, head, cmd);
  const at = new Date().toISOString();
  if (head.status === 'active') {
    const plan = handle.state.plans[planKey(head.id, head.currentVersion)];
    const taskIds = plan ? (plan.steps || []).flatMap((step) => step.taskIds || []) : [];
    for (const taskId of taskIds) {
      const task = handle.state.tasks[taskId];
      if (task && task.state === 'in_progress') throw new BoardError('plan-has-live-work', 'plan has an in_progress task: ' + taskId, { status: 409 });
      if (handle.leases.has(taskId)) throw new BoardError('plan-has-live-work', 'plan has a live lease on ' + taskId, { status: 409 });
    }
  }
  const next = { ...head, status: 'archived', archivedFrom: head.status, rev: head.rev + 1, updatedAt: at };
  const events = [{ type: 'plan/archived', data: next }];
  if (handle.state.project.focusPlanId === head.id) {
    const project = clone(handle.state.project);
    project.focusPlanId = null;
    project.updatedAt = at;
    events.push({ type: 'project/updated', data: project });
  }
  return { events, entityRev: next.rev };
}

export function planUnarchive(handle, cmd) {
  const head = requireHead(handle, cmd);
  if (head.status !== 'archived') throw new BoardError('illegal-transition', 'plan is not archived', { status: 409 });
  assertHeadRev(handle, head, cmd);
  const at = new Date().toISOString();
  const next = { ...head, status: head.archivedFrom || 'active', archivedFrom: null, rev: head.rev + 1, updatedAt: at };
  return { events: [{ type: 'plan/unarchived', data: next }], entityRev: next.rev };
}

export function planFocus(handle, cmd) {
  if (!cmd.actor || cmd.actor.kind !== 'human') throw new BoardError('forbidden-role', 'plan.focus is human only', { status: 403 });
  const raw = cmd.planId === undefined || cmd.planId === null || cmd.planId === '' ? null : String(cmd.planId);
  if (raw !== null) {
    const head = handle.state.planHeads[raw];
    if (!head) throw new BoardError('plan-not-found', 'plan not found: ' + raw, { status: 404 });
    if (head.status !== 'active') throw new BoardError('plan-not-active', 'plan is ' + head.status + ', focus requires active', { status: 409 });
  }
  if (handle.state.project.focusPlanId === raw) return { events: [] };
  const at = new Date().toISOString();
  const project = clone(handle.state.project);
  project.focusPlanId = raw;
  project.updatedAt = at;
  return {
    events: [
      { type: 'plan/focused', data: { planId: raw, projectRev: handle.rev + 1 } },
      { type: 'project/updated', data: project },
    ],
    entityRev: handle.rev + 1,
  };
}

export function requireHead(handle, cmd) {
  const planId = typeof cmd.planId === 'string' && cmd.planId !== '' ? cmd.planId : null;
  if (!planId) throw new BoardError('invalid-command', 'planId is required', { status: 400 });
  const head = handle.state.planHeads[planId];
  if (!head) throw new BoardError('plan-not-found', 'plan not found: ' + planId, { status: 404 });
  return head;
}

export function assertHeadRev(handle, head, cmd) {
  const expected = cmd.expected?.entityRev;
  if (!Number.isInteger(expected) || expected !== head.rev) {
    throw new BoardError('stale-revision', 'plan ' + head.id + ' rev is ' + head.rev + (Number.isInteger(expected) ? ', expected ' + expected : '; expectedRev is required'), {
      status: 409,
      details: { currentRev: head.rev, planId: head.id },
    });
  }
}

export function assertTitleUnique(handle, title, excludeId = null) {
  const key = String(title || '').trim().toLowerCase();
  if (key === '') return;
  for (const head of Object.values(handle.state.planHeads)) {
    if (head.id === excludeId) continue;
    if (String(head.title || '').trim().toLowerCase() === key) {
      throw new BoardError('plan-title-taken', 'plan title already taken: ' + title, { status: 409, details: { planId: head.id, title: head.title } });
    }
  }
}
