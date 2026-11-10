// In-memory view of local bindings: persisted registry records plus one
// implicit main binding for every project that has no persisted main binding
// (legacy projects, or a create whose registry write failed). Rebuilt whenever
// metas or the registry change; lookups never touch the registry file.

import { canonicalKey } from '../util.js';
import { legacyBindingId } from './registry.js';

function safeKey(root) {
  try { return canonicalKey(root); } catch { return null; }
}

export class BindingIndex {
  constructor(persisted, metas) {
    this.persisted = persisted.map((b) => ({ ...b }));
    this.byKey = new Map();
    this.mains = new Map();
    for (const b of this.persisted) {
      if (b.status !== 'active') continue;
      this._add(b);
    }
    for (const [projectId, meta] of metas) {
      if (this.mains.has(projectId)) continue;
      const root = meta && meta.project && meta.project.workspacePath;
      if (typeof root !== 'string' || root === '') continue;
      this._add({ bindingId: legacyBindingId(projectId, root), projectId, root, role: 'main', status: 'active', implicit: true });
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
