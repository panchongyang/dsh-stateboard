/**
 * Event compatibility contract.
 *
 * This table is the single source of truth for "can this build read that log?".
 * docs/CONTRACT.md §2.9.1 defines the semantics; this file enumerates the types for
 * normal replay and strict salvage/repair validation.
 *
 * Classes:
 *   applied    this build understands the event and projects it into state.
 *   additive   this build does not need it. The same commit carries the full
 *              state in a known event (e.g. task/updated), so ignoring it cannot
 *              change the projected state. Readers may treat it as a no-op.
 *   migration  the event changes meaning this build cannot derive; the store
 *              must be migrated before it can be opened.
 *
 * Anything not listed here is `refuse`: a reader that does not know an event
 * must not guess. Refusing to open is safer than silently projecting a wrong
 * state (ownership, state machine), and it is what makes down-switches explicit.
 *
 * Adding a type:
 *   1. pick the weakest class that is provably correct (prefer applied);
 *   2. additive requires a companion event in the same commit that carries the
 *      full state — prove it with a test;
 *   3. anything else defaults to refuse, which blocks old readers; ship a
 *      migration or accept that rolling back needs a pre-switch snapshot.
 */
export const EVENT_REGISTRY = Object.freeze({
  'project/created': 'applied',
  'project/updated': 'applied',

  'plan/created': 'applied',
  'plan/updated': 'applied',
  'plan/published': 'applied',
  'plan/revised': 'applied',
  'plan/archived': 'applied',
  'plan/unarchived': 'applied',
  'plan/focused': 'applied',
  'plan/superseded': 'applied',

  'task/created': 'applied',
  'task/updated': 'applied',
  'task/readied': 'applied',
  'task/claimed': 'applied',
  'task/released': 'applied',
  'task/submitted': 'applied',
  'task/verified': 'applied',
  'task/rejected': 'applied',
  'task/blocked': 'applied',
  'task/unblocked': 'applied',
  'task/interrupted': 'applied',
  'task/reconciled': 'applied',
  'task/canceled': 'applied',
  'task/reopened': 'applied',
  'task/orphaned': 'applied',

  // Audit/ledger only: task/updated|rejected|unblocked|reopened in the same
  // commit carries the full task, so ignoring these cannot change the state.
  'task/meta-edited': 'additive',
  'task/assignment': 'additive',

  'doc/created': 'applied',
  'doc/updated': 'applied',
  'doc/drift': 'applied',
  // External documents (docs/EXTERNAL-DOCS.md). Every event carries the full
  // record; old readers do not know these types and refuse the whole open.
  // Migration carries strict source identity, target content and archive mapping.
  'doc/external-migrated': 'applied',
  'doc/content-fixed': 'applied',
  'doc/external-registered': 'applied',
  'doc/external-updated': 'applied',
  'doc/external-relocated': 'applied',
  'doc/external-unregistered': 'applied',
  'doc/external-confirmed': 'applied',

  'session/bound': 'applied',
  'session/detached': 'applied',
  'session/checkpoint': 'additive',
  'session/handoff': 'additive',

  'work/intent': 'applied',
  'work/result': 'applied',
  'work/abandoned': 'applied',

  'lease/granted': 'applied',
  'lease/expired': 'additive',
  'lease/revoked': 'additive',

  'override/applied': 'applied',
});

export const EVENT_CLASSES = ['applied', 'additive', 'migration', 'refuse'];

/** Classify one type; unknown/invalid types are `refuse`, never a guess. */
export function eventClass(type, registry = EVENT_REGISTRY) {
  if (typeof type !== 'string' || type === '') return 'refuse';
  const known = registry[type];
  return EVENT_CLASSES.includes(known) && known !== 'refuse' ? known : 'refuse';
}
