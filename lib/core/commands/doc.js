// Document commands: put a revisioned blob and link a doc to tasks/plans.
//
// Bodies are verbatim moves from service.js with `this` rebound to the handle.
// The blob is written before baseRev validation on purpose (existing behavior);
// do not reorder it into a "cleaner" flow without an explicit data-migration plan.

import { BoardError } from '../errors.js';
import { normalizeDocLinks } from '../normalize.js';
import { newId } from '../util.js';
import { externalOperationRequired, isExternal } from '../documents/external-model.js';

// Inline documents are archive-only by default. A project opts back in only
// through the human-only `doc.inline_policy` command (state flag explicitly
// false); the sole production write path for new content is workspace files
// (external docs). `privilegedInlineWrites` is a constructor-only internal option
// on ProjectService for fixtures, seeds and the offline legacy importer; no
// HTTP, tool or env surface can set it.
function inlineDisabled(reason) {
  const message = reason === 'migrated-archive'
    ? 'migrated inline documents are read-only archives; the migration tool is the only converter'
    : 'inline writes are disabled for this project by default; write a workspace file and register it as an external document, or let the project owner re-enable inline writes with doc.inline_policy';
  return new BoardError('inline-write-disabled', message, { status: 409, details: { reason } });
}

export function isInlineWrite(op) {
  return op === 'doc.put' || op === 'doc.link';
}

/** Validate fields that need no project state. Put retains its legacy title coercion. */
export function validateInlineWriteShape(cmd) {
  if (cmd.op === 'doc.link') {
    if (!cmd.docId) throw new BoardError('invalid-command', 'docId is required', { status: 400 });
    return;
  }
  const title = String(cmd.title || '').trim();
  if (title === '') throw new BoardError('invalid-command', 'doc title is required', { status: 400 });
  if (typeof cmd.body !== 'string') throw new BoardError('invalid-command', 'doc body is required', { status: 400 });
  if (Buffer.byteLength(cmd.body, 'utf8') > 262144) throw new BoardError('invalid-command', 'doc body exceeds 256 KB', { status: 400 });
  return title;
}

/**
 * Shared early checks on the snapshot and again inside the serial command.
 * Put validates links before policy. Link validates links after the target,
 * policy and command envelope have passed, inside the serial command only.
 */
export function admitInlineWrite(state, cmd, privilegedInlineWrites = false) {
  const links = cmd.op === 'doc.put' && cmd.links !== undefined ? normalizeDocLinks(state, cmd.links) : undefined;
  const doc = cmd.docId ? state.docs?.[cmd.docId] : null;
  if (!doc && cmd.op === 'doc.link') throw new BoardError('not-found', 'doc not found: ' + cmd.docId, { status: 404 });
  if (doc?.migration) throw inlineDisabled('migrated-archive');
  if (isExternal(doc)) throw externalOperationRequired(cmd.docId, cmd.op);
  if (!privilegedInlineWrites && state.project.inlineWritesDisabled !== false) throw inlineDisabled('project-policy');
  return { doc, links };
}

export function docPut(handle, cmd) {
  const title = validateInlineWriteShape(cmd);
  const { doc: existing, links } = admitInlineWrite(handle.state, cmd, handle.service?.privilegedInlineWrites === true);
  const kind = ['spec', 'design', 'decision', 'note', 'runbook'].includes(cmd.kind) ? cmd.kind : 'note';
  const at = new Date().toISOString();
  const hash = handle.store.writeBlob(cmd.body);
  if (existing) {
    if (!Number.isInteger(cmd.baseRev) || cmd.baseRev !== existing.rev) {
      throw new BoardError('stale-revision', 'doc rev is ' + existing.rev + '; baseRev is required and must match', { status: 409, details: { currentRev: existing.rev, hash: existing.hash } });
    }
    const next = { ...existing, rev: existing.rev + 1, title, kind, hash, size: Buffer.byteLength(cmd.body, 'utf8'), links: links || existing.links, updatedAt: at };
    return { events: [{ type: 'doc/updated', docId: next.id, rev: next.rev, data: next }], entityRev: next.rev };
  }
  if (cmd.docId) throw new BoardError('not-found', 'doc not found: ' + cmd.docId, { status: 404 });
  const doc = {
    id: newId('doc'),
    rev: 1,
    title,
    kind,
    hash,
    size: Buffer.byteLength(cmd.body, 'utf8'),
    links: links || { taskIds: [], planRefs: [] },
    createdAt: at,
    updatedAt: at,
  };
  return { events: [{ type: 'doc/created', docId: doc.id, rev: 1, data: doc }], entityRev: 1 };
}

export function docLink(handle, cmd) {
  validateInlineWriteShape(cmd);
  const { doc } = admitInlineWrite(handle.state, cmd, handle.service?.privilegedInlineWrites === true);
  const links = cmd.links === undefined ? undefined : normalizeDocLinks(handle.state, cmd.links);
  const at = new Date().toISOString();
  const next = { ...doc, rev: doc.rev + 1, links: links || doc.links, updatedAt: at };
  return { events: [{ type: 'doc/updated', docId: next.id, rev: next.rev, data: next }], entityRev: next.rev };
}

export const DOC_HANDLERS = {
  'doc.put': docPut,
  'doc.link': docLink,
};
