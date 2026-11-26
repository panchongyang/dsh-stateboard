// 外置文档命令（docs/modules/documents/contract.md）。
// 命令只做授权、绑定/文件观测与定位校验；记录、版本与审计字段由具名模型操作产生。
// 可安装不可变正文对象，但不修改工作区源文件。

import { BoardError } from '../errors.js';
import { documentKind, documentTitle, assertExternalDocumentWriter } from '../domain/document-transitions.js';
import { validateRelPath } from '../domain/document-path.js';
import { isExternal } from '../documents/external-model.js';
import { readFailure } from '../domain/document-read-error.js';

// A registration must point at an existing regular file inside the root; its
// contents may be unpreviewable (binary, oversize, invalid UTF-8) — contract §3.2.
const REGISTRABLE = new Set(['readable', 'unsupported_format', 'oversize', 'undecodable']);

function invalid(message, details) {
  return new BoardError('invalid-command', message, { status: 400, details: details || null });
}

/**
 * Bindings are judged on disk state, as every identity write does: another
 * process may have retired or added one since this service loaded its index.
 */
function refreshBindings(read) {
  read.documents.refreshBindings();
}

/** Binding for a new locator: explicit and active for this project, or the main binding. */
function targetBinding(read, bindingId) {
  if (bindingId === undefined || bindingId === null) {
    const main = read.documents.mainBinding();
    if (!main) throw new BoardError('missing-binding', 'project has no main binding', { status: 409 });
    return main;
  }
  if (typeof bindingId !== 'string' || bindingId === '') throw new BoardError('invalid-external-doc', 'bindingId must be a non-empty string', { status: 400 });
  const binding = read.documents.bindingById(bindingId);
  if (!binding) throw new BoardError('missing-binding', 'binding ' + bindingId + ' is not an active binding of this project', { status: 409, details: { bindingId } });
  return binding;
}

/** Validate a new locator and prove the target is a registrable regular file. */
function checkedLocator(read, bindingId, relPath, except) {
  const lexical = validateRelPath(relPath);
  if (!lexical.ok) throw new BoardError(lexical.code, 'relPath rejected: ' + lexical.detail, { status: 403, details: { availability: lexical.availability, detail: lexical.detail } });
  const binding = targetBinding(read, bindingId);
  const locator = { bindingId: binding.bindingId, relPath };
  read.documents.assertUniqueLocator(locator, except);
  const { read: observed } = read.documents.readLocator(locator, { previewBytes: 1 });
  if (!REGISTRABLE.has(observed.availability)) throw readFailure(observed);
  return locator;
}

function requireExternal(read, cmd) {
  if (typeof cmd.docId !== 'string' || cmd.docId === '') throw invalid('docId is required');
  const doc = (read.state.docs || {})[cmd.docId];
  if (!doc) throw new BoardError('not-found', 'doc not found: ' + cmd.docId, { status: 404 });
  if (!isExternal(doc)) throw new BoardError('invalid-command', 'doc ' + cmd.docId + ' is not an external document', { status: 400, details: { docId: cmd.docId } });
  if (!Number.isInteger(cmd.expectedMetaRev) || cmd.expectedMetaRev !== doc.rev) {
    throw new BoardError('stale-revision', 'doc metaRev is ' + doc.rev + '; expectedMetaRev is required and must match', { status: 409, details: { docId: doc.id, currentMetaRev: doc.rev } });
  }
  if (doc.unregistered) throw new BoardError('illegal-transition', 'doc ' + doc.id + ' is unregistered', { status: 409, details: { docId: doc.id } });
  return doc;
}

function operation(kind, args) {
  return { operations: [{ kind, args }] };
}

function captureExternal(read, cmd) {
  const allowed = new Set(['op','docId','cmdId','actor','projectId','expected']);
  if (Object.keys(cmd).some(key => !allowed.has(key))) throw invalid('capture takes a document identity, never a body, hash or path');
  const doc = Object.hasOwn(read.state.docs, cmd.docId) ? read.state.docs[cmd.docId] : null;
  if (!doc) throw new BoardError('not-found', 'Document not found', {status:404});
  if (!isExternal(doc) || doc.unregistered) throw invalid('capture requires an active registered workspace file');
  const {contentHash, size} = read.documents.capture(doc);
  return operation('document.retainVersion', {docId: doc.id, locator: doc.locator, contentHash, size});
}

