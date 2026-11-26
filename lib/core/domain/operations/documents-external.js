// 外置文档的具名模型操作：不读文件、不做 Git、不刷新绑定。
// 调用方只提交已观测的定位与内容事实；记录、版本和审计字段由模型产生。
import { isDeepStrictEqual } from 'node:util';
import { BoardError } from '../../errors.js';
import { normalizeDocLinks } from '../../normalize.js';
import { BASELINE_DOMAIN, READER_VERSION, isExternal, assertExternalRecord } from '../../documents/external-model.js';
import {
  registerExternalDocument, requestDocumentReview, adoptDocument, returnDocumentDraft,
  archiveDocument, reopenDocument, unregisterExternalDocument, documentStatusTransition,
  documentTitle, documentKind, assertExternalDocumentWriter,
} from '../document-transitions.js';
import { retainVersion } from './documents-workspace.js';

function invalid(message, details) {
  return new BoardError('invalid-command', message, { status: 400, details: details || null });
}

function requireRole(request, allowed, label) {
  if (!allowed.includes(request?.actor?.kind)) throw new BoardError('forbidden-role', label, { status: 403 });
}

function assertFields(args, allowed) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw invalid('operation arguments must be an object');
  for (const key of Object.keys(args)) if (!allowed.includes(key)) throw invalid('unsupported external document operation field: ' + key);
}

function actorRef(actor) {
  assertExternalDocumentWriter(actor);
  const a = actor;
  return { kind: a.kind || 'system', sessionId: a.sessionId || null, agentId: a.agentId || null };
}

/** 外置写只接受已登记记录的精确 metaRev；注销记录不再接受管理写。 */
function requireExternal(work, args) {
  if (typeof args.docId !== 'string' || args.docId === '') throw invalid('docId is required');
  const doc = (work.state.docs || {})[args.docId];
  if (!doc) throw new BoardError('not-found', 'doc not found: ' + args.docId, { status: 404 });
  if (!isExternal(doc)) throw new BoardError('invalid-command', 'doc ' + args.docId + ' is not an external document', { status: 400, details: { docId: args.docId } });
  if (!Number.isInteger(args.expectedMetaRev) || args.expectedMetaRev !== doc.rev) {
    throw new BoardError('stale-revision', 'doc metaRev is ' + doc.rev + '; expectedMetaRev is required and must match', {
      status: 409, details: { docId: doc.id, currentMetaRev: doc.rev },
    });
  }
  if (doc.unregistered) throw new BoardError('illegal-transition', 'doc ' + doc.id + ' is unregistered', { status: 409, details: { docId: doc.id } });
  return doc;
}

function emit(type, record, extra = {}) {
  assertExternalRecord(record);
  return { type, docId: record.id, rev: record.rev, data: record, ...extra };
}

function next(doc, at, changes) {
  return { ...structuredClone(doc), ...changes, rev: doc.rev + 1, updatedAt: at };
}

function dutyFields(args) {
  const result = {};
  for (const key of ['purpose', 'scope']) {
    if (args[key] === undefined) continue;
    if (typeof args[key] !== 'string') throw invalid(key + ' must be text');
    result[key] = args[key].trim();
  }
  if (args.supersedes !== undefined) result.supersedes = args.supersedes;
  return result;
}

export function registerExternalDocumentOp(work, args, request) {
  assertFields(args, ['title', 'kind', 'locator', 'links', 'purpose', 'scope', 'supersedes']);
  const at = work.clock().toISOString();
  const record = registerExternalDocument({
    id: work.newId('doc'), source: 'external', rev: 1, title: documentTitle(args.title), kind: documentKind(args.kind, 'note'),
    locator: structuredClone(args.locator),
    links: args.links === undefined ? { taskIds: [], planRefs: [] } : normalizeDocLinks(work.state, args.links),
    baseline: null, baselineInContext: false, unregistered: null, createdAt: at, updatedAt: at,
    createdBy: actorRef(request?.actor), ...dutyFields(args),
  });
  return { events: [emit('doc/external-registered', record)], entityRev: 1, result: { docId: record.id } };
}

export function updateExternalDocument(work, args, request) {
  assertFields(args, ['docId', 'expectedMetaRev', 'title', 'kind', 'links', 'status', 'reason', 'purpose', 'scope', 'supersedes']);
  const doc = requireExternal(work, args);
  const changes = dutyFields(args);
  if (args.title !== undefined) changes.title = documentTitle(args.title);
  if (args.kind !== undefined) changes.kind = documentKind(args.kind, doc.kind);
  if (args.links !== undefined) changes.links = normalizeDocLinks(work.state, args.links);
  const transition = documentStatusTransition(doc, args.status, args.reason);
  const edges = {
    in_review: requestDocumentReview, adopted: adoptDocument, archived: archiveDocument,
    draft: doc.status === 'archived' ? reopenDocument : returnDocumentDraft,
  };
  const transitioned = transition ? edges[transition.to](doc) : doc;
  const fields = Object.keys(changes).filter((key) => !isDeepStrictEqual(changes[key], doc[key]));
  if (transition) fields.push('status');
  if (fields.length === 0) throw invalid('update_meta changes nothing');
  const record = next(transitioned, work.clock().toISOString(), changes);
  const change = { fields, by: actorRef(request?.actor), ...(transition ? { transition } : {}) };
  return { events: [emit('doc/external-updated', record, { change })], entityRev: record.rev };
}

