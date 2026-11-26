// ProjectService owns project metadata, workspace bindings and shared handles.
// ProjectHandle lives in handle.js and is re-exported for existing callers.

import fs from 'node:fs';
import path from 'node:path';
import { BoardError } from './errors.js';
import { JsonlStore, readStateWithoutLock } from './store.js';
import { openSpaceDirectory, projectDataDir } from './store/space-home.js';
import { ProjectListReader, projectListError, projectSummary, sortProjectList } from './project-list-reader.js';
import { DEFAULT_POLICY } from './normalize.js';
import { canonicalKey, ensureDir, newId, readJson, resolveWorkspacePath, writeJson } from './util.js';
import { ProjectHandle } from './handle.js';
import { queryWorkspaceProjection, hintWorkspaceProjection, closeWorkspaceProjection } from './reader/projection-service.js';
import { createProjectReader } from './project-reader.js';
import { commitPrefix } from './transaction/published.js';
import { SHARED_HANDLES, releaseHandle, scopedHandle, openWriter, repairAcceptance,
  commitCreation } from './runtime/service-writer.js';
import { prepareFirstCommand } from './runtime/serial-command.js';
import { isInlineWrite } from './commands/doc.js';
import { acquireInlineWriter } from './inline-doc-access.js';
import { BindingIndex } from './identity/bindings.js';
import { readMarker, resolveWorkspace } from './identity/discover.js';
import { newProjectId, syncMainBinding } from './identity/ops.js';
import { readRegistry } from './identity/registry.js';

export { MAX_DOC_LINKS } from './normalize.js';
export { ProjectHandle };

export class ProjectService {
  /**
   * `privilegedInlineWrites` is the constructor-only escape hatch for synthetic
   * fixtures, seed scripts and the offline legacy-board importer: the default
   * inline policy is "disabled", and only those internal paths need to mint
   * inline records. No config file, environment variable, HTTP route or agent
   * tool reaches it; production entry points never set it.
   */
  constructor({ rootDir, spaceRoot, assertAccess, projectionDenyPrefixes, clock, idgen, storeFactory, privilegedInlineWrites = false, offlineMaintenance = false } = {}) {
    if (rootDir !== undefined && spaceRoot !== undefined) throw new TypeError('Select either a legacy rootDir or an owning spaceRoot');
    this.spaceHome = spaceRoot === undefined ? null : openSpaceDirectory(spaceRoot);
    this.rootDir = this.spaceHome?.namespace ?? path.resolve(rootDir || '');
    this.projectsDir = path.join(this.rootDir, 'projects');
    this.assertAccess = assertAccess;
    this.projectionDenyPrefixes = projectionDenyPrefixes;
    this.clock = clock || (() => new Date());
    this.idgen = idgen || ((prefix) => newId(prefix));
    this.storeFactory = storeFactory || ((dir, meta) => new JsonlStore(dir, meta));
    this.privilegedInlineWrites = privilegedInlineWrites === true;
    this.offlineMaintenance = offlineMaintenance === true;
    this.handles = new Map();
    this._closed = false;
    this._reader = null;
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
    if (this.spaceHome) {
      const meta = this.spaceHome.readMeta();
      this.metas.clear();
      if (meta) this.metas.set(meta.projectId, { ...meta, dir: this.spaceHome.state });
      return this.reloadBindings();
    }
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
    if (this.spaceHome) {
      // Keep the logged main ID portable across A→B→C; only the physical root
      // changes. No registry or old machine path is read, and no alias grants a
      // new writable registration identity.
      return this._index = new BindingIndex([], this.metas, { spaceRoot: this.spaceHome.root });
    }
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
    if (this._closed) return;
    this._closed = true;
    const projectionClosed = closeWorkspaceProjection(this); // Detached I/O never owns the writer.
    await Promise.all([this._projectList.close(), this._reader?.close()]);
    for (const handle of this.handles.values()) {
      const dir = handle.meta?.dir || '';
      const outcome = releaseHandle(dir);
      // 'shared' means another service still holds this handle: leave it open.
      // 'last' already closed it. Only an unknown entry needs closing here.
      if (outcome === 'none') handle.close();
    }
    this.handles.clear();
    await projectionClosed;
  }