export function externalRegister(read, cmd) {
  refreshBindings(read);
  documentTitle(cmd.title);
  documentKind(cmd.kind, 'note');
  const locator = checkedLocator(read, cmd.bindingId, cmd.relPath);
  return operation('document.registerExternal', { title: cmd.title, kind: cmd.kind, locator, links: cmd.links,
    purpose: cmd.purpose, scope: cmd.scope, supersedes: cmd.supersedes });
}

export function externalUpdateMeta(read, cmd) {
  requireExternal(read, cmd);
  // 状态边与重开理由由模型操作判定；命令只提交请求字段。
  return operation('document.editExternalMetadata', {
    docId: cmd.docId, expectedMetaRev: cmd.expectedMetaRev,
    title: cmd.title, kind: cmd.kind, links: cmd.links, status: cmd.status, reason: cmd.reason,
    purpose: cmd.purpose, scope: cmd.scope, supersedes: cmd.supersedes,
  });
}

export function externalRelocate(read, cmd) {
  const doc = requireExternal(read, cmd);
  refreshBindings(read);
  const relPath = cmd.relPath === undefined ? doc.locator.relPath : cmd.relPath;
  const locator = checkedLocator(read, cmd.bindingId === undefined ? doc.locator.bindingId : cmd.bindingId, relPath, doc.id);
  return operation('document.moveExternalLocator', {
    docId: cmd.docId, expectedMetaRev: cmd.expectedMetaRev, locator,
    reason: typeof cmd.reason === 'string' ? cmd.reason : null,
  });
}

export function externalRebind(read, cmd) {
  const kind = cmd.actor && cmd.actor.kind;
  if (kind !== 'human' && kind !== 'system') throw new BoardError('forbidden-role', 'doc.external.rebind is human/system only', { status: 403 });
  if (!cmd.expected || !Number.isInteger(cmd.expected.projectRev)) throw invalid('rebind requires expected.projectRev');
  if (typeof cmd.fromBindingId !== 'string' || cmd.fromBindingId === '') throw invalid('fromBindingId is required');
  refreshBindings(read);
  const target = targetBinding(read, cmd.toBindingId ?? '');
  return operation('document.rebindExternalBinding', { fromBindingId: cmd.fromBindingId, toBindingId: target.bindingId });
}

export function externalConfirm(read, cmd) {
  assertExternalDocumentWriter(cmd.actor);
  const doc = requireExternal(read, cmd);
  if (typeof cmd.expectedContentHash !== 'string' || !/^[0-9a-f]{64}$/.test(cmd.expectedContentHash)) {
    throw invalid('expectedContentHash must be the lowercase hex64 SHA-256 of the full file');
  }
  refreshBindings(read);
  const retained = read.documents.hasOwningSpace;
  let contentHash, size;
  if (retained) {
    ({ contentHash, size } = read.documents.capture(doc, { expectedContentHash: cmd.expectedContentHash }));
  } else {
    const { read: observed } = read.documents.readLocator(doc.locator, { previewBytes: 1 });
    if (!observed.ok) throw readFailure(observed);
    ({ hash: contentHash, size } = observed);
  }
  return operation('document.confirmExternalBaseline', {
    docId: cmd.docId, expectedMetaRev: cmd.expectedMetaRev, expectedContentHash: cmd.expectedContentHash,
    observation: { contentHash, size, ...doc.locator, retained },
  });
}

export function externalUnregister(read, cmd) {
  requireExternal(read, cmd);
  return operation('document.unregisterExternal', { docId: cmd.docId, expectedMetaRev: cmd.expectedMetaRev, reason: cmd.reason });
}

export const DOC_EXTERNAL_HANDLERS = {
  'doc.external.register': externalRegister,
  'doc.external.update_meta': externalUpdateMeta,
  'doc.external.relocate': externalRelocate,
  'doc.external.rebind': externalRebind,
  'doc.external.confirm': externalConfirm,
  'doc.external.unregister': externalUnregister,
  'doc.workspace_capture': captureExternal,
};
