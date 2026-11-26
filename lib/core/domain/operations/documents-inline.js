// 内嵌文档的具名模型操作：只读事务私有 state/leases，不碰 blob、工作区或日志。
// 调用方提交正文哈希与大小（blob 已在外围写入），模型据此产生完整记录事件。
import { BoardError } from '../../errors.js';
import { normalizeDocLinks } from '../../normalize.js';
import { DOC_KINDS, externalOperationRequired, isExternal } from '../../documents/external-model.js';

function invalid(message) {
  return new BoardError('invalid-command', message, { status: 400 });
}

function assertFields(args, allowed) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw invalid('operation arguments must be an object');
  for (const key of Object.keys(args)) if (!allowed.includes(key)) throw invalid('unsupported document operation field: ' + key);
}

function inlineDisabled(reason) {
  const message = reason === 'migrated-archive'
    ? 'migrated inline documents are read-only archives; the migration tool is the only converter'
    : 'inline writes are disabled for this project by default; write a workspace file and register it as an external document, or let the project owner re-enable inline writes with doc.inline_policy';
  return new BoardError('inline-write-disabled', message, { status: 409, details: { reason } });
}

function existingInline(work, docId, op) {
  if (docId === undefined || docId === null) return null;
  if (typeof docId !== 'string' || docId === '') throw invalid('docId must be a non-empty string');
  const doc = work.state.docs?.[docId];
  if (!doc) throw new BoardError('not-found', 'doc not found: ' + docId, { status: 404 });
  if (doc.migration) throw inlineDisabled('migrated-archive');
  if (isExternal(doc)) throw externalOperationRequired(docId, op);
  return doc;
}

function requireWriter(work, request) {
  if (!['human', 'agent', 'system'].includes(request?.actor?.kind)) throw new BoardError('forbidden-role', 'document writes require a trusted actor', { status: 403 });
  if (work.privilegedInlineWrites !== true && work.state.project.inlineWritesDisabled !== false) throw inlineDisabled('project-policy');
}

function nextLinks(work, links) {
  return links === undefined ? undefined : normalizeDocLinks(work.state, links);
}

/** doc.put：已有记录要求 baseRev 精确匹配；正文只以 {hash,size} 事实进入事件。 */
export function putInlineDocument(work, args, request) {
  assertFields(args, ['docId', 'title', 'kind', 'hash', 'size', 'links', 'baseRev']);
  const title = String(args.title || '').trim();
  if (title === '') throw invalid('doc title is required');
  const kind = DOC_KINDS.includes(args.kind) ? args.kind : 'note';
  const links = nextLinks(work, args.links);
  const doc = existingInline(work, args.docId, 'document.writeRevision');
  requireWriter(work, request);
  if (typeof args.hash !== 'string' || !/^[0-9a-f]{64}$/.test(args.hash) || !Number.isSafeInteger(args.size) || args.size < 0 || args.size > 262144) throw invalid('body identity requires a SHA-256 hash and size within 256 KB');
  const at = work.clock().toISOString();
  if (doc) {
    if (!Number.isInteger(args.baseRev) || args.baseRev !== doc.rev) {
      throw new BoardError('stale-revision', 'doc rev is ' + doc.rev + '; baseRev is required and must match', {
        status: 409, details: { currentRev: doc.rev, hash: doc.hash },
      });
    }
    const next = {
      ...doc, rev: doc.rev + 1, title, kind, hash: args.hash, size: args.size,
      links: links || doc.links, updatedAt: at,
    };
    return { events: [{ type: 'doc/updated', docId: next.id, rev: next.rev, data: next }], entityRev: next.rev };
  }
  if (args.docId) throw new BoardError('not-found', 'doc not found: ' + args.docId, { status: 404 });
  const created = {
    id: work.newId('doc'), rev: 1, title, kind, hash: args.hash, size: args.size,
    links: links || { taskIds: [], planRefs: [] }, createdAt: at, updatedAt: at,
  };
  return { events: [{ type: 'doc/created', docId: created.id, rev: 1, data: created }], entityRev: 1 };
}

/** doc.link：只改关联，不写正文；提供 links 时按当前 state 归一化。 */
export function linkInlineDocument(work, args, request) {
  assertFields(args, ['docId', 'links']);
  const doc = existingInline(work, args.docId, 'document.changeLinks');
  if (!doc) throw new BoardError('not-found', 'doc not found: ' + String(args.docId), { status: 404 });
  requireWriter(work, request);
  const links = nextLinks(work, args.links);
  const next = { ...doc, rev: doc.rev + 1, links: links || doc.links, updatedAt: work.clock().toISOString() };
  return { events: [{ type: 'doc/updated', docId: next.id, rev: next.rev, data: next }], entityRev: next.rev };
}

export const INLINE_DOCUMENT_OPERATIONS = Object.freeze({
  'document.writeRevision': putInlineDocument,
  'document.changeLinks': linkInlineDocument,
});
