// Cold replay and projection run here so the host main thread never opens a
// store, holds a lock or performs a synchronous file/Git read for a query.
import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { DOC_RELATION_READ_VIEW } from '../../shared/agent-tools.js';
import { BoardError } from '../errors.js';
import { JsonlStore, readStateWithoutLock } from '../store.js';
import { readMigrationBlob } from '../documents/migration-blob.js';
import { executeRead } from './execute.js';
import { fingerprint, spaceReadKey } from './stable.js';
import { openSpaceDirectory } from '../store/space-home.js';

const STORE_ERRORS = {
  'content-object-missing': 'The retained body object is missing',
  'content-object-corrupt': 'The retained body object failed integrity validation',
  'hash-chain-broken': 'Project log failed validation',
  'unsupported-version': 'Project metadata or log version is unsupported',
  'schema-migration-required': 'Project data needs a schema upgrade',
  'incompatible-event': 'Project log contains an unsupported event',
};

function unreadable(message = 'Project data is unreadable') {
  return new BoardError('project-unreadable', message, { status: 503 });
}

function checkIdentity(state, projectId) {
  if (!state || state.project?.id !== projectId || !Number.isSafeInteger(state.lastSeq) || state.lastSeq < 1) throw unreadable();
}

function blobReader(dir) {
  const blobsDir = path.join(dir, 'blobs');
  return (hash) => readMigrationBlob(blobsDir, hash);
}

const TIMELINE_VIEWS = new Set(['brief', 'digest', 'task', 'events', 'task_overview', 'work_context']);

/**
 * The cold replay owns committed facts only. Return the minimal state the
 * injected pure eligibility provider reads, so allowedOps can be computed on
 * the main thread without shipping a writer, a lease or the whole project.
 * Runtime facts (the lease table) are explicitly empty and flagged unknown.
 */
function hintFactsOf(snapshot, params) {
  const taskId = params.taskId;
  const tasks = {};
  for (const [id, task] of Object.entries(snapshot.state.tasks || {})) {
    tasks[id] = id === taskId ? task : { id: task.id, state: task.state, deps: task.deps };
  }
  return {
    state: {
      project: snapshot.state.project,
      tasks,
      bindings: snapshot.state.bindings || {},
      intents: Object.fromEntries(Object.entries(snapshot.state.intents || {}).filter(([, intent]) => intent.status === 'open')),
      planHeads: snapshot.state.planHeads || {},
    },
    leases: [],
    now: snapshot.now,
    readOnly: snapshot.readOnly,
    taskId,
    runtimeUnknown: true,
  };
}

function readOnce({ dir, projectId, view, params, actor, now, bindings, wantHints, spaceRoot, spaceKey }, executeSpaceRead) {
  const spaceHome = spaceRoot ? openSpaceDirectory(spaceRoot) : null;
  const checkSpace = () => {
    if (spaceHome.root !== spaceRoot || spaceHome.state !== dir || spaceReadKey(spaceHome) !== spaceKey) {
      throw new BoardError('space-home-unavailable', 'The authorized space home has changed', { status: 409 });
    }
  };
  if (spaceHome) checkSpace();
  const meta = spaceHome ? spaceHome.readMeta() : JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  if (meta?.projectId !== projectId || meta?.project?.id !== projectId) throw unreadable();
  if (spaceHome) checkSpace();
  // "No writer" is not "read-only": report the observed lock, not an assumption.
  const readOnly = fs.existsSync(path.join(dir, 'lock.json'));
  let snapshot;
  const exactRelation = view === DOC_RELATION_READ_VIEW && params.relationId !== undefined;
  if (TIMELINE_VIEWS.has(view)) {
    const store = new JsonlStore(dir, meta, { lock: false });
    try {
      const data = store.open();
      checkIdentity(data.state, projectId);
      snapshot = { projectId, state: data.state, rev: data.lastSeq, timeline: data.timeline, commits: data.commits, leases: [], readOnly, now, workspacePath: data.state.project.workspacePath, meta };
    } finally { store.close(); }
  } else {
    const state = readStateWithoutLock(dir, meta);
    checkIdentity(state, projectId);
    snapshot = { projectId, state, rev: state.lastSeq, timeline: [], commits: [], leases: [], readOnly, now, workspacePath: state.project.workspacePath, meta };
  }
  if (spaceHome) {
    const value = executeSpaceRead({ snapshot, view, params, actor, spaceHome, bindings,
      readBlob: exactRelation ? blobReader(dir) : undefined });
    checkSpace();
    return { value, projectRev: snapshot.rev };
  }
  const value = executeRead({ snapshot, view, params, actor, readBlob: blobReader(dir), bindings, meta });
  return wantHints ? { value, hintFacts: hintFactsOf(snapshot, params) } : { value };
}

function readStable(data, executeSpaceRead) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = fingerprint(data.dir);
    if (!before.exists) throw new BoardError('not-found', 'Project not found', { status: 404 });
    let result, rejected;
    try {
      if (!before.complete) throw unreadable();
      result = readOnce(data, executeSpaceRead);
    } catch (error) { rejected = error; }
    if (before.key !== fingerprint(data.dir).key) continue;
    if (rejected) throw rejected;
    return result;
  }
  throw new BoardError('read-unstable', 'Project changed during read; retry', { status: 503 });
}

const SAFE = new Set([
  'not-found', 'read-unstable', 'project-unreadable', 'invalid-command', 'result-too-large',
  'external-doc-operation-required', 'missing-binding', 'invalid-fixed-reference', 'fixed-object-missing',
  'fixed-path-missing', 'fixed-object-mismatch', 'content-hash-mismatch', 'git-unavailable',
  'unsupported-repository', 'unsupported-content-transform', 'unsupported-format', 'oversize',
  'undecodable', 'root-unavailable', 'security-rejected', 'outside-root', 'permission-denied',
  'file-missing', 'oversize', 'unstable',
]);

function safeError(error) {
  if (error instanceof BoardError && SAFE.has(error.code)) return error;
  if (error instanceof BoardError && Object.hasOwn(STORE_ERRORS, error.code)) {
    return new BoardError(error.code, STORE_ERRORS[error.code], { status: error.status });
  }
  if (error instanceof BoardError && error.status && error.status < 500) return error;
  return unreadable();
}

try {
  const { signal: _signal, ...params } = workerData.params || {};
  let executeSpaceRead;
  if (workerData.spaceRoot) {
    executeSpaceRead = workerData.view === DOC_RELATION_READ_VIEW
      ? (await import('./document-relations.js')).executeDocumentRelationRead
      : (await import('./workspace-retained.js')).executeWorkspaceRetainedRead;
  }
  parentPort.postMessage({ result: readStable({ ...workerData, params }, executeSpaceRead) });
} catch (error) {
  const { code, message, status } = safeError(error);
  parentPort.postMessage({ error: { code, message, status } });
}
