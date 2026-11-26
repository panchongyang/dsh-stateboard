// Commands assemble restricted model intents; only the model derives records.
import { BoardError } from '../errors.js';
import { ensureAcyclic } from '../normalize.js';
import { assertPublishStageDependencies } from '../plan-stages.js';
import { assertPlanTitleUnique, normalizePlanIntentSteps } from '../business/plan-policy.js';

const operation = (kind, args) => ({ kind: 'plans.' + kind, args });
const expectedRev = (cmd) => cmd.expected?.entityRev;

export function planCreate(read, cmd) {
  const planId = read.newId('pln');
  return { operations: [operation('createDraft', { planId, ...draftInput(cmd), title: cmd.title })] };
}

export function planPublish(read, cmd) {
  const operations = [];
  let head;
  let planId = cmd.planId;
  if (typeof planId === 'string' && planId !== '') {
    head = requireHead(read, cmd);
    if (head.status === 'archived') throw new BoardError('plan-archived', 'plan is archived', { status: 409 });
    if (head.status !== 'draft') throw new BoardError('plan-not-draft', 'plan is ' + head.status + ', not draft', { status: 409 });
    assertHeadRev(read, head, cmd);
  } else {
    planId = read.newId('pln');
    operations.push(operation('createDraft', { planId, ...draftInput(cmd), title: cmd.title }));
  }
  const input = head ? head.draft || {} : cmd;
  const { steps, defs } = definitions(read, input.steps, false);
  operations.push(operation('publishVersion', {
    planId, expectedRev: head ? expectedRev(cmd) : 1, steps: membershipSteps(steps),
  }));
  for (const def of defs) operations.push(operation('createTask', taskIntent(planId, 1, def)));
  operations.push(operation('autoFocus', { planId }));
  return { operations };
}

export function planRevise(read, cmd) {
  const project = read.state.project;
  const planId = typeof cmd.planId === 'string' && cmd.planId ? cmd.planId : project.focusPlanId || project.currentPlanId;
  if (!planId) throw new BoardError('plan-not-found', 'plan not found: ' + (cmd.planId || ''), { status: 404 });
  const head = requireHead(read, { planId });
  if (head.status === 'archived') throw new BoardError('plan-archived', 'plan is archived', { status: 409 });
  if (head.status === 'draft') {
    return { operations: [operation('editDraft', { planId, expectedRev: expectedRev(cmd), ...draftInput(cmd, true), ...(typeof cmd.title === 'string' ? { title: cmd.title } : {}) })] };
  }
  if (!Number.isInteger(cmd.baseVersion) || cmd.baseVersion !== head.currentVersion) throw new BoardError('stale-revision', 'plan version is ' + head.currentVersion + ', expected ' + cmd.baseVersion, { status: 409, details: { currentVersion: head.currentVersion } });
  const { steps, defs } = definitions(read, cmd.steps, true);
  const operations = [operation('reviseVersion', {
    planId, baseVersion: cmd.baseVersion, ...versionInput(cmd), steps: membershipSteps(steps),
  })];
  const version = head.currentVersion + 1;
  for (const def of defs) operations.push(operation(read.state.tasks[def.id] ? 'reviseTask' : 'createTask', taskIntent(planId, version, def)));
  const retained = new Set(defs.map((def) => def.id));
  const previous = read.state.plans[planId + '@' + head.currentVersion];
  for (const taskId of new Set((previous?.steps || []).flatMap((step) => step.taskIds))) {
    if (!retained.has(taskId) && read.state.tasks[taskId]) operations.push(operation('orphanTask', { planId, previousVersion: head.currentVersion, taskId }));
  }
  return { operations };
}

