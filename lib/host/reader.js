// Single assembly point for the plugin's read port. Every ingress and every
// lifecycle surface shares one reader instance, including the task-hint
// provider, so hot task/task_detail reads agree on allowedOps and never fall
// back to a hintless projection.
import { createProjectReader } from '../core/project-reader.js';
import { taskHints } from '../core/application/task-hints.js';

export function createHostReader(service) {
  return createProjectReader(service, { taskHints });
}
