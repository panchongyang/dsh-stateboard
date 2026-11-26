// Shared value guards have no write capability; only the model adds lease transitions.
import * as lease from '../lease.js';

export function bindReadGuards(value) {
  const guards = { _requireTask: 'requireTask', _assertRev: 'assertRev', _nowMs: 'nowMs', _leaseOf: 'leaseOf',
    _assigneeResumeDenial: 'assigneeResumeDenial', _assertLease: 'assertLease', _assertClaimAllowed: 'assertClaimAllowed',
    _assertPlanActive: 'assertPlanActive' };
  for (const [key, name] of Object.entries(guards)) value[key] = (...args) => lease[name](value, ...args);
  Object.defineProperties(value, { id: { get: () => value.state.project.id }, workspacePath: { get: () => value.state.project.workspacePath } });
  return value;
}

/** This context is passed only to registered model operations. It cannot perform physical I/O. */
export function privateOperationContext(model, state, leases, io) {
  const time = io.clock().getTime();
  const context = bindReadGuards({ state, leases, rev: model.rev, readOnly: Boolean(io.readOnly), historicalAcceptance: io.historicalAcceptance, _lapsed: null,
    privilegedInlineWrites: io.privilegedInlineWrites === true,
    clock: () => new Date(time), newId: io.newId, scratch: new Map(), bindingUpdates: new Map() });
  context._grantLease = (...args) => lease.grantLease(context, ...args);
  context._renewLease = request => lease.renewLease(context, request);
  context._markLeaseProgress = taskId => lease.markLeaseProgress(context, taskId);
  context.setRuntimeBinding = (id, binding) => {
    context.bindingUpdates.set(id, structuredClone(binding));
    context.state.bindings[id] = structuredClone(binding);
  };
  return context;
}
