import { requireId, sendJson } from '../util.js';

/** GET /projects/:id/plans — read port only. */
export async function plansRoute(req, res, url, _parts, source) {
  const includeArchived = url.searchParams.get('includeArchived') !== '0';
  return sendJson(res, 200, { ok: true, ...await source.read('plans', { includeArchived }) });
}

/** GET /projects/:id/plans/current — read port only. */
export async function currentPlanRoute(req, res, _url, _parts, source) {
  return sendJson(res, 200, { ok: true, ...await source.read('plan', {}) });
}

/** GET /projects/:id/plans/:planId — read port only. */
export async function planRoute(req, res, _url, parts, source) {
  return sendJson(res, 200, { ok: true, ...await source.read('plan', { planId: requireId(parts[3], 'pln', 'planId') }) });
}
