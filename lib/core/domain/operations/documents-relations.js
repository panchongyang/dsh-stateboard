// One model-owned operation adds, closes or replaces explicit version relations.
import { isDeepStrictEqual } from 'node:util';
import { BoardError } from '../../errors.js';
import {
  RELATION_ADDED, RELATION_CLOSED, activeRelation, existingRelation, missingRelation,
  normalizeRelationSource, normalizeRelationTarget, owningStoredWorkspaceVersion, assertRelationSourceRevision, assertRelationWriter,
} from '../document-relations.js';
import { latestVersionFor } from '../workspace-record.js';

export const CAPTURE_GAPS = new Set([
  'history-capacity', 'file-missing', 'unstable', 'oversize', 'unsupported-format', 'undecodable',
  'content-object-corrupt', 'content-object-missing', 'write-capability-unavailable',
]);
const invalid = message => new BoardError('invalid-command', message, { status: 400 });
function closeEvent(row, replacedBy = null) {
  return { type: RELATION_CLOSED, docId: row.toVersionRef.docId, data: { relationId: row.relationId, replacedBy } };
}
export function relationReplacement(state, from, id) {
  if (id === undefined) return null;
  const row = activeRelation(state, id);
  if (!isDeepStrictEqual(row.fromVersion, from)) throw invalid('Replacement must preserve the exact source version');
  return row;
}
function addRelation(work, args, request) {
  assertRelationWriter(request);
  const fromVersion = normalizeRelationSource(args.from);
  assertRelationSourceRevision(work.state, fromVersion, args.ownerId, args.expectedRev);
  let target = normalizeRelationTarget(args.to, { allowCurrent: true });
  if (target.kind === 'workspace-current') {
    // The preceding retain operation owns version selection; never reconstruct
    // a versionId from a file hash or assume all captures create a new version.
    const version = latestVersionFor(work.state, target.docId);
    if (!version || version.versionRef.contentHash !== args.capturedHash) throw missingRelation();
    target = { kind: 'workspace-body', docId: target.docId, versionId: version.versionRef.versionId };
  }
  if (target.kind === 'workspace-body' && !owningStoredWorkspaceVersion(work.state, target)) throw missingRelation();
  if (target.kind === 'git-fixed') throw invalid('New Git-fixed relations are deprecated; select a retained workspace body');
  const previous = relationReplacement(work.state, fromVersion, args.replacesId);
  const existing = existingRelation(work.state, fromVersion, target);
  if (existing && previous && existing.relationId !== previous.relationId) throw invalid('This exact target is already associated');
  const relationId = existing?.relationId ?? work.newId('rel');
  const result = { relationId, relationState: 'exact', toVersionRef: target };
  if (existing) return { result };
  const data = { relationId, relationKind: 'reference', fromVersion, toVersionRef: target, sourceOwnerId: args.ownerId,
    ...(target.kind === 'inline' ? { inlineHash: args.inlineHash } : {}) };
  return { result, events: [ ...(previous ? [closeEvent(previous, relationId)] : []), { type: RELATION_ADDED, docId: target.docId, data } ] };
}
function removeRelation(work, args, request) {
  assertRelationWriter(request);
  const row = activeRelation(work.state, args.relationId);
  assertRelationSourceRevision(work.state, row.fromVersion, row.sourceOwnerId, args.expectedRev);
  return { events: [closeEvent(row)], result: { relationId: row.relationId, relationState: 'closed' } };
}
function reportCaptureGap(work, args, request) {
  assertRelationWriter(request);
  if (!CAPTURE_GAPS.has(args.reason)) throw invalid('Unrecognized capture failure');
  const from = normalizeRelationSource(args.from);
  assertRelationSourceRevision(work.state, from, args.ownerId, args.expectedRev);
  return { result: { relationState: 'current-only', reason: args.reason, docId: args.docId } };
}
export const DOCUMENT_RELATION_OPERATIONS = Object.freeze({
  'document.addRelation': addRelation,
  'document.removeRelation': removeRelation,
  'document.reportCaptureGap': reportCaptureGap,
});
