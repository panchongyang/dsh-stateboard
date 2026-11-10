// Project lock: one writer per project directory, guarded by lock.json.
//
// Acquisition is atomic: every contender first takes a short-lived `lock.json.claim`
// via O_EXCL, then reads/decides/writes lock.json inside that critical section.
// The lock itself names pid/hostname/nonce; a live pid on this host never loses
// the lock even if its heartbeat looks old (the process may be suspended with an
// open handle). A dead pid on this host may be taken over. A foreign host is
// never auto-taken-over: without a pid we cannot prove the holder exited, so a
// human must force-unlock.
//
// Heartbeats write a nonce-scoped `lock.json.hb.<nonce>` file and, when the claim
// is free, refresh lock.json too. An old owner therefore cannot overwrite the new
// owner's lock by heartbeating after a takeover. Every append re-checks that
// lock.json still names this acquisition (see JsonlStore._assertAppendable).

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BoardError } from '../errors.js';
import { nowIso, readJson, writeJson } from '../util.js';

export const LOCK_STALE_MS = 30_000;
export const LOCK_HEARTBEAT_MS = 5_000;
export const LOCK_CLAIM_STALE_MS = 5_000;
const CLAIM_RETRY_TRIES = 80;
const CLAIM_RETRY_MS = 5;

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

function claimDir(store) {
  return store.lockFile + '.claim';
}

function claimOwnerFile(store) {
  return path.join(claimDir(store), 'owner.json');
}

