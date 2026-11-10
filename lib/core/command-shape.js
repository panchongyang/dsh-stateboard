// Fail closed on unknown intake intent without interpreting obsolete field aliases.
import { BoardError } from './errors.js';

const ENVELOPE = ['op', 'cmdId', 'actor', 'expected', 'expectedRev', 'projectId', 'projectRev', 'fencingToken', 'note', 'reason'];
const TASK = ['taskId', 'title', 'description', 'priority', 'weight', 'acceptance', 'deps', 'labels', 'requiresAudit', 'planRef'];
const PLAN = ['planId', 'title', 'goal', 'assumptions', 'risks', 'steps', 'baseVersion', 'createIfMissing', 'stepId', 'taskIds'];
const DEFINITION = ['key', 'taskId', 'title', 'description', 'priority', 'weight', 'acceptance', 'deps', 'labels', 'requiresAudit'];
const INTAKE = new Set(['task.create', 'task.update', 'task.gate', 'plan.create', 'plan.publish', 'plan.revise']);

function invalid(message, details = {}) {
  throw new BoardError('invalid-command', message, { status: 400, details });
}

function properties(value, allowed, where) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(where + ' must be an object');
  const keys = Object.keys(value);
  if (keys.length > 64) invalid(where + ' has too many properties');
  const unknown = keys.filter((key) => !allowed.includes(key));
  if (unknown.length) invalid(where + ' contains unsupported properties: ' + unknown.join(', '), { properties: unknown, where });
}

export function validateGateInput(input, where = 'task') {
  // Tool adapters include undefined optional fields; only a supplied value is intent.
  if (input.requiresAudit !== undefined && typeof input.requiresAudit !== 'boolean') invalid(where + '.requiresAudit must be a boolean');
  if (input.labels === undefined) return;
  if (!Array.isArray(input.labels) || input.labels.length > 1000) invalid(where + '.labels must be an array with at most 1000 entries');
  for (const label of input.labels) {
    if (typeof label !== 'string') invalid(where + '.labels must contain strings');
    const normalized = label.trim();
    if (normalized.toLowerCase().startsWith('gate:') && normalized !== 'gate:audit') invalid('unsupported gate label; use gate:audit', { where });
  }
}

export function validatePlanSteps(steps, where = 'steps') {
  if (steps === undefined) return;
  if (!Array.isArray(steps) || steps.length > 1000) invalid(where + ' must be an array with at most 1000 steps');
  let count = 0;
  for (const [index, step] of steps.entries()) {
    const stepPath = where + '[' + index + ']';
    properties(step, ['id', 'title', 'tasks'], stepPath);
    if (step.tasks === undefined) continue;
    if (!Array.isArray(step.tasks)) invalid(stepPath + '.tasks must be an array');
    count += step.tasks.length;
    if (count > 10000) invalid(where + ' has more than 10000 task definitions');
    for (const [taskIndex, task] of step.tasks.entries()) {
      const taskPath = stepPath + '.tasks[' + taskIndex + ']';
      properties(task, DEFINITION, taskPath);
      validateGateInput(task, taskPath);
    }
  }
}

// Raw tools expose a common parameter union. Validate before adapters drop fields.
export function validateToolIntake(args, family) {
  if (!INTAKE.has(family + '.' + args.op)) return;
  const taskWork = ['audit', 'unassign', 'intent', 'sideEffects', 'acknowledgeDrift', 'refreshDrift', 'code', 'choice', 'summary', 'plannedSteps', 'expectedArtifacts', 'evidence'];
  const allowed = family === 'task' ? [...TASK, ...taskWork] : PLAN;
  properties(args, [...ENVELOPE, ...allowed], family + ' tool input');
  if (family === 'task') validateGateInput(args);
  else validatePlanSteps(args.steps);
}

export function validateIntakeCommand(cmd, state) {
  if (!INTAKE.has(cmd.op)) return;
  const isTask = cmd.op.startsWith('task.');
  properties(cmd, [...ENVELOPE, ...(isTask ? TASK : PLAN)], cmd.op);
  if (isTask) validateGateInput(cmd, cmd.op);
  else {
    validatePlanSteps(cmd.steps);
    const head = state?.planHeads?.[cmd.planId];
    if (head?.status === 'draft' && (cmd.op === 'plan.publish' || (cmd.op === 'plan.revise' && cmd.steps === undefined))) {
      validatePlanSteps(head.draft?.steps, 'draft.steps');
    }
  }
}
