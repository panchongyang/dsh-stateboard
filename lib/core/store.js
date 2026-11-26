import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readJson, readJsonLines, sha256 } from './util.js';
import { appendCommitLine, repairLogTail } from './store/writes.js';
import { BoardError } from './errors.js';
import { readMigrationBlob } from './documents/migration-blob.js';
import { commitHash, validateCommit, validateCommits } from './store/format.js';
import { assertCommittedProject, assertRecord, restoreRecords } from './transaction/records.js';
import { SUPPORTED_COMMIT_VERSION } from './store/format.js';
import { readBlob, saveSnapshot, writeBlob } from './store/files.js';
import {
  LOCK_HEARTBEAT_MS,
  LOCK_STALE_MS,
  acquireLock,
  cleanupLockFiles,
  degrade,
  ownsLockFile,
  startHeartbeat,
  stopHeartbeat,
  touchLock,
} from './store/lock.js';

import { freezeValue, requirePendingRecord, TransactionModel } from './transaction/model.js';

// Compatibility values are projections owned by the model, not store state.
function installModel(store, data) {
  store.model = new TransactionModel(data);
  return { ...data, state: store.model.state, timeline: store.model.timeline, cmdIds: store.model.cmdIds };
}

// One writer per project directory per process. A plugin reload builds a second
// ProjectService; if that service opened the same log again it would carry its
// own lastSeq and fork the commit chain, so the directory itself is the guard.
const OPEN_STORES = new Map();

