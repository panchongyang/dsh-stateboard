// The reader's public query entry: one validated request, one captured
// snapshot, one detached value DTO. Side-effect adapters are explicit; ordinary
// projection never opens a store, creates a handle or touches a lease.
import { projectDataDir } from '../store/space-home.js';
import path from 'node:path';
import { spaceReadKey } from './stable.js';
import { DOC_RELATION_READ_VIEW, WORKSPACE_BODY_READ_VIEWS } from '../../shared/agent-tools.js';
import { normalizeDocumentRelationQuery } from './document-relations.js';
import { PROJECT_READ_ID_PATTERNS, PROJECT_READ_PAGE_MAX } from '../../shared/contract.js';
import { BoardError } from '../errors.js';
import { detachValue } from '../projection/source.js';
import { IN_MEMORY_VIEWS } from '../projection/views.js';
import { createStableReadPort, executeRead } from './execute.js';
import {
  assertCurrent, blobReader, captureBindings, publishedBlobs, publishedSnapshot, readPublished,
} from './snapshot.js';

const PROJECT_ID = new RegExp(PROJECT_READ_ID_PATTERNS.project);
const TASK_ID = new RegExp(PROJECT_READ_ID_PATTERNS.task);
const DOC_ID = /^doc_[A-Za-z0-9_-]{1,126}$/;
const RETAINED_VIEWS = new Set(Object.values(WORKSPACE_BODY_READ_VIEWS));
const QUERY_VIEWS = new Set([...IN_MEMORY_VIEWS, ...RETAINED_VIEWS, DOC_RELATION_READ_VIEW, 'doc', 'inspect', 'get_fixed', 'doc_asset', 'health', 'list_external']);
const EXTERNAL_VIEWS = new Set(['inspect', 'get_fixed', 'doc_asset']);
function viewBindings(service, projectId, view) {
  if (EXTERNAL_VIEWS.has(view)) return captureBindings(service, projectId);
  // Cold health audits need the physical file root, not a change to document bindings.
  return view === 'health' && service.spaceHome ? { fileEvidenceRoot: service.spaceHome.root } : null;
}
const TIMELINE_VIEWS = new Set(['task', 'events', 'task_overview', 'work_context']);
const COMMIT_VIEWS = new Set(['brief', 'digest']);
const QUERY_WORKER = new URL('./query-worker.js', import.meta.url);
const HEALTH_WORKER = new URL('./health-worker.js', import.meta.url);
// One audit per (runner, project, revision): a repeated health read at the same
// published watermark shares the flight; a new revision starts a fresh one.
const healthFlights = new WeakMap();
// One observation port per (runner, project): external-observe keys its 30 s
// cache by this identity; values are refreshed before every call.
const externalPorts = new WeakMap();

function stableExternalPort(runner, projectId) {
  let ports = externalPorts.get(runner);
  if (!ports) { ports = new Map(); externalPorts.set(runner, ports); }
  let entry = ports.get(projectId);
  if (!entry) { entry = createStableReadPort({ projectId }); ports.set(projectId, entry); }
  return entry;
}

