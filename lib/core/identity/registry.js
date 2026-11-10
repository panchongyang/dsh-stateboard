// Machine-local workspace binding registry: <root>/workspace-bindings.json.
//
// A binding ties one local directory to one projectId with a role (main or
// worktree). Bindings are never repointed: moving a root retires the old binding
// and creates a new one. The project log stays authoritative for the main
// workspace path; projects without a persisted main binding get an implicit
// one derived from their log/meta, so a missing or older registry never hides a
// project. Persisting implicit bindings is an explicit migration step.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BoardError } from '../errors.js';
import { canonicalKey, sha256, writeJson } from '../util.js';

export const REGISTRY_FILE = 'workspace-bindings.json';
export const REGISTRY_SCHEMA = 1;
const LOCK_STALE_MS = 60_000;
const ROLES = new Set(['main', 'worktree']);

export function newBindingId() {
  return 'bnd_' + Date.now().toString(36) + crypto.randomBytes(6).toString('hex');
}

/** Deterministic id for a legacy project's implicit main binding, stable across restarts. */
export function legacyBindingId(projectId, root) {
  return 'bnd_legacy_' + sha256(projectId + '\n' + canonicalKey(root)).slice(0, 16);
}

function emptyRegistry() {
  return { schemaVersion: REGISTRY_SCHEMA, rev: 0, updatedAt: null, bindings: [] };
}

function validBinding(b) {
  return b && typeof b === 'object'
    && typeof b.bindingId === 'string' && b.bindingId.startsWith('bnd_')
    && typeof b.projectId === 'string' && /^prj_[0-9a-f]{16}$/.test(b.projectId)
    && typeof b.root === 'string' && path.isAbsolute(b.root)
    && ROLES.has(b.role)
    && (b.status === 'active' || b.status === 'retired');
}

/** Parse the registry file. A missing file is an empty registry; anything unreadable is an error. */
export function readRegistry(rootDir) {
  const file = path.join(rootDir, REGISTRY_FILE);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { registry: emptyRegistry(), mtimeMs: 0 };
    throw new BoardError('bindings-unreadable', 'cannot read ' + REGISTRY_FILE + ': ' + error.message, { status: 503 });
  }
  let data;
  try { data = JSON.parse(text); } catch {
    throw new BoardError('bindings-unreadable', REGISTRY_FILE + ' is not valid JSON', { status: 503 });
  }
  if (!data || data.schemaVersion !== REGISTRY_SCHEMA) {
    throw new BoardError('bindings-unsupported', REGISTRY_FILE + ' has unsupported schemaVersion ' + JSON.stringify(data && data.schemaVersion), { status: 503 });
  }
  if (!Array.isArray(data.bindings) || !data.bindings.every(validBinding) || !Number.isInteger(data.rev)) {
    throw new BoardError('bindings-unreadable', REGISTRY_FILE + ' has a malformed binding record', { status: 503 });
  }
  return { registry: data, mtimeMs: fs.statSync(file).mtimeMs };
}

function acquireLock(rootDir) {
  const lockFile = path.join(rootDir, REGISTRY_FILE + '.lock');
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString() }));
      fs.closeSync(fd);
      return lockFile;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      let age = 0;
      try { age = Date.now() - fs.statSync(lockFile).mtimeMs; } catch { continue; }
      // Never delete someone else's lock: a stale one is reported for a human to inspect.
      if (age > LOCK_STALE_MS) {
        throw new BoardError('bindings-locked', 'binding registry lock is stale; verify no writer is running, then remove ' + lockFile, { status: 503, details: { lockFile, ageMs: age } });
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  throw new BoardError('bindings-locked', 'binding registry is busy', { status: 503, details: { lockFile } });
}

/**
 * Read-modify-write under an exclusive lock. `mutate(registry)` returns the
 * records to add/retire; validation runs against the freshly read file, so a
 * concurrent writer cannot be overwritten with a stale view.
 */
export function updateRegistry(rootDir, mutate, io = fs) {
  const lockFile = acquireLock(rootDir);
  try {
    const { registry } = readRegistry(rootDir);
    const next = structuredClone(registry);
    const result = mutate(next);
    assertUnique(next.bindings);
    next.rev = registry.rev + 1;
    next.updatedAt = new Date().toISOString();
    writeJson(path.join(rootDir, REGISTRY_FILE), next, io);
    return { registry: next, result };
  } finally {
    try { fs.unlinkSync(lockFile); } catch { /* already gone */ }
  }
}

/** One active binding per root, one active main binding per project. */
export function assertUnique(bindings) {
  const roots = new Map();
  const mains = new Map();
  for (const b of bindings) {
    if (b.status !== 'active') continue;
    const key = canonicalKey(b.root);
    if (roots.has(key) && roots.get(key) !== b.bindingId) {
      throw new BoardError('identity-conflict', 'root is already bound: ' + b.root, { status: 409, details: { root: b.root, bindingIds: [roots.get(key), b.bindingId] } });
    }
    roots.set(key, b.bindingId);
    if (b.role === 'main') {
      if (mains.has(b.projectId)) {
        throw new BoardError('identity-conflict', 'project has two active main bindings: ' + b.projectId, { status: 409, details: { projectId: b.projectId } });
      }
      mains.set(b.projectId, b.bindingId);
    }
  }
}

export function makeBinding({ projectId, root, role, actor, bindingId }) {
  return {
    bindingId: bindingId || newBindingId(),
    projectId,
    root,
    role,
    status: 'active',
    createdAt: new Date().toISOString(),
    createdBy: actor ? String(actor.kind || 'system') : 'system',
  };
}

export function retire(binding, reason) {
  binding.status = 'retired';
  binding.retiredAt = new Date().toISOString();
  binding.reason = reason;
}
