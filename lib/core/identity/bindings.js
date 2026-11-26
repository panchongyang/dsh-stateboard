// In-memory view of local bindings: persisted registry records plus one
// implicit main binding for every project that has no persisted main binding
// (legacy projects, or a create whose registry write failed). Rebuilt whenever
// metas or the registry change; lookups never touch the registry file.

import path from 'node:path';
import { canonicalKey, sha256 } from '../util.js';
import { legacyBindingId } from './registry.js';

// Log main roots are already canonical. Never inspect the previous machine's
// path while reconstructing a portable binding for a cold space copy.
export function spaceMainBindingId(projectId, loggedRoot) {
  if (typeof loggedRoot !== 'string' || !path.isAbsolute(loggedRoot)) throw new TypeError('A logged absolute main root is required');
  const normalized = path.resolve(loggedRoot);
  const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  return 'bnd_legacy_' + sha256(projectId + '\n' + key).slice(0, 16);
}

function safeKey(root) {
  try { return canonicalKey(root); } catch { return null; }
}

export class BindingIndex {
  constructor(persisted, metas, { spaceRoot } = {}) {
    this.persisted = persisted.map((b) => ({ ...b }));
    this.byKey = new Map();
    this.mains = new Map();
    for (const b of this.persisted) {
      if (b.status !== 'active') continue;
      this._add(b);
    }
    for (const [projectId, meta] of metas) {
      if (this.mains.has(projectId)) continue;
      const loggedRoot = meta && meta.project && meta.project.workspacePath;
      const root = spaceRoot ?? loggedRoot;
      if (typeof root !== 'string' || root === '') continue;
      const bindingId = spaceRoot === undefined ? legacyBindingId(projectId, root) : spaceMainBindingId(projectId, loggedRoot);
      this._add({ bindingId, projectId, root, role: 'main', status: 'active', implicit: true });
    }
  }

  _add(binding) {
    const key = safeKey(binding.root);
    if (!key) return;
    if (!this.byKey.has(key)) this.byKey.set(key, []);
    this.byKey.get(key).push(binding);
    if (binding.role === 'main' && !this.mains.has(binding.projectId)) this.mains.set(binding.projectId, binding);
  }

  byRoot(dir) {
    const key = safeKey(dir);
    return key ? this.byKey.get(key) || [] : [];
  }

  mainOf(projectId) {
    return this.mains.get(projectId) || null;
  }

  activeFor(projectId) {
    const out = [];
    for (const list of this.byKey.values()) for (const b of list) if (b.projectId === projectId) out.push(b);
    return out;
  }

  /** Main roots → projectId, the shape the legacy pathIndex has always had. */
  mainPathIndex() {
    const out = new Map();
    for (const b of this.mains.values()) {
      const key = safeKey(b.root);
      if (key) out.set(key, b.projectId);
    }
    return out;
  }

  implicitMains() {
    return [...this.mains.values()].filter((b) => b.implicit);
  }
}
