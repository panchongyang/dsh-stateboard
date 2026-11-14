// ProjectService owns project metadata, workspace bindings and shared handles.
// ProjectHandle lives in handle.js and is re-exported for existing callers.

import fs from 'node:fs';
import path from 'node:path';
import { BoardError } from './errors.js';
import { JsonlStore, makeCommit, readStateWithoutLock } from './store.js';
import { ProjectListReader, projectListError, projectSummary, sortProjectList } from './project-list-reader.js';
import { DEFAULT_POLICY, actorSystem } from './normalize.js';
import { canonicalKey, ensureDir, newId, readJson, resolveWorkspacePath, writeJson } from './util.js';
import { ProjectHandle } from './handle.js';
import { isInlineWrite } from './commands/doc.js';
import { acquireInlineWriter } from './inline-doc-access.js';
import { BindingIndex } from './identity/bindings.js';
import { mainEquivalent, readMarker, resolveWorkspace } from './identity/discover.js';
import { newProjectId, syncMainBinding } from './identity/ops.js';
import { makeBinding, readRegistry, retire, updateRegistry } from './identity/registry.js';

export { MAX_DOC_LINKS } from './normalize.js';
export { ProjectHandle };

// Plugin reload shares one writer per log to keep a single revision counter.
// References keep the handle alive while either service still uses it.
const SHARED_HANDLES = new Map();

function shareHandle(dir, handle) {
  const entry = SHARED_HANDLES.get(dir);
  if (entry && !entry.handle.closed) {
    entry.refs += 1;
    return entry.handle;
  }
  SHARED_HANDLES.set(dir, { handle, refs: 1 });
  return handle;
}

function releaseHandle(dir) {
  const entry = SHARED_HANDLES.get(dir);
  if (!entry) return 'none';
  entry.refs -= 1;
  if (entry.refs > 0) return 'shared';
  SHARED_HANDLES.delete(dir);
  try {
    entry.handle.close();
  } catch {
    // closing twice is not an error
  }
  return 'last';
}

export class ProjectService {
  /**
   * `privilegedInlineWrites` is the constructor-only escape hatch for synthetic
   * fixtures, seed scripts and the offline legacy-board importer: the default
   * inline policy is "disabled", and only those internal paths need to mint
   * inline records. No config file, environment variable, HTTP route or agent
   * tool reaches it; production entry points never set it.
   */
  constructor({ rootDir, clock, idgen, storeFactory, privilegedInlineWrites = false } = {}) {
    this.rootDir = path.resolve(rootDir || '');
    this.projectsDir = path.join(this.rootDir, 'projects');
    this.clock = clock || (() => new Date());
    this.idgen = idgen || ((prefix) => newId(prefix));
    this.storeFactory = storeFactory || ((dir, meta) => new JsonlStore(dir, meta));
    this.privilegedInlineWrites = privilegedInlineWrites === true;
    this.handles = new Map();
    this.metas = new Map();
    this._projectList = new ProjectListReader(this, (id) => this.lookupLiveWriter(id));
    this.registryRev = 0;
    this.registryError = null;
    this._index = new BindingIndex([], this.metas);
  }

  async init() {
    this.refreshFromDisk();
    return this;
  }

