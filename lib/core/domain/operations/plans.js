// Only these named transitions are callable by the model transaction engine.
import * as life from './plans-life.js';
import * as tasks from './plans-tasks.js';
export { assertPlanOperationBatch, assertPlanOperationCompletion } from './plans-invariants.js';

export const PLAN_OPERATIONS = Object.freeze({
  'plans.createDraft': life.createDraft,
  'plans.editDraft': life.editDraft,
  'plans.publishVersion': life.publishVersion,
  'plans.reviseVersion': life.reviseVersion,
  'plans.rename': life.rename,
  'plans.archive': life.archive,
  'plans.unarchive': life.unarchive,
  'plans.focus': life.focus,
  'plans.autoFocus': life.autoFocus,
  'plans.createTask': tasks.createTask,
  'plans.reviseTask': tasks.reviseTask,
  'plans.orphanTask': tasks.orphanTask,
  'plans.addMembers': tasks.addMembers,
  'plans.removeMembers': tasks.removeMembers,
  'plans.assignTask': tasks.assignTask,
  'plans.releaseTask': tasks.releaseTask,
});
