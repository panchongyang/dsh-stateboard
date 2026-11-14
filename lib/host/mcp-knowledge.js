import { KNOWLEDGE_DESCRIPTIONS, KNOWLEDGE_INPUTS, KNOWLEDGE_TOOLS } from '../shared/knowledge.js';

// 用途：MCP 只追加入口身份/认证，业务 schema、来源和预算与 DSH 共用。
export function knowledgeTools({ tool, projectId, sessionToken, authenticated, reader }) {
  return Object.entries(KNOWLEDGE_TOOLS).map(([operation, name]) => {
    const input = KNOWLEDGE_INPUTS[operation];
    const schema = { ...input, properties: { projectId, sessionToken, ...input.properties },
      required: ['projectId', 'sessionToken', ...input.required] };
    return tool(name, KNOWLEDGE_DESCRIPTIONS[operation], schema, ({ sessionToken, ...args }) => {
      authenticated(args.projectId, sessionToken);
      return reader[operation + 'Knowledge'](args);
    }, true);
  });
}
