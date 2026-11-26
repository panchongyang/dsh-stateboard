import { BoardError } from '../../errors.js';
import { isAuditGate } from '../../audit.js';
import { ensureAcyclic, mergeAcceptance, newAcceptance, resolveAuditGate } from '../../normalize.js';
import { beginTaskAttempt, claimTask, createTask, readyTask, deferTaskForDependencies, assertTaskBegin, assertTaskOpen, assertTaskReady } from '../task-transitions.js';
import { startWorkAttempt } from '../work-transitions.js';
import { taskDepsSatisfied } from '../task-facts.js';
import { actorRef } from '../../intent.js';
import { assertNoOpenIntent, changedTask, clearTaskTransition, currentIntent, invalidOperation, modelTask, pendingTaskTransition,
  requireTaskActor, requireTaskParticipant, stageTaskTransition, taskEvent, workEvent } from './tasks-primitives.js';
import { TASK_REVIEW_OPERATIONS } from './tasks-review.js';
import { TASK_GOVERNANCE_OPERATIONS } from './tasks-governance.js';

function createStandalone(work, fields, request) {
  requireTaskActor(request.actor);
  if (pendingTaskTransition(work)) throw invalidOperation('task operation conflicts with an unfinished transition');
  const { title, description, priority, weight, planRef } = fields;
  if (!title || String(title).trim() === '') throw invalidOperation('task title is required');
  const acceptance = newAcceptance(fields.acceptance, work.newId);
  if (!acceptance.length) throw invalidOperation('task needs at least one acceptance criterion');
  const deps = Array.isArray(fields.deps) ? [...fields.deps] : [];
  for (const dep of deps) {
    if (!work.state.tasks[dep]) throw invalidOperation('unknown dependency ' + dep);
    if (dep === request.taskId) throw invalidOperation('task cannot depend on itself');
  }
  const at = work.clock().toISOString();
  const gate = resolveAuditGate(fields, null, request.actor);
  const id = work.newId('tsk');
  if (Object.hasOwn(work.state.tasks, id)) throw invalidOperation('task identifier already exists');
  const task = createTask({
    id, rev: 1, title: String(title).trim(), description: typeof description === 'string' ? description : '',
    priority: Number.isInteger(priority) ? priority : 100, weight: typeof weight === 'number' && weight > 0 ? weight : 1,
    labels: gate.labels, requiresAudit: gate.gate, deps, acceptance,
    evidence: [], workers: [], lastAudit: null, planRef: planRef || null,
    owner: null, assignee: null, work: null, blocker: null, createdAt: at, updatedAt: at,
  }, deps.every(dep => work.state.tasks[dep].state === 'done'));
  return { events: [taskEvent('created', task)], entityRev: task.rev };
}

function changeAuditGate(work, { taskId, requiresAudit }, request) {
  const task = modelTask(work, taskId, request);
  assertTaskOpen(task);
  if (typeof requiresAudit !== 'boolean') throw invalidOperation('requiresAudit must be a boolean');
  if (request.actor?.kind !== 'human' && (task.state === 'review' || !requiresAudit)) {
    throw new BoardError('forbidden-role', 'agents cannot disable the audit gate; a human must do it', { status: 403, details: { gateLocked: true, reason: task.state === 'review' ? 'review-gate-locked' : 'gate-locked' } });
  }
  if (isAuditGate(task) === requiresAudit) return {};
  const gate = resolveAuditGate({ requiresAudit }, task, request.actor);
  const next = { ...task, requiresAudit: gate.gate, labels: gate.labels };
  return changedTask('updated', next, work.clock().toISOString());
}

