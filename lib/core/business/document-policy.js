import { BoardError } from '../errors.js';
import { MANAGEMENT_STATES, transitionAllowed } from '../documents/external-model.js';

export function documentStatusDecision(doc, cmd) {
  if (cmd.status === undefined || cmd.status === doc.status) return null;
  if (!MANAGEMENT_STATES.includes(cmd.status)) throw new BoardError('invalid-command', 'status must be one of ' + MANAGEMENT_STATES.join(', '), { status: 400, details: null });
  if (!transitionAllowed(doc.status, cmd.status)) throw new BoardError('illegal-transition', 'doc status cannot move ' + doc.status + ' → ' + cmd.status, { status: 409, details: { from: doc.status, to: cmd.status } });
  const reason = typeof cmd.reason === 'string' ? cmd.reason.trim() : '';
  if (doc.status === 'archived' && reason === '') throw new BoardError('invalid-command', 'reopening an archived doc requires a reason', { status: 400, details: null });
  return { from: doc.status, to: cmd.status, reason: reason || null };
}
