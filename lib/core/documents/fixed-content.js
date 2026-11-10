import { BoardError } from '../errors.js';
import { bindingById, mainBinding, reloadBindings, readFailure, readLocator } from './external-observe.js';
import { assertFixedReference, assertRepositoryApproval } from './fixed-reference.js';
import { commitTree, fixedError, readGitContent, repositoryAt } from './fixed-git.js';
import { checkedCommitAttributes } from './fixed-worktree.js';
import { interpretDocumentBytes, readDocument } from './read.js';
import { validateRelPath } from './locate.js';

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

function selectedBinding(handle, bindingId) {
  reloadBindings(handle);
  const binding = bindingId === undefined ? mainBinding(handle) : bindingById(handle, bindingId);
  if (!binding) throw new BoardError('missing-binding', 'no active project binding for Git content', { status: 409 });
  return binding;
}

function sameSource(repo, source) {
  if (repo.objectFormat !== source.objectFormat) throw fixedError('unsupported-repository', 'repository object format changed', { reason: 'unsupported-format' });
  commitTree(repo.root, source.anchorCommitOid, source.objectFormat);
}

const SOURCE_PROOF_FAILURES = new Set([
  'fixed-object-missing', 'fixed-path-missing', 'fixed-object-mismatch',
  'content-hash-mismatch', 'unsupported-content-transform', 'oversize',
]);

function proveFailure(error, message) {
  if (SOURCE_PROOF_FAILURES.has(error.code)) throw fixedError('unsupported-repository', message, { reason: 'multiple-repositories', causeCode: error.code });
  throw error;
}

/**
 * Prove that `binding` holds the recorded Git source without writing anything:
 * same object format, resolvable anchor commit, and every recorded fixed object
 * verifiable. A move or local rebuild that copies the repository passes; an
 * unrelated repository or one missing the anchor fails.
 */
export function verifyRepositorySource(handle, binding, source) {
  const repo = repositoryAt(binding.root);
  if (repo.objectFormat !== source.objectFormat) {
    throw fixedError('unsupported-repository', 'repository object format changed', { reason: 'unsupported-format' });
  }
  try { commitTree(repo.root, source.anchorCommitOid, source.objectFormat); }
  catch (error) { proveFailure(error, 'binding cannot prove the recorded Git content source'); }
  for (const row of Object.values(handle.state.fixedContents || {})) {
    try { verifyInRepository(repo, row.fixed); }
    catch (error) { proveFailure(error, 'binding cannot prove recorded fixed content'); }
  }
  return repo;
}

export function approvedRepository(handle, bindingId) {
  const source = handle.state.project.gitContentRepository;
  assertRepositoryApproval(source);
  if (!source) throw fixedError('unsupported-repository', 'project has no recorded Git content source; submit doc evidence to auto-pin');
  reloadBindings(handle);
  // Default reads observe only the main binding, never hunt for another
  // worktree whose objects happen to be available.
  const selected = bindingId === undefined ? mainBinding(handle)?.bindingId : bindingId;
  if (selected === undefined) throw new BoardError('missing-binding', 'no recorded binding remains active', { status: 409 });
  const binding = selectedBinding(handle, selected);
  if (!source.bindingIds.includes(binding.bindingId)) {
    // Read-only allowance for a moved/rebound workspace: same source is enough.
    return { ...verifyRepositorySource(handle, binding, source), binding };
  }
  const repo = repositoryAt(binding.root);
  sameSource(repo, source);
  return { ...repo, binding };
}

export function verifyInRepository(repo, fixed) {
  if (repo.objectFormat !== fixed.objectFormat) throw fixedError('fixed-object-mismatch', 'fixed object format does not match repository');
  const content = readGitContent(repo, fixed.commitOid, fixed.pathAtCommit);
  if (content.oid !== fixed.blobOid) throw fixedError('fixed-object-mismatch', 'path blob identity differs from fixed reference');
  if (content.blobContentHash !== fixed.blobContentHash) throw fixedError('content-hash-mismatch', 'blob bytes differ from fixed content hash');
  checkedCommitAttributes(repo, fixed.pathAtCommit, fixed.commitOid);
  return content;
}

