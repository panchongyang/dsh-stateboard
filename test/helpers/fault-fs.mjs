// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// A real-disk, instance-local adapter. File descriptors are tracked, never global
// node:fs patched; only paths below the synthetic project may be faulted.
export function faultFs(root) {
  const fds = new Map();
  const calls = [];
  let armed = null;
  function invoke(method, args) {
    const file = typeof args[0] === 'number' ? fds.get(args[0]) : args[0];
    if (typeof file === 'string') {
      const relative = path.relative(root, file);
      assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), file);
    }
    calls.push({ method, file });
    if (armed && armed.method === method && armed.match(file)) {
      const fault = armed;
      armed = null;
      return fault.run(args, () => fs[method](...args));
    }
    return fs[method](...args);
  }
  const io = Object.create(fs);
  for (const method of ['mkdirSync', 'writeFileSync', 'fsyncSync', 'ftruncateSync', 'renameSync', 'fstatSync']) {
    io[method] = (...args) => invoke(method, args);
  }
  io.openSync = (file, flags) => {
    const fd = fs.openSync(file, flags);
    fds.set(fd, file);
    return fd;
  };
  io.closeSync = (fd) => {
    try { return invoke('closeSync', [fd]); } finally { fds.delete(fd); }
  };
  return {
    io, calls,
    arm(method, match, run) {
      assert.equal(armed, null, 'previous injection was not reached');
      armed = { method, match, run };
    },
    consumed() { assert.equal(armed, null, 'injection was not reached'); },
  };
}

export function ioError() {
  return Object.assign(new Error('injected synthetic EIO'), { code: 'EIO' });
}

export function partialWrite([fd, data, encoding]) {
  const bytes = Buffer.from(data, encoding);
  fs.writeSync(fd, bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 3))));
  throw ioError();
}
