// Detached bounded task views shared by the live reader and the cold worker.
import { EVIDENCE_KINDS, PROJECT_READ_ID_PATTERNS, TASK_STATES } from '../shared/contract.js';
import { BoardError } from './errors.js';

const TASK_ID = new RegExp(PROJECT_READ_ID_PATTERNS.task);
const MAX_TITLE = 300;
const MAX_DESCRIPTION = 4_000;
const MAX_ACCEPTANCE = 40;
const MAX_ACCEPTANCE_TEXT = 400;

function unreadable() {
  return new BoardError('project-unreadable', 'Project data is unreadable', { status: 503 });
}

function taskRow(task, id) {
  if (task?.id !== id || !TASK_ID.test(id) || !TASK_STATES.includes(task.state) || !Number.isSafeInteger(task.rev)) {
    throw unreadable();
  }
  const title = typeof task.title === 'string' ? task.title : '';
  return {
    id: task.id, title: title.slice(0, MAX_TITLE), state: task.state, rev: task.rev,
    priority: Number.isSafeInteger(task.priority) ? task.priority : null, truncated: title.length > MAX_TITLE,
  };
}

function taskDetail(task, id) {
  const row = taskRow(task, id);
  const description = typeof task.description === 'string' ? task.description : '';
  const criteria = task.acceptance ?? [];
  const displayedCriteria = criteria.slice(0, MAX_ACCEPTANCE);
  const acceptance = displayedCriteria.map(({ id, text, met, requiredKinds }) => ({
    id: String(id ?? '').slice(0, 128), text: String(text ?? '').slice(0, MAX_ACCEPTANCE_TEXT), met: Boolean(met),
    requiredKinds: EVIDENCE_KINDS.filter((kind) => Array.isArray(requiredKinds) && requiredKinds.includes(kind)),
  }));
  return {
    ...row, description: description.slice(0, MAX_DESCRIPTION), acceptance, acceptanceTotal: criteria.length,
    evidenceCount: Array.isArray(task.evidence) ? task.evidence.length : 0,
    truncated: row.truncated || description.length > MAX_DESCRIPTION || criteria.length > MAX_ACCEPTANCE
      || displayedCriteria.some(({ id, text }) => String(id ?? '').length > 128 || String(text ?? '').length > MAX_ACCEPTANCE_TEXT),
  };
}

export function projectResult(project, query) {
  const { projectId, taskId, state, limit, after } = query;
  const head = { projectId, projectRev: project.lastSeq };
  if (taskId !== undefined) {
    if (!Object.hasOwn(project.tasks, taskId)) {
      throw new BoardError('not-found', 'Task not found', { status: 404 });
    }
    return { ...head, task: taskDetail(project.tasks[taskId], taskId) };
  }
  const page = Object.keys(project.tasks).filter((id) =>
    (after === undefined || id > after) && (state === undefined || project.tasks[id].state === state),
  ).sort().slice(0, limit + 1);
  const tasks = page.slice(0, limit).map((id) => taskRow(project.tasks[id], id));
  return { ...head, tasks, nextCursor: page.length > limit ? tasks.at(-1).id : null };
}
