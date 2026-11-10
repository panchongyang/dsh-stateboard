/**
 * Install the per-agent project digest as a late system-prompt section.
 * The section is dynamic: it reads the agent's current project handle at every
 * assembly, and contributes nothing when the workspace has no project.
 *
 * `interpolate: false` is part of the plugin/host contract, not a character
 * patch: board text is data, so the host must not resolve `{{...}}` in it.
 */
export function installPrompt(runtime, agent) {
  if (runtime.promptFibers.has(agent.id)) return;
  try {
    const fiber = agent.ctx.inject(['systemPrompt'], (scope) => {
      return scope.systemPrompt.section({
        name: 'project:brief',
        order: 9000,
        interpolate: false,
        text: () => {
          const handle = runtime.sessionProjects.get(agent.id);
          if (!handle || handle.closed) return '';
          try {
            return handle.digest(agent.id);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            runtime.ctx.logger?.warn?.('[project-board] digest failed: ' + message);
            return '';
          }
        },
      });
    });
    runtime.promptFibers.set(agent.id, fiber);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.ctx.logger?.warn?.('[project-board] prompt install failed: ' + message);
  }
}

export function disposePrompt(runtime, agent) {
  const fiber = runtime.promptFibers.get(agent.id);
  if (!fiber) return;
  runtime.promptFibers.delete(agent.id);
  Promise.resolve(fiber.dispose?.()).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    runtime.ctx.logger?.warn?.('[project-board] prompt dispose failed: ' + message);
  });
}
