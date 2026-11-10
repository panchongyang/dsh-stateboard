// Strict bounded migration read; legacy store.readBlob behavior is unchanged.
import fs from 'node:fs';
import path from 'node:path';

const MAX = 16 * 1024 * 1024;
const unchanged = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

export function migrationBlobReader(store) {
  return typeof store.readMigrationBlob === 'function'
    ? (hash) => store.readMigrationBlob(hash) : (hash) => store.readBlob(hash);
}

export function readMigrationBlob(root, hash) {
  if (!/^[0-9a-f]{64}$/.test(hash || '')) return null;
  const file = path.join(root, hash);
  let fd;
  try {
    const namedBefore = fs.lstatSync(file);
    if (!namedBefore.isFile() || namedBefore.isSymbolicLink()) return null;
    fd = fs.openSync(file, 'r');
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > MAX || !unchanged(namedBefore, before)) return null;
    const bytes = Buffer.alloc(Math.min(before.size + 1, MAX + 1));
    let size = 0;
    while (size < bytes.length) {
      const count = fs.readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    const after = fs.fstatSync(fd);
    const named = fs.lstatSync(file);
    if (size !== before.size || !unchanged(before, after) || named.isSymbolicLink() || !unchanged(after, named)) return null;
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size));
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
