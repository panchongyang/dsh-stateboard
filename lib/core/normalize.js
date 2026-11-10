import { BoardError } from './errors.js';
import { newId } from './util.js';

// Command payload normalization: everything that turns untrusted input into the
// exact shape the state machine writes. Pure functions over (input, state), so
// the command methods in service.js stay about transitions and event order.

export const DEFAULT_POLICY = {
  maxInProgress: 5,
  maxPerSession: 1,
  leaseTtlSec: 900,
  leaseGraceSec: 900,
  maxRenewalsWithoutProgress: 2,
  verification: 'manual',
  requireIntentFor: 'irreversible',
};

export function policyOf(project) {
  return { ...DEFAULT_POLICY, ...(project.policy || {}), verification: 'manual' };
}

export function actorSystem() {
  return { kind: 'system', via: 'system' };
}

export function normalizeLabels(input) {
  if (!Array.isArray(input)) return null;
  const out = [];
  for (const raw of input) {
    const label = String(raw).trim();
    if (label !== '' && !out.includes(label)) out.push(label);
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * Resolve the audit switch from an explicit boolean and/or the
 * gate:audit label. Agents may turn the switch on, never off; only a human can
 * clear it. Labels alone never clear an existing gate.
 */
export function resolveAuditGate(input, current, actor) {
  const currentGate = Boolean(current && (current.requiresAudit || (Array.isArray(current.labels) && current.labels.includes('gate:audit'))));
  const hasBoolean = typeof input.requiresAudit === 'boolean';
  const labels = normalizeLabels(input.labels);
  const labelGate = Boolean(labels && labels.includes('gate:audit'));
  let gate = hasBoolean ? input.requiresAudit : currentGate;
  if (labelGate) gate = true;
  if (!hasBoolean && labels && !labelGate) gate = currentGate;
  const agent = actor?.kind === 'agent';
  const labelChanged = labels && labels.includes('gate:audit') !== Boolean(current?.labels?.includes('gate:audit'));
  if (agent && current?.state === 'review' && (gate !== currentGate || labelChanged || hasBoolean)) {
    throw new BoardError('forbidden-role', 'agents cannot change an audit gate in review', { status: 403, details: { gateLocked: true, reason: current?.state === 'review' ? 'review-gate-locked' : 'gate-locked' } });
  }
  if (actor?.kind !== 'human' && currentGate && !gate) {
    throw new BoardError('forbidden-role', 'agents cannot disable the audit gate; a human must do it', { status: 403, details: { gateLocked: true } });
  }
  let nextLabels = labels ? labels.slice() : (current && Array.isArray(current.labels) ? current.labels.slice() : []);
  if (gate && !nextLabels.includes('gate:audit')) nextLabels.push('gate:audit');
  if (!gate) nextLabels = nextLabels.filter((label) => label !== 'gate:audit');
  return { gate, labels: nextLabels };
}

export function mergeAcceptance(existing, input) {
  const list = Array.isArray(input) ? input : [];
  const old = Array.isArray(existing) ? existing : [];
  // Omitted (or empty) means "keep what is there". A plan revision or a task.update
  // that forgets acceptance must not erase the only way the task can ever be verified.
  if (list.length === 0) return old.map((entry) => ({ ...entry }));
  const out = [];
  for (const item of list) {
    const text = String(item.text || '').trim();
    if (text === '') throw new BoardError('invalid-command', 'acceptance text must be non-empty', { status: 400 });
    const previous = old.find((entry) => entry.text === text);
    if (previous) {
      out.push({
        ...previous,
        text,
        requiredKinds: Array.isArray(item.requiredKinds) ? item.requiredKinds : (previous.requiredKinds || []),
      });
    } else {
      out.push({
        id: newId('acc'),
        text,
        met: false,
        evidenceIds: [],
        requiredKinds: Array.isArray(item.requiredKinds) ? item.requiredKinds : [],
      });
    }
  }
  return out;
}

export function newAcceptance(input) {
  return mergeAcceptance([], input);
}

export function ensureAcyclic(defs) {
  const byKey = new Map(defs.map((def) => [def.key, def]));
  const visiting = new Set();
  const done = new Set();
  const visit = (key) => {
    if (visiting.has(key)) throw new BoardError('invalid-command', 'dependency cycle at ' + key, { status: 400 });
    if (done.has(key)) return;
    const def = byKey.get(key);
    if (!def) throw new BoardError('invalid-command', 'unknown dependency ' + key, { status: 400 });
    visiting.add(key);
    for (const dep of def.deps || []) visit(dep);
    visiting.delete(key);
    done.add(key);
  };
  for (const def of defs) visit(def.key);
}

export function normalizeSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new BoardError('invalid-command', 'plan requires at least one step', { status: 400 });
  }
  const out = [];
  let taskIndex = 0;
  for (let s = 0; s < steps.length; s++) {
    const step = steps[s];
    if (!step) throw new BoardError('invalid-command', 'plan step must be an object', { status: 400 });
    if (step.tasks !== undefined && !Array.isArray(step.tasks)) {
      throw new BoardError('invalid-command', 'plan step tasks must be an array', { status: 400 });
    }
    // A step may be empty: a skeleton plan is published first and filled by plan.adopt.
    const stepTasks = Array.isArray(step.tasks) ? step.tasks : [];
    const normalized = {
      id: typeof step.id === 'string' && step.id !== '' ? step.id : 'step_' + (s + 1),
      title: String(step.title || '').trim() || ('Step ' + (s + 1)),
      tasks: [],
    };
    for (let t = 0; t < stepTasks.length; t++) {
      const task = stepTasks[t] || {};
      taskIndex += 1;
      const key = typeof task.key === 'string' && task.key !== '' ? task.key : 't' + taskIndex;
      const title = String(task.title || '').trim();
      if (title === '') throw new BoardError('invalid-command', 'task title must be non-empty', { status: 400 });
      const acceptance = newAcceptance(task.acceptance);
      // A task entering through a plan is no different from task.create: without a
      // criterion it can never be verified, so it can never leave review either.
      // A revise that reuses an existing task may omit it (mergeAcceptance inherits).
      if (acceptance.length === 0 && !(typeof task.taskId === 'string' && task.taskId !== '')) {
        throw new BoardError('invalid-command', 'task "' + title + '" needs at least one acceptance criterion', { status: 400 });
      }
      normalized.tasks.push({
        ...task,
        key,
        title,
        priority: Number.isInteger(task.priority) ? task.priority : 100,
        weight: typeof task.weight === 'number' && task.weight > 0 ? task.weight : 1,
        deps: Array.isArray(task.deps) ? task.deps : [],
        acceptance,
      });
    }
    out.push(normalized);
  }
  return out;
}

