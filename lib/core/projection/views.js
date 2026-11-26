// Pure projections over a captured snapshot. No blob, file, Git, clock or
// health side effect lives here; the reader supplies the values and composes
// side-effect adapters separately.
import { BoardError } from '../errors.js';
import { buildDigest } from '../digest.js';
import { projectResult } from '../project-reader-projection.js';
import { progressOf } from '../model.js';
import { isExternal } from '../documents/external-model.js';
import { viewSource } from './source.js';
import { briefView, boardView, docsView, eventsView, plansView, planView, taskView } from '../views.js';

export const IN_MEMORY_VIEWS = Object.freeze([
  'brief', 'digest', 'summary', 'board', 'task', 'plan', 'plans', 'docs', 'doc_record', 'events', 'list_external', 'tasks', 'task_overview', 'work_context',
]);

function invalid(message) {
  throw new BoardError('invalid-command', message, { status: 400 });
}

function digestOf(snapshot, sessionId, options = {}) {
  const source = viewSource(snapshot);
  const brief = briefView(source, sessionId);
  return { brief, digest: buildDigest(brief, sessionId, options) };
}

/**
 * Pure projection. Returns only plain values cloned from the snapshot; callers
 * must still detach before publishing to another thread/endpoint.
 */
export function projectValue(view, snapshot, params = {}, actor = {}, hints = null) {
  const source = viewSource(snapshot);
  switch (view) {
    case 'brief':
      return briefView(source, params.sessionId ?? actor.sessionId);
    case 'digest': {
      const result = digestOf(snapshot, params.sessionId ?? actor.sessionId, params.options);
      return { digest: result.digest, brief: result.brief };
    }
    case 'summary': {
      const project = source.state.project;
      return {
        id: project.id, name: project.name, workspacePath: project.workspacePath,
        phase: project.phase, rev: source.rev, counts: progressOf(source.state),
        lastAt: project.updatedAt, readOnly: source.readOnly,
      };
    }
    case 'board':
      return boardView(source);
    case 'task': {
      if (typeof params.taskId !== 'string' || params.taskId === '') invalid('view=task requires taskId');
      return taskView(source, params.taskId, params.sessionId ?? actor.sessionId, hints, actor);
    }
    case 'plan':
      return planView(source, params.planId);
    case 'plans':
      return plansView(source, params);
    case 'doc_record': {
      const doc = source.state.docs[params.docId];
      if (!doc) throw new BoardError('not-found', 'doc not found: ' + params.docId, { status: 404 });
      return { doc: structuredClone(doc) };
    }
    case 'docs': {
      const result = docsView(source);
      if (!params.query) return result;
      const needle = String(params.query).toLowerCase();
      return { ...result, docs: result.docs.filter((doc) => String(doc.title).toLowerCase().includes(needle)) };
    }
    case 'list_external': {
      const includeUnregistered = params.includeUnregistered === true;
      const docs = Object.values(source.state.docs)
        .filter((doc) => isExternal(doc) && (includeUnregistered || !doc.unregistered))
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .map((doc) => structuredClone(doc));
      return { schemaVersion: 1, docs, projectRev: source.rev };
    }
    case 'events': {
      const after = Number.isInteger(params.after) ? params.after : 0;
      const limit = Number.isInteger(params.limit) ? params.limit : 50;
      return eventsView(source, after, limit);
    }
    case 'tasks':
    case 'task_overview':
    case 'work_context': {
      const query = workContextQuery({ ...params, view, projectId: params.projectId ?? source.projectId }, actor);
      return projectResult(source.state, query);
    }
    default:
      invalid('unknown project view: ' + view);
  }
}

function workContextQuery(params, _actor) {
  const query = {
    projectId: params.projectId,
    taskId: params.taskId,
    state: params.state,
    limit: params.limit,
    after: params.after,
    workContext: false,
  };
  if (params.view === 'work_context' || params.workContext === true) query.workContext = true;
  return query;
}

/** Synchronous pure digest for Prompt assembly: no module loading and no I/O. */
export function digestValue(snapshot, sessionId, options = {}) {
  return digestOf(snapshot, sessionId, options);
}

/**
 * Host-facing synchronous Prompt digest over already-published values. It never
 * loads a module, opens a file, touches Git, or asks a writer for anything.
 */
export function digestFromPublished(published, sessionId, options = {}, now) {
  if (!published || !published.state) return '';
  if (!Number.isFinite(now)) throw new BoardError('invalid-command', 'digestFromPublished requires the caller\'s captured time', { status: 400 });
  const leases = published.leases instanceof Map ? [...published.leases.values()] : (published.leases || []);
  return digestValue({
    state: published.state,
    rev: published.lastSeq ?? published.state.lastSeq,
    leases,
    // Delivery lines (LAST CHECKPOINT / verified) need the committed tail; the
    // tail is referenced, never cloned, and timeline is not touched.
    commits: published.commits || [],
    now,
    readOnly: false,
  }, sessionId, options).digest;
}

export function isDetachedValueView(view) {
  return IN_MEMORY_VIEWS.includes(view) || view === 'health';
}

export { viewSource };
