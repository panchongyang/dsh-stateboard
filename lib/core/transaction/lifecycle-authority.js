// An actor describes attribution; it does not confer the ability to send a lifecycle signal.
import { BoardError } from '../errors.js';

const grants = new WeakMap();
const repair = 'lifecycle.restoreAcceptance';
function forbidden() { throw new BoardError('forbidden-role', 'a scoped lifecycle or offline maintenance capability is required', { status: 403 }); }

function grant(ports, mode) {
  const capability = Object.freeze({ ...ports });
  grants.set(capability, { mode, model: ports.medium.model });
  return capability;
}

/** Ordinary command ports are deliberately not accepted by the standalone signal path. */
export function lifecyclePorts(ports) { return grant(ports, 'signal'); }

/** Called only for the service which owns the exclusive offline maintenance window. */
export function acceptanceRepairPorts(ports, service) {
  if (service.offlineMaintenance !== true) forbidden();
  return grant(ports, 'repair');
}

export function takeLifecycleAuthority(ports, model, actor, operations) {
  const scope = grants.get(ports);
  grants.delete(ports);
  if (!scope || scope.model !== model || ports.medium.model !== model) forbidden();
  if (!Array.isArray(operations) || operations.length !== 1) throw new BoardError('invalid-command', 'expected one lifecycle operation', { status: 400 });
  const kind = operations[0]?.kind;
  if ((kind === repair) !== (scope.mode === 'repair')) forbidden();
  // An explicitly created project attributes genesis to its authenticated creator.
  // Remotely supplied actor data never authorizes an attach, activity, recovery or repair.
  if (kind !== 'lifecycle.bootstrap' && actor?.kind !== 'system') forbidden();
}
