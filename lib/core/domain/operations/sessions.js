// 会话审计的具名模型操作：只发布交接审计事件，不管理 attach/detach 生命周期。
// 会话身份取自可信 request.actor，不接受调用方在参数里替换。
import { BoardError } from '../../errors.js';

function assertFields(args, allowed) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new BoardError('invalid-command', 'operation arguments must be an object', { status: 400 });
  for (const key of Object.keys(args)) if (!allowed.includes(key)) throw new BoardError('invalid-command', 'unsupported session operation field: ' + key, { status: 400 });
}

function noteData(work, args, request) {
  assertFields(args, ['note', 'nextActions']);
  const sessionId = request?.actor?.sessionId;
  if (request?.actor?.kind !== 'agent' || typeof sessionId !== 'string' || sessionId === '') throw new BoardError('forbidden-role', 'session note requires an agent session', { status: 403 });
  const note = String(args.note || '').trim();
  if (note === '') throw new BoardError('invalid-command', 'note is required', { status: 400 });
  return {
    sessionId, projectId: work.state.project.id, note,
    nextActions: Array.isArray(args.nextActions) ? args.nextActions.map(String) : [],
    at: work.clock().toISOString(),
  };
}

export function checkpointSession(work, args, request) {
  return { events: [{ type: 'session/checkpoint', data: noteData(work, args, request) }] };
}

export function handoffSession(work, args, request) {
  return { events: [{ type: 'session/handoff', data: noteData(work, args, request) }] };
}

export const sessionOperations = Object.freeze({
  'session.recordCheckpoint': checkpointSession,
  'session.recordHandoff': handoffSession,
});
