// Assemble values for the model; the document port alone reads source bytes.
import { BoardError } from '../errors.js';
import {
  activeRelation, assertRelationSourceRevision, assertRelationWriter, missingRelation, normalizeRelationSource, normalizeRelationTarget,
} from '../domain/document-relations.js';
import { CAPTURE_GAPS, relationReplacement } from '../domain/operations/documents-relations.js';

function restrict(cmd, fields) {
  const permitted = new Set(['op', 'cmdId', 'actor', 'projectId', 'expected', ...fields]);
  if (Object.keys(cmd).some(key => !permitted.has(key))) throw new BoardError('invalid-command', 'Unsupported version relation field', { status: 400 });
}
const operation = (kind, args) => ({ kind, args });

function visibleRelation(read, relationId) {
  const row = activeRelation(read.state, relationId);
  try { read.documents.assertRelationTarget(row.toVersionRef, { verifyBytes: false }); }
  catch (error) {
    if (!(error instanceof BoardError) || ['project-forbidden', 'space-home-unavailable', 'closed'].includes(error.code)) throw error;
    throw missingRelation();
  }
  return row;
}

function relate(read, cmd) {
  restrict(cmd, ['from', 'to', 'expectedRev', 'replacesId']);
  assertRelationWriter(cmd);
  read.documents.assertRelationSpace();
  const from = normalizeRelationSource(cmd.from);
  const to = normalizeRelationTarget(cmd.to, { allowCurrent: true });
  if (to.kind === 'git-fixed') throw new BoardError('invalid-command', 'New Git-fixed relations are deprecated; select a retained workspace body', { status: 400 });
  const ownerId = read.documents.relationOwner(from);
  if (!ownerId) throw missingRelation();
  assertRelationSourceRevision(read.state, from, ownerId, cmd.expectedRev);
  if (cmd.replacesId !== undefined) {
    visibleRelation(read, cmd.replacesId);
    relationReplacement(read.state, from, cmd.replacesId);
  }
  const args = { from, to, ownerId, expectedRev: cmd.expectedRev, replacesId: cmd.replacesId };
  if (to.kind !== 'workspace-current') {
    const inlineHash = read.documents.assertRelationTarget(to);
    return { operations: [operation('document.addRelation', { ...args, inlineHash })] };
  }
  const doc = read.state.docs[to.docId];
  if (!doc || doc.source !== 'external' || doc.unregistered) throw missingRelation();
  let observed;
  try { observed = read.documents.capture(doc); }
  catch (error) {
    if (!CAPTURE_GAPS.has(error?.code)) throw error;
    return { operations: [operation('document.reportCaptureGap', { ...args, docId: doc.id, reason: error.code })] };
  }
  return { operations: [
    operation('document.retainVersion', { docId: doc.id, locator: doc.locator, contentHash: observed.contentHash, size: observed.size }),
    operation('document.addRelation', { ...args, capturedHash: observed.contentHash }),
  ] };
}

function unrelate(read, cmd) {
  restrict(cmd, ['relationId', 'expectedRev']);
  assertRelationWriter(cmd);
  read.documents.assertRelationSpace();
  const row = visibleRelation(read, cmd.relationId);
  assertRelationSourceRevision(read.state, row.fromVersion, row.sourceOwnerId, cmd.expectedRev);
  return { operations: [operation('document.removeRelation', { relationId: row.relationId, expectedRev: cmd.expectedRev })] };
}

export const DOC_RELATION_HANDLERS = {
  'doc.relation.add': relate,
  'doc.relation.remove': unrelate,
};
