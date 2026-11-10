import { requireWebActor } from '../auth.js';
import { BoardError } from '../../core/errors.js';
import { readJson, sendJson } from '../util.js';

function assertCommandBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new BoardError('invalid-command', 'request body must be a JSON object', { status: 400 });
  }
  if (typeof body.op !== 'string' || body.op === '') {
    throw new BoardError('invalid-command', 'command op is required', { status: 400 });
  }
  return body;
}

/** POST /projects/:id/commands — the one write path for the web UI. */
export async function commandsRoute(req, res, projectId, service, authority) {
  const actor = requireWebActor(authority);
  const body = assertCommandBody(await readJson(req));
  const command = {
    ...body,
    projectId,
    cmdId: typeof body.cmdId === 'string' && body.cmdId !== '' ? body.cmdId : 'cmd_' + Math.random().toString(36).slice(2),
    actor,
  };
  const result = await service.command(projectId, command);
  return sendJson(res, 200, { ok: true, result });
}
