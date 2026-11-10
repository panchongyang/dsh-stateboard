import { BoardError } from '../../core/errors.js';
import { sendJson } from '../util.js';

// Helpers shared by the resource modules. The HTTP shapes here are frozen:
// every error body is { ok: false, error: { code, message, details? } }.

export function num(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function summaryOf(handle) {
  const board = handle.query('board', {});
  return {
    id: handle.id,
    name: handle.name,
    workspacePath: handle.workspacePath,
    phase: board.project.phase,
    rev: handle.rev,
    counts: board.counts,
    lastAt: board.project.updatedAt,
    readOnly: handle.readOnly,
  };
}

/**
 * Split the decoded route into segments. decodeURIComponent throws URIError on
 * %zz and on invalid UTF-8 sequences; that used to escape the handler as a 500
 * for what is plainly a bad request.
 */
export function parseParts(route) {
  return route.split('/').filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      throw new BoardError('invalid-path', 'malformed percent-encoding in the path', { status: 400 });
    }
  });
}

export function notFound(res, route) {
  return sendJson(res, 404, {
    ok: false,
    error: { code: 'not-found', message: route === undefined ? 'Unknown route.' : 'Unknown route: ' + route },
  });
}

export function methodNotAllowed(res, method) {
  return sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: method } });
}
