import { BoardError } from '../errors.js';
import { DOC_KINDS, MANAGEMENT_STATES, assertExternalRecord, transitionAllowed } from '../documents/external-model.js';

export function assertExternalDocumentWriter(actor) {
  if (!['human', 'agent', 'system'].includes(actor?.kind)) throw new BoardError('forbidden-role', 'document writes require a trusted actor', { status: 403 });
}

/** 外置记录标题/类型的模型输入规则；命令可提前复用同一判定以保持错误次序。 */
export function documentTitle(value) {
  const title = String(value ?? '').trim();
  if (title === '') throw new BoardError('invalid-command', 'doc title is required', { status: 400, details: null });
  if (title.length > 200) throw new BoardError('invalid-command', 'doc title exceeds 200 characters', { status: 400, details: null });
  return title;
}

export function documentKind(value, fallback) {
  if (value === undefined) return fallback;
  if (!DOC_KINDS.includes(value)) throw new BoardError('invalid-command', 'kind must be one of ' + DOC_KINDS.join(', '), { status: 400, details: null });
  return value;
}

/**
 * 管理状态转移的模型合法性（契约 §2.1）：只有允许的边，且归档重开必须带理由。
 * 业务只发起请求；合法边不因入口是 HTTP、工具还是迁移脚本而不同。
 */
export function documentStatusTransition(doc, status, reason) {
  if (status === undefined || status === doc.status) return null;
  if (!MANAGEMENT_STATES.includes(status)) throw new BoardError('invalid-command', 'status must be one of ' + MANAGEMENT_STATES.join(', '), { status: 400, details: null });
  if (!transitionAllowed(doc.status, status)) throw new BoardError('illegal-transition', 'doc status cannot move ' + doc.status + ' → ' + status, { status: 409, details: { from: doc.status, to: status } });
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  if (doc.status === 'archived' && trimmed === '') throw new BoardError('invalid-command', 'reopening an archived doc requires a reason', { status: 400, details: null });
  return { from: doc.status, to: status, reason: trimmed || null };
}

export function registerExternalDocument(fields) {
  const doc = { ...fields, status: 'draft' };
  assertExternalRecord(doc);
  return doc;
}
function managementEdge(doc, to) {
  if (doc.unregistered) throw new BoardError('illegal-transition', 'doc ' + doc.id + ' is unregistered', { status: 409, details: { docId: doc.id } });
  if (!transitionAllowed(doc.status, to)) throw new BoardError('illegal-transition', 'doc status cannot move ' + doc.status + ' → ' + to, { status: 409, details: { from: doc.status, to } });
  return { ...structuredClone(doc), status: to };
}
export function requestDocumentReview(doc) { return managementEdge(doc, 'in_review'); }
export function adoptDocument(doc) { return managementEdge(doc, 'adopted'); }
export function returnDocumentDraft(doc) {
  if (doc.status !== 'in_review') throw new BoardError('illegal-transition', 'only a document in review can return to draft', { status: 409 });
  return managementEdge(doc, 'draft');
}
export function archiveDocument(doc) { return managementEdge(doc, 'archived'); }
export function reopenDocument(doc) {
  if (doc.status !== 'archived') throw new BoardError('illegal-transition', 'only an archived document can be reopened', { status: 409 });
  return managementEdge(doc, 'draft');
}
export function unregisterExternalDocument(doc, unregistered, at) {
  if (doc.unregistered) throw new BoardError('illegal-transition', 'doc ' + doc.id + ' is unregistered', { status: 409, details: { docId: doc.id } });
  return { ...structuredClone(doc), unregistered, rev: doc.rev + 1, updatedAt: at };
}
export function migrateInlineDocument(doc, fields) {
  if (doc.source === 'external') throw new BoardError('illegal-transition', 'document is already external', { status: 409 });
  const record = registerExternalDocument(fields);
  if (record.id !== doc.id || record.rev !== doc.rev + 1) throw new BoardError('stale-revision', 'migration must preserve identity and advance revision', { status: 409 });
  return record;
}