  // Synchronous compatibility for offline scripts. HTTP must use the async
  // variant: cold log validation/replay belongs off the host event loop.
  listProjects() {
    const out = [];
    for (const [id, meta] of this.metas) {
      const live = this._projectList.live(id);
      if (live) { out.push(live); continue; }
      const store = new JsonlStore(projectDataDir(this, id), meta, { lock: false });
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
    const handle = this.handles.get(projectId) || SHARED_HANDLES.get(projectDataDir(this, projectId))?.handle;
    return handle && !handle.closed && !handle.readOnly && !handle.store?.readOnly ? handle : null;
  }

  publishedState(projectId) {
    if (this.spaceHome) this._assertOpen(); // A cached prompt or reader cannot outlive its physical home.
    const handle = this.lookupLiveWriter(projectId);
    if (!handle) return null;
    const history = handle.store.commits, length = history.length;
    let commits;
    return Object.freeze(Object.defineProperties({ meta: structuredClone(handle.meta),
      get commits() { return commits ??= commitPrefix(history, length); },
      readBlob: (hash) => handle.store.readBlob(hash),
      readMigrationBlob: (hash) => handle.store.readMigrationBlob?.(hash) ?? handle.store.readBlob(hash),
    }, Object.getOwnPropertyDescriptors(handle.model.readSnapshot())));
  }

  /** Constant-time publication fence; never scans command IDs or timeline. */
  publishedRevision(projectId) {
    const handle = this.lookupLiveWriter(projectId);
    return handle ? { lastSeq: handle.rev, lastHash: handle.lastHash } : null;
  }

  _assertOpen() {
    this.assertAccess?.(); // Includes the original writer queue at the actual synchronous commit boundary.
    if (this._closed) throw new BoardError('handle-closed', 'project service is closed', { status: 503 });
    this.spaceHome?.check();
  }

  _serviceHandle(handle) { return scopedHandle(this, handle); }

  _openSync(projectId) { return openWriter(this, projectId, { explicit: true }); }

  _acquireCommandWriter(projectId) { return openWriter(this, projectId); }

  /**
   * meta.json and the main binding are derived from the log. If a post-commit
   * relocate write failed, the log's project/updated event is authoritative;
   * rewrite them here. Idempotent and best-effort.
   */
  _healMeta(handle) {
    if (this.spaceHome) return; // In this layout no address is ever healed from a historical event.
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

  /** Constructor-gated offline repair; never a public command DTO. */
  restoreHistoricalAcceptance(projectId, request) { return repairAcceptance(this, projectId, request); }

  /** Compatibility query delegates only to the detached read port. */
  query(projectId, view, params = {}, actor = {}) {
    this._assertOpen();
    this._reader ??= createProjectReader(this);
    return this._reader.query(projectId, view, params, actor);
  }

  queryWorkspaceProjection(projectId, request, authority) { return queryWorkspaceProjection(this,projectId,request,authority); }
  hintWorkspaceProjection(projectId, authority) { return hintWorkspaceProjection(this,projectId,authority); }

  async command(projectId, cmd, options) {
    if (this.spaceHome && (cmd?.op === 'project.relocate' || (cmd?.projectId !== undefined && cmd.projectId !== projectId))) {
      throw new BoardError('invalid-command', 'A business command cannot change the owning space', { status: 400 });
    }
    const handle = isInlineWrite(cmd?.op) ? await acquireInlineWriter(this, projectId, cmd) : this._acquireCommandWriter(projectId);
    // The trusted ingress supplies the session-binding context in options; this
    // layer forwards it unchanged as the model command's second argument.
    return handle.command(cmd, options);
  }

  /**
   * Which project (and which local binding) a working directory belongs to.
   * Returns null when nothing claims it; conflicts and unbound markers throw.
   */
  resolveWorkspace(workspacePath) {
    if (this.spaceHome) {
      this.refreshFromDisk();
      const id = this.metas.keys().next().value;
      return id === undefined ? null : this._index.mainOf(id);
    }
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
    if (this.spaceHome) projectDataDir(this, projectId);
    const meta = this.metas.get(projectId) || readJson(path.join(this.projectsDir, projectId, 'meta.json'), null);
    if (!meta || meta.projectId !== projectId || !meta.project) return null;
    return readStateWithoutLock(meta.dir || path.join(this.projectsDir, projectId), { ...meta });
  }
  peekProject(projectId) {
    return this.peekProjectState(projectId)?.project ?? null;
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
    this._assertOpen();
    if (ignoreMarker && (!actor || (actor.kind !== 'human' && actor.kind !== 'system'))) {
      throw new BoardError('forbidden-role', 'creating over a project marker is human/system only', { status: 403 });
    }
    this.refreshFromDisk();
    const { projectId, resolved } = this._createTarget(workspacePath, ignoreMarker);
    if (projectId) return this._openSync(projectId);
    const meta = this._newProjectMeta(resolved, name);
    return commitCreation(this, meta, actor).handle;
  }

  /** First native business write: prepare fully before reserving the workspace. */
  async commandInWorkspace(workspacePath, cmd, { agentSessionSource } = {}) {
    this._assertOpen();
    if (agentSessionSource !== 'tool' || cmd?.actor?.kind !== 'agent' || typeof cmd.actor.sessionId !== 'string' || !cmd.actor.sessionId) {
      throw new BoardError('forbidden-role', 'first workspace writes require an owning native agent session', { status: 403 });
    }
    if (cmd.op !== 'task.create' && cmd.op !== 'plan.create' && !(cmd.op === 'plan.publish' && cmd.createIfMissing === true && !cmd.planId)) {
      throw new BoardError('invalid-command', 'this command requires an existing project', { status: 400 });
    }
    // A project may have become discoverable since the host sampled the cwd.
    this.refreshFromDisk();
    const target = this._createTarget(workspacePath, false, true);
    if (target.projectId) {
      const result = await this.command(target.projectId, { ...cmd, projectId: target.projectId }, { agentSessionSource });
      return { projectId: target.projectId, result };
    }
    const meta = this._newProjectMeta(target.resolved, path.basename(workspacePath));
    const ticket = prepareFirstCommand(this, meta, { ...cmd, projectId: meta.projectId }, { agentSessionSource });
    const { result } = commitCreation(this, meta, cmd.actor, ticket);
    return { projectId: meta.projectId, result };
  }

  _createTarget(workspacePath, ignoreMarker, discoverOwning = false) {
    if (this.spaceHome) {
      if (workspacePath !== undefined && canonicalKey(workspacePath) !== canonicalKey(this.spaceHome.root)) {
        throw new BoardError('invalid-command', 'Creation cannot change the owning space', { status: 400 });
      }
      return { projectId: this.metas.keys().next().value, resolved: this.spaceHome.root };
    }
    let resolved = resolveWorkspacePath(workspacePath);
    if (!ignoreMarker) {
      // A linked worktree root (marked or not) whose own binding/marker agrees
      // with the main checkout's project joins it; disagreements throw here.
      let found = null;
      try { found = this.resolveWorkspace(resolved); } catch (error) { if (discoverOwning || error?.code === 'identity-conflict') throw error; }
      if (found && (discoverOwning || (found.via === 'git-common-dir' && canonicalKey(found.root) === canonicalKey(resolved)))) return { projectId: found.projectId, resolved };
    }
    const existing = this._existingForCreate(resolved, ignoreMarker);
    return { projectId: existing, resolved };
  }

  _newProjectMeta(resolved, name) {
    let projectId = newProjectId();
    while (this.metas.has(projectId) || fs.existsSync(path.join(this.projectsDir, projectId))) projectId = newProjectId();
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
    return { schemaVersion: 3, projectId, project, createdAt: at };
  }
}