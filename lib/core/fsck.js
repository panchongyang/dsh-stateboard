import { TASK_STATES, normalizePlanHeads, planKey, taskDepsSatisfied } from './model.js';
import { agentAuditValid } from './audit.js';
import { externalRecordProblem } from './documents/external-model.js';

export function checkState(state, { leases = [], now = Date.now() } = {}) {
  // Derive legacy heads only on a private projection. The normalizer assigns
  // schemaVersion, project fields and head keys; health must not repair input.
  state = {
    ...state,
    project: { ...state.project },
    planHeads: state.planHeads && typeof state.planHeads === 'object' && !Array.isArray(state.planHeads)
      ? { ...state.planHeads } : state.planHeads,
  };
  normalizePlanHeads(state);
  const checks = [];
  const warnings = [];
  const ok = (name, condition, detail) => {
    checks.push({ name, ok: Boolean(condition), detail: detail ?? null });
    if (!condition && detail) warnings.push(name + ': ' + detail);
  };

  const tasks = Object.values(state.tasks);
  checkProject(state, ok);
  checkTasks(state, tasks, ok);
  checkIntents(state, ok);
  checkArchivedWork(state, tasks, leases, now, ok);
  checkPlanStepUniqueness(state, ok);
  checkPlanHeads(state, ok);
  checkFocusAndTitles(state, ok);
  checkDependencyCycles(state, tasks, ok);
  checkDocs(state, ok);

  const drifts = Array.isArray(state.drifts) ? state.drifts.length : 0;
  ok('doc-drift', drifts === 0, drifts + ' drifted document(s)');

  return {
    ok: warnings.length === 0,
    checks,
    warnings,
    taskCount: tasks.length,
    docCount: Object.keys(state.docs).length,
    driftCount: drifts,
  };
}

function checkProject(state, ok) {
  ok('project-id', typeof state.project.id === 'string' && state.project.id.startsWith('prj_'));
  ok('project-phase', ['active', 'paused', 'archived'].includes(state.project.phase), state.project.phase);
}

function checkTasks(state, tasks, ok) {
  for (const task of tasks) {
    checkTaskWork(state, task, ok);
    // I23 applies only to explicit agent acceptance, never historical policy/overrides.
    if (task.state === 'done' && task.verifiedBy === 'agent') {
      ok('task-audit:' + task.id, agentAuditValid(task), 'I23: agent done requires an independent passing audit bound to the unchanged delivery scope');
    }
    if (!TASK_STATES.includes(task.state)) {
      ok('task-state:' + task.id, false, 'unknown state ' + task.state);
      continue;
    }
    if (!Number.isInteger(task.rev) || task.rev < 1) ok('task-rev:' + task.id, false, 'rev=' + task.rev);
    if (task.state === 'done' && !task.verifiedAt) ok('task-verified:' + task.id, false, 'done without verifiedAt');
    if (task.state === 'ready' && !taskDepsSatisfied(state, task)) ok('task-deps:' + task.id, false, 'ready with unmet deps');
    if (task.state === 'in_progress' && !task.owner) ok('task-owner:' + task.id, false, 'in_progress without owner');
    if (task.state !== 'in_progress' && task.owner) ok('task-owner:' + task.id, false, task.state + ' with owner');
    for (const dep of task.deps || []) {
      if (!state.tasks[dep]) ok('task-dep-exists:' + task.id, false, 'missing dep ' + dep);
    }
    // I16: planRef must point at an existing plan@version whose steps contain the task.
    if (task.planRef) {
      const pv = state.plans[planKey(task.planRef.planId, task.planRef.version)];
      const inStep = Boolean(pv && (pv.steps || []).some((step) => (step.taskIds || []).includes(task.id)));
      ok('task-planref:' + task.id, inStep, task.planRef.planId + '@' + task.planRef.version);
    }
  }
}

