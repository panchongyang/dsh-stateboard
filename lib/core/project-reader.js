// MCP and future adapters read detached project data without opening a writer.
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { PROJECT_READ_ID_PATTERNS, PROJECT_READ_PAGE_DEFAULT, PROJECT_READ_PAGE_MAX, TASK_STATES } from '../shared/contract.js';
import { BoardError } from './errors.js';
import { projectResult } from './project-reader-projection.js';

const PROJECT_ID = new RegExp(PROJECT_READ_ID_PATTERNS.project);
const TASK_ID = new RegExp(PROJECT_READ_ID_PATTERNS.task);
const MAX_WORKERS = 2;
const READ_TIMEOUT_MS = 30_000;
let activeWorkers = 0;

function invalid(message) {
  throw new BoardError('invalid-command', message, { status: 400 });
}

function unavailable(code, message) {
  return new BoardError(code, message, { status: 503 });
}

function validateId(id, pattern, name) {
  if (typeof id !== 'string' || !pattern.test(id)) invalid(name + ' is not a valid id');
}

function validatePage(limit, after, pattern) {
  if (!Number.isInteger(limit) || limit < 1 || limit > PROJECT_READ_PAGE_MAX) {
    invalid('limit must be an integer between 1 and ' + PROJECT_READ_PAGE_MAX);
  }
  if (after !== undefined) validateId(after, pattern, 'after');
}

function projectRow(row) {
  if (row.error || typeof row.name !== 'string' || !Number.isSafeInteger(row.rev) || row.rev < 1 || !['active', 'paused', 'archived'].includes(row.phase)) {
    return { id: row.id, available: false, error: { code: 'project-unreadable', message: 'Project data is unavailable' } };
  }
  return { id: row.id, name: row.name.slice(0, 300), phase: row.phase, rev: row.rev, available: true };
}

function runRead(data, jobs) {
  if (activeWorkers >= MAX_WORKERS) throw unavailable('read-busy', 'Project reads are busy; retry later');
  const worker = new Worker(new URL('./project-reader-worker.js', import.meta.url), {
    workerData: data,
    resourceLimits: { maxOldGenerationSizeMb: 256 },
  });
  activeWorkers += 1;
  return new Promise((resolve, reject) => {
    let stopping;
    function finish(error, value) {
      if (stopping) return stopping;
      clearTimeout(timer);
      stopping = worker.terminate().catch(() => {
        error ??= unavailable('project-unreadable', 'Project read worker could not stop');
      }).then(() => {
        activeWorkers -= 1;
        jobs.delete(cancel);
        if (error) reject(error); else resolve(value);
      });
      return stopping;
    }
    const cancel = () => finish(unavailable('closed', 'Project reader is closed'));
    const timer = setTimeout(() => finish(unavailable('read-expired', 'Project read exceeded its deadline')), READ_TIMEOUT_MS);
    jobs.add(cancel);
    worker.once('message', ({ error, result }) => finish(error ? new BoardError(error.code, error.message, { status: error.status }) : null, result));
    worker.once('error', () => finish(unavailable('project-unreadable', 'Project read worker failed')));
    worker.once('exit', () => finish(unavailable('project-unreadable', 'Project read worker exited without a result')));
  });
}

/** The read port owns its replay workers. The service still owns project-list work. */
export function createProjectReader(service) {
  let closed = false;
  const jobs = new Set();

  function assertOpen() {
    if (closed) throw unavailable('closed', 'Project reader is closed');
  }

  async function read(projectId, query) {
    assertOpen();
    validateId(projectId, PROJECT_ID, 'projectId');
    const request = { projectId, ...query };
    const writer = service.lookupLiveWriter(projectId);
    // Store state is published after append succeeds. Handle state can be a working copy.
    if (writer) return projectResult(writer.store.state, request);

    let result, error;
    try { result = await runRead({ dir: path.join(service.projectsDir, projectId), ...request }, jobs); }
    catch (caught) { error = caught; }
    assertOpen();
    // A writer may have opened while the worker was observing the file.
    const opened = service.lookupLiveWriter(projectId);
    if (opened) return projectResult(opened.store.state, request);
    if (error) throw error;
    return result;
  }

  return {
    async listProjects({ limit = PROJECT_READ_PAGE_DEFAULT, after } = {}) {
      assertOpen();
      validatePage(limit, after, PROJECT_ID);
      const rows = await service.listProjectsAsync();
      assertOpen();
      const byId = new Map(rows.filter(({ id }) => typeof id === 'string' && PROJECT_ID.test(id)).map((row) => [row.id, row]));
      const page = [...byId.keys()].filter((id) => after === undefined || id > after).sort().slice(0, limit + 1);
      const projects = page.slice(0, limit).map((id) => projectRow(byId.get(id)));
      return { projects, nextCursor: page.length > limit ? projects.at(-1).id : null };
    },

    async listTasks({ projectId, state, limit = PROJECT_READ_PAGE_DEFAULT, after }) {
      validatePage(limit, after, TASK_ID);
      if (state !== undefined && !TASK_STATES.includes(state)) invalid('state is not a valid task state');
      return read(projectId, { limit, after, state });
    },

    async getTask({ projectId, taskId }) {
      validateId(taskId, TASK_ID, 'taskId');
      return read(projectId, { taskId });
    },

    // Use the same committed read path for a task and its project context.
    async getWorkContext({ projectId, taskId }) {
      if (taskId !== undefined) validateId(taskId, TASK_ID, 'taskId');
      return read(projectId, { taskId, workContext: true });
    },

    async close() {
      closed = true;
      await Promise.all([...jobs].map((cancel) => cancel()));
    },
  };
}
