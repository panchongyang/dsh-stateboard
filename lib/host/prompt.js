import { applicationFor } from './application.js';

/**
 * Install the per-agent project digest as a late system-prompt section.
 * The section is dynamic: it reads the project's *published* value on every
 * assembly (pure synchronous projection) and contributes nothing when the
 * workspace has no project. It never opens, locks or touches a writer.
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
          const ref = runtime.sessionProjects.get(agent.id);
          if (!ref || !ref.projectId) return '';
          try {
            return applicationFor(runtime).capabilities.promptDigest(ref.projectId, agent.id);
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
