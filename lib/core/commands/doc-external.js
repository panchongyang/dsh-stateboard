// External document commands (docs/EXTERNAL-DOCS.md, contract §1–§2.3, §6).
//
// No command writes a body blob or touches the workspace file. Every write is
// guarded by the record's metaRev (`expectedMetaRev`, rebind: expected.projectRev).

import { BoardError } from '../errors.js';
import { normalizeDocLinks } from '../normalize.js';
import { newId } from '../util.js';
import { validateRelPath } from '../documents/locate.js';
import {
  assertExternalRecord, BASELINE_DOMAIN, DOC_KINDS, isExternal, MANAGEMENT_STATES, READER_VERSION, transitionAllowed,
} from '../documents/external-model.js';
import { bindingById, mainBinding, readFailure, readLocator } from '../documents/external-observe.js';
import { gitHeadOid } from '../documents/external-git.js';

// A registration must point at an existing regular file inside the root; its
// contents may be unpreviewable (binary, oversize, invalid UTF-8) — contract §3.2.
const REGISTRABLE = new Set(['readable', 'unsupported_format', 'oversize', 'undecodable']);

function invalid(message, details) {
  return new BoardError('invalid-command', message, { status: 400, details: details || null });
}

function actorRef(actor) {
  const a = actor || {};
  return { kind: a.kind || 'system', sessionId: a.sessionId || null, agentId: a.agentId || null };
}

function titleOf(value) {
  const title = String(value ?? '').trim();
  if (title === '') throw invalid('doc title is required');
  if (title.length > 200) throw invalid('doc title exceeds 200 characters');
  return title;
}

function kindOf(value, fallback) {
  if (value === undefined) return fallback;
  if (!DOC_KINDS.includes(value)) throw invalid('kind must be one of ' + DOC_KINDS.join(', '));
  return value;
}

/**
 * Bindings are judged on disk state, as every identity write does: another
 * process may have retired or added one since this service loaded its index.
 */
function refreshBindings(handle) {
  if (handle.service && typeof handle.service.refreshFromDisk === 'function') handle.service.refreshFromDisk({ strict: true });
}

/** Binding for a new locator: explicit and active for this project, or the main binding. */
function targetBinding(handle, bindingId) {
  if (bindingId === undefined || bindingId === null) {
    const main = mainBinding(handle);
    if (!main) throw new BoardError('missing-binding', 'project has no main binding', { status: 409 });
    return main;
  }
  if (typeof bindingId !== 'string' || bindingId === '') throw new BoardError('invalid-external-doc', 'bindingId must be a non-empty string', { status: 400 });
  const binding = bindingById(handle, bindingId);
  if (!binding) throw new BoardError('missing-binding', 'binding ' + bindingId + ' is not an active binding of this project', { status: 409, details: { bindingId } });
  return binding;
}

/** Validate a new locator and prove the target is a registrable regular file. */
function checkedLocator(handle, bindingId, relPath) {
  const lexical = validateRelPath(relPath);
  if (!lexical.ok) throw new BoardError(lexical.code, 'relPath rejected: ' + lexical.detail, { status: 403, details: { availability: lexical.availability, detail: lexical.detail } });
  const binding = targetBinding(handle, bindingId);
  const locator = { bindingId: binding.bindingId, relPath };
  const { read } = readLocator(handle, locator, { previewBytes: 1 });
  if (!REGISTRABLE.has(read.availability)) throw readFailure(read);
  return locator;
}

