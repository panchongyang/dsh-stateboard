// Outbound observation ports belong to command assembly, not to a model operation.
import { createCommandPorts } from '../adapters/command-ports.js';
import { bindReadGuards } from '../domain/operation-context.js';
import { freezeValue, stateContainers } from './values.js';
import { newId } from '../util.js';

/** A command can observe facts and stage external content; it cannot alter transaction state. */
export function commandRead(sample, options) {
  const time = Date.parse(sample.at);
  const view = bindReadGuards({ state: sample.state, leases: sample.leases, rev: sample.rev,
    clock: () => new Date(time), newId: prefix => options.service.idgen?.(prefix) || newId(prefix), _lapsed: sample.lapsed, readOnly: false });
  // An unborn project has no I/O capabilities. Intake, draft creation and initial publish need only facts and IDs.
  return Object.freeze(options.store ? Object.assign(view, createCommandPorts({ ...options, work: view })) : view);
}

/** Compatibility reader for code constructing an explicit command preparation outside the bus. */
export function createWorkingContext(model, options) {
  return commandRead({ state: freezeValue(stateContainers(model.state)), leases: model.leases, rev: model.rev,
    at: options.clock().toISOString(), lapsed: null }, options);
}