function singleHealth(runner, key, start) {
  let flights = healthFlights.get(runner);
  if (!flights) { flights = new Map(); healthFlights.set(runner, flights); }
  const existing = flights.get(key);
  if (existing) return existing;
  const promise = start();
  const entry = { promise };
  flights.set(key, entry);
  const clear = () => { if (flights.get(key) === entry) flights.delete(key); };
  promise.then(clear, clear);
  return entry;
}

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new BoardError('read-cancelled', 'Project read was cancelled', { status: 503 }));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new BoardError('read-cancelled', 'Project read was cancelled', { status: 503 }));
    signal.addEventListener('abort', abort, { once: true });
    promise.then((value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error) => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

function invalid(message) {
  throw new BoardError('invalid-command', message, { status: 400 });
}

function validateId(id, pattern, name) {
  if (typeof id !== 'string' || !pattern.test(id)) invalid(name + ' is not a valid id');
}

function normalize(projectId, view, params) {
  validateId(projectId, PROJECT_ID, 'projectId');
  if (typeof view !== 'string' || !QUERY_VIEWS.has(view)) invalid('unknown project view: ' + String(view));
  if (params === null || typeof params !== 'object' || Array.isArray(params)) invalid('params must be an object');
  const maxLimit = view === 'events' ? 500 : view === 'workspace_history' ? 100 : PROJECT_READ_PAGE_MAX;
  if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > maxLimit)) {
    invalid('limit must be an integer between 1 and ' + maxLimit);
  }
  if (view === 'tasks' && params.after !== undefined) validateId(params.after, TASK_ID, 'after');
  if (view === 'events' && params.after !== undefined && (!Number.isInteger(params.after) || params.after < 0)) {
    invalid('events after must be a non-negative integer');
  }
  if (view === 'task' || view === 'task_overview' || view === 'work_context') {
    if (params.taskId !== undefined) validateId(params.taskId, TASK_ID, 'taskId');
    if (view === 'task' && params.taskId === undefined) invalid('view=task requires taskId');
  }
  if (view === 'tasks' && params.taskId !== undefined) invalid('view=tasks does not accept taskId; use task_overview');
  if (view === 'doc' || view === 'doc_record' || view === 'inspect' || view === 'get_fixed' || view === 'doc_asset') {
    validateId(params.docId, DOC_ID, 'docId');
  }
  if (params.maxBytes !== undefined && (!Number.isInteger(params.maxBytes) || params.maxBytes < 0)) invalid('maxBytes must be a non-negative integer');
  if (params.signal !== undefined && (typeof params.signal !== 'object' || typeof params.signal.aborted !== 'boolean')) {
    invalid('signal must be an AbortSignal');
  }
  const { signal, ...serializable } = params;
  if (view === DOC_RELATION_READ_VIEW) return { clean: normalizeDocumentRelationQuery(serializable), signal };
  if (RETAINED_VIEWS.has(view)) {
    const allowed = new Set(['docId', ...(view === 'workspace_history' ? ['limit', 'after']
      : view === 'workspace_version' ? ['versionId', 'maxBytes'] : ['versionId'])]);
    if (Object.keys(serializable).some(key => !allowed.has(key))) invalid('Unsupported workspace history field');
    validateId(params.docId, DOC_ID, 'docId');
    const validVersionId = id => typeof id === 'string' && id.length <= 256 && id.trim() !== '';
    if (view !== 'workspace_history' && !validVersionId(params.versionId)) invalid('A versionId is required');
    if (params.after !== undefined && !validVersionId(params.after)) invalid('Invalid history cursor');
    if (params.maxBytes > 16 * 1024 * 1024) invalid('maxBytes cannot exceed 16 MiB');
  }
  return { clean: serializable, signal };
}

function envelope(projectId, view, projectRev, value) {
  return { projectId, view, projectRev, ...value };
}

function closedError() {
  return new BoardError('closed', 'Project reader is closed', { status: 503 });
}

/**
 * Eligibility is a pure value decision. Both the published snapshot and the
 * cold replay use this one injected provider; for a cold replay the runtime
 * lease table is empty and flagged unknown rather than fabricated.
 */
function taskHintsFor(taskHints, snapshot, params, actor, runtimeUnknown = false) {
  if (!taskHints || !params.taskId) return null;
  return taskHints({
    state: snapshot.state,
    leases: snapshot.leases,
    now: snapshot.now,
    readOnly: snapshot.readOnly,
    actor,
    taskId: params.taskId,
    sessionId: params.sessionId ?? actor.sessionId,
    runtimeUnknown,
  });
}

/**
 * Run one query. `runner` is a createWorkerRunner() instance owned by the reader;
 * closing the reader cancels every in-flight query.
 */
