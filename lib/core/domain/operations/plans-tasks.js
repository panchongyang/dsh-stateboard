// Restricted cross-entity transitions owned by the plan model. All records are
// derived from the current private task, never a caller-supplied post-image.
import { BoardError } from '../../errors.js';
import { assertAuditScopeUnchanged } from '../../audit.js';
import { mergeAcceptance, resolveAuditGate } from '../../normalize.js';
import { createTask as initialTask, readyTask } from '../task-transitions.js';
import { fields, id, invalid, activeVersion, requireTask, assertAvailable, membership, revisedVersion, requireTransition } from './plans-shared.js';

const TASK_FIELDS = ['planId', 'version', 'taskId', 'stepId', 'title', 'description', 'priority', 'weight', 'labels', 'requiresAudit', 'deps', 'acceptance'];
function definition(args) {
  fields(args, TASK_FIELDS);
  if (typeof args.title !== 'string' || !args.title.trim()) invalid('task title must be non-empty');
  if (!Array.isArray(args.deps) || args.deps.some((dep) => typeof dep !== 'string' || !dep)) invalid('task dependencies must be identifiers');
  if (!Array.isArray(args.acceptance)) invalid('task acceptance must be an array');
  for (const entry of args.acceptance) fields(entry, ['text', 'requiredKinds']);
  if (args.requiresAudit !== undefined && typeof args.requiresAudit !== 'boolean') invalid('requiresAudit must be boolean');
  if (args.labels !== undefined && (!Array.isArray(args.labels) || args.labels.some((label) => typeof label !== 'string'))) invalid('labels must contain strings');
  for (const label of args.labels || []) if (label.trim().toLowerCase().startsWith('gate:') && label.trim() !== 'gate:audit') invalid('unsupported gate label; use gate:audit');
}
function changedTask(task, at) { return { ...structuredClone(task), rev: task.rev + 1, updatedAt: at }; }
function taskEvent(work, args, action, type, task) {
  const transition = requireTransition(work, args.planId, args.version, ['publish', 'revise', 'adopt', 'release'], action, task.id);
  const pending = transition.pending.get(task.id);
  if (--pending.remaining === 0) transition.pending.delete(task.id);
  return { events: [{ type, taskId: task.id, rev: task.rev, data: task }] };
}
function planRef(args) { return { planId: args.planId, version: args.version, stepId: args.stepId }; }
export function createTask(work, args, request) {
  definition(args);
  requireTransition(work, args.planId, args.version, ['publish', 'revise']);
  membership(work, args);
  const taskId = id(args.taskId);
  if (work.state.tasks[taskId]) invalid('task already exists: ' + taskId);
  const gate = resolveAuditGate(args, null, request.actor);
  const acceptance = mergeAcceptance([], args.acceptance, work.newId);
  if (!acceptance.length) invalid('new task requires acceptance');
  const at = work.clock().toISOString();
  const task = initialTask({ id: taskId, rev: 1, title: args.title.trim(),
    description: typeof args.description === 'string' ? args.description : '',
    priority: Number.isInteger(args.priority) ? args.priority : 100,
    weight: typeof args.weight === 'number' && args.weight > 0 ? args.weight : 1,
    labels: gate.labels, requiresAudit: gate.gate, deps: args.deps.slice(), acceptance,
    evidence: [], workers: [], lastAudit: null, planRef: planRef(args),
    owner: null, assignee: null, work: null, blocker: null, createdAt: at, updatedAt: at }, args.deps.length === 0);
  return taskEvent(work, args, 'create', 'task/created', task);
}
export function reviseTask(work, args, request) {
  definition(args);
  const transition = requireTransition(work, args.planId, args.version, ['revise']);
  membership(work, args);
  const previous = requireTask(work, args.taskId);
  const foreignLegacy = previous.planRef && previous.planRef.planId !== args.planId && transition.previous.has(args.taskId);
  if (!foreignLegacy) assertAvailable(previous, args.planId);
  const next = changedTask(previous, work.clock().toISOString());
  next.title = args.title.trim();
  if (typeof args.description === 'string') next.description = args.description;
  next.priority = Number.isInteger(args.priority) ? args.priority : 100;
  next.weight = typeof args.weight === 'number' && args.weight > 0 ? args.weight : 1;
  const gate = resolveAuditGate(args, previous, request.actor);
  next.labels = gate.labels;
  next.requiresAudit = gate.gate;
  next.deps = args.deps.slice();
  next.acceptance = mergeAcceptance(previous.acceptance, args.acceptance, work.newId);
  assertAuditScopeUnchanged(previous, next);
  next.planRef = foreignLegacy ? structuredClone(previous.planRef) : planRef(args);
  if (next.state === 'backlog' && next.deps.every((dep) => work.state.tasks[dep]?.state === 'done') && next.acceptance.length) readyTask(next);
  return taskEvent(work, args, 'revise', 'task/updated', next);
}
export function orphanTask(work, args) {
  fields(args, ['planId', 'previousVersion', 'taskId']);
  requireTransition(work, args.planId, args.previousVersion + 1, ['revise']);
  const { plan } = activeVersion(work, args.planId, args.previousVersion + 1);
  const previousPlan = work.state.plans[args.planId + '@' + args.previousVersion];
  if (!previousPlan?.steps.some((step) => step.taskIds.includes(args.taskId)) || plan.steps.some((step) => step.taskIds.includes(args.taskId))) invalid('only a removed plan member can be orphaned');
  const task = requireTask(work, args.taskId);
  if (task.planRef && task.planRef.planId !== args.planId) {
    const transition = requireTransition(work, args.planId, args.previousVersion + 1, ['revise'], 'orphan', task.id);
    transition.pending.delete(task.id);
    return { events: [] }; // Removing a historical ghost membership does not orphan its actual owner.
  }
  const next = changedTask(task, work.clock().toISOString());
  next.orphaned = true;
  return taskEvent(work, { ...args, version: args.previousVersion + 1 }, 'orphan', 'task/orphaned', next);
}
function taskIdsOf(raw) {
  if (!Array.isArray(raw) || !raw.length) invalid('taskIds is required');
  return [...new Set(raw.map(id))];
}
export function addMembers(work, args) {
  fields(args, ['planId', 'baseVersion', 'stepId', 'taskIds']);
  const { head, plan } = activeVersion(work, args.planId, args.baseVersion);
  const steps = structuredClone(plan.steps);
  const target = steps.find((step) => step.id === args.stepId);
  if (!target) throw new BoardError('plan-step-not-found', 'step not found: ' + args.stepId, { status: 400 });
  let added = false;
  for (const taskId of taskIdsOf(args.taskIds)) {
    const task = requireTask(work, taskId);
    assertAvailable(task, args.planId);
    if (steps.some((step) => step.taskIds.includes(taskId))) continue;
    assertAvailable(task, args.planId, true);
    target.taskIds.push(taskId);
    added = true;
  }
  if (!added) return { events: [], entityRev: head.rev };
  return revisedVersion(work, head, plan, {}, steps, 'adopt');
}
export function removeMembers(work, args) {
  fields(args, ['planId', 'baseVersion', 'taskIds']);
  const { head, plan } = activeVersion(work, args.planId, args.baseVersion);
  const taskIds = taskIdsOf(args.taskIds);
  for (const taskId of taskIds) {
    const task = requireTask(work, taskId);
    if (task.planRef?.planId !== args.planId) invalid('task is not in this plan: ' + taskId);
    assertAvailable(task, args.planId, true);
    if (!plan.steps.some((step) => step.taskIds.includes(taskId))) throw new BoardError('invalid-command', 'task is not in the current plan version: ' + taskId, { status: 409 });
  }
  const steps = plan.steps.map((step) => ({ ...step, taskIds: step.taskIds.filter((taskId) => !taskIds.includes(taskId)) }));
  return revisedVersion(work, head, plan, {}, steps, 'release');
}
export function assignTask(work, args) {
  fields(args, ['planId', 'version', 'taskId', 'stepId']);
  requireTransition(work, args.planId, args.version, ['adopt']);
  membership(work, args);
  const previous = requireTask(work, args.taskId);
  assertAvailable(previous, args.planId, true);
  const next = changedTask(previous, work.clock().toISOString());
  next.planRef = planRef(args);
  next.orphaned = false;
  return taskEvent(work, args, 'assign', 'task/updated', next);
}
export function releaseTask(work, args) {
  fields(args, ['planId', 'version', 'taskId']);
  requireTransition(work, args.planId, args.version, ['release']);
  const { plan } = activeVersion(work, args.planId, args.version);
  if (plan.steps.some((step) => step.taskIds.includes(args.taskId))) invalid('task is still a current member');
  const previous = requireTask(work, args.taskId);
  if (previous.planRef?.planId !== args.planId) invalid('task is not in this plan');
  const prior = work.state.plans[args.planId + '@' + (args.version - 1)];
  if (!prior?.steps.some((step) => step.taskIds.includes(args.taskId))) invalid('task was not removed from the preceding version');
  assertAvailable(previous, args.planId, true);
  const next = changedTask(previous, work.clock().toISOString());
  next.planRef = null;
  return taskEvent(work, args, 'release', 'task/updated', next);
}
