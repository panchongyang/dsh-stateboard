// Immutable workspace byte objects.
//
// Layout: .projectboard/objects/workspace-bytes/<first two hash chars>/<sha256>.
// An object is published only after its bytes are flushed and read back, so the
// content-addressed name is never visible with a partial body. Existing objects
// are verified byte-for-byte and are never overwritten or garbage-collected.
//
// Prerequisites (not provided by this module):
// - the caller holds the project writer/fencing lease for every write;
// - the volume supports hard links (NTFS/ext4/APFS do; FAT/exFAT and some
//   network shares do not, and are reported as write-capability-unavailable);
// - Node cannot flush a directory handle on Windows (fsync returns EPERM), so
//   durability of the directory entry itself is left to the device/OS. File
//   bytes are flushed before publication.
//
// Reads never create directories. Every public entry point re-runs the trusted
// spaceHome.check() and refuses a home whose pinned identity no longer matches.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BoardError } from '../errors.js';
import { isInside } from '../util.js';

export const WORKSPACE_OBJECT_MAX_BYTES = 16 * 1024 * 1024;
export const WORKSPACE_OBJECT_BUDGET_BYTES = 1024 * 1024 * 1024;

const HASH = /^[a-f0-9]{64}$/;
const TEMP_PREFIX = '.pending-';
const PENDING_ALIAS = /^\.pending-\d+-[0-9a-f]{16}$/;
const MAX_OBJECTS = 65_536;
const LINK_UNSUPPORTED = new Set(['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK']);

const fail = (code, message, status, details = null) => new BoardError(code, message, { status, details });
const corrupt = (message, details = null) => fail('content-object-corrupt', message, 503, details);
const rejected = (message, details = null) => fail('security-rejected', message, 403, details);
const unavailable = (message, details = null) => fail('write-capability-unavailable', message, 503, details);

function assertHome(spaceHome) {
  if (!spaceHome || typeof spaceHome.check !== 'function'
    || typeof spaceHome.root !== 'string' || !path.isAbsolute(spaceHome.root)
    || typeof spaceHome.namespace !== 'string' || !path.isAbsolute(spaceHome.namespace)) {
    throw fail('space-home-unavailable', 'A trusted, opened space home is required', 409);
  }
  if (spaceHome.check() !== true) {
    throw fail('space-home-unavailable', 'The selected space medium is not initialised or has changed', 409);
  }
  const root = fs.realpathSync.native(spaceHome.root);
  if (!isInside(root, path.resolve(spaceHome.namespace))) {
    throw fail('space-home-unavailable', 'The space namespace is outside its opened root', 409);
  }
  return root;
}

function asBytes(input) {
  if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) {
    throw fail('invalid-command', 'Workspace object bytes must be a Buffer or Uint8Array', 400);
  }
  return Buffer.from(input);
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sameBytes(left, right) {
  return left.length === right.length && left.equals(right);
}

function assertHash(value) {
  if (typeof value !== 'string' || !HASH.test(value)) {
    throw fail('invalid-command', 'A lowercase SHA-256 hex content hash is required', 400, { contentHash: value });
  }
  return value;
}

// Resolve a directory chain under the opened root without following links.
// Missing components return null on reads and are created one level at a time
// on writes; every component is re-checked through realpath containment.
function realDirectory(spaceHome, segments, create) {
  const root = assertHome(spaceHome);
  let current = path.resolve(spaceHome.namespace);
  if (!isInside(root, current)) throw fail('space-home-unavailable', 'The space namespace escapes its opened root', 409);
  for (const name of segments) {
    current = path.join(current, name);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return null;
      fs.mkdirSync(current);
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.ino <= 0) {
      throw rejected('A medium directory is a link, reparse point or not a directory', { path: current });
    }
    const real = fs.realpathSync.native(current);
    if (!isInside(root, real)) throw rejected('A medium directory escapes the opened space root', { path: current });
    current = real;
  }
  return current;
}