function checkTaskWork(state, task, ok) {
  const intentId = task.work?.intentId;
  if (intentId === undefined || intentId === null) return;
  const intent = Object.hasOwn(state.intents || {}, intentId) ? state.intents[intentId] : null;
  const detail = 'taskId=' + task.id + ' intentId=' + intentId;
  ok('task-work:' + task.id, Boolean(intent), detail + ' missing intent');
  if (intent) ok('task-work-task:' + task.id, intent.taskId === task.id, detail + ' points to taskId=' + intent.taskId);
  // Closed/abandoned work is valid history (including after unblock/reject).
  // Recovery can also leave an open intent without task.work: I6 is one-way.
}

// I6: diagnose the intent even if the task is absent or has an unknown state.
function checkIntents(state, ok) {
  for (const intent of Object.values(state.intents || {})) {
    const detail = 'taskId=' + intent.taskId + ' intentId=' + intent.id;
    if (intent.status === 'open') {
      const task = state.tasks[intent.taskId];
      ok('intent-task:' + intent.id, Boolean(task), detail + ' missing task');
      if (task) ok('intent-state:' + intent.id, ['in_progress', 'interrupted'].includes(task.state), detail + ' open in state=' + task.state);
    }
    checkSettlement(intent, detail, ok);
  }
}

// I22: only RFC-3-specific fields identify a new settlement. status/closedAt/
// resolution already occurred in legacy logs; neither dates nor schemaVersion
// can distinguish them. Unmarked submit results therefore remain legacy here.
function checkSettlement(intent, detail, ok) {
  const markers = ['closeReason', 'closedBy', 'outcome', 'sideEffects', 'settlementNote'];
  if (!markers.some((field) => Object.hasOwn(intent, field))) return;
  const missing = [];
  if (!['closed', 'abandoned'].includes(intent.status)) missing.push('status');
  const nonempty = (value) => typeof value === 'string' && value.trim() !== '';
  if (!nonempty(intent.closeReason) && !nonempty(intent.resolution)) missing.push('closeReason/resolution');
  if (!nonempty(intent.closedBy?.kind)) missing.push('closedBy');
  if (!nonempty(intent.closedAt) || !Number.isFinite(Date.parse(intent.closedAt))) missing.push('closedAt');
  const governance = ['blocked', 'released', 'canceled', 'override', 'rejected'].includes(intent.closeReason);
  if (governance || Object.hasOwn(intent, 'outcome') || Object.hasOwn(intent, 'sideEffects')) {
    if (intent.outcome !== 'stopped') missing.push('outcome=stopped');
    if (!Array.isArray(intent.sideEffects)) missing.push('sideEffects');
  }
  ok('intent-settlement:' + intent.id, missing.length === 0, detail + ' invalid settlement: ' + missing.join(', '));
}

function checkArchivedWork(state, tasks, leases, now, ok) {
  if (state.project.phase !== 'archived') return;
  for (const task of tasks) {
    if (task.state === 'in_progress') ok('project-archived-task:' + task.id, false, 'taskId=' + task.id + ' in_progress in archived project');
  }
  for (const intent of Object.values(state.intents || {})) {
    if (intent.status === 'open') ok('project-archived-intent:' + intent.id, false, 'taskId=' + intent.taskId + ' intentId=' + intent.id + ' open in archived project');
  }
  // Runtime leases, not persisted owner.leaseUntil (which touch does not update).
  // Expired-but-renewable leases are not live; existing health warnings cover them.
  for (const lease of leases) {
    if (Date.parse(lease.expiresAt) > now) ok('project-archived-lease:' + lease.taskId, false, 'taskId=' + lease.taskId + ' live lease in archived project');
  }
}

// I20: each task appears in at most one step of the current plan version.
function checkPlanStepUniqueness(state, ok) {
  for (const head of Object.values(state.planHeads || {})) {
    if (!Number.isInteger(head.currentVersion) || head.currentVersion < 1) continue;
    const pv = state.plans[planKey(head.id, head.currentVersion)];
    if (!pv) continue;
    const seen = new Set();
    const duplicates = [];
    for (const step of pv.steps || []) {
      for (const taskId of step.taskIds || []) {
        if (seen.has(taskId)) duplicates.push(taskId);
        else seen.add(taskId);
      }
    }
    ok('plan-step-unique:' + head.id, duplicates.length === 0, duplicates.length ? 'task in multiple steps: ' + duplicates.join(', ') : null);
  }
}

