import { requireWebActor } from '../auth.js';
import { BoardError } from '../../core/errors.js';
import { readJson, sendJson } from '../util.js';
import { methodNotAllowed, summaryOf } from './shared.js';

/** /projects — list every registered project, or create one from the UI. */
export async function projectsRoute(req, res, runtime, method, authority) {
  if (method === 'GET') {
    const projects = await runtime.service.listProjectsAsync();
    return sendJson(res, 200, { ok: true, projects });
  }
  if (method === 'POST') {
    const actor = requireWebActor(authority);
    const body = await readJson(req);
    if (typeof body.workspacePath !== 'string' || body.workspacePath === '') {
      throw new BoardError('invalid-command', 'workspacePath is required', { status: 400 });
    }
    const handle = await runtime.service.createProject({
      workspacePath: body.workspacePath,
      name: typeof body.name === 'string' && body.name !== '' ? body.name : undefined,
      actor,
    });
    return sendJson(res, 200, { ok: true, project: summaryOf(handle) });
  }
  return methodNotAllowed(res, method);
}
