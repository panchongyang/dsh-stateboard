/**
 * Compatibility entry point for the host tools.
 *
 * The implementations are split by domain under ./tools/ and the runtime
 * imports ./tools/index.js (see lib/index.js). This module stays as a stable
 * alias for compositions that still resolve lib/host/tools.js, and it carries
 * the static name -> module manifest so a rename is visible in one place
 * (test/contract-parity.test.mjs checks the names here; the registered surface
 * itself is frozen by test/fixtures/tool-schema.json).
 *
 *   name: 'project_board'   -> ./tools/board.js
 *   name: 'project_plan'    -> ./tools/plan.js
 *   name: 'project_task'    -> ./tools/task.js
 *   name: 'project_doc'     -> ./tools/doc.js
 *   name: 'project_session' -> ./tools/session.js
 */
import { TOOL_NAMES } from '../shared/contract.js';

export { registerTools } from './tools/index.js';

/** Tool name -> owning domain module, in registration order. */
export const TOOL_MANIFEST = [
  { name: 'project_board', module: './tools/board.js' },
  { name: 'project_plan', module: './tools/plan.js' },
  { name: 'project_task', module: './tools/task.js' },
  { name: 'project_doc', module: './tools/doc.js' },
  { name: 'project_session', module: './tools/session.js' },
];

// Fail loudly if the manifest and the shared contract drift apart.
if (TOOL_MANIFEST.some((entry, index) => entry.name !== TOOL_NAMES[index])) {
  throw new Error('lib/host/tools.js manifest drifted from lib/shared/contract.js TOOL_NAMES');
}
