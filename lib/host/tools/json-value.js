// DSH's lossless JSON boundary: do not let a native object carry data that the
// MCP JSON transport would drop or coerce. Iterative traversal permits DAGs,
// rejects ancestor cycles and never calls toJSON.
function nativePrototype(proto, name) {
  if (!proto) return false;
  const ctor = Object.getOwnPropertyDescriptor(proto, 'constructor')?.value;
  return typeof ctor === 'function' && ctor.name === name && ctor.prototype === proto
    && Function.prototype.toString.call(ctor) === Function.prototype.toString.call(name === 'Object' ? Object : Array);
}

function objectPrototype(proto) {
  return proto !== null && Object.getPrototypeOf(proto) === null && nativePrototype(proto, 'Object');
}

export function losslessJson(value) {
  const ancestors = new Set();
  const pending = [{ value }];
  try {
    while (pending.length) {
      const entry = pending.pop();
      if (entry.exit) { ancestors.delete(entry.value); continue; }
      const item = entry.value;
      if (item === null || typeof item === 'string' || typeof item === 'boolean') continue;
      if (typeof item === 'number') { if (!Number.isFinite(item) || Object.is(item, -0)) return false; continue; }
      if (typeof item !== 'object' || ancestors.has(item)) return false;
      const keys = Reflect.ownKeys(item);
      const proto = Object.getPrototypeOf(item);
      if (Array.isArray(item)) {
        if (!nativePrototype(proto, 'Array') || !objectPrototype(Object.getPrototypeOf(proto)) || keys.length !== item.length + 1) return false;
        for (let index = 0; index < item.length; index += 1) if (!Object.hasOwn(item, index)) return false;
      } else if (proto !== null && !objectPrototype(proto)) return false;
      ancestors.add(item);
      pending.push({ value: item, exit: true });
      for (const key of keys) {
        if (Array.isArray(item) && key === 'length') continue;
        if (typeof key !== 'string' || (!Array.isArray(item) && !Object.getOwnPropertyDescriptor(item, key).enumerable)) return false;
        pending.push({ value: item[key] });
      }
    }
    return true;
  } catch { return false; }
}
