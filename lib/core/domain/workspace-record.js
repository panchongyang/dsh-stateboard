// Retained workspace-body versions for already registered external documents.
// One applied event carries the full version record; replay validates it and
// refuses (invalid-workspace-version) instead of guessing.
import { isDeepStrictEqual } from 'node:util';
import { BoardError } from '../errors.js';
import { applyExternalDocEvent, isExternal } from '../documents/external-model.js';
import { validateRelPath } from './document-path.js';
import { canonicalJSON } from './value-hash.js';
import { versionRefProblem } from './workspace-version-ref.js';
export { versionRefProblem, WORKSPACE_VERSION_REF_V, WORKSPACE_VERSION_KIND } from './workspace-version-ref.js';

export const WORKSPACE_RETAINED_EVENT = 'doc/workspace-retained';
export const WORKSPACE_MAX_BYTES = 16 * 1024 * 1024;

const VERSION_FIELDS = Object.freeze(['versionRef', 'locator', 'size', 'observedAt', 'seq', 'provenance']);

export function invalidVersion(message, details = null) {
  return new BoardError('invalid-workspace-version', message, { status: 400, details });
}

function exactFields(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === fields.slice().sort().join(',');
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

export function versionProblem(version, { projectId } = {}) {
  if (!exactFields(version, VERSION_FIELDS)) return 'version must be exactly {' + VERSION_FIELDS.join(', ') + '}';
  const refProblem = versionRefProblem(version.versionRef, { projectId });
  if (refProblem) return refProblem;
  if (version.versionRef.versionId !== version.versionRef.docId + '~' + version.seq + '~' + version.versionRef.contentHash) return 'versionRef.versionId shape must be docId~seq~contentHash';
  if (!exactFields(version.locator, ['bindingId', 'relPath'])) return 'version.locator must be exactly {bindingId, relPath}';
  if (!nonEmpty(version.locator.bindingId)) return 'version.locator.bindingId missing';
  if (!validateRelPath(version.locator.relPath).ok) return 'version.locator.relPath invalid';
  if (!Number.isSafeInteger(version.size) || version.size < 0 || version.size > WORKSPACE_MAX_BYTES) return 'version.size must be a non-negative safe integer within the body limit';
  if (!nonEmpty(version.observedAt)) return 'version.observedAt missing';
  if (!Number.isSafeInteger(version.seq) || version.seq < 1) return 'version.seq must be a positive integer';
  if (version.provenance !== 'observed') return 'version.provenance must be observed';
  return null;
}

/** Latest retained version for one document, by the event-assigned sequence. */
export function latestVersionFor(state, docId) {
  let latest = null;
  for (const version of Object.values(state.workspaceVersions || {})) {
    if (version.versionRef.docId !== docId) continue;
    if (!latest || version.seq > latest.seq) latest = version;
  }
  return latest;
}

export function assertVersion(version, { projectId } = {}) {
  const problem = versionProblem(version, { projectId });
  if (problem) throw invalidVersion('invalid workspace version: ' + problem, { versionId: version?.versionRef?.versionId ?? null, reason: problem });
}

/** Replay projection for doc/workspace-retained. Documents and baselines stay untouched. */
export function applyRetainedVersionEvent(state, event, commit = null) {
  const details = { seq: commit && Number.isInteger(commit.seq) ? commit.seq : null, type: event?.type ?? null };
  if (!state.workspaceVersions || typeof state.workspaceVersions !== 'object') state.workspaceVersions = {};
  const data = event && event.data;
  if (!exactFields(data, ['version'])) throw invalidVersion('retained event data must be exactly {version}', details);
  const version = data.version;
  assertVersion(version, { projectId: state.project?.id });
  const docId = version.versionRef.docId;
  const existing = state.docs?.[docId];
  if (!existing || !isExternal(existing)) throw invalidVersion('retained version targets a document that is not an external record', { ...details, docId });
  if (existing.unregistered) throw invalidVersion('retained version targets an unregistered document', { ...details, docId });
  if (event.docId !== undefined && event.docId !== docId) throw invalidVersion('event docId does not match the version', { ...details, docId });
  if (!isDeepStrictEqual(version.locator, existing.locator)) throw invalidVersion('retained version locator does not match the registered document', { ...details, docId });
  const versionId = version.versionRef.versionId;
  if (state.workspaceVersions[versionId]) throw invalidVersion('version ' + versionId + ' is already recorded', details);
  if (version.seq !== (state.counters.workspaceVersionSeq || 0) + 1) throw invalidVersion('version sequence must advance by exactly one', details);
  const latest = latestVersionFor(state, docId);
  if (latest && latest.versionRef.contentHash === version.versionRef.contentHash && isDeepStrictEqual(latest.locator, version.locator)) {
    throw invalidVersion('an unchanged retention must reuse the previous version instead of appending', details);
  }
  state.workspaceVersions[versionId] = version;
  state.counters.workspaceVersionSeq = version.seq;
}

export function assertWorkspaceVersionsMatch(state, expected, { seq = null } = {}) {
  const versions = expected || {};
  const counter = Object.values(versions).reduce((max, version) => Math.max(max, version.seq || 0), 0);
  if ((state?.counters?.workspaceVersionSeq || 0) !== counter) {
    throw invalidVersion('snapshot version counter does not match the log at seq ' + seq, { origin: 'snapshot', seq, reason: 'snapshot-version-counter', expected: counter });
  }
  if (canonicalJSON(state?.workspaceVersions || {}) !== canonicalJSON(expected || {})) {
    throw invalidVersion('snapshot retained versions differ from the log at seq ' + seq, { origin: 'snapshot', seq, reason: 'snapshot-version-mismatch' });
  }
}

/** Snapshot rows: every retained version must be structurally valid and match its key. */
export function assertWorkspaceVersionsInState(state, { seq = null } = {}) {
  const versions = state?.workspaceVersions;
  if (versions == null) return;
  if (typeof versions !== 'object' || Array.isArray(versions)) throw invalidVersion('snapshot workspaceVersions must be a record map', { origin: 'snapshot', seq });
  for (const [versionId, version] of Object.entries(versions)) {
    assertVersion(version, { projectId: state.project?.id });
    if (version.versionRef.versionId !== versionId) throw invalidVersion('snapshot version key does not match versionRef', { origin: 'snapshot', seq, versionId });
  }
}

/**
 * Versions derivable from the log at `snapshotSeq` (default: end). Used to prove
 * a snapshot's retained map equals the authoritative log instead of trusting it.
 */
export function retainedVersionsInLog(commits, snapshotSeq = null, projectId = null) {
  if (snapshotSeq === 0) return {};
  const shadow = { project: { id: projectId ?? undefined }, docs: {}, workspaceVersions: {}, counters: {} };
  for (const commit of commits) {
    for (const event of commit.events || []) {
      if (event?.type === 'project/created' || event?.type === 'project/updated') shadow.project = event.data;
      else if (event?.type === 'doc/created' || event?.type === 'doc/updated') shadow.docs[event.data.id] = event.data;
      else if (typeof event?.type === 'string' && event.type.startsWith('doc/external-')) {
        applyExternalDocEvent(shadow, event, structuredClone(event.data), commit);
      } else if (event?.type === WORKSPACE_RETAINED_EVENT) {
        applyRetainedVersionEvent(shadow, { ...event, data: structuredClone(event.data) }, commit);
      }
    }
    if (snapshotSeq !== null && commit.seq === snapshotSeq) return structuredClone(shadow.workspaceVersions);
  }
  return snapshotSeq === null ? structuredClone(shadow.workspaceVersions) : undefined;
}
