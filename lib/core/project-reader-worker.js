// Read and project persisted state here so cold replay never blocks the host.
import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { BoardError } from './errors.js';
import { projectResult } from './project-reader-projection.js';
import { JsonlStore, readStateWithoutLock } from './store.js';
const projectViewResult = workerData.params ? (await import('./project-reader-views.js')).projectViewResult : null;

const REQUIRED_FILES = ['meta.json', 'commits.jsonl'];
const STORE_FILES = [...REQUIRED_FILES, 'snapshot.json'];
const STORE_ERRORS = {
  'hash-chain-broken': 'Project log failed validation',
  'unsupported-version': 'Project metadata or log version is unsupported',
  'schema-migration-required': 'Project data needs a schema upgrade',
  'incompatible-event': 'Project log contains an unsupported event',
};

function unreadable() {
  return new BoardError('project-unreadable', 'Project data is unreadable', { status: 503 });
}

function stat(file) {
  try { return fs.lstatSync(file, { bigint: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function fileIdentity(file) {
  return file ? [file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].join(':') : 'missing';
}

function fingerprint(dir) {
  const directory = stat(dir);
  if (!directory) return { key: 'missing-project', exists: false };
  if (!directory.isDirectory()) throw unreadable();
  const files = STORE_FILES.map((name) => stat(path.join(dir, name)));
  if (files.some((file) => file && !file.isFile())) throw unreadable();
  return {
    key: [directory.dev, directory.ino, ...files.map(fileIdentity)].join('|'),
    exists: true,
    complete: files.slice(0, REQUIRED_FILES.length).every(Boolean),
  };
}

function readProject(dir, id, query) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  if (meta?.projectId !== id || meta.project?.id !== id) throw unreadable();
  if (query.params) {
    const store = new JsonlStore(dir, meta, { lock: false });
    try {
      const { state, timeline, commits } = store.open();
      checkProjectIdentity(state, id);
      return projectViewResult(query, { meta, state, timeline, commits });
    } finally { store.close(); }
  }
  const state = readStateWithoutLock(dir, meta);
  checkProjectIdentity(state, id);
  return projectResult(state, query);
}

function checkProjectIdentity(state, id) {
  if (state.project?.id !== id || !Number.isSafeInteger(state.lastSeq) || state.lastSeq < 1) throw unreadable();
}

function readStable(query) {
  const { dir, projectId, live } = query;
  if (live) return projectViewResult(query, live);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = fingerprint(dir);
    if (!before.exists) throw new BoardError('not-found', 'Project not found', { status: 404 });
    let result, rejected;
    try {
      if (!before.complete) throw unreadable();
      result = readProject(dir, projectId, query);
    } catch (error) { rejected = error; }
    if (before.key !== fingerprint(dir).key) continue;
    if (rejected) throw rejected;
    return result;
  }
  throw new BoardError('read-unstable', 'Project changed during read; retry', { status: 503 });
}

function safeError(error) {
  if (error instanceof BoardError && [
    'not-found', 'read-unstable', 'project-unreadable', 'invalid-command', 'result-too-large',
    'external-doc-operation-required', 'missing-binding', 'invalid-fixed-reference', 'fixed-object-missing',
    'fixed-path-missing', 'fixed-object-mismatch', 'content-hash-mismatch', 'git-unavailable',
    'unsupported-repository', 'unsupported-content-transform', 'unsupported-format', 'oversize',
    'undecodable', 'root-unavailable', 'security-rejected', 'outside-root',
  ].includes(error.code)) return error;
  if (error instanceof BoardError && Object.hasOwn(STORE_ERRORS, error.code)) {
    return new BoardError(error.code, STORE_ERRORS[error.code], { status: error.status });
  }
  return unreadable();
}

try {
  parentPort.postMessage({ result: readStable(workerData) });
} catch (error) {
  const { code, message, status } = safeError(error);
  parentPort.postMessage({ error: { code, message, status } });
}