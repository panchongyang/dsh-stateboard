// Model-only plan guards. Inputs describe intent, not events or entity post-images.
import { BoardError } from '../../errors.js';
import { planVersionPayload, revisePlanHead, supersedePlanVersion, assertPlanTitleUnique } from '../plan-transitions.js';

export function invalid(message) { throw new BoardError('invalid-command', message, { status: 400 }); }
export function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('operation arguments must be an object');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid('unsupported plan operation field: ' + key);
}
export function id(value) {
  if (typeof value !== 'string' || !value) invalid('non-empty identifier is required');
  return value;
}
export function requireHead(work, planId) {
  const head = work.state.planHeads[id(planId)];
  if (!head) throw new BoardError('plan-not-found', 'plan not found: ' + planId, { status: 404 });
  return head;
}
export function notArchived(head) {
  if (head.status === 'archived') throw new BoardError('plan-archived', 'plan is archived', { status: 409 });
}
export function headRev(head, expected) {
  if (!Number.isInteger(expected) || head.rev !== expected) throw new BoardError('stale-revision', 'plan ' + head.id + ' rev is ' + head.rev + '; expectedRev must match', { status: 409, details: { currentRev: head.rev, planId: head.id } });
}
export function activeVersion(work, planId, expected) {
  const head = requireHead(work, planId);
  notArchived(head);
  if (head.status !== 'active') throw new BoardError('plan-not-active', 'plan is ' + head.status + ', not active', { status: 409 });
  if (!Number.isInteger(expected) || head.currentVersion !== expected) throw new BoardError('stale-revision', 'plan version is ' + head.currentVersion + ', expected ' + expected, { status: 409, details: { currentVersion: head.currentVersion } });
  const plan = work.state.plans[planId + '@' + head.currentVersion];
  if (!plan) throw new BoardError('not-found', 'plan version missing', { status: 404 });
  return { head, plan };
}
export function titleOf(work, input, excludeId) {
  const title = String(input || '').trim();
  if (!title) invalid('plan title is required');
  assertPlanTitleUnique(work.state.planHeads, title, excludeId);
  return title;
}
export function metadata(args, previous = {}) {
  return { goal: typeof args.goal === 'string' ? args.goal : previous.goal || '',
    assumptions: Array.isArray(args.assumptions) ? args.assumptions.map(String) : previous.assumptions || [],
    risks: Array.isArray(args.risks) ? args.risks.map(String) : previous.risks || [] };
}
export function draftOf(args, previous = {}) {
  const steps = Array.isArray(args.steps) ? args.steps : previous.steps || [];
  if (!Array.isArray(steps)) invalid('draft steps must be an array');
  for (const step of steps) {
    fields(step, ['id', 'title', 'tasks']);
    if (step.tasks !== undefined && !Array.isArray(step.tasks)) invalid('draft tasks must be an array');
    for (const task of step.tasks || []) fields(task, ['key', 'taskId', 'title', 'description', 'priority', 'weight', 'acceptance', 'deps', 'labels', 'requiresAudit']);
  }
  // Draft definitions may be incomplete. They cannot smuggle execution state or
  // satisfied acceptance flags into later materialization.
  const copy = structuredClone(steps);
  for (const step of copy) for (const task of step.tasks || []) {
    if (!Array.isArray(task.acceptance)) continue;
    for (const criterion of task.acceptance) fields(criterion, ['text', 'requiredKinds']);
  }
  return { ...metadata(args, previous), steps: copy };
}
export function stepsOf(raw, previousSteps = []) {
  if (!Array.isArray(raw) || !raw.length) invalid('plan requires at least one step');
  const stepIds = new Set();
  const priorCounts = new Map();
  for (const step of previousSteps) for (const taskId of step.taskIds) priorCounts.set(taskId, (priorCounts.get(taskId) || 0) + 1);
  const counts = new Map();
  return raw.map((step) => {
    fields(step, ['id', 'title', 'taskIds']);
    const stepId = id(step.id);
    if (stepIds.has(stepId)) invalid('duplicate step id ' + stepId);
    stepIds.add(stepId);
    if (!Array.isArray(step.taskIds)) invalid('step taskIds must be an array');
    const local = new Set();
    const taskIds = step.taskIds.map((taskId) => {
      id(taskId);
      const count = (counts.get(taskId) || 0) + 1;
      if (local.has(taskId) || count > Math.max(1, priorCounts.get(taskId) || 0)) invalid('task may not gain overlapping plan membership: ' + taskId);
      local.add(taskId);
      counts.set(taskId, count);
      return taskId;
    });
    return { id: stepId, title: String(step.title || '').trim() || stepId, taskIds };
  });
}
// Scratch carries model-owned transition provenance, never durable entity state.
export function markVersion(work, planId, version, kind, steps, previousSteps = []) {
  const key = 'plans.transition:' + planId;
  if (work.scratch.has(key)) invalid('a plan version transition is already open in this transaction');
  const members = new Set(steps.flatMap((step) => step.taskIds));
  const previous = new Set(previousSteps.flatMap((step) => step.taskIds));
  const pending = new Map();
  if (kind === 'publish' || kind === 'revise') for (const taskId of steps.flatMap((step) => step.taskIds)) {
    const entry = pending.get(taskId) || { action: work.state.tasks[taskId] ? 'revise' : 'create', remaining: 0 };
    entry.remaining += 1;
    pending.set(taskId, entry);
  }
  if (kind === 'adopt') for (const taskId of members) if (!previous.has(taskId)) pending.set(taskId, { action: 'assign', remaining: 1 });
  for (const taskId of previous) if (!members.has(taskId) && work.state.tasks[taskId]) pending.set(taskId, { action: kind === 'release' ? 'release' : 'orphan', remaining: 1 });
  work.scratch.set(key, { planId, version, kind, pending, previous });
}
export function requireTransition(work, planId, version, kinds, action, taskId) {
  const transition = work.scratch.get('plans.transition:' + planId);
  if (!transition || transition.version !== version || !kinds.includes(transition.kind)) invalid('plan task action requires its matching version transition in this transaction');
  if (action && transition.pending.get(taskId)?.action !== action) invalid('task action is not pending in this plan transition');
  return transition;
}
export function revisedVersion(work, head, previous, args, steps, kind = 'revise') {
  const at = work.clock().toISOString();
  const version = head.currentVersion + 1;
  const title = typeof args.title === 'string' && args.title.trim() ? titleOf(work, args.title, head.id) : previous.title;
  const plan = planVersionPayload({ id: head.id, version, title, ...metadata(args, previous),
    steps, createdAt: previous.createdAt, publishedAt: at, supersedes: head.currentVersion });
  markVersion(work, head.id, version, kind, steps, previous.steps);
  return { events: [
    { type: 'plan/superseded', data: supersedePlanVersion(previous, { planId: head.id, version }) },
    { type: 'plan/revised', data: plan, head: revisePlanHead(head, version, at, title) },
  ], entityRev: version };
}
export function requireTask(work, taskId) {
  const task = work.state.tasks[id(taskId)];
  if (!task) throw new BoardError('not-found', 'task not found: ' + taskId, { status: 404 });
  return task;
}
export function assertAvailable(task, planId, checkProgress = false) {
  if (task.planRef && task.planRef.planId !== planId) throw new BoardError('plan-task-in-use', 'task belongs to plan ' + task.planRef.planId, { status: 409, details: { taskId: task.id, planId: task.planRef.planId } });
  if (checkProgress && task.state === 'in_progress') throw new BoardError('plan-task-in-progress', 'task is in progress: ' + task.id, { status: 409, details: { taskId: task.id } });
}
export function membership(work, args) {
  const current = activeVersion(work, args.planId, args.version);
  const step = current.plan.steps.find((step) => step.id === args.stepId);
  if (!step?.taskIds.includes(args.taskId)) invalid('task is not assigned to this current plan step');
  return current;
}
