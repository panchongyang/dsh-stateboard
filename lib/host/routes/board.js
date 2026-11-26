import { sendJson } from '../util.js';

/** GET /projects/:id/board — read port only. */
export async function boardRoute(req, res, _url, _parts, source) {
  return sendJson(res, 200, { ok: true, ...await source.read('board', {}) });
}
