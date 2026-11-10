import { sendJson } from '../util.js';

/** GET /projects/:id/health */
export async function healthRoute(req, res, _url, _parts, handle) {
  return sendJson(res, 200, { ok: true, health: await handle.healthAsync() });
}
