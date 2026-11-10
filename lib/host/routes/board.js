import { sendJson } from '../util.js';

/** GET /projects/:id/board */
export function boardRoute(req, res, _url, _parts, handle) {
  return sendJson(res, 200, { ok: true, ...handle.query('board', {}) });
}
