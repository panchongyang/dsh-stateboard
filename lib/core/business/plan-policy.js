import { BoardError } from '../errors.js';
import { planTitleConflict, planLiveWorkFact } from '../../shared/plan-rules.js';

export function assertPlanTitleUnique(heads, title, excludeId = null) {
  const conflict = planTitleConflict(heads, title, excludeId);
  if (conflict) throw new BoardError('plan-title-taken', 'plan title already taken: ' + title, { status: 409, details: conflict });
}

export function assertPlanArchivable(state, head, leasedTaskIds) {
  const fact = planLiveWorkFact(state, head, leasedTaskIds);
  if (fact) throw new BoardError('plan-has-live-work', 'plan has live work on ' + fact.taskId, { status: 409 });
}

// Pure use-case input: unlike entity acceptance normalization this never creates
// IDs, met/evidence flags, versions, states, owners or audit provenance.
export function normalizePlanIntentSteps(steps) {
  if (!Array.isArray(steps) || !steps.length) throw new BoardError('invalid-command', 'plan requires at least one step', { status: 400 });
  let taskIndex = 0;
  return steps.map((step, index) => {
    if (!step || typeof step !== 'object' || (step.tasks !== undefined && !Array.isArray(step.tasks))) throw new BoardError('invalid-command', 'plan step tasks must be an array', { status: 400 });
    return { id: typeof step.id === 'string' && step.id ? step.id : 'step_' + (index + 1),
      title: String(step.title || '').trim() || 'Step ' + (index + 1),
      tasks: (step.tasks || []).map((raw) => {
        const task = raw || {};
        taskIndex += 1;
        const title = String(task.title || '').trim();
        if (!title) throw new BoardError('invalid-command', 'task title must be non-empty', { status: 400 });
        const acceptance = (Array.isArray(task.acceptance) ? task.acceptance : []).map((entry) => {
          const text = String(entry.text || '').trim();
          if (!text) throw new BoardError('invalid-command', 'acceptance text must be non-empty', { status: 400 });
          return { text, requiredKinds: Array.isArray(entry.requiredKinds) ? entry.requiredKinds : [] };
        });
        if (!acceptance.length && !(typeof task.taskId === 'string' && task.taskId)) throw new BoardError('invalid-command', 'task "' + title + '" needs at least one acceptance criterion', { status: 400 });
        const intent = { key: typeof task.key === 'string' && task.key ? task.key : 't' + taskIndex, title,
          priority: Number.isInteger(task.priority) ? task.priority : 100,
          weight: typeof task.weight === 'number' && task.weight > 0 ? task.weight : 1,
          deps: Array.isArray(task.deps) ? task.deps : [], acceptance };
        for (const key of ['taskId', 'description', 'labels', 'requiresAudit']) if (task[key] !== undefined) intent[key] = task[key];
        return intent;
      }) };
  });
}