export function resolveFixedContent(handle, args) {
  assertFixedReadArgs(args);
  handle._ensureOpen();
  const doc = handle.state.docs[args.docId];
  if (!doc) throw new BoardError('not-found', 'doc not found: ' + args.docId, { status: 404 });
  if (Object.hasOwn(args, 'fixed')) assertFixedReference(args.fixed, handle.id);
  else if (typeof args.commitOid !== 'string' || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(args.commitOid) || typeof args.pathAtCommit !== 'string') {
    throw fixedError('invalid-fixed-reference', 'get_fixed requires fixed or explicit full commitOid/pathAtCommit');
  }
  // A project without a recorded source still supports a pure read: resolve the
  // active binding and verify the requested bytes, writing nothing.
  let repo;
  if (handle.state.project.gitContentRepository) {
    repo = approvedRepository(handle, args.bindingId);
  } else {
    const binding = selectedBinding(handle, args.bindingId);
    repo = { ...repositoryAt(binding.root), binding };
  }
  if (Object.hasOwn(args, 'fixed')) return { repo, fixed: structuredClone(args.fixed), content: verifyInRepository(repo, args.fixed) };
  const content = readGitContent(repo, args.commitOid, args.pathAtCommit);
  checkedCommitAttributes(repo, args.pathAtCommit, args.commitOid);
  const fixed = { v: 1, projectId: handle.id, commitOid: args.commitOid, pathAtCommit: args.pathAtCommit, blobOid: content.oid, objectFormat: repo.objectFormat, blobContentHash: content.blobContentHash };
  return { repo, fixed, content };
}

function workspaceComparison(handle, docId, repo, fixed) {
  const doc = handle.state.docs[docId];
  const read = doc.source === 'external'
    ? readLocator(handle, doc.locator, { previewBytes: 1 }).read
    : readDocument(repo.root, fixed.pathAtCommit, { previewBytes: 1 });
  const contentHash = read.ok ? read.hash : null;
  const state = contentHash === null ? 'not_comparable' : contentHash === fixed.blobContentHash ? 'matches_git_bytes' : 'differs_from_git_bytes';
  const notice = state === 'differs_from_git_bytes'
    ? 'Git blob bytes differ from current workspace bytes; this is the pinned Git version, not the workspace hash.'
    : 'This is the pinned Git commit/path/blobContentHash; it does not prove merge, deployment or acceptance.';
  return { state, domain: 'workspace-bytes', contentHash, availability: read.availability, notice };
}

export function getFixedContent(handle, args) {
  const { repo, fixed, content } = resolveFixedContent(handle, args);
  const interpreted = interpretDocumentBytes(content.bytes, fixed.pathAtCommit);
  if (!interpreted.ok) throw readFailure(interpreted);
  if (!interpreted.previewable) throw fixedError('unsupported-format', 'fixed blob is not previewable text');
  const preview = interpreted.preview;
  return { schemaVersion: 1, docId: args.docId, fixed, hash: fixed.blobContentHash, body: preview.text, truncated: preview.truncated, totalBytes: content.bytes.length, domain: 'git-blob-bytes', workspaceComparison: workspaceComparison(handle, args.docId, repo, fixed) };
}

export function auditFixedEvidence(handle, row) {
  try {
    assertFixedReference(row.fixed, handle.id);
    if (row.kind !== 'doc' || typeof row.ref !== 'string' || !row.ref.startsWith('doc_') || row.ref.includes('@')) throw fixedError('invalid-fixed-reference', 'fixed requires doc evidence with a stable docId');
    if (row.hash !== row.fixed.blobContentHash) throw fixedError('content-hash-mismatch', 'evidence hash differs from fixed hash');
    const repo = approvedRepository(handle);
    verifyInRepository(repo, row.fixed);
    return null;
  } catch (error) {
    const unavailable = ['git-unavailable', 'root-unavailable', 'missing-binding', 'fixed-object-missing'].includes(error.code)
      || (error.code === 'unsupported-repository' && (error.details?.reason === 'not-a-repo' || error.details?.causeCode === 'fixed-object-missing' || !handle.state.project.gitContentRepository));
    return { evidenceId: row.id, code: error.code || 'fixed-object-missing', severity: unavailable ? 'warning' : 'error',
      message: unavailable ? 'Historical Git content is not observable; no content match is asserted: ' + error.message : error.message };
  }
}