// I17/I18/I19/I21: plan head invariants.
function checkPlanHeads(state, ok) {
  for (const head of Object.values(state.planHeads || {})) {
    const name = 'plan-head-version:' + head.id;
    if (head.status === 'active') {
      ok(name, Number.isInteger(head.currentVersion) && head.currentVersion >= 1 && Boolean(state.plans[planKey(head.id, head.currentVersion)]), 'currentVersion=' + head.currentVersion);
    } else if (head.status === 'draft') {
      ok(name, head.currentVersion === 0, 'draft must have currentVersion 0, got ' + head.currentVersion);
    } else if (head.status === 'archived') {
      if (head.archivedFrom === 'active') {
        ok(name, Number.isInteger(head.currentVersion) && head.currentVersion >= 1 && Boolean(state.plans[planKey(head.id, head.currentVersion)]), 'currentVersion=' + head.currentVersion);
      } else {
        ok(name, head.currentVersion === 0, 'archived draft must have currentVersion 0, got ' + head.currentVersion);
      }
    }
    if (head.status === 'archived' && head.archivedFrom === 'active') {
      const pv = state.plans[planKey(head.id, head.currentVersion)];
      const ids = pv ? (pv.steps || []).flatMap((step) => step.taskIds || []) : [];
      const live = ids.filter((id) => state.tasks[id] && state.tasks[id].state === 'in_progress');
      ok('plan-archived-tasks:' + head.id, live.length === 0, 'in_progress tasks in archived plan: ' + live.join(', '));
    }
  }
}

function checkFocusAndTitles(state, ok) {
  const focusId = state.project.focusPlanId ?? null;
  ok('plan-focus', focusId === null || (Boolean(state.planHeads[focusId]) && state.planHeads[focusId].status === 'active'), 'focus ' + focusId);
  const seen = new Map();
  const duplicates = [];
  for (const head of Object.values(state.planHeads || {})) {
    const key = String(head.title || '').trim().toLowerCase();
    if (key === '') continue;
    if (seen.has(key)) duplicates.push(head.title);
    else seen.set(key, head.id);
  }
  ok('plan-titles', duplicates.length === 0, duplicates.length ? 'duplicate plan titles: ' + duplicates.join(', ') : null);
}

// dependency cycles
function checkDependencyCycles(state, tasks, ok) {
  const visiting = new Set();
  const visited = new Set();
  let cycle = null;
  const visit = (taskId, stack) => {
    if (cycle) return;
    if (visiting.has(taskId)) {
      cycle = stack.concat(taskId).join(' -> ');
      return;
    }
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    const task = state.tasks[taskId];
    if (task) for (const dep of task.deps || []) visit(dep, stack.concat(taskId));
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of tasks) visit(task.id, []);
  ok('dependency-acyclic', cycle === null, cycle);
}

function checkDocs(state, ok) {
  for (const doc of Object.values(state.docs)) {
    // External rows have no body blob; workspace availability is never a store fault.
    if (doc.source === 'external') ok('doc-external:' + doc.id, externalRecordProblem(doc) === null, externalRecordProblem(doc));
    else ok('doc-hash:' + doc.id, typeof doc.hash === 'string' && doc.hash.length === 64, 'bad hash');
    ok('doc-rev:' + doc.id, Number.isInteger(doc.rev) && doc.rev >= 1, 'rev=' + doc.rev);
    // Links are validated on write; rows written before that guard can still
    // dangle, so health reports them without blocking reads.
    const linkedTasks = doc.links && Array.isArray(doc.links.taskIds) ? doc.links.taskIds : [];
    const missingTasks = linkedTasks.filter((id) => !state.tasks[id]);
    ok('doc-link-task:' + doc.id, missingTasks.length === 0, 'unknown task ' + missingTasks.join(', '));
    const planRefs = doc.links && Array.isArray(doc.links.planRefs) ? doc.links.planRefs : [];
    const missingPlans = planRefs
      .map((ref) => (ref && ref.planId ? ref.planId + '@' + ref.version : String(ref)))
      .filter((key) => !state.plans[key]);
    ok('doc-link-plan:' + doc.id, missingPlans.length === 0, 'unknown plan ' + missingPlans.join(', '));
  }
}
