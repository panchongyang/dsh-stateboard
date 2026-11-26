import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { ProjectService } from './core/service.js';
import { createHostReader } from './host/reader.js';
import { registerTools } from './host/tools/index.js';
import { registerRoutes } from './host/routes.js';
import { attachAgent, detachAgent } from './host/lifecycle.js';
import { mountProjectMcp } from './host/mcp.js';
import { createSpaceRuntime } from './host/space-runtime.js';

export const name = 'project-board';
export const inject = ['tools', 'systemPrompt', 'agents', 'sessions'];

function defaultRoot() {
  return path.join(resolveDshHome(), 'project-board');
}

/**
 * ProjectBoard host half: durable cross-session project state (tasks, plans,
 * documents, evidence, leases) plus the model-facing tools and the Web API the
 * kanban client uses. The state machine lives in lib/core and is independent of
 * this adapter.
 */
export function apply(ctx, config = {}) {
  const layout = Object.getOwnPropertyDescriptor(config ?? {}, 'storageLayout')?.value;
  if (layout !== undefined && layout !== 'space' && layout !== 'legacy') throw new TypeError('Unknown board storage layout');
  const spaces = layout === 'space' ? createSpaceRuntime(ctx) : null;
  const rootDir = spaces ? null : (typeof config?.rootDir === 'string' && config.rootDir !== '' ? config.rootDir : defaultRoot());
  const runtime = {
    ctx,
    rootDir,
    spaces, service: spaces ? null : new ProjectService({ rootDir }),
    // One reader for every ingress; the plugin owns its lifecycle.
    reader: null,
    ready: null,
    token: randomBytes(24).toString('hex'),
    sessionProjects: new Map(),
    sessionProjectRefs: new Map(),
    promptFibers: new Map(),
  };

  if (runtime.service) runtime.reader = createHostReader(runtime.service);
  runtime.ready = runtime.service?.init() ?? Promise.resolve();
  runtime.ready.catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger?.warn?.('[project-board] init failed: ' + message);
  });

  registerTools(ctx, runtime);

  // The web server is optional (headless compositions still get the tools).
  // Wait for the service instead of reading it eagerly: on a cold start the
  // web server may not be mounted yet, and ctx.get('webServer') would be
  // undefined, silently skipping both the API routes and the token injection.
  const mountRoutes = (webCtx) => {
    if (spaces) return; // These legacy HTTP routes have no trusted owning space.
    try {
      const disposeRoutes = registerRoutes(webCtx, runtime);
      if (disposeRoutes) {
        webCtx.effect(() => disposeRoutes, 'project-board.routes()');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      webCtx.logger?.warn?.('[project-board] routes unavailable: ' + message);
    }
  };
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], mountRoutes);
  } else if (ctx.get('webServer')) {
    // White-box/preflight contexts may not implement Cordis inject.
    mountRoutes(ctx);
  }

  ctx.on('agent/created', async ({ agent, source }) => {
    await attachAgent(runtime, agent, source);
  });

  ctx.on('agent/disposed', ({ agent }) => {
    detachAgent(runtime, agent).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger?.warn?.('[project-board] detach failed: ' + message);
    });
  });

  try {
    for (const agent of ctx.agents.list()) {
      attachAgent(runtime, agent, 'startup').catch(() => {});
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger?.warn?.('[project-board] existing-agent attach failed: ' + message);
  }

  const stopMcp = mountProjectMcp(runtime, Object.getOwnPropertyDescriptor(config ?? {}, 'mcp')?.value);
  ctx.effect(() => async () => {
    try { await stopMcp?.(); } finally {
      if (spaces) await spaces.close();
      else try { await runtime.reader.close(); } finally { await runtime.service.close(); }
    }
  }, 'project-board.close()');
  ctx.logger?.info?.('[project-board] ready · ' + (spaces ? 'owning space' : 'root=' + rootDir));
}
