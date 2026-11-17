// Compatibility module path: the knowledge tools are part of the same seven
// definitions. This module owns no schema, authentication or reader behavior.
import { projectTools } from './mcp-tools.js';

export function knowledgeTools(runtime, authority) {
  return projectTools(runtime, authority).filter(({ name }) => name === 'search_project_knowledge' || name === 'read_project_knowledge');
}
