import { readImageAsset } from '../../core/documents/assets.js';
import { requireWebActor } from '../auth.js';
import { randomUUID } from 'node:crypto';
import { assertFixedReadArgs, getFixedContent } from '../../core/documents/fixed-content.js';
import { BoardError } from '../../core/errors.js';
import { readJson, requireId, sendJson } from '../util.js';
import { num } from './shared.js';
import { DOC_EXTERNAL_HTTP_ENVELOPE, DOC_EXTERNAL_WRITE_FIELDS } from '../../shared/contract.js';
import { inspectExternalDoc, listExternalDocs } from '../../core/documents/external-observe.js';

// External document surface (contract §6.1). Responses carry schemaVersion=1;
// a write that names an unknown schemaVersion is refused instead of being
// guessed. The accepted field set is the shared command table: a misspelled
// field is a 400 before any command runs, never a silent default. An
// unavailable file is still a normal inspect/list result: only store, auth and
// unknown-doc failures are request failures.
const SCHEMA_VERSION = 1;

export async function externalDocAssetRoute(_req, res, url, parts, handle) {
  const rawPath = url.searchParams.get('path');
  if (rawPath === null) throw invalid('path query parameter is required');
  const { bytes, contentType, size } = readImageAsset(handle, requireId(parts[4], 'doc', 'docId'), rawPath);
  res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': String(size), 'Cache-Control': 'no-store' });
  res.end(bytes);
}

function flag(value) {
  return value === '1' || value === 'true';
}

function invalid(message, details) {
  return new BoardError('invalid-command', message, { status: 400, details: details ?? null });
}

function unsupportedSchema(body) {
  if (body.schemaVersion !== undefined && body.schemaVersion !== SCHEMA_VERSION) {
    return new BoardError('invalid-command', 'unsupported schemaVersion ' + JSON.stringify(body.schemaVersion) + '; this server writes schemaVersion 1 (client is read-only until upgraded)', {
      status: 400,
      details: { schemaVersion: body.schemaVersion ?? null, supported: SCHEMA_VERSION },
    });
  }
  return null;
}

/** Reject a body that is not a JSON object, carries unknown fields, or contradicts the URL docId. */
function assertWritableBody(body, action, docId) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw invalid('request body must be a JSON object');
  const fields = action === 'fixed' ? ['docId', 'fixed', 'commitOid', 'pathAtCommit', 'bindingId'] : DOC_EXTERNAL_WRITE_FIELDS[action];
  const allowed = new Set([...fields, ...DOC_EXTERNAL_HTTP_ENVELOPE]);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw invalid('unknown field(s) for doc.external.' + action + ': ' + unknown.join(', ') + '; allowed: ' + [...allowed].join(', '), { fields: unknown, allowed: [...allowed] });
  }
  if (docId !== undefined && body.docId !== undefined && body.docId !== docId) {
    throw invalid('docId in the body does not match the URL', { bodyDocId: body.docId, urlDocId: docId });
  }
}

const ACTIONS = new Set(['relocate', 'confirm', 'unregister', 'fixed']);

async function write(handle, { prepared, authority } = {}) {
  const actor = requireWebActor(authority);
  if (!prepared) throw invalid('external write was not pre-validated');
  const { action, docId, body } = prepared;
  const cmd = { op: 'doc.external.' + action, cmdId: typeof body.cmdId === 'string' && body.cmdId !== '' ? body.cmdId : 'cmd_' + randomUUID() };
  for (const field of DOC_EXTERNAL_WRITE_FIELDS[action]) if (body[field] !== undefined) cmd[field] = body[field];
  if (docId !== undefined) cmd.docId = docId;
  return handle.command({ ...cmd, actor });
}

function docOf(handle, result, fallbackId) {
  const docId = result.docId || result.events?.find((event) => event.docId)?.docId || fallbackId;
  return docId ? structuredClone(handle.state.docs[docId] ?? null) : null;
}