  /**
   * Re-scan project metas and the binding registry. Every identity write calls
   * this first: another process may have created, relocated or bound a project
   * since this service started, and claims must be judged on disk state.
   */
  refreshFromDisk({ strict = false } = {}) {
    ensureDir(this.projectsDir);
    for (const entry of fs.readdirSync(this.projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const meta = readJson(path.join(this.projectsDir, entry.name, 'meta.json'), null);
      // The directory name is the on-disk identity; a staging copy or hand-made
      // folder is never registered under another project's id.
      if (!meta || !meta.projectId || !meta.project || meta.projectId !== entry.name) continue;
      this.metas.set(meta.projectId, { ...meta, dir: path.join(this.projectsDir, entry.name) });
    }
    return this.reloadBindings({ strict });
  }

  /** A project other than `selfId` whose log or binding claims `root`; null when free. */
  claimantOf(root, selfId = null) {
    const bound = this._index.byRoot(root).find((b) => b.projectId !== selfId);
    if (bound) return bound.projectId;
    const logged = this._discoverByWorkspace(canonicalKey(root));
    return logged && logged !== selfId ? logged : null;
  }

  /**
   * Rebuild the binding index from the registry and metas. An unreadable
   * registry degrades to implicit main bindings (meta.json) and every registry
   * write is refused; `strict` surfaces the error instead.
   */
  reloadBindings({ strict = false } = {}) {
    let persisted = [];
    try {
      const { registry } = readRegistry(this.rootDir);
      persisted = registry.bindings;
      this.registryRev = registry.rev;
      this.registryError = null;
    } catch (error) {
      if (strict) throw error;
      this.registryError = error instanceof Error ? error.message : String(error);
    }
    this._index = new BindingIndex(persisted, this.metas);
    return this._index;
  }

  bindings() {
    return this._index;
  }

  /** Main workspace roots → projectId; a derived read-only view. */
  get pathIndex() {
    return this._index.mainPathIndex();
  }

  registerProjectDir(projectId) {
    const dir = path.join(this.projectsDir, projectId);
    const meta = readJson(path.join(dir, 'meta.json'), null);
    if (!meta || meta.projectId !== projectId || !meta.project) throw new BoardError('not-found', 'project not found: ' + projectId, { status: 404 });
    this.metas.set(projectId, { ...meta, dir });
    this.reloadBindings();
  }

  async close() {
    await this._projectList.close();
    for (const handle of this.handles.values()) {
      const dir = handle.meta?.dir || '';
      const outcome = releaseHandle(dir);
      // 'shared' means another service still holds this handle: leave it open.
      // 'last' already closed it. Only an unknown entry needs closing here.
      if (outcome === 'none') handle.close();
    }
    this.handles.clear();
  }

  // Synchronous compatibility for offline scripts. HTTP must use the async
  // variant: cold log validation/replay belongs off the host event loop.
  listProjects() {
    const out = [];
    for (const [id, meta] of this.metas) {
      const live = this._projectList.live(id);
      if (live) { out.push(live); continue; }
      const store = new JsonlStore(path.join(this.projectsDir, id), meta, { lock: false });
      try {
        const data = store.open();
        out.push(projectSummary(id, data.state, data.lastSeq));
      } catch (error) {
        out.push(projectListError(id, error));
      } finally {
        try { store.close(); } catch { /* lock-free reader */ }
      }
    }
    return sortProjectList(out);
  }

  listProjectsAsync() {
    return this._projectList.list();
  }
  // Look up a published writer without opening or retaining it.
  lookupLiveWriter(projectId) {
    const handle = this.handles.get(projectId) || SHARED_HANDLES.get(path.join(this.projectsDir, projectId))?.handle;
    return handle && !handle.closed && !handle.readOnly && !handle.store?.readOnly ? handle : null;
  }

  _openSync(projectId) {
    const cached = this.handles.get(projectId);
    if (cached) {
      // A plugin reload can close a handle that another service still caches.
      // Never hand out a closed handle; drop it and rebuild from disk.
      if (!cached.closed) return cached;
      this.handles.delete(projectId);
    }
    const known = this.metas.get(projectId);
    const meta = known || readJson(path.join(this.projectsDir, projectId, 'meta.json'), null);
    if (!meta || !meta.project) throw new BoardError('not-found', 'project not found: ' + projectId, { status: 404 });
    const fullMeta = { ...meta, dir: path.join(this.projectsDir, projectId) };
    this.metas.set(projectId, fullMeta);
    if (!known) this.reloadBindings();
    const shared = SHARED_HANDLES.get(fullMeta.dir);
    if (shared && !shared.handle.closed) {
      const reused = shareHandle(fullMeta.dir, shared.handle);
      this.handles.set(projectId, reused);
      return reused;
    }
    const store = this.storeFactory(fullMeta.dir, fullMeta);
    const data = store.open();
    const handle = new ProjectHandle(this, fullMeta, store, data);
    this.handles.set(projectId, handle);
    shareHandle(fullMeta.dir, handle);
    this._healMeta(handle);
    if (!handle.readOnly) handle.recover();
    return handle;
  }

  /**
   * meta.json and the main binding are derived from the log. If a post-commit
   * relocate write failed, the log's project/updated event is authoritative;
   * rewrite them here. Idempotent and best-effort.
   */
  _healMeta(handle) {
    const actual = handle.state.project;
    const metaProject = handle.meta && handle.meta.project;
    if (!actual || !metaProject) return;
    try {
      if (actual.workspacePath !== metaProject.workspacePath || actual.name !== metaProject.name || actual.phase !== metaProject.phase) {
        writeJson(path.join(handle.meta.dir, 'meta.json'), {
          schemaVersion: 3,
          projectId: actual.id,
          project: actual,
          createdAt: handle.meta.createdAt || actual.createdAt,
        });
        handle.meta.project = actual;
        handle.meta.projectId = actual.id;
        this.metas.set(actual.id, handle.meta);
        this.reloadBindings();
      }
      const main = this._index.mainOf(actual.id);
      if (main && !main.implicit && canonicalKey(main.root) !== canonicalKey(actual.workspacePath)) {
        syncMainBinding(this, actual.id, actual.workspacePath, 'healed-from-log');
      }
    } catch (error) {
      handle.metaWarning = 'meta-heal-failed: ' + (error instanceof Error ? error.message : String(error));
    }
  }

  async open(projectId) {
    return this._openSync(projectId);
  }

  async command(projectId, cmd) {
    const handle = isInlineWrite(cmd?.op) ? await acquireInlineWriter(this, projectId, cmd) : await this.open(projectId);
    return handle.command(cmd);
  }

  /**
   * Which project (and which local binding) a working directory belongs to.
   * Returns null when nothing claims it; conflicts and unbound markers throw.
   */
  resolveWorkspace(workspacePath) {
    const found = resolveWorkspace(workspacePath, this._index, {
      projectExists: (id) => this.metas.has(id),
      mainRootOf: (id) => this._index.mainOf(id)?.root || null,
    });
    if (found) return found;
    const legacy = this._discoverByWorkspace(canonicalKey(workspacePath));
    return legacy ? { projectId: legacy, bindingId: null, role: 'main', root: resolveWorkspacePath(workspacePath), via: 'log' } : null;
  }

  async openByWorkspace(workspacePath) {
    const found = this.resolveWorkspace(workspacePath);
    return found ? this._openSync(found.projectId) : null;
  }

  /** Lock-free replay. Absent project metadata yields null; unreadable logs throw. */
  peekProjectState(projectId) {
    const meta = this.metas.get(projectId) || readJson(path.join(this.projectsDir, projectId, 'meta.json'), null);
    if (!meta || meta.projectId !== projectId || !meta.project) return null;
    return readStateWithoutLock(meta.dir || path.join(this.projectsDir, projectId), { ...meta });
  }
  peekProject(projectId) {
    return this.peekProjectState(projectId)?.project ?? null;
  }

  /**
   * 锁外回放的只读视图：不调用 open、不获取 writer、不修尾、不恢复在途工作。
   * 只给纯读端点使用；返回值只保证 state 与 service，不提供命令或租约。
   */
  peekReadOnlyHandle(projectId) {
    let state;
    try {
      state = this.peekProjectState(projectId);
    } catch {
      throw new BoardError('store-unavailable', 'project state is not readable', { status: 503 });
    }
    if (!state) throw new BoardError('not-found', 'project not found: ' + projectId, { status: 404 });
    return { id: projectId, state, service: this, readOnly: true, closed: false };
  }

  /**
   * A failed post-commit relocate can leave meta.json pointing at the old
   * workspace. Only on a miss do we scan the lock-free logs for the
   * authoritative project/updated workspacePath; found projects are healed by
   * _openSync/_healMeta. This keeps normal entry from creating a duplicate.
   */
  _discoverByWorkspace(key) {
    for (const [id, meta] of this.metas) {
      const dir = meta.dir || path.join(this.projectsDir, id);
      const store = new JsonlStore(dir, meta, { lock: false });
      try {
        const data = store.open();
        if (canonicalKey(data.state.project.workspacePath) === key) return id;
      } catch {
        // corrupt/unsupported project: skip; open(projectId) will surface it
      } finally {
        try { store.close(); } catch { /* read-only */ }
      }
    }
    return null;
  }

  /** Same root → the existing project. Any other or disagreeing claim on the root is refused, never merged. */
  _existingForCreate(resolved, ignoreMarker) {
    const bound = this._index.byRoot(resolved);
    const marker = ignoreMarker ? null : readMarker(resolved);
    const owners = [...new Set(bound.map((b) => b.projectId))];
    if (owners.length > 1 || (owners.length === 1 && marker && marker.projectId !== owners[0])) {
      throw new BoardError('identity-conflict', 'directory is claimed by more than one project: ' + resolved, {
        status: 409, details: { root: resolved, markerProjectId: marker ? marker.projectId : null, bindings: bound.map((b) => ({ bindingId: b.bindingId, projectId: b.projectId, role: b.role })) },
      });
    }
    if (owners.length === 1) {
      if (!this.metas.has(owners[0])) throw new BoardError('board-data-missing', 'bound project has no board data on this machine: ' + owners[0], { status: 409, details: { projectId: owners[0], root: resolved } });
      return owners[0];
    }
    const legacy = this._discoverByWorkspace(canonicalKey(resolved));
    if (legacy) {
      if (marker && marker.projectId !== legacy) throw new BoardError('identity-conflict', 'marker disagrees with the project logged at ' + resolved, { status: 409, details: { root: resolved, markerProjectId: marker.projectId, projectId: legacy } });
      return legacy;
    }
    if (marker) {
      const known = this.metas.has(marker.projectId);
      throw new BoardError(known ? 'binding-required' : 'board-data-missing', 'directory carries a marker for ' + marker.projectId + '; relocate, bind, fork or import explicitly', {
        status: 409, details: { projectId: marker.projectId, markerDir: resolved },
      });
    }
    if (this.registryError) throw new BoardError('bindings-unreadable', 'binding registry is unreadable: ' + this.registryError, { status: 503 });
    return null;
  }

  async createProject({ workspacePath, name, actor, ignoreMarker = false } = {}) {
    if (ignoreMarker && (!actor || (actor.kind !== 'human' && actor.kind !== 'system'))) {
      throw new BoardError('forbidden-role', 'creating over a project marker is human/system only', { status: 403 });
    }
    // Fresh disk read: another process may have bound or moved a project since init.
    this.refreshFromDisk();
    let resolved = resolveWorkspacePath(workspacePath);
    if (!ignoreMarker) {
      // A linked worktree root (marked or not) whose own binding/marker agrees
      // with the main checkout's project joins it; disagreements throw here.
      let found = null;
      try { found = this.resolveWorkspace(resolved); } catch (error) { if (error && error.code === 'identity-conflict') throw error; }
      if (found && found.via === 'git-common-dir' && canonicalKey(found.root) === canonicalKey(resolved)) return this._openSync(found.projectId);
    }
    let existing = this._existingForCreate(resolved, ignoreMarker);
    if (existing) return this._openSync(existing);
    if (!ignoreMarker) {
      // Created from a linked worktree: the project lives at the main checkout,
      // so a worktree never becomes the shared main workspace or evidence root.
      const main = mainEquivalent(resolved);
      if (main) {
        resolved = resolveWorkspacePath(main);
        existing = this._existingForCreate(resolved, false);
        if (existing) return this._openSync(existing);
      }
    }
    let projectId = newProjectId();
    while (this.metas.has(projectId) || fs.existsSync(path.join(this.projectsDir, projectId))) projectId = newProjectId();
    // Bind first, under the registry lock: a concurrent create of the same root
    // in another process loses here, before any project directory exists.
    const binding = makeBinding({ projectId, root: resolved, role: 'main', actor });
    updateRegistry(this.rootDir, (registry) => { registry.bindings.push(binding); });
    let handle;
    try {
      handle = this._createLog(projectId, resolved, name, actor);
    } catch (error) {
      if (!this._discardUnbornProject(projectId)) {
        // Genesis bytes may be durable: keep the binding and register the data so
        // a retry opens (and surfaces) this project instead of minting a second one.
        try { this.registerProjectDir(projectId); } catch { this.reloadBindings(); }
        throw error;
      }
      try {
        updateRegistry(this.rootDir, (registry) => {
          const own = registry.bindings.find((b) => b.bindingId === binding.bindingId && b.status === 'active');
          if (own) retire(own, 'create-failed');
        });
      } catch { /* the binding then reports board-data-missing; never a silent duplicate */ }
      this.reloadBindings();
      throw error;
    }
    this.reloadBindings();
    return handle;
  }

  /** Remove a directory this create made when no genesis bytes reached the log; true when discarded. */
  _discardUnbornProject(projectId) {
    const dir = path.join(this.projectsDir, projectId);
    const log = path.join(dir, 'commits.jsonl');
    let size;
    try { size = fs.statSync(log).size; } catch (error) { size = error && error.code === 'ENOENT' ? 0 : -1; }
    const cached = this.handles.get(projectId);
    if (cached) { try { cached.close(); } catch { /* half-open */ } this.handles.delete(projectId); }
    releaseHandle(dir);
    // Only a provably absent or empty log authorises deletion; any stat doubt keeps the data.
    if (size !== 0) return false;
    this.metas.delete(projectId);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* left for fsck; it has no log */ }
    return true;
  }

