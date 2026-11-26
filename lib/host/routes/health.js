import { sendJson } from '../util.js';

/** GET /projects/:id/health — the isolated audit is served by the read port. */
export async function healthRoute(req, res, _url, _parts, source) {
  return sendJson(res, 200, { ok: true, health: await source.read('health', {}) });
}
