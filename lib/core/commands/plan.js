// Plan command registry: op -> handler(handle, cmd).
//
// plan-life.js owns the plan lifecycle (create/publish/revise/rename/archive/
// unarchive/focus) plus the shared guards; plan-members.js owns adopt/release.
// They are split so each file stays under the 450-line audit limit.

import {
  planArchive,
  planCreate,
  planFocus,
  planPublish,
  planRename,
  planRevise,
  planUnarchive,
} from './plan-life.js';
import { planAdopt, planRelease } from './plan-members.js';

export const PLAN_HANDLERS = {
  'plan.create': planCreate,
  'plan.publish': planPublish,
  'plan.revise': planRevise,
  'plan.adopt': planAdopt,
  'plan.release': planRelease,
  'plan.rename': planRename,
  'plan.archive': planArchive,
  'plan.unarchive': planUnarchive,
  'plan.focus': planFocus,
};