function requireExternal(handle, cmd) {
  if (typeof cmd.docId !== 'string' || cmd.docId === '') throw invalid('docId is required');
  const doc = handle.state.docs[cmd.docId];
  if (!doc) throw new BoardError('not-found', 'doc not found: ' + cmd.docId, { status: 404 });
  if (!isExternal(doc)) throw new BoardError('invalid-command', 'doc ' + cmd.docId + ' is not an external document', { status: 400, details: { docId: cmd.docId } });
  if (!Number.isInteger(cmd.expectedMetaRev) || cmd.expectedMetaRev !== doc.rev) {
    throw new BoardError('stale-revision', 'doc metaRev is ' + doc.rev + '; expectedMetaRev is required and must match', { status: 409, details: { docId: doc.id, currentMetaRev: doc.rev } });
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

export function externalRegister(handle, cmd) {
  refreshBindings(handle);
  const title = titleOf(cmd.title);
  const kind = kindOf(cmd.kind, 'note');
  const locator = checkedLocator(handle, cmd.bindingId, cmd.relPath);
  const links = cmd.links === undefined ? { taskIds: [], planRefs: [] } : normalizeDocLinks(handle.state, cmd.links);
  const at = new Date().toISOString();
  const record = {
    id: newId('doc'), source: 'external', rev: 1, title, kind, status: 'draft',
    locator, links, baseline: null, baselineInContext: false, unregistered: null, createdAt: at, updatedAt: at,
    createdBy: actorRef(cmd.actor),
  };
  return { events: [emit('doc/external-registered', record)], entityRev: 1, result: { docId: record.id } };
}

function statusChange(doc, cmd) {
  if (cmd.status === undefined || cmd.status === doc.status) return null;
  if (!MANAGEMENT_STATES.includes(cmd.status)) throw invalid('status must be one of ' + MANAGEMENT_STATES.join(', '));
  if (!transitionAllowed(doc.status, cmd.status)) {
    throw new BoardError('illegal-transition', 'doc status cannot move ' + doc.status + ' → ' + cmd.status, { status: 409, details: { from: doc.status, to: cmd.status } });
  }
  const reason = typeof cmd.reason === 'string' ? cmd.reason.trim() : '';
  if (doc.status === 'archived' && reason === '') throw invalid('reopening an archived doc requires a reason');
  return { from: doc.status, to: cmd.status, reason: reason || null };
}

export function externalUpdateMeta(handle, cmd) {
  const doc = requireExternal(handle, cmd);
  const changes = {};
  if (cmd.title !== undefined) changes.title = titleOf(cmd.title);
  if (cmd.kind !== undefined) changes.kind = kindOf(cmd.kind, doc.kind);
  if (cmd.links !== undefined) changes.links = normalizeDocLinks(handle.state, cmd.links);
  const transition = statusChange(doc, cmd);
  if (transition) changes.status = transition.to;
  const fields = Object.keys(changes).filter((key) => JSON.stringify(changes[key]) !== JSON.stringify(doc[key]));
  if (fields.length === 0) throw invalid('update_meta changes nothing');
  const record = next(doc, new Date().toISOString(), changes);
  const change = { fields, by: actorRef(cmd.actor), ...(transition ? { transition } : {}) };
  return { events: [emit('doc/external-updated', record, { change })], entityRev: record.rev };
}

export function externalRelocate(handle, cmd) {
  const doc = requireExternal(handle, cmd);
  refreshBindings(handle);
  const relPath = cmd.relPath === undefined ? doc.locator.relPath : cmd.relPath;
  const locator = checkedLocator(handle, cmd.bindingId === undefined ? doc.locator.bindingId : cmd.bindingId, relPath);
  if (locator.bindingId === doc.locator.bindingId && locator.relPath === doc.locator.relPath) throw invalid('relocate target equals the current locator');
  const record = next(doc, new Date().toISOString(), { locator, baselineInContext: false });
  const change = { from: doc.locator, to: locator, by: actorRef(cmd.actor), reason: typeof cmd.reason === 'string' ? cmd.reason : null };
  return { events: [emit('doc/external-relocated', record, { change })], entityRev: record.rev };
}

export function externalRebind(handle, cmd) {
  const kind = cmd.actor && cmd.actor.kind;
  if (kind !== 'human' && kind !== 'system') throw new BoardError('forbidden-role', 'doc.external.rebind is human/system only', { status: 403 });
  if (!cmd.expected || !Number.isInteger(cmd.expected.projectRev)) throw invalid('rebind requires expected.projectRev');
  if (typeof cmd.fromBindingId !== 'string' || cmd.fromBindingId === '') throw invalid('fromBindingId is required');
  refreshBindings(handle);
  const target = targetBinding(handle, cmd.toBindingId ?? '');
  if (target.bindingId === cmd.fromBindingId) throw invalid('fromBindingId equals toBindingId');
  const at = new Date().toISOString();
  const events = [];
  for (const doc of Object.values(handle.state.docs)) {
    if (!isExternal(doc) || doc.unregistered || doc.locator.bindingId !== cmd.fromBindingId) continue;
    const locator = { bindingId: target.bindingId, relPath: doc.locator.relPath };
    const record = next(doc, at, { locator, baselineInContext: false });
    events.push(emit('doc/external-relocated', record, { change: { from: doc.locator, to: locator, by: actorRef(cmd.actor), rebind: true } }));
  }
  return { events, result: { matched: events.length, docIds: events.map((e) => e.docId) } };
}

export function externalConfirm(handle, cmd) {
  const doc = requireExternal(handle, cmd);
  if (typeof cmd.expectedContentHash !== 'string' || !/^[0-9a-f]{64}$/.test(cmd.expectedContentHash)) {
    throw invalid('expectedContentHash must be the lowercase hex64 SHA-256 of the full file');
  }
  refreshBindings(handle);
  const { context, read } = readLocator(handle, doc.locator, { previewBytes: 1 });
  if (!read.ok) throw readFailure(read);
  if (read.hash !== cmd.expectedContentHash) {
    throw new BoardError('stale-revision', 'document content changed since it was read; re-read and confirm again', { status: 409, details: { docId: doc.id, currentContentHash: read.hash } });
  }
  const baseline = {
    domain: BASELINE_DOMAIN,
    contentHash: read.hash,
    bindingId: context.bindingId,
    relPath: context.relPath,
    gitHeadOid: gitHeadOid(context.root),
    confirmedAt: new Date().toISOString(),
    confirmedBy: actorRef(cmd.actor),
    readerVersion: READER_VERSION,
  };
  const record = next(doc, baseline.confirmedAt, { baseline, baselineInContext: true });
  const change = { previousBaseline: doc.baseline || null, size: read.size };
  return { events: [emit('doc/external-confirmed', record, { change })], entityRev: record.rev };
}

export function externalUnregister(handle, cmd) {
  const doc = requireExternal(handle, cmd);
  const at = new Date().toISOString();
  const reason = typeof cmd.reason === 'string' && cmd.reason.trim() !== '' ? cmd.reason.trim() : null;
  const record = next(doc, at, { unregistered: { at, by: actorRef(cmd.actor), reason } });
  return { events: [emit('doc/external-unregistered', record)], entityRev: record.rev };
}

export const DOC_EXTERNAL_HANDLERS = {
  'doc.external.register': externalRegister,
  'doc.external.update_meta': externalUpdateMeta,
  'doc.external.relocate': externalRelocate,
  'doc.external.rebind': externalRebind,
  'doc.external.confirm': externalConfirm,
  'doc.external.unregister': externalUnregister,
};
