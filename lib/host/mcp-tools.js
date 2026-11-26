import { agentTools } from './tools/index.js';
import { mcpExecution } from './agent-context.js';
import { knowledgeMcpTool } from '../shared/knowledge.js';

/** The transport changes only the envelope, never schema, validation or render. */
export function projectTools(runtime, fixedAuthority) {
  return agentTools(runtime).map((definition) => ({
    name: definition.name,
    description: definition.description,
    inputSchema: definition.parameters,
    annotations: { readOnlyHint: knowledgeMcpTool(definition.name), openWorldHint: false },
    format: 'agent',
    async run(args, { signal, authority, knowledgeJson = false } = {}) {
      const value = await definition.execute(args, mcpExecution(fixedAuthority ?? authority, signal));
      return { content: knowledgeJson && knowledgeMcpTool(definition.name)
        ? [{ type: 'text', text: JSON.stringify(value) }]
        : definition.output.render(args, value) };
    },
  }));
}

export function projectReadTools(runtime) {
  return projectTools(runtime, { key: Symbol('mcp:metadata'), scope: 'metadata', allows: () => true });
}
