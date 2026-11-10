import { requireId, sendJson } from '../util.js';

/** GET /projects/:id/tasks/:taskId */
export function taskRoute(req, res, url, parts, handle) {
  const sessionId = url.searchParams.get('sessionId') || undefined;
  return sendJson(res, 200, { ok: true, ...handle.query('task', { taskId: requireId(parts[3], 'tsk', 'taskId'), sessionId }) });
}
