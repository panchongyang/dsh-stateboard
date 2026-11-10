// Inline write admission runs on the persisted projection before acquiring a
// writer. Its command handler rechecks admission against the queued state.
import { BoardError } from './errors.js';
import { admitInlineWrite, validateInlineWriteShape } from './commands/doc.js';

export async function acquireInlineWriter(service, ref, cmd) {
  validateInlineWriteShape(cmd);
  const projectId = typeof ref === 'string' ? ref : projectForTool(service, ref.workspacePath, cmd.actor?.sessionId);
  const state = service.peekProjectState(projectId);
  if (state) admitInlineWrite(state, cmd);
  return service.open(projectId);
}

function projectForTool(service, workspacePath, sessionId) {
  if (!sessionId) throw new BoardError('forbidden-role', 'project tools require an owning agent session', { status: 403 });
  if (typeof workspacePath !== 'string' || workspacePath === '') {
    throw new BoardError('invalid-command', 'the session has no working directory', { status: 400 });
  }
  const found = service.resolveWorkspace(workspacePath);
  if (!found) {
    throw new BoardError('not-found', 'No ProjectBoard project exists for this workspace yet. Call project_plan with op=publish first.', { status: 404 });
  }
  return found.projectId;
}

/** Run an inline tool command and notify host session tracking after acquisition. */
export async function writeInlineDocumentByWorkspace(service, workspacePath, cmd, trackSessionProject) {
  const handle = await acquireInlineWriter(service, { workspacePath }, cmd);
  handle.touch(cmd.actor.sessionId);
  trackSessionProject(handle);
  const result = await handle.command(cmd);
  const docId = cmd.docId || result.events.find((event) => event.type === 'doc/created')?.docId;
  const doc = docId ? structuredClone(handle.query('doc', { docId, maxBytes: 0 }).doc) : null;
  return { projectId: handle.id, result, doc };
}
