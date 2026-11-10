import { taskGate, taskCreate, taskReady, taskUpdate } from './task-intake.js';
import { taskBegin, taskClaim, taskReject, taskSubmit, taskVerify } from './task-work.js';
import { renewLease } from '../lease.js';
import {
  override,
  taskBlock,
  taskCancel,
  taskInterrupt,
  taskReconcile,
  taskRelease,
  taskReopen,
  taskUnblock,
} from './task-gov.js';

// The task command registry: op -> handler(handle, cmd). _execute in service.js
// consults this table before its remaining switch, so adding a task op means one
// row here and one entry in lib/shared COMMAND_OPS, never a new switch branch.
export const TASK_HANDLERS = {
  'task.create': taskCreate,
  'task.update': taskUpdate,
  'task.gate': taskGate,
  'task.ready': taskReady,
  'task.claim': taskClaim,
  'task.begin': taskBegin,
  'task.renew': renewLease,
  'task.submit': taskSubmit,
  'task.verify': taskVerify,
  'task.reject': taskReject,
  'task.block': taskBlock,
  'task.interrupt': taskInterrupt,
  'task.unblock': taskUnblock,
  'task.release': taskRelease,
  'task.reconcile': taskReconcile,
  'task.cancel': taskCancel,
  'task.reopen': taskReopen,
  override,
};
