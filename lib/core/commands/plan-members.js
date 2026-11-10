// Plan membership: adopt and release tasks in a published plan.
//
// Every body is a verbatim move from service.js with `this` rebound to the handle.
// The head guard is shared with plan-life.js.

import { BoardError } from '../errors.js';
import { clone, planKey, touchTask } from '../model.js';
import { requireHead } from './plan-life.js';

export function planMembership(handle, cmd) {
  const head = requireHead(handle, cmd);
  if (head.status === 'archived') throw new BoardError('plan-archived', 'plan is archived', { status: 409 });
  if (head.status !== 'active') throw new BoardError('plan-not-active', 'plan is ' + head.status + ', not active', { status: 409 });
  const oldPlan = handle.state.plans[planKey(head.id, head.currentVersion)];
  if (!oldPlan) throw new BoardError('not-found', 'plan version missing: ' + planKey(head.id, head.currentVersion), { status: 404 });
  if (!Number.isInteger(cmd.baseVersion) || cmd.baseVersion !== head.currentVersion) {
    throw new BoardError('stale-revision', 'plan version is ' + head.currentVersion + ', expected ' + cmd.baseVersion, { status: 409, details: { currentVersion: head.currentVersion } });
  }
  return { head, oldPlan };
}

export function planMembershipTaskIds(handle, cmd) {
  const ids = Array.isArray(cmd.taskIds) ? cmd.taskIds.map(String).filter((taskId) => taskId !== '') : [];
  const unique = [...new Set(ids)];
  if (unique.length === 0) throw new BoardError('invalid-command', 'taskIds is required', { status: 400 });
  return unique;
}

export function planAdopt(handle, cmd) {
  const { head, oldPlan } = planMembership(handle, cmd);
  const stepId = String(cmd.stepId || '');
  const target = (oldPlan.steps || []).find((step) => step.id === stepId);
  if (!target) throw new BoardError('plan-step-not-found', 'step not found: ' + stepId, { status: 400 });
  const taskIds = planMembershipTaskIds(handle, cmd);
  const steps = (oldPlan.steps || []).map((step) => ({ id: step.id, title: step.title, taskIds: (step.taskIds || []).slice() }));
  const targetStep = steps.find((step) => step.id === stepId);
  const adopted = [];
  for (const taskId of taskIds) {
    const task = handle.state.tasks[taskId];
    if (!task) throw new BoardError('not-found', 'task not found: ' + taskId, { status: 404 });
    if (task.planRef && task.planRef.planId !== head.id) throw new BoardError('plan-task-in-use', 'task belongs to plan ' + task.planRef.planId, { status: 409, details: { taskId, planId: task.planRef.planId } });
    // Already a member of the current version: idempotent no-op. Moving between steps needs a revise.
    if (task.planRef && task.planRef.planId === head.id && (oldPlan.steps || []).some((step) => (step.taskIds || []).includes(taskId))) continue;
    if (task.state === 'in_progress') throw new BoardError('plan-task-in-progress', 'task is in progress: ' + taskId, { status: 409, details: { taskId } });
    if (targetStep.taskIds.includes(taskId)) continue;
    targetStep.taskIds.push(taskId);
    adopted.push(task);
  }
  if (adopted.length === 0) return { events: [], entityRev: head.rev };
  const at = new Date().toISOString();
  const version = head.currentVersion + 1;
  const plan = { ...oldPlan, version, status: 'published', steps, publishedAt: at, supersedes: head.currentVersion };
  const nextHead = { ...head, rev: head.rev + 1, currentVersion: version, updatedAt: at };
  const events = [
    { type: 'plan/superseded', data: { ...oldPlan, status: 'superseded', supersededBy: { planId: head.id, version } } },
    { type: 'plan/revised', data: plan, head: nextHead },
  ];
  for (const task of adopted) {
    const next = clone(task);
    next.planRef = { planId: head.id, version, stepId };
    next.orphaned = false;
    touchTask(next, at);
    events.push({ type: 'task/updated', taskId: next.id, rev: next.rev, data: next });
  }
  return { events, entityRev: version };
}

export function planRelease(handle, cmd) {
  const { head, oldPlan } = planMembership(handle, cmd);
  const taskIds = planMembershipTaskIds(handle, cmd);
  const steps = (oldPlan.steps || []).map((step) => ({ id: step.id, title: step.title, taskIds: (step.taskIds || []).slice() }));
  const released = [];
  for (const taskId of taskIds) {
    const task = handle.state.tasks[taskId];
    if (!task) throw new BoardError('not-found', 'task not found: ' + taskId, { status: 404 });
    if (!task.planRef || task.planRef.planId !== head.id) throw new BoardError('invalid-command', 'task is not in this plan: ' + taskId, { status: 400 });
    if (task.state === 'in_progress') throw new BoardError('plan-task-in-progress', 'task is in progress: ' + taskId, { status: 409, details: { taskId } });
    if (!steps.some((step) => step.taskIds.includes(taskId))) throw new BoardError('invalid-command', 'task is not in the current plan version: ' + taskId, { status: 409 });
    released.push(task);
  }
  const at = new Date().toISOString();
  const version = head.currentVersion + 1;
  for (const step of steps) step.taskIds = step.taskIds.filter((taskId) => !released.some((task) => task.id === taskId));
  const plan = { ...oldPlan, version, status: 'published', steps, publishedAt: at, supersedes: head.currentVersion };
  const nextHead = { ...head, rev: head.rev + 1, currentVersion: version, updatedAt: at };
  const events = [
    { type: 'plan/superseded', data: { ...oldPlan, status: 'superseded', supersededBy: { planId: head.id, version } } },
    { type: 'plan/revised', data: plan, head: nextHead },
  ];
  for (const task of released) {
    const next = clone(task);
    next.planRef = null;
    touchTask(next, at);
    events.push({ type: 'task/updated', taskId: next.id, rev: next.rev, data: next });
  }
  return { events, entityRev: version };
}
