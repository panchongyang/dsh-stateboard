// The command registry: every op in COMMAND_OPS maps to handler(handle, cmd).
//
// Keys are kept in the exact order of lib/shared/contract.js COMMAND_OPS:
// `override` is hoisted out of TASK_HANDLERS so the doc/session ops can sit
// between the task ops and it. test/contract-parity.test.mjs asserts the key
// list, so a new op cannot be dispatched without being in the shared contract.

import { DOC_HANDLERS } from './doc.js';
import { DOC_EXTERNAL_HANDLERS } from './doc-external.js';
import { DOC_MIGRATION_HANDLERS } from './doc-migration.js';
import { PLAN_HANDLERS } from './plan.js';
import { PROJECT_HANDLERS } from './project.js';
import { SESSION_HANDLERS } from './session.js';
import { TASK_HANDLERS } from './task.js';

const { override, ...taskOps } = TASK_HANDLERS;

export const COMMAND_HANDLERS = {
  ...PROJECT_HANDLERS,
  ...PLAN_HANDLERS,
  ...taskOps,
  ...DOC_HANDLERS,
  ...DOC_EXTERNAL_HANDLERS,
  ...DOC_MIGRATION_HANDLERS,
  ...SESSION_HANDLERS,
  override,
};
