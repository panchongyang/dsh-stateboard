import { BoardError } from '../errors.js';
import { assertFixedReference, fixedKey } from './fixed-reference.js';
import { validateRelPath } from './locate.js';
import { LEGACY_GIT_RECORD } from '../../shared/contract.js';

const fixedError = (code, message) => new BoardError(code, message, { status: 400 });

// Historical identities are records, not capabilities to open a Git repository.
export const LEGACY_GIT_STATUS = LEGACY_GIT_RECORD;
export function legacyGitRecord(fixed) {
  return { ...LEGACY_GIT_STATUS, fixed: structuredClone(fixed), hash: fixed.blobContentHash, hashDomain: 'git-blob-bytes',
    notice: 'Recorded Git commit/path/blob/format/hash only; historical body is unavailable and has not been reverified.' };
}

export function assertFixedReadArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw fixedError('invalid-fixed-reference', 'fixed read requires an object');
  const allowed = new Set(['op', 'schemaVersion', 'cmdId', 'docId', 'fixed', 'commitOid', 'pathAtCommit', 'bindingId']);
  if (Object.keys(args).some((key) => !allowed.has(key))) throw fixedError('invalid-fixed-reference', 'unknown fixed read field');
  if (args.schemaVersion !== undefined && args.schemaVersion !== 1) throw new BoardError('invalid-command', 'unsupported schemaVersion; keep the client read-only until upgraded', { status: 400 });
  if (typeof args.docId !== 'string' || !args.docId.startsWith('doc_') || args.docId.includes('@')) throw fixedError('invalid-fixed-reference', 'fixed read requires docId');
  if (Object.hasOwn(args, 'fixed')) {
    assertFixedReference(args.fixed);
    if (args.commitOid !== undefined || args.pathAtCommit !== undefined) throw fixedError('invalid-fixed-reference', 'do not mix fixed and target fields');
  } else if (typeof args.commitOid !== 'string' || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(args.commitOid) || !validateRelPath(args.pathAtCommit).ok) {
    throw fixedError('invalid-fixed-reference', 'fixed read requires a full commitOid and repository-relative pathAtCommit');
  }
  if (args.bindingId !== undefined && (typeof args.bindingId !== 'string' || args.bindingId === '')) throw fixedError('invalid-fixed-reference', 'invalid binding read hint');
}

export function resolveFixedContent(handle, args) {
  assertFixedReadArgs(args);
  handle._ensureOpen();
  if (!handle.state.docs[args.docId]) throw new BoardError('not-found', 'doc not found: ' + args.docId, { status: 404 });
  if (Object.hasOwn(args, 'fixed')) assertFixedReference(args.fixed, handle.id);
  const rows = Object.values(handle.state.fixedContents || {});
  // Select only an exact retained identity. Never infer a new reference from a
  // commit/path, the present workspace, or the existence of repository objects.
  const matches = rows.filter(row => row.ref === args.docId && row.fixed?.projectId === handle.id
    && (args.fixed ? fixedKey(row.ref, row.fixed) === fixedKey(args.docId, args.fixed)
      : row.fixed.commitOid === args.commitOid && row.fixed.pathAtCommit === args.pathAtCommit));
  if (matches.length !== 1) throw new BoardError('not-found', 'No recorded legacy Git source matches this document and target', { status: 404 });
  const fixed = structuredClone(matches[0].fixed);
  assertFixedReference(fixed, handle.id);
  return { fixed, content: null, ...LEGACY_GIT_STATUS };
}

export function getFixedContent(handle, args) {
  const { fixed } = resolveFixedContent(handle, args);
  return { schemaVersion: 1, docId: args.docId, ...legacyGitRecord(fixed), body: null, truncated: false, totalBytes: null, domain: 'git-blob-bytes' };
}

// Compatibility export for evidence audit callers. A retained Git identity can
// no longer be reverified; it must never block human verification as a byte error.