function readObjectFile(file, contentHash, linkCount = 1n) {
  let named;
  try {
    named = fs.lstatSync(file, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (named.isSymbolicLink() || !named.isFile() || named.nlink !== linkCount) {
    throw rejected('An object path is a link, reparse point or multiply linked file', { path: file });
  }
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (stat.dev !== named.dev || stat.ino !== named.ino || stat.size !== named.size
      || stat.nlink !== named.nlink || stat.ctimeNs !== named.ctimeNs) {
      throw rejected('The opened object is not the file that was named', { path: file });
    }
    if (!stat.isFile() || stat.nlink !== linkCount) {
      throw rejected('An object path is a link, reparse point or multiply linked file', { path: file });
    }
    if (stat.size > BigInt(WORKSPACE_OBJECT_MAX_BYTES)) {
      throw corrupt('Stored object size is outside the object bounds', { path: file, size: Number(stat.size) });
    }
    const size = Number(stat.size), limit = size + 1;
    const buffer = Buffer.allocUnsafe(limit);
    let read = 0;
    while (read < limit) {
      const count = fs.readSync(fd, buffer, read, limit - read, read);
      if (count === 0) break;
      read += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size
      || after.ctimeNs !== stat.ctimeNs || after.nlink !== linkCount || !after.isFile()) {
      throw rejected('An object path changed while it was being read', { path: file });
    }
    if (read !== size) throw corrupt('Stored object bytes are shorter or longer than its opened size', { path: file });
    const bytes = buffer.subarray(0, read);
    if (sha256Bytes(bytes) !== contentHash) {
      throw corrupt('Stored object bytes do not match their content address', { path: file });
    }
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

function objectBucket(spaceHome, contentHash, create) {
  return realDirectory(spaceHome, ['objects', 'workspace-bytes', contentHash.slice(0, 2)], create);
}

function readObject(spaceHome, contentHash) {
  const bucket = objectBucket(spaceHome, contentHash, false);
  if (!bucket) return null;
  return readObjectFile(path.join(bucket, contentHash), contentHash);
}

// A crash between link(temp, final) and unlink(temp) leaves the final object with
// exactly two links: the content address and our protocol-named temp. Only that
// precise shape is reclaimable, and only while holding the project writer.
function pendingAliases(bucket, stat) {
  const aliases = [];
  for (const entry of fs.readdirSync(bucket, { withFileTypes: true })) {
    if (!PENDING_ALIAS.test(entry.name)) continue;
    const alias = path.join(bucket, entry.name);
    let aliasStat;
    try {
      aliasStat = fs.lstatSync(alias, { bigint: true });
    } catch {
      continue;
    }
    if (aliasStat.isFile() && aliasStat.nlink === 2n
      && aliasStat.dev === stat.dev && aliasStat.ino === stat.ino) aliases.push(alias);
  }
  return aliases;
}

function reclaimPendingObject(spaceHome, contentHash) {
  const bucket = objectBucket(spaceHome, contentHash, false);
  if (!bucket) return null;
  const file = path.join(bucket, contentHash);
  let stat;
  try {
    stat = fs.lstatSync(file, { bigint: true });
  } catch {
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 2n) return null;
  const aliases = pendingAliases(bucket, stat);
  if (aliases.length !== 1) return null;
  const bytes = readObjectFile(file, contentHash, 2n); // Full hash before any removal.
  try {
    fs.unlinkSync(aliases[0]); // Remove only the protocol-named internal temp.
  } catch {
    throw rejected('A recoverable pending object alias could not be removed', { path: aliases[0] });
  }
  const after = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
  if (!after || after.nlink !== 1n || after.isSymbolicLink() || !after.isFile()) {
    throw rejected('The object still has a non-protocol link after recovery', { path: file });
  }
  return bytes;
}

function objectUsage(spaceHome) {
  const base = realDirectory(spaceHome, ['objects', 'workspace-bytes'], false);
  if (!base) return { used: 0, count: 0 };
  let used = 0, count = 0;
  for (const bucket of fs.readdirSync(base, { withFileTypes: true })) {
    if (!bucket.isDirectory() || bucket.isSymbolicLink()) {
      if (bucket.isSymbolicLink()) throw rejected('An object bucket is a link or reparse point', { path: path.join(base, bucket.name) });
      continue;
    }
    const bucketPath = path.join(base, bucket.name);
    for (const entry of fs.readdirSync(bucketPath, { withFileTypes: true })) {
      if (!HASH.test(entry.name)) continue;
      if (entry.isSymbolicLink()) throw rejected('An object file is a link or reparse point', { path: path.join(bucketPath, entry.name) });
      if (!entry.isFile()) continue;
      if (++count > MAX_OBJECTS) {
        throw fail('history-capacity', 'The retained object set exceeds the bounded capacity scan', 409, {
          budgetBytes: WORKSPACE_OBJECT_BUDGET_BYTES, objects: count, reason: 'object-count-limit',
        });
      }
      const stat = fs.lstatSync(path.join(bucketPath, entry.name), { bigint: true });
      if (stat.nlink !== 1n) {
        const recoverable = stat.nlink === 2n && pendingAliases(bucketPath, stat).length === 1;
        if (!recoverable) throw rejected('An object file is multiply linked', { path: path.join(bucketPath, entry.name) });
      }
      used += Number(stat.size);
    }
  }
  return { used, count };
}

function assertCapacity(spaceHome, incomingBytes) {
  const { used, count } = objectUsage(spaceHome);
  if (count >= MAX_OBJECTS) {
    throw fail('history-capacity', 'The retained object set is at its bounded limit', 409, {
      budgetBytes: WORKSPACE_OBJECT_BUDGET_BYTES, usedBytes: used, objects: count,
      maxObjects: MAX_OBJECTS, reason: 'object-count-limit',
    });
  }
  if (used + incomingBytes > WORKSPACE_OBJECT_BUDGET_BYTES) {
    throw fail('history-capacity', 'Storing this object would exceed the per-project history budget', 409, {
      budgetBytes: WORKSPACE_OBJECT_BUDGET_BYTES, usedBytes: used, incomingBytes,
    });
  }
}

// Best effort: Windows lets Node open a directory but fsync on it returns EPERM.
// File data is already flushed; the directory entry durability is not promised.
function fsyncDirectory(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch {
    // Device/filesystem dependent; see the module header.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Store raw bytes under their full SHA-256. Returns {contentHash, size}.
 * An existing object is verified and reused; a mismatch is never overwritten.
 */
export function putWorkspaceObject(spaceHome, input) {
  assertHome(spaceHome);
  const bytes = asBytes(input);
  if (bytes.length > WORKSPACE_OBJECT_MAX_BYTES) {
    throw fail('oversize', 'A workspace object exceeds 16 MiB', 413, {
      maxBytes: WORKSPACE_OBJECT_MAX_BYTES, size: bytes.length,
    });
  }
  const contentHash = sha256Bytes(bytes);
  let existing;
  try {
    existing = readObject(spaceHome, contentHash);
  } catch (error) {
    if (error.code !== 'security-rejected') throw error;
    existing = reclaimPendingObject(spaceHome, contentHash);
    if (existing === null) throw error;
  }
  if (existing) {
    if (!sameBytes(existing, bytes)) throw corrupt('An existing object differs from the proposed bytes', { contentHash });
    return { contentHash, size: existing.length };
  }

  assertCapacity(spaceHome, bytes.length);
  const bucket = objectBucket(spaceHome, contentHash, true);
  if (!bucket) throw rejected('The object bucket could not be resolved', { contentHash });
  const file = path.join(bucket, contentHash);
  const temp = path.join(bucket, TEMP_PREFIX + process.pid + '-' + crypto.randomBytes(8).toString('hex'));
  let published = false;
  try {
    let fd;
    try {
      fd = fs.openSync(temp, 'wx+'); // exclusive create with read-back on the same handle
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      const stat = fs.fstatSync(fd, { bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n || stat.size !== BigInt(bytes.length)) {
        throw corrupt('A temporary object has the wrong identity or length', { size: Number(stat.size) });
      }
      const back = Buffer.allocUnsafe(bytes.length);
      let read = 0;
      while (read < bytes.length) {
        const count = fs.readSync(fd, back, read, bytes.length - read, read);
        if (count === 0) break;
        read += count;
      }
      if (read !== bytes.length || !sameBytes(back, bytes)) {
        throw corrupt('Object read-back differs from the proposed bytes');
      }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    try {
      fs.linkSync(temp, file); // Atomic no-replace publication of complete bytes.
      published = true;
    } catch (error) {
      if (error.code === 'EEXIST') {
        const raced = readObject(spaceHome, contentHash);
        if (!raced) throw corrupt('An object appeared and disappeared during publication', { contentHash });
        if (!sameBytes(raced, bytes)) throw corrupt('A raced object differs from the proposed bytes', { contentHash });
        return { contentHash, size: raced.length };
      }
      if (LINK_UNSUPPORTED.has(error.code)) {
        throw unavailable('This filesystem cannot publish an immutable object with an atomic no-replace link', {
          contentHash, cause: error.code,
        });
      }
      throw error;
    }
  } finally {
    try { fs.unlinkSync(temp); } catch { /* published object already carries the bytes */ }
  }
  if (published) fsyncDirectory(bucket);
  const stored = readObject(spaceHome, contentHash);
  if (!stored) throw corrupt('The published object is no longer readable', { contentHash });
  if (!sameBytes(stored, bytes)) throw corrupt('The published object differs from the proposed bytes', { contentHash });
  return { contentHash, size: stored.length };
}

/** Read one immutable object and verify its full bytes and identity. */
export function readWorkspaceObject(spaceHome, contentHash) {
  assertHome(spaceHome);
  const hash = assertHash(contentHash);
  const bytes = readObject(spaceHome, hash);
  if (!bytes) throw fail('content-object-missing', 'The requested content object does not exist', 404, { contentHash: hash });
  return bytes;
}
