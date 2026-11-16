import { installPrompt, disposePrompt } from './prompt.js';
import { trackHandle } from './tools/shared.js';

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
      trackHandle(runtime, agent.id, handle);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.ctx.logger?.warn?.('[project-board] attach failed for ' + agent.id + ': ' + message);
  }
  // Install even without a project: publishing a plan later flips the section from '' to the digest.
  installPrompt(runtime, agent);
}

export async function detachAgent(runtime, agent) {
  const handles = new Set(runtime.sessionHandles?.get(agent.id) ?? []);
  const handle = runtime.sessionProjects.get(agent.id);
  if (handle) handles.add(handle);
  runtime.sessionProjects.delete(agent.id);
  runtime.sessionHandles?.delete(agent.id);
  runtime.agentContexts?.dropNative(agent.id);
  disposePrompt(runtime, agent);
  for (const project of handles) {
    try {
      await project.detach(agent.id, 'session-closed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runtime.ctx.logger?.warn?.('[project-board] detach failed for ' + agent.id + ': ' + message);
    }
  }
}
