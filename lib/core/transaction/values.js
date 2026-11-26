// Only JSON values are durable. Validate before publishing OR writing, never on replay.
import { BoardError } from '../errors.js';

function invalid(message) { throw new BoardError('invalid-command', message, { status: 400 }); }

/** Copy an accepted value to the exact representation both JSONL and memory can retain. */
export function durableValue(value, parents = new Set()) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid('a durable number must be finite');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object' || parents.has(value)) invalid('a durable value must be acyclic JSON');
  const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
  if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) invalid('a durable container must be plain');
  // Inspect own data descriptors, not property reads or an input-supplied iterator.
  // In particular, validation of a batch must never execute its contents.
  parents.add(value);
  const fields = [], items = [];
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (array && key === 'length') continue;
    const d = descriptors[key];
    if (typeof key !== 'string' || !d.enumerable || !Object.hasOwn(d, 'value')) invalid('a durable field must be an enumerable data property');
    if (array) {
      if (String(items.length) !== key) invalid('a durable array must have only consecutive indices');
      items.push(durableValue(d.value, parents));
    } else if (d.value !== undefined) fields.push([key, durableValue(d.value, parents)]);
  }
  if (array && items.length !== descriptors.length.value) invalid('a durable array cannot contain empty slots');
  const copy = array ? items : Object.fromEntries(fields);
  parents.delete(value);
  return copy;
}

export function freezeValue(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freezeValue(item);
    Object.freeze(value);
  }
  return value;
}

/** Replay replaces records, but some projection handlers edit top-level project/counters and arrays. */
export function stateContainers(state) {
  return Object.fromEntries(Object.entries(state).map(([key, value]) => [key,
    Array.isArray(value) ? value.slice() : value && typeof value === 'object' ? { ...value } : value]));
}