export function relocateExternalDocument(work, args, request) {
  assertFields(args, ['docId', 'expectedMetaRev', 'locator', 'reason']);
  const doc = requireExternal(work, args);
  if (!args.locator || typeof args.locator !== 'object' || Array.isArray(args.locator)) throw invalid('locator is required');
  const locator = structuredClone(args.locator);
  if (locator.bindingId === doc.locator.bindingId && locator.relPath === doc.locator.relPath) {
    throw invalid('relocate target equals the current locator');
  }
  const record = next(doc, work.clock().toISOString(), { locator, baselineInContext: false });
  const change = {
    from: structuredClone(doc.locator), to: structuredClone(locator),
    by: actorRef(request?.actor), reason: typeof args.reason === 'string' ? args.reason : null,
  };
  return { events: [emit('doc/external-relocated', record, { change })], entityRev: record.rev };
}

/** 绑定退役后的显式重定基：只改仍在旧绑定上的外置记录，一条动作可含多条记录事件。 */
export function rebindExternalDocuments(work, args, request) {
  requireRole(request, ['human', 'system'], 'doc.external.rebind is human/system only');
  if (!Number.isInteger(request?.expected?.projectRev)) throw invalid('rebind requires expected.projectRev');
  if (request.expected.projectRev !== work.rev) throw new BoardError('stale-revision', 'project revision changed before rebind', { status: 409 });
  assertFields(args, ['fromBindingId', 'toBindingId']);
  const from = args.fromBindingId, to = args.toBindingId;
  if (typeof from !== 'string' || from === '') throw invalid('fromBindingId is required');
  if (typeof to !== 'string' || to === '') throw invalid('toBindingId is required');
  if (from === to) throw invalid('fromBindingId equals toBindingId');
  const at = work.clock().toISOString();
  const events = [];
  for (const doc of Object.values(work.state.docs || {})) {
    if (!isExternal(doc) || doc.unregistered || doc.locator.bindingId !== from) continue;
    const locator = { bindingId: to, relPath: doc.locator.relPath };
    const record = next(doc, at, { locator, baselineInContext: false });
    events.push(emit('doc/external-relocated', record, {
      change: { from: structuredClone(doc.locator), to: structuredClone(locator), by: actorRef(request?.actor), rebind: true },
    }));
  }
  return { events, result: { matched: events.length, docIds: events.map((event) => event.docId) } };
}

export function confirmExternalDocument(work, args, request) {
  assertFields(args, ['docId', 'expectedMetaRev', 'expectedContentHash', 'observation']);
  const doc = requireExternal(work, args);
  const observation = args.observation || {};
  assertFields(observation, ['contentHash', 'size', 'bindingId', 'relPath', 'retained']);
  if (typeof observation.retained !== 'boolean') throw invalid('observation must declare whether the workspace body was retained');
  if (typeof args.expectedContentHash !== 'string' || !/^[0-9a-f]{64}$/.test(args.expectedContentHash)) throw invalid('expectedContentHash must be lowercase hex64');
  if (observation.bindingId !== doc.locator.bindingId || observation.relPath !== doc.locator.relPath) throw invalid('observation must describe the current document locator');
  if (!Number.isSafeInteger(observation.size) || observation.size < 0) throw invalid('observation size must be non-negative');
  if (observation.contentHash !== args.expectedContentHash) {
    throw new BoardError('stale-revision', 'document content changed since it was read; re-read and confirm again', {
      status: 409, details: { docId: doc.id, currentContentHash: observation.contentHash ?? null },
    });
  }
  const at = work.clock().toISOString();
  const retention = observation.retained ? retainVersion(work, {
    docId: doc.id, locator: doc.locator, contentHash: observation.contentHash, size: observation.size,
  }) : null;
  const baseline = {
    domain: BASELINE_DOMAIN, contentHash: observation.contentHash,
    bindingId: observation.bindingId, relPath: observation.relPath,
    ...(retention ? { workspaceVersion: retention.result.versionRef } : {}),
    confirmedAt: at, confirmedBy: actorRef(request?.actor), readerVersion: READER_VERSION,
  };
  const record = next(doc, at, { baseline, baselineInContext: true });
  const change = { previousBaseline: doc.baseline || null, size: observation.size };
  return { events: [...(retention?.events ?? []), emit('doc/external-confirmed', record, { change })], entityRev: record.rev };
}

export function unregisterExternalDocumentOp(work, args, request) {
  assertFields(args, ['docId', 'expectedMetaRev', 'reason']);
  const doc = requireExternal(work, args);
  const at = work.clock().toISOString();
  const reason = typeof args.reason === 'string' && args.reason.trim() !== '' ? args.reason.trim() : null;
  const record = unregisterExternalDocument(doc, { at, by: actorRef(request?.actor), reason }, at);
  return { events: [emit('doc/external-unregistered', record)], entityRev: record.rev };
}

export const EXTERNAL_DOCUMENT_OPERATIONS = Object.freeze({
  'document.registerExternal': registerExternalDocumentOp,
  'document.editExternalMetadata': updateExternalDocument,
  'document.moveExternalLocator': relocateExternalDocument,
  'document.rebindExternalBinding': rebindExternalDocuments,
  'document.confirmExternalBaseline': confirmExternalDocument,
  'document.unregisterExternal': unregisterExternalDocumentOp,
});