const META_FIELDS = ['title', 'description', 'priority', 'weight', 'deps', 'acceptance', 'labels', 'requiresAudit'];
const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function editMetadata(work, fields, request) {
  const task = modelTask(work, fields.taskId, request);
  assertTaskOpen(task);
  const gate = resolveAuditGate(fields, task, request.actor);
  if (work._leaseOf(task.id) || !(request.actor?.kind === 'human' || ['backlog', 'ready'].includes(task.state))) {
    work._assertLease(task, request, { allowHuman: true, requireToken: false });
  }
  const next = structuredClone(task);
  if (typeof fields.title === 'string' && fields.title.trim()) next.title = fields.title.trim();
  if (typeof fields.description === 'string') next.description = fields.description;
  if (Number.isInteger(fields.priority)) next.priority = fields.priority;
  if (typeof fields.weight === 'number' && fields.weight > 0) next.weight = fields.weight;
  if (Array.isArray(fields.deps)) {
    for (const dep of fields.deps) if (!work.state.tasks[dep]) throw invalidOperation('unknown dependency ' + dep);
    next.deps = [...fields.deps];
  }
  if (Array.isArray(fields.acceptance)) next.acceptance = mergeAcceptance(task.acceptance, fields.acceptance, work.newId);
  ensureAcyclic(Object.values(work.state.tasks).map(item => ({ key: item.id, deps: item.id === task.id ? next.deps : item.deps })));
  next.labels = gate.labels;
  next.requiresAudit = gate.gate;
  if (next.state === 'ready' && !taskDepsSatisfied(work.state, next)) deferTaskForDependencies(next);
  const changed = META_FIELDS.filter(field => fields[field] !== undefined && !sameJson(task[field], next[field]));
  if (task.state !== next.state) changed.push('state');
  const at = work.clock().toISOString();
  const result = changedTask('updated', next, at);
  if (changed.length) result.events.push({
    type: 'task/meta-edited', taskId: task.id, rev: next.rev,
    data: { taskId: task.id, by: actorRef(request.actor), fields: changed, reason: typeof fields.reason === 'string' ? fields.reason : '', at },
  });
  return result;
}

function promoteFromBacklog(work, { taskId }, request) {
  const task = modelTask(work, taskId, request);
  assertTaskReady(task);
  if (!taskDepsSatisfied(work.state, task)) throw new BoardError('dependency-unmet', 'dependencies are not done', { status: 409 });
  if (!Array.isArray(task.acceptance) || !task.acceptance.length) throw new BoardError('acceptance-unmet', 'task has no acceptance criteria', { status: 422 });
  return changedTask('readied', readyTask(structuredClone(task)), work.clock().toISOString());
}

function claimReadyWork(work, { taskId }, request) {
  const task = modelTask(work, taskId, request, { checkRev: false });
  requireTaskParticipant(request.actor);
  work._assertClaimAllowed(task, request);
  const at = work.clock().toISOString();
  const lease = work._grantLease(task, request.actor || {}, at);
  const next = claimTask(structuredClone(task), lease, at);
  return changedTask('claimed', next, at, [{ type: 'lease/granted', taskId, data: lease }]);
}

const begunAttempt = Symbol('unlinked work attempt');

function openAttempt(work, { taskId, intentId, summary, plannedSteps, expectedArtifacts }, request) {
  const task = modelTask(work, taskId, request);
  const lease = work._assertLease(task, request);
  assertTaskBegin(task);
  assertNoOpenIntent(work, task);
  requireTaskParticipant(request.actor);
  if (Object.hasOwn(work.state.intents, intentId)) throw invalidOperation('intent identifier already exists');
  const intent = startWorkAttempt(task, lease, { intentId, summary, plannedSteps, expectedArtifacts }, work.clock().toISOString(), request.actor);
  stageTaskTransition(work, begunAttempt, task, { intentId });
  return { events: [workEvent('intent', intent)] };
}

function beginAttempt(work, { taskId, intentId }, request) {
  const task = modelTask(work, taskId, request, { phase: begunAttempt });
  requireTaskParticipant(request.actor);
  const lease = work._assertLease(task, request);
  const pending = pendingTaskTransition(work);
  if (pending?.taskId !== taskId || pending.intentId !== intentId) throw invalidOperation('attempt must be opened in this transaction');
  const intent = currentIntent(work, task, intentId);
  clearTaskTransition(work);
  const at = work.clock().toISOString();
  const next = beginTaskAttempt(structuredClone(task), intent, lease, at);
  work._markLeaseProgress(task.id);
  return changedTask('updated', next, at);
}

function extendHeldTask(work, { taskId }, request) {
  modelTask(work, taskId, request, { checkRev: false });
  requireTaskParticipant(request.actor);
  return work._renewLease(request);
}

export const taskOperations = Object.freeze({
  'task.createStandalone': createStandalone,
  'task.changeAuditGate': changeAuditGate,
  'task.editMetadata': editMetadata,
  'task.promoteFromBacklog': promoteFromBacklog,
  'task.claimReadyWork': claimReadyWork,
  'work.openAttempt': openAttempt,
  'task.beginAttempt': beginAttempt,
  'lease.extendHeldTask': extendHeldTask,
  ...TASK_REVIEW_OPERATIONS,
  ...TASK_GOVERNANCE_OPERATIONS,
});
