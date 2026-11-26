// Shared structural identity of a retained workspace body, independent of its ledger.
export const WORKSPACE_VERSION_REF_V = 1;
export const WORKSPACE_VERSION_KIND = 'workspace-body';
const HEX64 = /^[0-9a-f]{64}$/;
const REF_FIELDS = Object.freeze(['v', 'kind', 'projectId', 'docId', 'versionId', 'contentHash']);

const nonEmpty = value => typeof value === 'string' && value.trim() !== '';

export function versionRefProblem(ref, { projectId, docId, versionId, contentHash } = {}) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)
    || Object.keys(ref).sort().join(',') !== REF_FIELDS.slice().sort().join(',')) return 'versionRef must be exactly {' + REF_FIELDS.join(', ') + '}';
  if (ref.v !== WORKSPACE_VERSION_REF_V) return 'versionRef.v must be ' + WORKSPACE_VERSION_REF_V;
  if (ref.kind !== WORKSPACE_VERSION_KIND) return 'versionRef.kind must be ' + WORKSPACE_VERSION_KIND;
  if (!nonEmpty(ref.projectId)) return 'versionRef.projectId missing';
  if (!nonEmpty(ref.docId)) return 'versionRef.docId missing';
  if (!nonEmpty(ref.versionId)) return 'versionRef.versionId missing';
  if (typeof ref.contentHash !== 'string' || !HEX64.test(ref.contentHash)) return 'versionRef.contentHash must be lowercase hex64';
  if (projectId !== undefined && ref.projectId !== projectId) return 'versionRef.projectId does not belong to this project';
  if (docId !== undefined && ref.docId !== docId) return 'versionRef.docId does not match the document';
  if (versionId !== undefined && ref.versionId !== versionId) return 'versionRef.versionId does not match the version key';
  if (contentHash !== undefined && ref.contentHash !== contentHash) return 'versionRef.contentHash does not match the bytes';
  return null;
}

// A persisted evidence row must name its document and hash explicitly.
// Missing fields are not optional selectors as they are in version lookups.
export function workspaceEvidenceRefProblem(row, projectId) {
  if (row?.kind !== 'doc' || !nonEmpty(row.ref) || typeof row.hash !== 'string' || !HEX64.test(row.hash)) {
    return 'retained evidence requires a document reference and a full hash';
  }
  return versionRefProblem(row.workspaceVersion, { projectId, docId: row.ref, contentHash: row.hash });
}
