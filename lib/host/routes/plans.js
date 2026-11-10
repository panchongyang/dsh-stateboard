import { requireId, sendJson } from '../util.js';

/** GET /projects/:id/plans */
export function plansRoute(req, res, url, _parts, handle) {
  const includeArchived = url.searchParams.get('includeArchived') !== '0';
  return sendJson(res, 200, { ok: true, ...handle.query('plans', { includeArchived }) });
}

/** GET /projects/:id/plans/current */
export function currentPlanRoute(req, res, _url, _parts, handle) {
  return sendJson(res, 200, { ok: true, ...handle.query('plan', {}) });
}

/** GET /projects/:id/plans/:planId */
export function planRoute(req, res, _url, parts, handle) {
  return sendJson(res, 200, { ok: true, ...handle.query('plan', { planId: requireId(parts[3], 'pln', 'planId') }) });
}
