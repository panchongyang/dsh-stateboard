// A captured immutable prefix of retained, frozen commit records. Array methods
// read through the fixed boundary; capturing a watermark never copies history.
// This internal read capability is projected to plain DTOs before transport.
export function commitPrefix(history, length) {
  const target = [];
  target.length = length;
  const indexOf = key => typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) ? Number(key) : null;
  const denied = () => { throw new TypeError('published commit history is read-only'); };
  return new Proxy(target, {
    get(array, key, receiver) {
      const index = indexOf(key);
      return index === null ? Reflect.get(array, key, receiver) : index < length ? history[index] : undefined;
    },
    has(array, key) {
      const index = indexOf(key);
      return index === null ? Reflect.has(array, key) : index < length;
    },
    ownKeys() { return [...Array.from({ length }, (_, i) => String(i)), 'length']; },
    getOwnPropertyDescriptor(array, key) {
      const index = indexOf(key);
      if (index === null) return Reflect.getOwnPropertyDescriptor(array, key);
      return index < length ? { configurable: true, enumerable: true, writable: false, value: history[index] } : undefined;
    },
    set: denied, defineProperty: denied, deleteProperty: denied,
    setPrototypeOf: denied, preventExtensions: denied,
  });
}
