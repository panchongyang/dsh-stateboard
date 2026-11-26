// All per-project writers share the ordering, not each other's service authority.
import { assembleCommand, commandStart } from '../commands/transaction.js';
import { projectCommandWindow } from '../business/project-command-policy.js';
import { commandRead } from '../transaction/work.js';
import { durableValue, freezeValue } from '../transaction/values.js';
import { TransactionModel } from '../transaction/model.js';
import { emptyState } from '../model.js';
import { actorSystem } from '../normalize.js';
import { newId } from '../util.js';
import { BoardError } from '../errors.js';

const initialCommands = new WeakMap();
const queues = new WeakMap();
export function serializeProject(model, action) {
  const previous = queues.get(model) ?? Promise.resolve();
  const job = previous.then(action);
  queues.set(model, job.then(() => undefined, () => undefined));
  return job;
}

/** No await between the model sample, read-only command assembly and value-only submission. */
export function runCommand(handle, service, request, session, preview = false) {
  const model = handle.model;
  const ports = handle._transactionPorts(service);
  const { header, preparation } = commandStart(request, session);
  // 这是物理 writer 代次的重启事实，不来自 DTO，也不是由单个任务缺租约推断的。
  const restartPending = !handle.recovered;
  if (restartPending && model.state.project.phase !== 'archived') {
    ports.restartRecovery = true;
    preparation.splice(1, 0, { kind: 'lifecycle.recoverBeforeCommand' });
  }
  const { sample, receipt } = model.beginCommand(header, preparation, ports);
  if (receipt) return preview ? true : receipt;
  try {
    const before = model.state.project;
    const unarchive = projectCommandWindow(before, request);
    const descriptor = assembleCommand(request, commandRead(sample, { service, store: handle.store, preview }));
    if (preview) return model.previewOperations(sample, descriptor.operations);
    const result = model.submitOperations(sample, descriptor.operations);
    const warnings = [];
    if (result.committed) {
      const to = model.state.project.workspacePath;
      if (to !== before.workspacePath) handle._applyRelocateSafe({ from: before.workspacePath, to }, warnings);
      if (restartPending || unarchive) {
        handle.recovered = true;
        if (to === before.workspacePath) service._healMeta(handle);
      }
    }
    return commandReceipt(descriptor, result, warnings);
  } finally { model.discardCommand(sample); }
}

function commandReceipt(descriptor, result, extraWarnings = []) {
  const warnings = [...(descriptor.warnings ?? []), ...(result.warnings ?? []), ...extraWarnings];
  return { ...descriptor.result, ...(descriptor.entityRev !== undefined ? { entityRev: descriptor.entityRev } : {}), ...result,
    ...(warnings.length ? { warnings } : {}) };
}

/** No registry, directory, lock, store, blob or host binding is needed to decide the first command. */
export function prepareFirstCommand(service, meta, input, session = {}) {
  service._assertOpen();
  const request = freezeValue(durableValue(input));
  if (request.op !== 'task.create' && request.op !== 'plan.create' && !(request.op === 'plan.publish' && request.createIfMissing === true && !request.planId)) {
    throw new BoardError('invalid-command', 'operation cannot create a project', { status: 400 });
  }
  const model = new TransactionModel({ state: emptyState(meta.project) });
  const { header, preparation } = commandStart(request, session);
  const ports = { clock: service.clock, systemActor: actorSystem(), newId: prefix => service.idgen?.(prefix) || newId(prefix) };
  const { sample } = model.beginFirstCommand(header, preparation, ports);
  try {
    const descriptor = assembleCommand(request, commandRead(sample, { service }));
    const ticket = model.prepareFirstOperations(sample, descriptor.operations);
    initialCommands.set(ticket, { service, result: descriptor.result, entityRev: descriptor.entityRev, warnings: descriptor.warnings });
    return ticket;
  } finally { model.discardCommand(sample); }
}

/** One synchronous append to the reserved writer. Never reassemble or repeat an external observation here. */
export function commitFirstCommand(handle, ticket) {
  const frame = initialCommands.get(ticket);
  initialCommands.delete(ticket);
  if (!frame || frame.service !== handle.service) throw new BoardError('invalid-command', 'unknown initial command', { status: 400 });
  const result = handle.model.commitFirst(ticket, handle._transactionPorts(frame.service));
  return commandReceipt(frame, result);
}
