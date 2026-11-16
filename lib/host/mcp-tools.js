import { agentTools } from './tools/index.js';
import { mcpExecution } from './agent-context.js';

/** The transport changes only the envelope, never schema, validation or render. */
export function projectTools(runtime, authority) {
  return agentTools(runtime).map((definition) => ({
    name: definition.name,
    description: definition.description,
    inputSchema: definition.parameters,
    annotations: { readOnlyHint: ['search_project_knowledge', 'read_project_knowledge'].includes(definition.name), openWorldHint: false },
    format: 'agent',
    async run(args, { signal } = {}) {
      const value = await definition.execute(args, mcpExecution(authority, signal));
      return { content: definition.output.render(args, value) };
    },
  }));
}

export function projectReadTools(runtime) {
  return projectTools(runtime, { key: Symbol('mcp:metadata'), scope: 'metadata', allows: () => true });
}
