// Append recovery is local to one store, not a process-wide fs monkey patch.
import fs from 'node:fs';
import { BoardError } from '../errors.js';
import { atomicWrite } from '../util.js';

function failure(error) {
  return { code: error?.code || null, message: error instanceof Error ? error.message : String(error) };
}

function uncertain(store, original, recovery, phase) {
  store.readOnly = true;
  store.stopHeartbeat();
  const error = new BoardError('log-write-uncertain', 'commit write outcome is uncertain; writer is read-only until reopened', {
    status: 503,
    details: { outcome: 'unknown', phase, original: failure(original), recovery: failure(recovery) },
  });
  error.cause = original;
  return error;
}

// The caller must validate the entire parsed commit chain before this write.
// Complete JSON without LF is retained; malformed incomplete bytes are omitted.
export function repairLogTail(store, lines) {
  const body = lines.length === 0 ? '' : lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
  try {
    if (!store.ownsLockFile()) throw new Error('tail repair refused: writer lost its lock');
    atomicWrite(store.commitsFile, body, 'utf8', store.fs);
    if (fs.readFileSync(store.commitsFile, 'utf8') !== body || !store.ownsLockFile()) {
      throw new Error('tail repair could not confirm framing or lock ownership');
    }
  } catch (error) {
    throw uncertain(store, error, new Error('cold-open framing repair was not confirmed'), 'open-tail-repair');
  }
}

function restoreTail(store, before, bytes) {
  // Windows append handles cannot ftruncate: reopen r+ without truncation, then
  // verify identity before touching it. Never erase a successor/foreign tail.
  // Locks are cooperative, not an atomic fence against rogue OS writers.
  const fd = store.fs.openSync(store.commitsFile, 'r+');
  try {
    const current = fs.fstatSync(fd);
    const named = fs.statSync(store.commitsFile);
    if (!store.ownsLockFile() || named.dev !== before.dev || named.ino !== before.ino
      || current.dev !== before.dev || current.ino !== before.ino
      || current.size < before.size || current.size > before.size + bytes.length) {
      throw new Error('append recovery refused: lock, file identity or tail size changed');
    }
    const tail = Buffer.alloc(current.size - before.size);
    const read = fs.readSync(fd, tail, 0, tail.length, before.size);
    if (read !== tail.length || !tail.equals(bytes.subarray(0, tail.length)) || !store.ownsLockFile()) {
      throw new Error('append recovery refused: foreign tail or lost lock');
    }
    store.fs.ftruncateSync(fd, before.size);
    store.fs.fsyncSync(fd);
    if (fs.fstatSync(fd).size !== before.size || !store.ownsLockFile()) {
      throw new Error('append recovery could not confirm the restored tail');
    }
  } finally {
    store.fs.closeSync(fd);
  }
}

export function appendCommitLine(store, line) {
  const io = store.fs;
  const fd = io.openSync(store.commitsFile, 'a+');
  let error = null;
  try {
    const before = fs.fstatSync(fd);
    if (before.size !== store._fileSize) {
      throw uncertain(store, new Error('log changed before write'), new Error('no recovery attempted'), 'pre-write');
    }
    const bytes = Buffer.from(line + '\n', 'utf8');
    try {
      io.writeFileSync(fd, bytes);
      io.fsyncSync(fd);
    } catch (original) {
      try { restoreTail(store, before, bytes); }
      catch (recovery) { throw uncertain(store, original, recovery, 'rollback'); }
      throw original;
    }
  } catch (caught) {
    error = caught;
  }
  try { io.closeSync(fd); }
  catch (closeError) { throw uncertain(store, error || closeError, closeError, 'close'); }
  if (error) throw error;
}
