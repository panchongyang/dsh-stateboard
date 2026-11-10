// Detached bounded task views shared by the live reader and the cold worker.
import { EVIDENCE_KINDS, PROJECT_READ_ID_PATTERNS, TASK_STATES } from '../shared/contract.js';
import { BoardError } from './errors.js';
import { isAuditGate } from './model.js';

const TASK_ID = new RegExp(PROJECT_READ_ID_PATTERNS.task);
const MAX_TITLE = 300;
const MAX_DESCRIPTION = 4_000;
const MAX_ACCEPTANCE = 40;
const MAX_ACCEPTANCE_TEXT = 400;
const MAX_WORK_CANDIDATES = 5;
const WORK_STATE_ORDER = ['interrupted', 'in_progress', 'review', 'blocked', 'ready', 'backlog'];
const NEXT_TASK_ACTION = {
  backlog: 'check_dependencies',
  ready: 'check_claim',
  in_progress: 'check_work_session',
  review: 'check_review',
  blocked: 'inspect_blocker',
  interrupted: 'reconcile',
  done: 'read_outcome',
  canceled: 'read_outcome',
};

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

// Project a bounded copy of the durable blocker, without owner or runtime data.
function blockerDetail(task) {
  if (task.state !== 'blocked' || !task.blocker) return null;
  const code = String(task.blocker.code ?? '');
  const note = String(task.blocker.note ?? '');
  return { code: code.slice(0, 128), note: note.slice(0, 400), truncated: code.length > 128 || note.length > 400 };
}

// Continuity comes first. Even a single candidate still needs confirmation.
function workCandidates(tasks) {
  const candidates = Object.values(tasks).filter((task) => WORK_STATE_ORDER.includes(task.state));
  candidates.sort((a, b) =>
    WORK_STATE_ORDER.indexOf(a.state) - WORK_STATE_ORDER.indexOf(b.state)
    || String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''))
    || a.id.localeCompare(b.id));
  return {
    task: null,
    candidates: candidates.slice(0, MAX_WORK_CANDIDATES).map((task) => taskRow(task, task.id)),
    candidateCount: candidates.length,
    nextAction: candidates.length ? 'select_task' : 'no_open_task',
  };
}

export function projectResult(project, query) {
  const { projectId, taskId, state, limit, after, workContext } = query;
  const head = { projectId, projectRev: project.lastSeq };
  if (workContext) {
    const { name, phase } = project.project;
    head.project = { name: name.slice(0, MAX_TITLE), phase };
  }
  if (taskId !== undefined) {
    if (!Object.hasOwn(project.tasks, taskId)) {
      throw new BoardError('not-found', 'Task not found', { status: 404 });
    }
    const task = project.tasks[taskId];
    const detail = taskDetail(task, taskId);
    if (!workContext) return { ...head, task: detail };
    return {
      ...head,
      task: { ...detail, requiresAudit: isAuditGate(task), blocker: blockerDetail(task) },
      candidates: [],
      candidateCount: 0,
      nextAction: NEXT_TASK_ACTION[task.state],
    };
  }
  if (workContext) return { ...head, ...workCandidates(project.tasks) };
  const page = Object.keys(project.tasks).filter((id) =>
    (after === undefined || id > after) && (state === undefined || project.tasks[id].state === state),
  ).sort().slice(0, limit + 1);
  const tasks = page.slice(0, limit).map((id) => taskRow(project.tasks[id], id));
  return { ...head, tasks, nextCursor: page.length > limit ? tasks.at(-1).id : null };
}
