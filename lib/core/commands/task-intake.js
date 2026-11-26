// Intake handlers name the task fields they accept. Revision, readiness and
// history are model decisions, not writable fields in the command DTO.
import { assertTaskOpen } from '../domain/task-transitions.js';
import { gateDecision, metadataDecision } from '../business/task-policy.js';

function taskFields(cmd) {
  const { title, description, priority, weight, deps, acceptance, labels, requiresAudit } = cmd;
  return { title, description, priority, weight, deps, acceptance, labels, requiresAudit };
}

export function taskCreate(read, cmd) {
  return { operations: [{ kind: 'task.createStandalone', args: { ...taskFields(cmd), planRef: cmd.planRef || null } }] };
}

export function taskGate(read, cmd) {
  const task = read._requireTask(cmd);
  read._assertRev(task, cmd);
  assertTaskOpen(task);
  const changed = gateDecision(task, cmd.requiresAudit, cmd.actor);
  return { operations: changed ? [{ kind: 'task.changeAuditGate', args: { taskId: task.id, requiresAudit: cmd.requiresAudit } }] : [] };
}

export function taskUpdate(read, cmd) {
  const task = read._requireTask(cmd);
  read._assertRev(task, cmd);
  assertTaskOpen(task);
  const fields = taskFields(cmd);
  if (metadataDecision(task, fields, cmd.actor, Boolean(read._leaseOf(task.id)))) {
    read._assertLease(task, cmd, { allowHuman: true, requireToken: false });
  }
  return { operations: [{ kind: 'task.editMetadata', args: { taskId: task.id, ...fields, reason: cmd.reason } }] };
}

export function taskReady(read, cmd) {
  const task = read._requireTask(cmd);
  return { operations: [{ kind: 'task.promoteFromBacklog', args: { taskId: task.id } }] };
}
