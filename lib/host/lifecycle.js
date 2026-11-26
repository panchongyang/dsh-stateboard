import { installPrompt, disposePrompt } from './prompt.js';
import { trackProject } from './tools/shared.js';
import { applicationFor } from './application.js';

/**
 * Lifecycle attach: a write capability that records the session on the project.
 * It returns a value reference; the plugin never parks a writer on the runtime.
 */
export async function attachAgent(runtime, agent, source) {
  if (!agent?.id || !agent?.session) return;
  if (runtime.spaces) {
    try { await runtime.spaces.use({ agent }, local => attachAgent(local, agent, source)); }
    catch { runtime.ctx.logger?.warn?.('[project-board] attach skipped: owning space unavailable'); }
    return;
  }
  const cwd = agent.session.header?.cwd;
  if (typeof cwd !== 'string' || cwd === '') return;
  try {
    await runtime.ready;
    const ref = await applicationFor(runtime).capabilities.ensureAgentProject({
      workspacePath: cwd, sessionId: agent.id, agentId: agent.id, source,
    });
    if (ref) trackProject(runtime, agent.id, ref);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.ctx.logger?.warn?.('[project-board] attach failed for ' + agent.id + ': ' + message);
  }
  // Install even without a project: publishing a plan later flips the section from '' to the digest.
  installPrompt(runtime, agent);
}

export async function detachAgent(runtime, agent) {
  if (runtime.spaces) return runtime.spaces.use({ agent }, local => detachAgent(local, agent), { existingOnly: true });
  const refs = new Set(runtime.sessionProjectRefs?.get(agent.id) ?? []);
  const current = runtime.sessionProjects.get(agent.id);
  if (current?.projectId) refs.add(current.projectId);
  runtime.sessionProjects.delete(agent.id);
  runtime.sessionProjectRefs?.delete(agent.id);
  runtime.agentContexts?.dropNative(agent.id);
  disposePrompt(runtime, agent);
  const application = applicationFor(runtime);
  for (const projectId of refs) {
    try {
      await application.capabilities.detachAgentSession({ projectId, sessionId: agent.id, reason: 'session-closed' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runtime.ctx.logger?.warn?.('[project-board] detach failed for ' + agent.id + ': ' + message);
    }
  }
}
