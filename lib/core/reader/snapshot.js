// Acquisition adapters for the reader port. The live side is the command bus's
// `service.publishedState(projectId)` contract only: it returns already-published
// values or null, and never a writer, handle, service or live state object.
import path from 'node:path';
import { readMigrationBlob } from '../documents/migration-blob.js';
import { BoardError } from '../errors.js';

const UNAVAILABLE = () => new BoardError('read-unavailable', 'The command bus does not expose publishedState; reader cannot publish live values', { status: 503 });

/**
 * Validate and normalize the published value contract:
 * { state, timeline, lastSeq, lastHash, cmdIds, leases, meta, commits, blobs? } | null.
 * No writer fallback exists: a missing contract is unavailable, not an invitation
 * to read a handle.
 */
export function readPublished(service, projectId) {
  if (typeof service.publishedState !== 'function') throw UNAVAILABLE();
  const published = service.publishedState(projectId);
  if (published === null || published === undefined) return null;
  if (!published.state || !published.state.project || published.state.project.id !== projectId) {
    throw new BoardError('project-unreadable', 'Published project state does not match the requested project', { status: 503 });
  }
  return published;
}

/** Normalize published values into the captured snapshot used by projections. */
export function publishedSnapshot(published, now, { timeline = false, commits = false } = {}) {
  return {
    projectId: published.state.project.id,
    state: published.state,
    rev: published.lastSeq ?? published.state.lastSeq,
    lastHash: published.lastHash ?? null,
    timeline: timeline ? (published.timeline || []) : [],
    commits: commits ? (published.commits || []) : [],
    leases: published.leases instanceof Map ? [...published.leases.values()] : (published.leases || []),
    // A published writer exists, so claim guidance is not blocked by the lock.
    readOnly: false,
    now,
    workspacePath: published.state.project.workspacePath,
    meta: published.meta || null,
  };
}

/** Cheap watermark when the writer publishes one; full value otherwise. */
export function readPublishedWatermark(service, projectId) {
  if (typeof service.publishedRevision === 'function') {
    const revision = service.publishedRevision(projectId);
    return revision ? { lastSeq: revision.lastSeq ?? revision.rev, lastHash: revision.lastHash } : null;
  }
  const published = readPublished(service, projectId);
  return published ? { lastSeq: published.lastSeq, lastHash: published.lastHash } : null;
}

/** The published revision must still be current before any result is returned. */
export function assertCurrent(service, projectId, snapshot) {
  const current = readPublishedWatermark(service, projectId);
  const live = current && current.lastSeq === snapshot.rev
    && (!snapshot.lastHash || !current.lastHash || current.lastHash === snapshot.lastHash);
  if (!live) {
    throw new BoardError('read-unstable', 'Project changed during read; retry', { status: 503 });
  }
}

/** Blob side-effect port: published read functions first, then the blob directory. */
export function blobReader(snapshot, projectDir, published) {
  const read = typeof published?.readMigrationBlob === 'function' ? published.readMigrationBlob
    : typeof published?.readBlob === 'function' ? published.readBlob : null;
  const blobsDir = path.join(projectDir, 'blobs');
  return (hash) => {
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return null;
    if (read) return read(hash);
    return readMigrationBlob(blobsDir, hash);
  };
}

/** Serializable blobs (when the published contract exposes them) for worker audits. */
export function publishedBlobs(published) {
  if (published?.blobs instanceof Map) return [...published.blobs];
  if (Array.isArray(published?.blobs)) return published.blobs;
  return null;
}

/** Serializable binding values for workspace/Git observation. */
export function captureBindings(service, projectId) {
  try { service.reloadBindings?.(); } catch { /* degrade to implicit bindings, never stale ones */ }
  const index = service.bindings?.();
  return {
    fileEvidenceRoot: service.spaceHome?.root,
    active: (index?.activeFor(projectId) ?? []).map((binding) => structuredClone(binding)),
    main: index?.mainOf(projectId) ? structuredClone(index.mainOf(projectId)) : null,
  };
}