// IDs identify proposed creations, never task/head post-images. Acceptance IDs,
// evidence/met flags, task states and audit provenance are exclusively model-owned.
function definitions(read, rawSteps, revise) {
  const steps = normalizePlanIntentSteps(rawSteps);
  const defs = steps.flatMap((step) => step.tasks.map((task) => Object.assign(task, { stepId: step.id })));
  const ids = new Map();
  for (const def of defs) {
    if (revise && def.taskId && !read.state.tasks[def.taskId]) throw new BoardError('invalid-command', 'taskId ' + def.taskId + ' is not in this project', { status: 400 });
    if (ids.has(def.key)) throw new BoardError('invalid-command', 'duplicate task key ' + def.key, { status: 400 });
    ids.set(def.key, revise && def.taskId ? def.taskId : read.newId('tsk'));
  }
  if (revise) {
    const keys = new Set(ids.keys());
    ensureAcyclic(defs.map((def) => ({ ...def, deps: def.deps.filter((dep) => keys.has(dep)) })));
  } else {
    ensureAcyclic(defs);
    assertPublishStageDependencies(steps);
  }
  for (const def of defs) {
    def.id = ids.get(def.key);
    def.deps = def.deps.map((dep) => {
      if (ids.has(dep)) return ids.get(dep);
      if (revise && read.state.tasks[dep]) return dep;
      throw new BoardError('invalid-command', 'unknown dependency ' + dep, { status: 400 });
    });
  }
  return { steps, defs };
}
function membershipSteps(steps) {
  return steps.map((step) => ({ id: step.id, title: step.title, taskIds: step.tasks.map((def) => def.id) }));
}
function taskIntent(planId, version, def) {
  const args = { planId, version, taskId: def.id, stepId: def.stepId, title: def.title,
    priority: def.priority, weight: def.weight, deps: def.deps,
    acceptance: def.acceptance.map(({ text, requiredKinds }) => ({ text, requiredKinds })) };
  for (const key of ['description', 'labels', 'requiresAudit']) if (def[key] !== undefined) args[key] = def[key];
  return args;
}
function versionInput(cmd) {
  const input = {};
  for (const key of ['title', 'goal', 'assumptions', 'risks']) if (cmd[key] !== undefined) input[key] = cmd[key];
  return input;
}
function draftInput(cmd, partial = false) {
  const input = versionInput(cmd);
  delete input.title;
  if (!partial || cmd.steps !== undefined) input.steps = Array.isArray(cmd.steps) ? cmd.steps : [];
  return input;
}

export function planRename(read, cmd) {
  return { operations: [operation('rename', { planId: cmd.planId, expectedRev: expectedRev(cmd), title: cmd.title })] };
}
export function planArchive(read, cmd) {
  return { operations: [operation('archive', { planId: cmd.planId, expectedRev: expectedRev(cmd) })] };
}
export function planUnarchive(read, cmd) {
  return { operations: [operation('unarchive', { planId: cmd.planId, expectedRev: expectedRev(cmd) })] };
}
export function planFocus(read, cmd) {
  const planId = cmd.planId === undefined || cmd.planId === null || cmd.planId === '' ? null : String(cmd.planId);
  return { operations: [operation('focus', { planId })] };
}
export function requireHead(read, cmd) {
  const planId = typeof cmd.planId === 'string' && cmd.planId !== '' ? cmd.planId : null;
  if (!planId) throw new BoardError('invalid-command', 'planId is required', { status: 400 });
  const head = read.state.planHeads[planId];
  if (!head) throw new BoardError('plan-not-found', 'plan not found: ' + planId, { status: 404 });
  return head;
}
export function assertHeadRev(read, head, cmd) {
  const expected = expectedRev(cmd);
  if (!Number.isInteger(expected) || expected !== head.rev) throw new BoardError('stale-revision', 'plan ' + head.id + ' rev is ' + head.rev + (Number.isInteger(expected) ? ', expected ' + expected : '; expectedRev is required'), { status: 409, details: { currentRev: head.rev, planId: head.id } });
}
export function assertTitleUnique(read, title, excludeId = null) {
  return assertPlanTitleUnique(read.state.planHeads, title, excludeId);
}
