import { requireId, sendJson } from '../util.js';

/** GET /projects/:id/tasks/:taskId — read port only. */
export async function taskRoute(req, res, url, parts, source) {
  const sessionId = url.searchParams.get('sessionId') || undefined;
  return sendJson(res, 200, { ok: true, ...await source.read('task', { taskId: requireId(parts[3], 'tsk', 'taskId'), sessionId }) });
}