  _createLog(projectId, resolved, name, actor) {
    const dir = path.join(this.projectsDir, projectId);
    ensureDir(dir);
    const at = new Date().toISOString();
    const project = {
      schemaVersion: 3,
      id: projectId,
      workspacePath: resolved,
      name: typeof name === 'string' && name.trim() !== '' ? name.trim() : path.basename(resolved),
      phase: 'active',
      rev: 0,
      policy: { ...DEFAULT_POLICY },
      // Inline documents are archive-only from the first shipped version on;
      // a human may re-enable writes per project with doc.inline_policy.
      inlineWritesDisabled: true,
      focusPlanId: null,
      createdAt: at,
      updatedAt: at,
    };
    const meta = { schemaVersion: 3, projectId, project, createdAt: at };
    writeJson(path.join(dir, 'meta.json'), meta);
    const store = this.storeFactory(dir, meta);
    const data = store.open();
    const handle = new ProjectHandle(this, { ...meta, dir }, store, data);
    const commit = makeCommit(1, 'genesis', actor || actorSystem(), 'cmd_create_' + projectId, 0, [{ type: 'project/created', data: project }]);
    try {
      store.append(commit);
    } catch (error) {
      // Release the lock so a retry in this process can reopen and judge the log.
      try { store.close(); } catch { /* already degraded */ }
      throw error;
    }
    handle.rev = 1;
    handle.lastHash = commit.hash;
    handle.cmdIds.add(commit.cmdId);
    handle.state.project = project;
    handle.state.lastSeq = 1;
    handle.state.lastHash = commit.hash;
    handle.state.project.rev = 1;
    this.metas.set(projectId, { ...meta, dir });
    this.handles.set(projectId, handle);
    shareHandle(dir, handle);
    // A fresh project has no in-flight work, but the handle still gets its one
    // recovery pass so "recovered" is true from the start.
    if (!handle.readOnly) handle.recover();
    return handle;
  }
}
