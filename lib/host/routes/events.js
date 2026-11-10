import { sendJson } from '../util.js';
import { num } from './shared.js';

/** GET /projects/:id/events */
export function eventsRoute(req, res, url, _parts, handle) {
  return sendJson(res, 200, { ok: true, ...handle.query('events', {
    after: num(url.searchParams.get('after'), 0),
    limit: num(url.searchParams.get('limit'), 100),
  }) });
}
