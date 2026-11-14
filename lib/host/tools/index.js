// Host tools, one module per domain. Registration order is the order the model
// sees; it is frozen by test/fixtures/tool-schema.json.
import { register as registerBoard } from './board.js';
import { register as registerDoc } from './doc.js';
import { register as registerPlan } from './plan.js';
import { register as registerSession } from './session.js';
import { register as registerTask } from './task.js';
import { register as registerKnowledge } from './knowledge.js';

const REGISTRARS = [registerBoard, registerPlan, registerTask, registerDoc, registerSession, registerKnowledge];

export function registerTools(ctx, runtime) {
  for (const register of REGISTRARS) register(ctx, runtime);
}
