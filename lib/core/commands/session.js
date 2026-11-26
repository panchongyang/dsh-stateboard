// Public session commands assemble model operation requests only.

export function sessionNote(read, cmd, kind) {
  return { operations: [{ kind, args: { note: cmd.note, nextActions: cmd.nextActions } }] };
}

export function sessionCheckpoint(read, cmd) {
  return sessionNote(read, cmd, 'session.recordCheckpoint');
}

export function sessionHandoff(read, cmd) {
  return sessionNote(read, cmd, 'session.recordHandoff');
}

export const SESSION_HANDLERS = {
  'session.checkpoint': sessionCheckpoint,
  'session.handoff': sessionHandoff,
};
