// Offline adapter submits only a named model operation, never state or raw events.
import { newId } from '../util.js';
export { validateAcceptanceRepair } from '../domain/operations/lifecycle.js';

// Caller retains the writer lock and canonical serial section for the inventory CAS.
export function restoreHistoricalAcceptance(model, request, ports) {
  const result = model.lifecycle({ actor: { kind: 'system', via: 'repair' },
    cmdId: 'cmd_repair_acceptance_' + newId('x') }, [{ kind: 'lifecycle.restoreAcceptance', args: request }], ports);
  return result.committed ? { seq: result.projectRev, hash: model.lastHash, count: result.count } : null;
}
