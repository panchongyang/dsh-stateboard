// Observation of external documents (contract §2.2–§2.4). Nothing here writes:
// no event, no rev, no baseline. Results may be cached for at most 30 seconds;
// confirmation and formal evidence never use this cache.

import { BoardError } from '../errors.js';
import { AVAILABILITY_CODES, readDocument } from './read.js';
import { isExternal } from './external-model.js';
import { observeGit } from './external-git.js';

export const OBSERVATION_TTL_MS = 30_000;
const SCHEMA_VERSION = 1;
const NO_GIT = new Set(['missing_binding', 'root_unavailable', 'security_rejected', 'outside_root']);
const caches = new WeakMap();

/**
 * Re-read the binding registry so a binding retired by another process stops
 * being readable here, cached observation included. A registry that cannot be
 * read degrades to implicit main bindings, never to stale persisted ones.
 */
export function reloadBindings(handle) {
  if (handle.service && typeof handle.service.reloadBindings === 'function') handle.service.reloadBindings();
}

/** Active binding `bindingId` of this project, or null. Never derived from a session cwd. */
export function bindingById(handle, bindingId) {
  if (typeof bindingId !== 'string' || bindingId === '') return null;
  const index = handle.service && handle.service.bindings && handle.service.bindings();
  if (!index) return null;
  return index.activeFor(handle.id).find((b) => b.bindingId === bindingId) || null;
}

/** The project's main binding (implicit bnd_legacy_* included), or null. */
export function mainBinding(handle) {
  const index = handle.service && handle.service.bindings && handle.service.bindings();
  return index ? index.mainOf(handle.id) : null;
}

/**
 * One fresh, uncached read of a locator in its own binding root.
 * Returns `{ context, read }` where read is the D2 reader result, or a
 * missing_binding failure when the binding is not an active binding of this project.
 */
export function readLocator(handle, locator, options = {}) {
  const binding = bindingById(handle, locator.bindingId);
  const context = { bindingId: locator.bindingId, root: binding ? binding.root : null, relPath: locator.relPath, role: binding ? binding.role : null };
  if (!binding) return { context, read: { ok: false, availability: 'missing_binding', code: AVAILABILITY_CODES.missing_binding } };
  return { context, read: readDocument(binding.root, locator.relPath, options) };
}

/** Throw the contract error for a failed read (used by commands, never by inspect). */
export function readFailure(read) {
  const status = { 'root-unavailable': 503, 'missing-binding': 409, 'file-missing': 404, 'permission-denied': 403, 'outside-root': 403, 'security-rejected': 403, 'not-regular': 400, oversize: 413, undecodable: 400, 'unsupported-format': 400, unstable: 409 }[read.code] || 409;
  return new BoardError(read.code, 'workspace document is not available: ' + read.availability, { status, details: { availability: read.availability, detail: read.detail ?? null } });
}

/** Confirmation state of `doc` against an observed read (contract §2.2/§2.3). */
export function confirmationOf(doc, read) {
  const baseline = doc.baseline || null;
  if (!baseline) return { state: 'unconfirmed', baseline: null };
  if (!doc.baselineInContext) return { state: 'not_comparable', reason: 'relocated', baseline };
  if (baseline.bindingId !== doc.locator.bindingId || baseline.relPath !== doc.locator.relPath) {
    return { state: 'not_comparable', reason: 'context-changed', baseline };
  }
  if (baseline.domain !== 'workspace-bytes') return { state: 'not_comparable', reason: 'domain', baseline };
  if (!read || !read.ok || typeof read.hash !== 'string') return { state: 'not_comparable', reason: 'no-complete-hash', baseline };
  return { state: read.hash === baseline.contentHash ? 'matches_baseline' : 'changed_since_confirm', baseline };
}

function observe(handle, doc) {
  const { context, read } = readLocator(handle, doc.locator);
  const git = NO_GIT.has(read.availability) ? null : observeGit(context.root, doc.locator.relPath);
  return {
    context,
    read,
    git,
    observedAt: handle.clock().toISOString(),
    observedMs: handle.clock().getTime(),
  };
}

function cacheOf(handle) {
  let cache = caches.get(handle);
  if (!cache) {
    cache = new Map();
    caches.set(handle, cache);
  }
  return cache;
}

function cacheKey(handle, doc) {
  const binding = bindingById(handle, doc.locator.bindingId);
  return [doc.id, doc.rev, doc.locator.bindingId, binding ? binding.root : '', doc.locator.relPath].join('\0');
}

function observationFor(handle, doc, fresh) {
  const cache = cacheOf(handle);
  const key = cacheKey(handle, doc);
  const hit = cache.get(key);
  const now = handle.clock().getTime();
  if (!fresh && hit && now - hit.observedMs >= 0 && now - hit.observedMs < OBSERVATION_TTL_MS) return { ...hit, cached: true };
  const observed = observe(handle, doc);
  for (const [k, v] of cache) if (now - v.observedMs >= OBSERVATION_TTL_MS || k.startsWith(doc.id + '\0')) cache.delete(k);
  cache.set(key, observed);
  return { ...observed, cached: false };
}

function readView(read, withPreview) {
  return {
    contentHash: read.ok ? read.hash : null,
    size: typeof read.size === 'number' ? read.size : null,
    previewable: Boolean(read.ok && read.previewable),
    detail: read.detail ?? null,
    ...(withPreview ? { preview: read.ok && read.preview ? read.preview : null } : {}),
  };
}

/**
 * Registration + observation of one external doc. A missing or unreadable file
 * is a normal result (availability/code), never a thrown error; unknown docs,
 * inline docs and closed handles still throw.
 *
 * options: `fresh` bypasses the 30 s cache; `preview` includes the bounded
 * preview text (contract §3.2).
 */
export function inspectExternalDoc(handle, docId, options = {}) {
  handle._ensureOpen();
  const doc = handle.state.docs[docId];
  if (!doc) throw new BoardError('not-found', 'doc not found: ' + docId, { status: 404 });
  if (!isExternal(doc)) throw new BoardError('invalid-command', 'doc ' + docId + ' is an inline document; use the inline doc view', { status: 400, details: { docId, source: 'inline' } });
  const base = { schemaVersion: SCHEMA_VERSION, doc: structuredClone(doc), metaRev: doc.rev, projectRev: handle.rev };
  if (doc.unregistered) {
    return { ...base, availability: null, code: null, unregistered: true, observation: null, confirmation: { state: doc.baseline ? 'not_comparable' : 'unconfirmed', reason: 'unregistered', baseline: doc.baseline || null }, git: null };
  }
  reloadBindings(handle);
  const observed = observationFor(handle, doc, Boolean(options.fresh));
  return {
    ...base,
    unregistered: false,
    availability: observed.read.availability,
    code: AVAILABILITY_CODES[observed.read.availability] ?? observed.read.code ?? null,
    observation: { observedAt: observed.observedAt, cached: observed.cached, context: observed.context, ...readView(observed.read, Boolean(options.preview)) },
    confirmation: confirmationOf(doc, observed.read),
    git: observed.git,
  };
}

/** Registration rows of every external doc, without touching the workspace. */
export function listExternalDocs(handle, { includeUnregistered = false } = {}) {
  handle._ensureOpen();
  const docs = Object.values(handle.state.docs)
    .filter((doc) => isExternal(doc) && (includeUnregistered || !doc.unregistered))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .map((doc) => structuredClone(doc));
  return { schemaVersion: SCHEMA_VERSION, docs, projectRev: handle.rev };
}

/** Drop cached observations for a handle (tests, explicit refresh). */
export function clearObservationCache(handle) {
  caches.delete(handle);
}
