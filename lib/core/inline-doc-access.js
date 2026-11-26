// Inline write admission runs on the persisted projection before acquiring a
// writer. Its command handler rechecks admission against the queued state.
import { BoardError } from './errors.js';
import { admitInlineWrite, validateInlineWriteShape } from './commands/doc.js';

export async function acquireInlineWriter(service, ref, cmd) {
  validateInlineWriteShape(cmd);
  const projectId = typeof ref === 'string' ? ref : projectForTool(service, ref.workspacePath, cmd.actor?.sessionId);
  const state = service.peekProjectState(projectId);
  // Admission must judge the *current* service policy. A shared writer from
  // another service instance may carry a different privilegedInlineWrites.
  if (state) admitInlineWrite(state, cmd, service.privilegedInlineWrites === true);
  return service._acquireCommandWriter(projectId);
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
