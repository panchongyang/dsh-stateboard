import { BoardError } from '../core/errors.js';

export const MAX_BODY_BYTES = 1024 * 1024;

/** Read a JSON request body with a hard size cap. */
export function readJson(req, { strict = false } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Keep draining instead of destroying the socket: a destroyed request
        // surfaces on the client as a connection reset and the 413 is never seen.
        chunks.length = 0;
        settle(reject, new BoardError('invalid-command', 'request body too large', { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      if (chunks.length === 0 && !strict) return settle(resolve, {});
      try {
        const bytes = Buffer.concat(chunks);
        const text = strict ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : bytes.toString('utf8');
        settle(resolve, JSON.parse(text));
      } catch {
        settle(reject, new BoardError('invalid-command', 'request body is not valid JSON', { status: 400 }));
      }
    });
    req.on('error', (error) => settle(reject, error));
  });
}

/** Ids travel in URLs and end up as directory names: anything else is rejected up front. */
export function requireId(value, prefix, label) {
  if (typeof value !== 'string' || !new RegExp('^' + prefix + '_[0-9a-z]+$').test(value)) {
    throw new BoardError('invalid-command', (label || prefix + ' id') + ' is not a valid id', { status: 400 });
  }
  return value;
}

export function sendJson(res, status, value) {
  if (res.headersSent) return;
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function sendError(res, error, logger) {
  if (error instanceof BoardError) {
    return sendJson(res, error.status, {
      ok: false,
      error: { code: error.code, message: error.message, details: error.details ?? null },
    });
  }
  // An unexpected error carries stack frames, absolute paths and Node internals.
  // Log it locally, answer with nothing that maps the host.
  try { logger?.error?.('[project-board] ' + (error && error.stack ? error.stack : String(error))); } catch { /* logging must not mask the response */ }
  return sendJson(res, 500, { ok: false, error: { code: 'internal', message: 'internal error' } });
}

/** Parse /project-board/api/<rest>. */
export function routePath(req) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const rest = url.pathname.startsWith('/project-board/api')
    ? url.pathname.slice('/project-board/api'.length)
    : url.pathname;
  return { path: rest === '' ? '/' : rest, url };
}