/**
 * Validate a doc.links payload against current state. Unknown ids are rejected
 * here because the commit log is append-only: a dangling link written today can
 * never be deleted later, only filtered out on read.
 */
export const MAX_DOC_LINKS = 100;

export function normalizeDocLinks(state, links) {
  const rawTasks = Array.isArray(links && links.taskIds) ? links.taskIds : [];
  const taskIds = [];
  const unknownTaskIds = [];
  for (const raw of rawTasks) {
    const id = String(raw == null ? '' : raw).trim();
    if (id === '' || taskIds.includes(id)) continue;
    if (!state.tasks[id]) { unknownTaskIds.push(id); continue; }
    taskIds.push(id);
  }
  if (unknownTaskIds.length > 0) {
    throw new BoardError('invalid-command', 'unknown task in doc links: ' + unknownTaskIds.join(', '), { status: 400, details: { unknownTaskIds } });
  }
  if (taskIds.length > MAX_DOC_LINKS) {
    throw new BoardError('invalid-command', 'doc links exceed ' + MAX_DOC_LINKS + ' task ids', { status: 400 });
  }
  const planRefs = [];
  const seen = new Set();
  for (const raw of Array.isArray(links && links.planRefs) ? links.planRefs : []) {
    const planId = String(raw && raw.planId ? raw.planId : '').trim();
    const version = raw && Number.isInteger(raw.version) ? raw.version : null;
    if (planId === '' || version === null) {
      throw new BoardError('invalid-command', 'planRef needs planId and an integer version', { status: 400 });
    }
    const key = planId + '@' + version;
    if (seen.has(key)) continue;
    if (!state.plans[key]) {
      throw new BoardError('invalid-command', 'unknown plan version in doc links: ' + key, { status: 400, details: { planRef: key } });
    }
    seen.add(key);
    planRefs.push({ planId, version });
  }
  return { taskIds, planRefs };
}

export function keyToIdHasValue(map, value) {
  for (const candidate of map.values()) if (candidate === value) return true;
  return false;
}
