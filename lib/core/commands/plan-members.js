// Membership changes are version and ownership intents in one model transaction.
import { BoardError } from '../errors.js';
import { requireHead } from './plan-life.js';

export function planMembership(read, cmd) {
  const head = requireHead(read, cmd);
  if (head.status === 'archived') throw new BoardError('plan-archived', 'plan is archived', { status: 409 });
  if (head.status !== 'active') throw new BoardError('plan-not-active', 'plan is ' + head.status + ', not active', { status: 409 });
  const oldPlan = read.state.plans[head.id + '@' + head.currentVersion];
  if (!oldPlan) throw new BoardError('not-found', 'plan version missing', { status: 404 });
  if (!Number.isInteger(cmd.baseVersion) || cmd.baseVersion !== head.currentVersion) throw new BoardError('stale-revision', 'plan version is ' + head.currentVersion + ', expected ' + cmd.baseVersion, { status: 409, details: { currentVersion: head.currentVersion } });
  return { head, oldPlan };
}
export function planMembershipTaskIds(read, cmd) {
  const taskIds = [...new Set(Array.isArray(cmd.taskIds) ? cmd.taskIds.map(String).filter(Boolean) : [])];
  if (!taskIds.length) throw new BoardError('invalid-command', 'taskIds is required', { status: 400 });
  return taskIds;
}
export function planAdopt(read, cmd) {
  const { head, oldPlan } = planMembership(read, cmd);
  const stepId = String(cmd.stepId || '');
  if (!oldPlan.steps.some((step) => step.id === stepId)) throw new BoardError('plan-step-not-found', 'step not found: ' + stepId, { status: 400 });
  const taskIds = planMembershipTaskIds(read, cmd).filter((taskId) => {
    const task = read.state.tasks[taskId];
    return !(task?.planRef?.planId === head.id && oldPlan.steps.some((step) => step.taskIds.includes(taskId)));
  });
  if (!taskIds.length) return { operations: [], entityRev: head.rev };
  const planId = head.id;
  const version = head.currentVersion + 1;
  return { operations: [
    { kind: 'plans.addMembers', args: { planId, baseVersion: cmd.baseVersion, stepId, taskIds } },
    ...taskIds.map((taskId) => ({ kind: 'plans.assignTask', args: { planId, version, stepId, taskId } })),
  ] };
}
export function planRelease(read, cmd) {
  const { head } = planMembership(read, cmd);
  const taskIds = planMembershipTaskIds(read, cmd);
  const planId = head.id;
  const version = head.currentVersion + 1;
  return { operations: [
    { kind: 'plans.removeMembers', args: { planId, baseVersion: cmd.baseVersion, taskIds } },
    ...taskIds.map((taskId) => ({ kind: 'plans.releaseTask', args: { planId, version, taskId } })),
  ] };
}
