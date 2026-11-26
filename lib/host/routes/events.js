import { sendJson } from '../util.js';
import { num } from './shared.js';

/** GET /projects/:id/events — read port only. */
export async function eventsRoute(req, res, url, _parts, source) {
  return sendJson(res, 200, { ok: true, ...await source.read('events', {
    after: num(url.searchParams.get('after'), 0),
    limit: num(url.searchParams.get('limit'), 100),
  }) });
}