export async function queryProject({ service, runner, isClosed, taskHints = null }, projectId, view, params = {}, actor = {}) {
  const { clean, signal } = normalize(projectId, view, params);
  const check = () => {
    if (isClosed()) throw closedError();
    if (signal?.aborted) throw new BoardError('read-cancelled', 'Project read was cancelled', { status: 503 });
  };
  check();
  const now = service.clock().getTime();
  if (RETAINED_VIEWS.has(view) || view === DOC_RELATION_READ_VIEW) {
    // Even with a published writer, run these observations against stable,
    // lock-free replay. No writer or current-content cache is passed to the worker.
    service.assertAccess?.();
    const spaceHome = service.spaceHome;
    const spaceKey = spaceReadKey(spaceHome);
    const isRelation = view === DOC_RELATION_READ_VIEW;
    const unavailable = () => new BoardError('space-home-unavailable', isRelation
      ? 'Document relations require the authorized space home' : 'Workspace history requires the authorized space home', { status: 409 });
    if (!spaceKey) throw unavailable();
    const dir = projectDataDir(service, projectId);
    const bindings = isRelation ? captureBindings(service, projectId) : undefined;
    const outcome = await runner.run(QUERY_WORKER, { dir, projectId, view, params: clean, actor, now, spaceRoot: spaceHome.root, spaceKey, bindings }, { signal });
    check();
    service.assertAccess?.();
    if (spaceReadKey(spaceHome) !== spaceKey) throw unavailable();
    return envelope(projectId, view, outcome.projectRev, outcome.value);
  }
  const projectDir = projectDataDir(service, projectId);
  const published = readPublished(service, projectId);
  if (published) {
    return queryPublished({ service, runner, isClosed, taskHints, projectId, view, params: clean, actor, published, now, signal, projectDir });
  }
  const bindings = viewBindings(service, projectId, view);
  const outcome = await runner.run(QUERY_WORKER, {
    dir: projectDir, projectId, view, params: clean, actor, now, bindings,
    // The worker owns the replayed state, so it returns the minimal eligibility
    // facts for the application's pure hint provider (cold task reads only).
    wantHints: Boolean(taskHints) && view === 'task',
  }, { signal });
  const value = outcome && Object.hasOwn(outcome, 'value') ? outcome.value : outcome;
  check();
  // A writer may have appeared while the worker replayed the file. Never publish
  // the worker's snapshot over a newer published revision.
  const appeared = readPublished(service, projectId);
  if (appeared) {
    const source = publishedSnapshot(appeared, now, { timeline: TIMELINE_VIEWS.has(view), commits: COMMIT_VIEWS.has(view) });
    const fresh = executeRead({
      snapshot: source, view, params: clean, actor,
      readBlob: blobReader(source, projectDir, appeared),
      bindings: viewBindings(service, projectId, view),
      meta: appeared.meta,
      hints: taskHintsFor(taskHints, source, clean, actor),
    });
    assertCurrent(service, projectId, source);
    return envelope(projectId, view, source.rev, detachValue(fresh));
  }
  if (outcome?.hintFacts && taskHints) {
    const hints = taskHints({ ...outcome.hintFacts, actor, sessionId: clean.sessionId ?? actor.sessionId });
    return envelope(projectId, view, value?.projectRev ?? value?.rev ?? null, { ...value, allowedOps: hints.allowedOps });
  }
  return envelope(projectId, view, value?.projectRev ?? value?.rev ?? null, value);
}

async function queryPublished({ service, runner, isClosed, taskHints, projectId, view, params, actor, published, now, signal, projectDir }) {
  const snapshot = publishedSnapshot(published, now, {
    timeline: TIMELINE_VIEWS.has(view),
    commits: COMMIT_VIEWS.has(view),
  });
  if (view === 'health') {
    // A full audit always leaves the main thread, even for a hot project.
    const blobs = publishedBlobs(published);
    const key = projectId + ':' + snapshot.rev + ':' + (snapshot.lastHash || '');
    const flight = singleHealth(runner, key, () => runner.run(HEALTH_WORKER, {
      projectId, state: snapshot.state, rev: snapshot.rev, now, readOnly: snapshot.readOnly,
      leases: snapshot.leases, meta: snapshot.meta,
      bindings: captureBindings(service, projectId),
      blobs, blobsDir: path.join(projectDir, 'blobs'),
    }));
    const value = await abortable(flight.promise, signal);
    if (isClosed()) throw closedError();
    assertCurrent(service, projectId, snapshot);
    return envelope(projectId, view, snapshot.rev, value);
  }
  const readBlob = view === 'doc' ? blobReader(snapshot, projectDir, published) : () => null;
  const bindings = viewBindings(service, projectId, view);
  let observationPort = null;
  if (EXTERNAL_VIEWS.has(view)) {
    observationPort = stableExternalPort(runner, projectId).update({
      projectId, state: snapshot.state, rev: snapshot.rev, now, leases: snapshot.leases,
      meta: published.meta, bindings, readBlob, readOnly: false,
    });
  }
  const hints = view === 'task' ? taskHintsFor(taskHints, snapshot, params, actor) : null;
  const value = executeRead({ snapshot, view, params, actor, readBlob, bindings, meta: published.meta, port: observationPort, hints });
  assertCurrent(service, projectId, snapshot);
  if (isClosed()) throw closedError();
  return envelope(projectId, view, snapshot.rev, detachValue(value));
}
