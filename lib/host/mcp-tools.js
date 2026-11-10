import { BoardError } from '../core/errors.js';
import { MCP_READ_TOOLS, PROJECT_READ_ID_PATTERNS, PROJECT_READ_PAGE_DEFAULT, PROJECT_READ_PAGE_MAX, TASK_STATES } from '../shared/contract.js';

const projectId = { type: 'string', pattern: PROJECT_READ_ID_PATTERNS.project };
const taskId = { type: 'string', pattern: PROJECT_READ_ID_PATTERNS.task };
const limit = { type: 'integer', minimum: 1, maximum: PROJECT_READ_PAGE_MAX, default: PROJECT_READ_PAGE_DEFAULT };

function readTool(name, description, properties, required, read) {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run(args) {
      if (Object.keys(args).some((key) => !Object.hasOwn(properties, key))) {
        throw new BoardError('invalid-command', 'unexpected arguments for ' + name, { status: 400 });
      }
      return read(args);
    },
  };
}

export function projectReadTools(reader) {
  return [
    readTool(MCP_READ_TOOLS.listProjects, 'List registered ProjectBoard projects. Use nextCursor as after for the next page.',
      { limit, after: projectId }, [], (args) => reader.listProjects(args)),
    readTool(MCP_READ_TOOLS.listTasks, 'List task summaries from the board. Use nextCursor as after for the next page.',
      { projectId, state: { type: 'string', enum: TASK_STATES }, limit, after: taskId }, ['projectId'], (args) => reader.listTasks(args)),
    readTool(MCP_READ_TOOLS.getTask, 'Read task details and acceptance criteria from the board.',
      { projectId, taskId }, ['projectId', 'taskId'], (args) => reader.getTask(args)),
  ];
}