/**
 * Parse and validate an external write before the project is opened. Opening a
 * cold project runs recovery (recover/intent settle writes), so validation that
 * ran after `service.open` could return 400 while the log had already changed.
 * Returns `{ action, docId, body }` for the three write shapes, else null.
 */
export async function prepareExternalWrite(req, parts, method) {
  let shape = null;
  if (parts.length === 4 && parts[2] === 'docs' && parts[3] === 'external' && method === 'POST') shape = { action: 'register', docId: undefined };
  else if (parts.length === 5 && parts[2] === 'docs' && parts[3] === 'external' && method === 'PATCH') shape = { action: 'update_meta', docId: requireId(parts[4], 'doc', 'docId') };
  else if (parts.length === 6 && parts[2] === 'docs' && parts[3] === 'external' && method === 'POST') {
    if (!ACTIONS.has(parts[5])) throw new BoardError('not-found', 'unknown external doc action: ' + parts[5], { status: 404 });
    shape = { action: parts[5], docId: requireId(parts[4], 'doc', 'docId') };
  }
  if (!shape) return null;
  const body = await readJson(req);
  assertWritableBody(body, shape.action, shape.docId);
  const unsupported = unsupportedSchema(body);
  if (unsupported) throw unsupported;
  if (shape.action === 'fixed') assertFixedReadArgs({ ...body, docId: shape.docId });
  return { action: shape.action, docId: shape.docId, body };
}

/** GET /projects/:id/docs — inline list (kept as-is) */
export function docsRoute(req, res, _url, _parts, handle) {
  return sendJson(res, 200, { ok: true, ...handle.query('docs', {}) });
}

/** GET /projects/:id/docs/:docId — inline body only; external docs are refused by core. */
export function docRoute(req, res, url, parts, handle) {
  const maxBytes = num(url.searchParams.get('maxBytes'), 262144);
  return sendJson(res, 200, { ok: true, ...handle.query('doc', { docId: requireId(parts[3], 'doc', 'docId'), maxBytes }) });
}

/** GET /projects/:id/docs/external (list) and POST (register). */
export async function externalDocsRoute(req, res, url, _parts, handle, context) {
  if (req.method === 'GET') {
    const includeUnregistered = flag(url.searchParams.get('includeUnregistered'));
    return sendJson(res, 200, { ok: true, ...listExternalDocs(handle, { includeUnregistered }) });
  }
  const result = await write(handle, context);
  return sendJson(res, 200, { ok: true, schemaVersion: SCHEMA_VERSION, result, doc: docOf(handle, result) });
}

/** GET /projects/:id/docs/external/:docId (inspect) and PATCH (update_meta). */
export async function externalDocRoute(req, res, url, parts, handle, context) {
  const docId = requireId(parts[4], 'doc', 'docId');
  if (req.method === 'GET') {
    const options = { fresh: flag(url.searchParams.get('fresh')), preview: flag(url.searchParams.get('preview')) };
    return sendJson(res, 200, { ok: true, ...inspectExternalDoc(handle, docId, options) });
  }
  const result = await write(handle, context);
  return sendJson(res, 200, { ok: true, schemaVersion: SCHEMA_VERSION, result, doc: docOf(handle, result, docId) });
}

/** POST /projects/:id/docs/external/:docId/(relocate|confirm|unregister|fixed) */
export async function externalDocActionRoute(req, res, _url, parts, handle, context) {
  const docId = requireId(parts[4], 'doc', 'docId');
  const action = parts[5];
  if (!ACTIONS.has(action)) throw new BoardError('not-found', 'unknown external doc action: ' + action, { status: 404 });
  if (action === 'fixed') return sendJson(res, 200, { ok: true, ...getFixedContent(handle, { ...context.prepared.body, docId }) });
  const result = await write(handle, context);
  return sendJson(res, 200, { ok: true, schemaVersion: SCHEMA_VERSION, result, doc: docOf(handle, result, docId) });
}
