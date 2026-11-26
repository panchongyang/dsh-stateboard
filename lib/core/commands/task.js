import { taskGate, taskCreate, taskReady, taskUpdate } from './task-intake.js';
import { taskBegin, taskClaim, taskReject, taskRenew, taskSubmit, taskVerify } from './task-work.js';
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

// Public task handlers only describe the transaction they request.
export const TASK_HANDLERS = {
  'task.create': taskCreate,
  'task.update': taskUpdate,
  'task.gate': taskGate,
  'task.ready': taskReady,
  'task.claim': taskClaim,
  'task.begin': taskBegin,
  'task.renew': taskRenew,
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