function heartbeatFile(store, nonce) {
  return store.lockFile + '.hb.' + nonce;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function claimOwnerAt(dirPath) {
  return readJson(path.join(dirPath, 'owner.json'), null);
}

function claimAgeMs(dirPath) {
  try {
    return Date.now() - fs.statSync(dirPath).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Snapshot of the claim that may be reclaimed, or null when it is live, fresh
 * or foreign. The nonce is carried so the reclaim can prove it moved the same
 * owner it judged dead; a claim installed by another contender in between must
 * never be deleted.
 */
function staleClaim(store) {
  const dir = claimDir(store);
  const owner = claimOwnerAt(dir);
  if (!owner || !Number.isInteger(owner.pid)) {
    const age = claimAgeMs(dir);
    return age !== null && age > LOCK_CLAIM_STALE_MS ? { nonce: typeof owner?.nonce === 'string' ? owner.nonce : null } : null;
  }
  const sameHost = !owner.hostname || owner.hostname === os.hostname();
  if (!sameHost) return null; // cannot prove a foreign claimant exited; human cleanup
  return isPidAlive(owner.pid) ? null : { nonce: typeof owner.nonce === 'string' ? owner.nonce : null };
}

function sameClaimOwner(stale, moved) {
  if (stale.nonce === null) return moved === null;
  return Boolean(moved) && moved.nonce === stale.nonce;
}

/**
 * Rename the stale claim to a tombstone, then verify the tombstone still holds
 * the owner we judged dead. A replacement claim is renamed back, never deleted.
 */
function reclaimStaleClaim(store, stale, nonce) {
  const dir = claimDir(store);
  const tomb = dir + '.stale.' + nonce;
  try {
    fs.renameSync(dir, tomb);
  } catch {
    return false; // another contender moved it first; retry mkdir
  }
  const moved = claimOwnerAt(tomb);
  if (!sameClaimOwner(stale, moved)) {
    try { fs.renameSync(tomb, dir); } catch { /* the path is occupied; leave the tomb */ }
    return false;
  }
  // The dead claim had no owner file (crash between mkdir and owner write). A
  // fresh replacement can be in the same window: only delete an old tombstone.
  if (stale.nonce === null && moved === null) {
    const age = claimAgeMs(tomb);
    if (age === null || age <= LOCK_CLAIM_STALE_MS) {
      try { fs.renameSync(tomb, dir); } catch { /* path occupied; leave the tomb */ }
      return false;
    }
  }
  try { fs.rmSync(tomb, { recursive: true, force: true }); } catch { /* best effort */ }
  return true;
}

/** Try to take the short-lived acquisition claim directory. Returns its nonce or null. */
function tryClaim(store, { retries = 0, allowStale = false } = {}) {
  const dir = claimDir(store);
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const nonce = crypto.randomBytes(6).toString('hex');
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(claimOwnerFile(store), JSON.stringify({ pid: process.pid, hostname: os.hostname(), nonce, at: Date.now() }));
      return nonce;
    } catch (error) {
      if (error && error.code !== 'EEXIST') return null;
    }
    if (allowStale) {
      const stale = staleClaim(store);
      if (stale && reclaimStaleClaim(store, stale, nonce)) continue;
    }
    if (attempt < retries) sleepSync(CLAIM_RETRY_MS);
  }
  return null;
}

function releaseClaim(store, nonce) {
  if (!nonce) return;
  const current = readJson(claimOwnerFile(store), null);
  if (current && current.nonce === nonce) {
    try { fs.rmSync(claimDir(store), { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function canTakeOver(store, existing) {
  if (existing.pid === process.pid) return true;
  const sameHost = !existing.hostname || existing.hostname === os.hostname();
  if (!sameHost) {
    store.lockWarning = 'lock is held by another host; explicit force-unlock required';
    return false;
  }
  if (isPidAlive(existing.pid)) {
    store.lockWarning = 'lock is held by live pid ' + existing.pid;
    return false;
  }
  return true;
}

export function acquireLock(store) {
  const claim = tryClaim(store, { retries: CLAIM_RETRY_TRIES, allowStale: true });
  if (!claim) {
    store.readOnly = true;
    store.lockWarning = 'lock acquisition is busy; retry or open read-only';
    return;
  }
  try {
    const existing = readJson(store.lockFile, null);
    if (existing && !canTakeOver(store, existing)) {
      store.readOnly = true;
      return;
    }
    store.lockStartedAt = nowIso();
    store.lockNonce = crypto.randomBytes(8).toString('hex');
    store.lastHeartbeatAt = Date.now();
    writeJson(store.lockFile, {
      pid: process.pid,
      hostname: os.hostname(),
      nonce: store.lockNonce,
      startedAt: store.lockStartedAt,
      heartbeatAt: store.lastHeartbeatAt,
    });
    try { fs.writeFileSync(heartbeatFile(store, store.lockNonce), String(store.lastHeartbeatAt)); } catch { /* best effort */ }
    store.ownsLock = true;
    startHeartbeat(store);
  } finally {
    releaseClaim(store, claim);
  }
}

export function startHeartbeat(store) {
  if (store.heartbeatTimer || !(store.heartbeatMs > 0)) return;
  store.heartbeatTimer = setInterval(() => touchLock(store, true), store.heartbeatMs);
  store.heartbeatTimer.unref?.();
}

export function stopHeartbeat(store) {
  if (!store.heartbeatTimer) return;
  clearInterval(store.heartbeatTimer);
  store.heartbeatTimer = null;
}

export function touchLock(store, force = false) {
  if (!store.ownsLock || store.readOnly || store.closed) return;
  const now = Date.now();
  if (!force && now - store.lastHeartbeatAt < Math.max(1_000, Math.floor(store.heartbeatMs / 2))) return;
  store.lastHeartbeatAt = now;
  try {
    fs.writeFileSync(heartbeatFile(store, store.lockNonce), String(now));
  } catch {
    // heartbeat is best-effort
  }
  // Refresh lock.json only inside the acquisition claim: a heartbeat must never
  // overwrite a lock that a new owner acquired after us.
  const claim = tryClaim(store, { retries: 0, allowStale: false });
  if (!claim) return;
  try {
    const lock = readJson(store.lockFile, null);
    if (lock && lock.pid === process.pid && lock.nonce === store.lockNonce) {
      writeJson(store.lockFile, { ...lock, heartbeatAt: now });
    }
  } catch {
    // lock heartbeat is best-effort
  } finally {
    releaseClaim(store, claim);
  }
}

/** True when lock.json still names this process and this acquisition. */
export function ownsLockFile(store) {
  if (!store.ownsLock) return false;
  const lock = readJson(store.lockFile, null);
  if (!lock || lock.pid !== process.pid) return false;
  return !store.lockNonce || lock.nonce === store.lockNonce;
}

/** Remove this acquisition's heartbeat file; never touches lock.json. */
export function cleanupLockFiles(store) {
  if (!store.lockNonce) return;
  try { fs.unlinkSync(heartbeatFile(store, store.lockNonce)); } catch { /* ignore */ }
}

export function degrade(store, message) {
  store.readOnly = true;
  stopHeartbeat(store);
  return new BoardError('log-forked', message, { status: 503 });
}
