// 内嵌文档命令：只做形状/策略准入与 blob 外围写，提交的是一组具名模型操作。
// blob 在 baseRev 校验前写入是既有行为；不要在没有显式迁移计划时改成"先校验后写"。
import { BoardError } from '../errors.js';
import { normalizeDocLinks } from '../normalize.js';
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

export function docPut(read, cmd) {
  const title = validateInlineWriteShape(cmd);
  const { links } = admitInlineWrite(read.state, cmd, read.privilegedInlineWrites === true);
  // The body blob is an external write owned by the command; the model only
  // commits its hash/size and the record transition.
  const hash = read.blobs.write(cmd.body);
  const size = Buffer.byteLength(cmd.body, 'utf8');
  return {
    operations: [{
      kind: 'document.writeRevision',
      args: { docId: cmd.docId, title, kind: cmd.kind, hash, size, links, baseRev: cmd.baseRev },
    }],
  };
}

export function docLink(read, cmd) {
  validateInlineWriteShape(cmd);
  admitInlineWrite(read.state, cmd, read.privilegedInlineWrites === true);
  return { operations: [{ kind: 'document.changeLinks', args: { docId: cmd.docId, links: cmd.links } }] };
}

export const DOC_HANDLERS = {
  'doc.put': docPut,
  'doc.link': docLink,
};
