import { installPrompt, disposePrompt } from './prompt.js';

/** Best-effort attach: never let a project-store failure fail session creation. */
export async function attachAgent(runtime, agent, source) {
  if (!agent?.id || !agent?.session) return;
  const cwd = agent.session.header?.cwd;
  if (typeof cwd !== 'string' || cwd === '') return;
  try {
    await runtime.ready;
    const handle = await runtime.service.openByWorkspace(cwd);
    if (handle) {
      await handle.attach({ sessionId: agent.id, agentId: agent.id, source, role: 'worker' });
      runtime.sessionProjects.set(agent.id, handle);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.ctx.logger?.warn?.('[project-board] attach failed for ' + agent.id + ': ' + message);
  }
  // Install even without a project: publishing a plan later flips the section from '' to the digest.
  installPrompt(runtime, agent);
}

export async function detachAgent(runtime, agent) {
  const handle = runtime.sessionProjects.get(agent.id);
  runtime.sessionProjects.delete(agent.id);
  disposePrompt(runtime, agent);
  if (!handle) return;
  try {
    await handle.detach(agent.id, 'session-closed');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.ctx.logger?.warn?.('[project-board] detach failed for ' + agent.id + ': ' + message);
  }
}
