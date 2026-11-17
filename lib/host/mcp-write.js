import { projectTools } from './mcp-tools.js';
import { agentContexts } from './agent-context.js';

const SECRET = /^[0-9a-f]{64}$/;

/** Authorization profile only. All business behavior belongs to agentTools. */
export function createMcpWrite(runtime, settings, env, readToken) {
  if (Object.getOwnPropertyDescriptor(settings ?? {}, 'enabled')?.value !== true) return null;
  const token = env.PROJECT_BOARD_MCP_WRITE_TOKEN;
  const ids = settings.projectIds;
  if (typeof token !== 'string' || !SECRET.test(token) || token === readToken
    || !Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string' || !/^prj_[0-9a-z]{1,124}$/.test(id))) {
    runtime.ctx?.logger?.warn?.('[project-board] MCP write disabled: distinct write credential and project allowlist required');
    return null;
  }
  let closed = false;
  const authority = {
    key: Symbol('mcp:full'), scope: 'full',
    active: () => !closed,
    allows: (id) => !closed && settings.enabled === true && settings.projectIds.includes(id),
  };
  const pending = new Set();
  const tools = projectTools(runtime, authority).map((tool) => ({
    ...tool,
    async run(args, options) {
      const request = tool.run(args, options);
      pending.add(request);
      try { return await request; } finally { pending.delete(request); }
    },
  }));
  let closing;
  return { token, tools, close() {
    closed = true;
    return closing ??= Promise.allSettled(pending).then(() => agentContexts(runtime).closeAuthority(authority.key));
  } };
}