function storeKey(dir) {
  const resolved = path.resolve(dir);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// Re-exported: the commit envelope and its hash are part of the public surface
// (tests and lib/core/repair.js build/verify commits through store.js).
export { commitHash, makeCommit, SUPPORTED_COMMIT_VERSION } from './store/format.js';

export class MemoryStore {
  constructor(meta, commits = []) {
    this.meta = meta;
    this.commits = commits.map((commit) => freezeValue(structuredClone(commit)));
    this.blobs = new Map();
    this.readOnly = false;
    this.closed = false;
  }

  open({ requireCommitted = false } = {}) {
    validateCommits(this.commits);
    if (requireCommitted) assertCommittedProject(this.commits.length, this.meta.projectId);
    const { state, timeline } = restoreRecords(this.meta, this.commits);
    this.lastSeq = state.lastSeq;
    this.lastHash = state.lastHash;
    return installModel(this, {
      state,
      commits: this.commits,
      timeline,
      lastSeq: this.lastSeq,
      lastHash: this.lastHash,
      cmdIds: new Set(this.commits.map((commit) => commit.cmdId)),
      readOnly: false,
    });
  }

  get state() { return this.model.state; }
  get timeline() { return this.model.timeline; }
  get cmdIds() { return this.model.cmdIds; }

  commitPhysical(commit) {
    requirePendingRecord(this, commit);
    if (this.closed || this.readOnly) throw new BoardError('read-only', 'store is not writable', { status: 503 });
    validateCommit(commit, { line: commit.seq, validSeq: this.lastSeq, validHash: this.lastHash });
    this.commits.push(freezeValue(structuredClone(commit)));
    this.lastSeq = commit.seq;
    this.lastHash = commit.hash;
    return Object.freeze({ seq: commit.seq, hash: commit.hash });
  }

  saveSnapshot() {}

  writeBlob(body) {
    const hash = sha256(body);
    this.blobs.set(hash, body);
    return hash;
  }

  readBlob(hash) {
    return this.blobs.get(hash) ?? null;
  }

  close() { this.closed = true; }

  touchLock() {}
}

export class JsonlStore {
  constructor(dir, meta, opts = {}) {
    this.dir = dir;
    this.meta = meta;
    // Per-store write adapter; never replace the process-wide node:fs object.
    // Reads and lock ownership remain real so injected writes exercise the WAL.
    this.fs = opts.fs || fs;
    this.commitsFile = path.join(dir, 'commits.jsonl');
    this.snapshotFile = path.join(dir, 'snapshot.json');
    this.blobsDir = path.join(dir, 'blobs');
    this.lockFile = path.join(dir, 'lock.json');
    this.readOnly = false;
    this.closed = false;
    this.ownsLock = false;
    this.heartbeatMs = Number.isFinite(opts.heartbeatMs) ? opts.heartbeatMs : LOCK_HEARTBEAT_MS;
    this.staleMs = Number.isFinite(opts.staleMs) ? opts.staleMs : LOCK_STALE_MS;
    this.lockNonce = null;
    this.lockStartedAt = null;
    this.lastHeartbeatAt = 0;
    this.heartbeatTimer = null;
    // A lock-free peek: used by listProjects to read a summary without taking
    // the project lock or registering a writable handle.
    this.wantLock = opts.lock !== false;
  }

  open({ requireCommitted = false } = {}) {
    try {
      return this._open(requireCommitted);
    } catch (error) {
      // A half-open store must not keep the lock or a heartbeat timer alive.
      this.close();
      throw error;
    }
  }

  _validateLogCommit(commit, context) {
    validateCommit(commit, context);
    // Refuse before framing normalization, including snapshot-covered commits.
    assertRecord(this.meta, commit);
  }

  _open(requireCommitted) {
    if (this.wantLock) {
      ensureDir(this.dir);
      ensureDir(this.blobsDir);
    }
    const key = storeKey(this.dir);
    const holder = OPEN_STORES.get(key);
    if (this.wantLock && holder && holder !== this && !holder.closed) {
      throw new BoardError('log-busy', 'project log is already open in this process: ' + this.dir, { status: 503 });
    }
    if (this.wantLock) this.acquireLock();
    else this.readOnly = true;

    const { lines, tailUnterminated } = readJsonLines(this.commitsFile, { validate: (commit, context) => this._validateLogCommit(commit, context) });
    // A public open may repair a tail after committed work, never an uncertain first line into an empty live writer.
    if (requireCommitted) assertCommittedProject(lines.length, this.meta.projectId);
    // Model restoration validates every record and snapshot before tail repair.
    const { state, timeline } = restoreRecords(this.meta, lines, readJson(this.snapshotFile, null));
    if (tailUnterminated && !this.readOnly) repairLogTail(this, lines);
    this._fileSize = fs.existsSync(this.commitsFile) ? fs.statSync(this.commitsFile).size : 0;
    this.commits = lines.map((commit) => freezeValue(commit));
    this.lastSeq = state.lastSeq;
    this.lastHash = state.lastHash;

    this._dirKey = key;
    // A lock-free peek is not the project's writer: it must neither block a
    // writable open nor be evicted as if it owned the log.
    if (this.wantLock) OPEN_STORES.set(key, this);
    return installModel(this, {
      state,
      commits: this.commits,
      timeline,
      lastSeq: this.lastSeq,
      lastHash: this.lastHash,
      cmdIds: new Set(lines.map((commit) => commit.cmdId)),
      readOnly: this.readOnly,
    });
  }

  /**
   * Read only what was appended since the last read. A read-only follower (the
   * second process, a UI polling a foreign writer) must see new commits without
   * re-reading a log that keeps growing.
   */
  refresh() {
    if (this.closed) return null;
    if (!fs.existsSync(this.commitsFile)) return null;
    const size = fs.statSync(this.commitsFile).size;
    if (size <= this._fileSize) return null;
    const fd = fs.openSync(this.commitsFile, 'r');
    let text;
    try {
      const buffer = Buffer.allocUnsafe(size - this._fileSize);
      fs.readSync(fd, buffer, 0, buffer.length, this._fileSize);
      text = buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    const lastNewline = text.lastIndexOf('\n');
    const complete = lastNewline === -1 ? '' : text.slice(0, lastNewline);
    if (complete.trim() === '') return null; // only a half-written line so far
    const lines = complete.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
    let prevHash = this.lastHash;
    let prevSeq = this.lastSeq;
    for (const commit of lines) {
      if (commit.v !== SUPPORTED_COMMIT_VERSION) {
        throw new BoardError('unsupported-version', 'commit at seq ' + commit.seq + ' uses log version ' + commit.v + '; this build supports v' + SUPPORTED_COMMIT_VERSION, {
          status: 409,
          details: { found: commit.v, supported: SUPPORTED_COMMIT_VERSION },
        });
      }
      if (commit.seq !== prevSeq + 1) throw new BoardError('hash-chain-broken', 'non-contiguous seq at ' + commit.seq, { status: 503 });
      if (commit.prev !== prevHash) throw new BoardError('hash-chain-broken', 'broken prev hash at seq ' + commit.seq, { status: 503 });
      if (commitHash(commit) !== commit.hash) throw new BoardError('hash-chain-broken', 'bad commit hash at seq ' + commit.seq, { status: 503 });
      if (!Array.isArray(commit.events)) throw new BoardError('hash-chain-broken', 'commit has no events at seq ' + commit.seq, { status: 503 });
      prevSeq = commit.seq;
      prevHash = commit.hash;
    }
    // Validate and apply the whole observed batch privately before publication.
    this.model = TransactionModel.replayTail(this.model, this.commits, lines);
    this.commits = [...this.commits, ...lines.map(record => freezeValue(record))];
    this.lastSeq = prevSeq;
    this.lastHash = prevHash;
    this._fileSize += Buffer.byteLength(complete, 'utf8') + 1;
    return { state: this.state, timeline: this.timeline, lastSeq: this.lastSeq, lastHash: this.lastHash };
  }

  acquireLock() {
    acquireLock(this);
  }

  startHeartbeat() {
    startHeartbeat(this);
  }

  stopHeartbeat() {
    stopHeartbeat(this);
  }

  touchLock(force = false) {
    touchLock(this, force);
  }

  /** True when lock.json still names this process and this acquisition. */
  ownsLockFile() {
    return ownsLockFile(this);
  }

  degrade(message) {
    return degrade(this, message);
  }

  get state() { return this.model.state; }
  get timeline() { return this.model.timeline; }
  get cmdIds() { return this.model.cmdIds; }

  commitPhysical(commit) {
    requirePendingRecord(this, commit);
    if (this.closed || this.readOnly) throw new BoardError('read-only', 'store is not writable', { status: 503 });
    this._assertAppendable(commit);
    validateCommit(commit, { line: commit.seq, validSeq: this.lastSeq, validHash: this.lastHash });
    const line = JSON.stringify(commit);
    const retained = freezeValue(structuredClone(commit));
    appendCommitLine(this, line);
    try {
      const actualSize = fs.existsSync(this.commitsFile) ? fs.statSync(this.commitsFile).size : 0;
      const expectedSize = this._fileSize + Buffer.byteLength(line, 'utf8') + 1;
      if (actualSize !== expectedSize) throw new Error('the commit log changed during append');
      this._fileSize = actualSize;
      this.commits.push(retained);
      this.lastSeq = commit.seq;
      this.lastHash = commit.hash;
    } catch (cause) {
      this.readOnly = true;
      this.stopHeartbeat();
      throw new BoardError('log-write-uncertain', 'durable append receipt could not be confirmed; reopen before writing', {
        status: 503, details: { outcome: 'unknown', phase: 'receipt', cause: String(cause) },
      });
    }
    // Lock maintenance is derived and cannot invalidate a durable receipt.
    try { this.touchLock(); } catch { /* next append rechecks ownership */ }
    return Object.freeze({ seq: commit.seq, hash: commit.hash });
  }

  /**
   * Refuse to write when this handle no longer owns the tail of the log. The
   * seq/prev check catches a forked counter; the file-size check catches a
   * second writer that appended behind our back.
   */
  _assertAppendable(commit) {
    if (commit.seq !== this.lastSeq + 1) {
      throw new BoardError('log-forked', 'commit seq ' + commit.seq + ' does not follow ' + this.lastSeq, { status: 503 });
    }
    if (commit.prev !== this.lastHash) {
      throw new BoardError('log-forked', 'commit prev does not match ' + String(this.lastHash).slice(0, 12), { status: 503 });
    }
    const size = fs.existsSync(this.commitsFile) ? fs.statSync(this.commitsFile).size : 0;
    if (size !== this._fileSize) {
      throw new BoardError('log-forked', 'commit log changed on disk since this writer opened it (' + this._fileSize + ' -> ' + size + ')', {
        status: 503,
        details: { expectedSize: this._fileSize, actualSize: size },
      });
    }
    if (!this.ownsLockFile()) {
      throw this.degrade('lock.json no longer belongs to this writer (another process took over); append refused');
    }
  }

  saveSnapshot() {
    saveSnapshot(this);
  }

  writeBlob(body) {
    return writeBlob(this, body);
  }

  readBlob(hash) {
    return readBlob(this, hash);
  }

  readMigrationBlob(hash) {
    return readMigrationBlob(this.blobsDir, hash);
  }

  close() {
    this.closed = true;
    this.stopHeartbeat();
    if (this._dirKey && OPEN_STORES.get(this._dirKey) === this) OPEN_STORES.delete(this._dirKey);
    if (this.ownsLock) {
      // Never delete a lock that another process has since taken over.
      if (this.ownsLockFile()) {
        try { fs.unlinkSync(this.lockFile); } catch { /* ignore */ }
      }
      this.ownsLock = false;
    }
    cleanupLockFiles(this);
  }
}

/**
 * Replay one project log WITHOUT the project lock and without recovery writes.
 * Inline admission uses this persisted projection before writer acquisition.
 * An unreadable log is an error so admission cannot mistake it for absence.
 */
export function readStateWithoutLock(dir, meta) {
  const store = new JsonlStore(dir, meta, { lock: false });
  try { return store.open().state; } finally { try { store.close(); } catch { /* read-only */ } }
}