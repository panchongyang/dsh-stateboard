// @ts-check
// Independent expectations transcribed from CONTRACT §2.4/2.6 and DESIGN T3–T15.
// No production guards, transition tables, returned events or snapshots are used.
export const STATES = ['backlog', 'ready', 'in_progress', 'review', 'blocked', 'interrupted', 'done', 'canceled'];
export const OPS = ['block', 'unblock', 'release', 'cancel', 'reject', 'override', 'interrupt', 'reconcile', 'claim', 'begin', 'submit'];
export const SETTLERS = ['block', 'release', 'cancel', 'reject', 'override'];
const deny = (error) => ({ error });
const allow = (state, ...events) => ({ state, events });
const terminal = (state) => ['done', 'canceled'].includes(state);

function leaseGuard(row) {
  if (row.lease === 'none' || row.lease === 'expired') return 'lease-expired';
  if (row.token !== 'correct') return 'fencing-stale';
  if (row.foreign && row.kind !== 'human') return 'lease-held';
  return null;
}

export function oracle(row) {
  const { op, state, kind, open, revision = 'current' } = row;
  const human = kind === 'human';
  const leased = row.lease === 'live' || row.lease === 'grace';
  // Explicit ordering cases: claim tests lease before entity CAS; override tests
  // human role before CAS. Other commands in this matrix check entity CAS first.
  if (op === 'override' && !human) return deny('forbidden-role');
  if (op === 'claim' && leased) return deny('lease-held');
  if (revision !== 'current') return deny('stale-revision');
  if (op === 'claim') return state === 'ready'
    ? allow('in_progress', 'lease/granted', 'task/claimed') : deny('illegal-transition');
  if (['begin', 'submit', 'release'].includes(op)) {
    const error = leaseGuard(row);
    if (error) return deny(error);
    if (state !== 'in_progress') return deny('illegal-transition');
  }
  if (op === 'begin') return open ? deny('illegal-transition') : allow(state, 'work/intent', 'task/updated');
  if (op === 'submit') return open ? allow('review', 'work/result', 'task/submitted') : deny('illegal-transition');
  if (op === 'block') {
    if (!['in_progress', 'review'].includes(state)) return deny('illegal-transition');
    if (!human && !leased) return deny('forbidden-role');
    if (!human && leaseGuard(row)) return deny(leaseGuard(row));
  }
  if (op === 'reject') {
    if (state !== 'review') return deny('illegal-transition');
    if (!human && leased && row.foreign) return deny('forbidden-role');
    if (!human && leased && leaseGuard(row)) return deny(leaseGuard(row));
  }
  if (op === 'cancel') {
    if (terminal(state)) return deny('illegal-transition');
    if (!human && row.gated) return deny('forbidden-role');
    if (!human && leased && row.foreign) return deny('forbidden-role');
    if (!human && leased && leaseGuard(row)) return deny(leaseGuard(row));
  }
  if (SETTLERS.includes(op)) return settlementResult(row, leased);
  if (op === 'unblock') {
    if (state !== 'blocked') return deny('illegal-transition');
    if (open) return deny('intent-unresolved');
    return allow(row.resumeTo === 'review' ? 'review' : 'ready', 'task/unblocked', 'task/assignment');
  }
  if (op === 'interrupt') {
    if (state === 'interrupted' || terminal(state)) return deny('illegal-transition');
    if (state !== 'in_progress' && !(human && open)) return deny('illegal-transition');
    if (!human && leaseGuard(row)) return deny(leaseGuard(row));
    return allow('interrupted', ...(leased ? ['lease/revoked'] : []), 'task/interrupted');
  }
  if (op === 'reconcile') {
    if (state !== 'interrupted') return deny('illegal-transition');
    const choice = row.choice || 'discard';
    if (choice === 'resume') return allow('in_progress', ...(open ? ['work/abandoned'] : []), 'lease/granted', 'work/intent', 'task/reconciled');
    if (choice === 'completed') return allow('review', ...(open ? ['work/result'] : []), 'task/reconciled');
    return allow('ready', ...(open ? ['work/abandoned'] : []), 'task/reconciled');
  }
  throw new Error('uncovered oracle operation ' + op);
}

function settlementResult(row, leased) {
  const { op, open } = row;
  const settlement = row.settlement || (open ? 'stopped' : 'absent');
  if (!open && settlement !== 'absent') return deny('invalid-command');
  if (open && ['absent', 'unknown', 'invalid-outcome'].includes(settlement)) return deny('intent-unresolved');
  if (open && !['stopped', 'effects', 'limit50'].includes(settlement)) return deny('invalid-command');
  const events = open ? ['work/abandoned'] : [];
  if (op !== 'reject' && leased) events.push('lease/revoked');
  if (op === 'override') return allow('ready', ...events, 'task/updated', 'override/applied');
  if (op === 'reject') return allow(leased ? 'in_progress' : 'ready', ...events, 'task/rejected', 'task/assignment');
  const targets = { block: 'blocked', release: 'ready', cancel: 'canceled' };
  const verbs = { block: 'blocked', release: 'released', cancel: 'canceled' };
  return allow(targets[op], ...events, 'task/' + verbs[op]);
}

export function settlementPayload(name) {
  const entry = { kind: 'file', ref: 'artifact.txt', note: 'synthetic declaration', hash: 'a'.repeat(64) };
  const values = {
    absent: undefined, stopped: { outcome: 'stopped', sideEffects: [] },
    unknown: { outcome: 'unknown', sideEffects: [] }, 'invalid-outcome': { outcome: 'rollback', sideEffects: [] },
    'missing-effects': { outcome: 'stopped' }, effects: { outcome: 'stopped', sideEffects: [entry] },
    limit50: { outcome: 'stopped', sideEffects: Array(50).fill(entry) },
    limit51: { outcome: 'stopped', sideEffects: Array(51).fill(entry) },
    'bad-kind': { outcome: 'stopped', sideEffects: [{ kind: 'invalid', ref: 'x' }] },
    'bad-ref': { outcome: 'stopped', sideEffects: [{ kind: 'other', ref: '' }] },
    'bad-hash': { outcome: 'stopped', sideEffects: [{ ...entry, hash: 'bad' }] },
    'over-bytes': { outcome: 'stopped', sideEffects: Array(20).fill({ kind: 'other', ref: 'x'.repeat(1000) }) },
  };
  if (!Object.hasOwn(values, name)) throw new Error('unknown settlement ' + name);
  return structuredClone(values[name]);
}
