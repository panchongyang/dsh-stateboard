import path from 'node:path';
import { canonicalKey, isInside } from '../util.js';
import { mainBinding, readFailure, readLocator } from './external-observe.js';
import { approvedRepository, verifyInRepository, verifyRepositorySource } from './fixed-content.js';
import { commitTree, fixedError, gitRequired, readGitContent, rejectNestedRepository, repositoryAt } from './fixed-git.js';
import { assertCleanPath } from './fixed-worktree.js';
import { contentFixedEvents } from './fixed-reference.js';

// Rows (not handles) key the pending approval: one submit may carry several
// documents, but only the first new source produces an event.
const pendingApprovals = new WeakMap();

// fixedReason is a closed set (see docs/DOC-EXTERNAL-EVIDENCE.md §3). Engine
// error codes are internal and intentionally more granular than this contract.
function pinReason(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const detail = typeof error?.details?.reason === 'string' ? error.details.reason : '';
  if (code === 'git-unavailable') return ['ENOENT', 'git-exec-not-found'].includes(detail) ? 'no-git' : 'git-unavailable';
  if (code === 'dirty-worktree') return 'dirty-worktree';
  if (code === 'head-changed') return 'head-changed';
  if (code === 'oversize') return 'oversize';
  if (code === 'unsupported-format') return 'unsupported-format';
  if (code === 'unsupported-content-transform') return detail === 'lfs-pointer' ? 'lfs-pointer' : 'content-transform';
  if (code === 'unsupported-repository') {
    return ['nested-repository', 'multiple-repositories', 'not-a-repo', 'unsupported-format'].includes(detail) ? detail : 'not-a-repo';
  }
  if (code === 'fixed-object-missing' || code === 'fixed-path-missing') return 'uncommitted';
  return 'git-unavailable';
}

/**
 * Stage the automatic source write (repository object + event reason) for one
 * evidence row. `repository` is the immutable object that will land in
 * project/updated; null means the project already had it (idempotent).
 */
export function rememberAutoApproval(row, approval) {
  if (approval) pendingApprovals.set(row, approval);
}

/** Only the main binding is pinnable: other roots would be a second source. */
function pinnableRepository(handle, doc) {
  const binding = mainBinding(handle);
  if (!binding || binding.bindingId !== doc.locator.bindingId) throw fixedError('unsupported-repository', 'document is not on the main binding', { reason: 'multiple-repositories' });
  const source = handle.state.project.gitContentRepository;
  if (!source) return { binding, repo: repositoryAt(binding.root), source: null, rebind: false };
  if (!source.bindingIds.includes(binding.bindingId)) {
    // A moved/rebuilt workspace may yield a new main binding for the same
    // repository; prove it before the source grows, never adopt a stranger.
    return { binding, repo: verifyRepositorySource(handle, binding, source), source, rebind: true };
  }
  return { binding, repo: approvedRepository(handle, binding.bindingId), source, rebind: false };
}

function pinCurrent(handle, doc) {
  const { binding, repo, source, rebind } = pinnableRepository(handle, doc);
  const absolute = path.resolve(binding.root, ...doc.locator.relPath.split('/'));
  if (!isInside(repo.root, absolute)) throw fixedError('unsupported-repository', 'document is outside the repository', { reason: 'nested-repository' });
  const relPath = path.relative(repo.root, absolute).split(path.sep).join('/');
  if (canonicalKey(repositoryAt(path.dirname(absolute)).root) !== canonicalKey(repo.root)) {
    throw fixedError('unsupported-repository', 'document belongs to a nested repository', { reason: 'nested-repository' });
  }
  rejectNestedRepository(repo.root, absolute);
  const head = gitRequired(repo.root, ['rev-parse', '--verify', 'HEAD^{commit}'], 'fixed-object-missing').text.trim();
  const content = readGitContent(repo, head, relPath);
  const fixed = { v: 1, projectId: handle.id, commitOid: head, pathAtCommit: relPath, blobOid: content.oid, objectFormat: repo.objectFormat, blobContentHash: content.blobContentHash };
  verifyInRepository(repo, fixed);
  assertCleanPath(repo, relPath, head);
  if (source && !rebind) return { fixed, repository: null, reason: null };
  if (source) {
    // Same-source verification already froze the anchor; only the binding is new.
    return { fixed, repository: { ...source, bindingIds: [...source.bindingIds, binding.bindingId] }, reason: 'auto-rebind-git-content-repository' };
  }
  // Freeze the anchor only after every other check passed; the commit tree must
  // be provably present before it becomes the project source.
  commitTree(repo.root, head, repo.objectFormat);
  const repository = { v: 1, objectFormat: repo.objectFormat, anchorCommitOid: head, bindingIds: [binding.bindingId] };
  return { fixed, repository, reason: 'auto-approve-git-content-repository' };
}

/** Pin an external doc to HEAD when provably clean; otherwise silently fall back to the current workspace hash. */
export function autoExternalEvidence(handle, doc) {
  const located = readLocator(handle, doc.locator, { previewBytes: 1 });
  const read = located.read;
  if (!read.ok) {
    // A non-UTF-8 document still has a raw-byte hash, exactly like file
    // evidence: degrade instead of failing the whole submit.
    if (read.code === 'undecodable' && typeof read.hash === 'string') {
      return { hash: read.hash, fixed: null, fixedState: 'current-only', fixedReason: 'unsupported-format', approval: null };
    }
    throw readFailure(read);
  }
  const current = read.hash;
  try {
    const { fixed, repository, reason } = pinCurrent(handle, doc);
    return { hash: fixed.blobContentHash, fixed, fixedState: 'pinned', approval: repository ? { repository, reason } : null };
  } catch (error) {
    return { hash: current, fixed: null, fixedState: 'current-only', fixedReason: pinReason(error), approval: null };
  }
}

/**
 * Events for one evidence batch. An automatic approval is staged on the working
 * state (a command clone) because the pre-review audit runs before the commit is
 * appended; the emitted project/updated then carries the same object. The event
 * actor marks the source as system-generated even though the commit belongs to
 * the caller's command.
 */
export function fixedEvents(handle, added) {
  const events = [];
  for (const row of added) {
    const pending = pendingApprovals.get(row);
    if (!pending) continue;
    handle.state.project.gitContentRepository = structuredClone(pending.repository);
    events.push({
      type: 'project/updated',
      data: structuredClone(handle.state.project),
      actor: { kind: 'system', reason: pending.reason },
    });
    break;
  }
  return [...events, ...contentFixedEvents(added)];
}

export function auditCurrentOnlyDoc(handle, row, doc) {
  const { read } = readLocator(handle, doc.locator, { previewBytes: 1 });
  // Undecodable content is auditable through its raw-byte hash; only a read
  // without any hash makes the current-only row unavailable.
  if (!read.ok && typeof read.hash !== 'string') return { evidenceId: row.id, code: 'doc-unavailable', severity: 'error', message: 'current-only doc evidence is not readable: ' + row.ref };
  if (read.hash !== row.hash) return { evidenceId: row.id, code: 'doc-drift', severity: 'error', message: 'current-only doc evidence changed: ' + row.ref };
  return null;
}
