// Command assembly is synchronous: only already materialized, serializable values leave this layer.
import { COMMAND_HANDLERS } from './index.js';
import { validateIntakeCommand } from '../command-shape.js';
import { BoardError } from '../errors.js';
import { durableValue } from '../transaction/values.js';

/** Only identity/CAS and named preparatory operations cross into the model. */
export function commandStart(cmd, session = {}) {
  if (!cmd || typeof cmd.op !== 'string') throw new BoardError('invalid-command', 'command op is required', { status: 400 });
  const { cmdId, actor, expected, taskId, fencingToken } = cmd;
  const header = { cmdId, actor, expected, taskId, fencingToken };
  if (cmd.authorized === true) header.authorized = true;
  const recovers = (cmd.op === 'task.interrupt' || cmd.op === 'task.reconcile') && typeof taskId === 'string' && taskId !== '';
  const args = recovers ? { recoverTaskId: taskId, deferDisposition: cmd.op === 'task.interrupt' } : {};
  const preparation = [{ kind: 'lease.normalizeBeforeCommand', args }];
  if (session.agentSessionSource) preparation.push({ kind: 'session.bindForCommand', args: { source: session.agentSessionSource } });
  else if (session.workSessionSource && (cmd.op === 'task.claim' || (cmd.op === 'task.reconcile' && cmd.choice === 'resume'))) {
    preparation.push({ kind: 'session.bindBeforeGrant', args: { source: session.workSessionSource } });
  }
  return { header, preparation };
}

export function assembleCommand(cmd, read) {
  const handler = Object.hasOwn(COMMAND_HANDLERS, cmd.op) && COMMAND_HANDLERS[cmd.op];
  if (!handler) throw new BoardError('invalid-command', 'unknown command op: ' + cmd.op, { status: 400 });
  validateIntakeCommand(cmd, read.state);
  const value = durableValue(handler(read, cmd));
  if (!value || !Array.isArray(value.operations) || Object.keys(value).some(k => !['operations', 'result', 'entityRev', 'warnings'].includes(k))) {
    throw new BoardError('invalid-command', 'command must produce operation values and response metadata only', { status: 400 });
  }
  return value;
}
