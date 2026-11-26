// Pure queries over the selected space and its committed version records. No capture port.
import { BoardError } from '../errors.js';
import { readWorkspaceObject, WORKSPACE_OBJECT_MAX_BYTES } from '../store/workspace-objects.js';
import { observeWorkspaceSource, assertWorkspaceSourceLocator } from '../documents/workspace-source.js';
import { owningStoredWorkspaceVersion } from '../domain/document-relations.js';

const invalid = message => new BoardError('invalid-command', message, {status:400});
const missing = () => new BoardError('not-found', 'No retained version for this document', {status:404});

function history(rows, doc, params, authorize) {
  const limit = params.limit ?? 30;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid('history limit must be between 1 and 100');
  const versions = Object.values(rows).filter(v => v.versionRef.docId === doc.id).sort((a,b) => b.seq-a.seq);
  const start = params.after === undefined ? 0 : versions.findIndex(v => v.versionRef.versionId === params.after) + 1;
  if (params.after !== undefined && !start) throw invalid('unknown history cursor for this document');
  const page = versions.slice(start, start+limit);
  for (const row of page) authorize(row.locator);
  return {docId:doc.id, versions:page, nextCursor:start+page.length < versions.length ? page.at(-1).versionRef.versionId : null};
}

// Authority belongs to the recorded locator, not the current registration.
// The exact reader is lazy so callers can authorize metadata without reading bytes.
export function resolveExactWorkspaceVersion(spaceHome, state, target) {
  const row = owningStoredWorkspaceVersion(state, target);
  if (!row) return null;
  assertWorkspaceSourceLocator(spaceHome, state.project, row.locator);
  const ref = row.versionRef;
  return {
    versionRef: ref,
    read(maxBytes = 256 * 1024) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > WORKSPACE_OBJECT_MAX_BYTES) {
        throw invalid('maxBytes is outside the document limit');
      }
      const bytes = readWorkspaceObject(spaceHome, ref.contentHash);
      if (bytes.length !== row.size) throw new BoardError('content-object-corrupt', 'Version size does not match retained bytes', { status: 503 });
      const truncated = bytes.length > maxBytes;
      const body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, maxBytes), { stream: truncated });
      return { docId: ref.docId, versionRef: ref, body, size: bytes.length, truncated };
    },
  };
}

export function executeWorkspaceRetainedRead({snapshot,view,params,spaceHome}) {
  if (!spaceHome) throw new BoardError('space-home-unavailable','This read needs an authorized owning space');
  const state = snapshot.state, doc = Object.hasOwn(state.docs,params.docId) ? state.docs[params.docId] : null;
  if (!doc || doc.unregistered || doc.source !== 'external') throw new BoardError('not-found','No active registered workspace file', {status:404});
  const authorize = locator => assertWorkspaceSourceLocator(spaceHome,state.project,locator);
  authorize(doc.locator);
  const rows = state.workspaceVersions ?? {};
  if (view === 'workspace_history') return history(rows, doc, params, authorize);
  const exact = resolveExactWorkspaceVersion(spaceHome, state, { kind: 'workspace-body', docId: doc.id, versionId: params.versionId });
  if (!exact) {
    // Do not disclose whether an unrecognized reference belongs to another document.
    if (view === 'workspace_compare') return {docId:doc.id,state:'unavailable',reason:'version-not-retained'};
    throw missing();
  }
  const ref = exact.versionRef;
  if (view === 'workspace_compare') {
    try {
      // The committed hash, not the preview or metadata revision, is the comparator.
      const source = observeWorkspaceSource(spaceHome,state.project,doc);
      return {docId:doc.id,versionRef:ref,state:source.contentHash === ref.contentHash ? 'unchanged' : 'changed',currentContentHash:source.contentHash};
    } catch (e) {
      if (!(e instanceof BoardError) || ['project-forbidden','space-home-unavailable','missing-binding'].includes(e.code)) throw e;
      return {docId:doc.id,versionRef:ref,state:'unavailable',reason:e.code};
    }
  }
  if (view !== 'workspace_version') throw invalid('unknown workspace document read');
  return exact.read(params.maxBytes ?? undefined);
}
