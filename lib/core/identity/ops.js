// Explicit, human/system-only identity operations. Every write goes through the
// locked registry update; project history is only ever appended through the
// existing project.relocate command, never edited.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BoardError } from '../errors.js';
import { JsonlStore } from '../store.js';
import { canonicalJSON, canonicalKey, readJson, resolveWorkspacePath, sha256 } from '../util.js';
import { readMarker, writeMarker } from './discover.js';
import { legacyBindingId, makeBinding, retire, updateRegistry } from './registry.js';

const PROJECT_ID = /^prj_[0-9a-f]{16}$/;

export function newProjectId() {
  return 'prj_' + crypto.randomBytes(8).toString('hex');
}

function assertOperator(actor, op) {
  if (!actor || (actor.kind !== 'human' && actor.kind !== 'system')) {
    throw new BoardError('forbidden-role', op + ' is human/system only', { status: 403 });
  }
}

function existingDir(input) {
  let root;
  try { root = resolveWorkspacePath(input); } catch {
    throw new BoardError('invalid-command', 'workspacePath is required', { status: 400 });
  }
  let stat = null;
  try { stat = fs.statSync(root); } catch { stat = null; }
  if (!stat || !stat.isDirectory()) throw new BoardError('invalid-command', 'workspace does not exist or is not a directory: ' + root, { status: 400 });
  return root;
}

/** Refuse a root that is bound, logged as another project's workspace, or carries another project's marker. Judged on fresh disk state. */
export function assertRootFree(service, root, projectId = null) {
  service.refreshFromDisk({ strict: true });
  const bound = service.bindings().byRoot(root);
  if (bound.length > 0) {
    throw new BoardError('identity-conflict', 'directory is already bound: ' + root, { status: 409, details: { root, bindings: bound.map((b) => ({ bindingId: b.bindingId, projectId: b.projectId, role: b.role })) } });
  }
  const logged = service.claimantOf(root, projectId);
  if (logged) {
    throw new BoardError('identity-conflict', 'directory is the logged workspace of ' + logged, { status: 409, details: { root, projectId: logged } });
  }
  const marker = readMarker(root);
  if (marker && marker.projectId !== projectId) {
    throw new BoardError('identity-conflict', 'directory carries a marker for ' + marker.projectId, { status: 409, details: { root, markerProjectId: marker.projectId } });
  }
}

/**
 * Align persisted bindings after the main root moved to `root` (retire + create,
 * never repoint). An implicit legacy main follows meta.json by itself and is
 * not persisted here; a same-project worktree binding at `root` is retired.
 */
export function syncMainBinding(service, projectId, root, reason) {
  const index = service.reloadBindings();
  const key = canonicalKey(root);
  const main = index.mainOf(projectId);
  const persistedMain = main && !main.implicit ? main : null;
  const worktreeHere = index.byRoot(root).some((b) => b.projectId === projectId && b.role === 'worktree');
  if (!worktreeHere && (!persistedMain || canonicalKey(persistedMain.root) === key)) return;
  updateRegistry(service.rootDir, (registry) => {
    const active = registry.bindings.filter((b) => b.projectId === projectId && b.status === 'active');
    for (const b of active) if (b.role === 'worktree' && canonicalKey(b.root) === key) retire(b, 'promoted-to-main');
    const current = active.find((b) => b.role === 'main');
    if (current && canonicalKey(current.root) !== key) {
      retire(current, reason);
      registry.bindings.push(makeBinding({ projectId, root, role: 'main' }));
    }
  });
  service.reloadBindings();
}

export function bindWorktree(service, { projectId, workspacePath, actor }) {
  assertOperator(actor, 'bind');
  if (!service.metas.has(projectId)) throw new BoardError('not-found', 'project not found: ' + projectId, { status: 404 });
  const root = existingDir(workspacePath);
  assertRootFree(service, root, projectId);
  const { result } = updateRegistry(service.rootDir, (registry) => {
    const binding = makeBinding({ projectId, root, role: 'worktree', actor });
    registry.bindings.push(binding);
    return binding;
  });
  service.reloadBindings();
  return result;
}

export function unbind(service, { bindingId, reason, actor }) {
  assertOperator(actor, 'unbind');
  service.refreshFromDisk({ strict: true });
  const { result } = updateRegistry(service.rootDir, (registry) => {
    const binding = registry.bindings.find((b) => b.bindingId === bindingId && b.status === 'active');
    if (!binding) throw new BoardError('not-found', 'no active persisted binding ' + bindingId, { status: 404 });
    // An orphan main binding (a create that crashed before its log existed) has no project to relocate.
    if (binding.role === 'main' && service.metas.has(binding.projectId)) throw new BoardError('invalid-command', 'a main binding moves only through project.relocate', { status: 400 });
    retire(binding, typeof reason === 'string' && reason.trim() !== '' ? reason.trim() : 'unbound');
    return binding;
  });
  service.reloadBindings();
  return result;
}

/** A marked copy becomes an independent project: new random id, original history untouched. */
export async function forkWorkspace(service, { workspacePath, name, actor }) {
  assertOperator(actor, 'fork');
  const root = existingDir(workspacePath);
  const marker = readMarker(root);
  if (!marker) throw new BoardError('invalid-command', 'fork needs a .dsh-project.json marker; an unmarked directory is simply a new project', { status: 400 });
  assertRootFree(service, root, marker.projectId);
  const handle = await service.createProject({ workspacePath: root, name, actor, ignoreMarker: true });
  writeMarker(root, handle.id);
  return { handle, forkedFrom: marker.projectId };
}

function peek(dir) {
  const meta = readJson(path.join(dir, 'meta.json'), null);
  if (!meta || typeof meta.projectId !== 'string' || !PROJECT_ID.test(meta.projectId) || !meta.project) {
    throw new BoardError('invalid-command', 'not a project data directory: ' + dir, { status: 400 });
  }
  const store = new JsonlStore(dir, { ...meta, dir }, { lock: false });
  try {
    const data = store.open();
    if (data.state.project.id !== meta.projectId) throw new BoardError('identity-conflict', 'meta.json and log disagree on projectId', { status: 409 });
    return { meta, lastSeq: data.lastSeq, lastHash: data.lastHash, commits: data.commits };
  } finally {
    store.close();
  }
}

function copyProjectDir(source, target) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name.startsWith('lock.json')) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      copyProjectDir(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    }
  }
}

/**
 * Explicit cross-machine import of a project data copy, then local rebind via
 * project.relocate. Re-running after an interruption resumes; a different
 * project under the same id is refused, never overwritten.
 */
export async function importProject(service, { sourceDir, workspacePath, actor }) {
  assertOperator(actor, 'import');
  const source = peek(path.resolve(sourceDir));
  const projectId = source.meta.projectId;
  const root = existingDir(workspacePath);
  const target = path.join(service.projectsDir, projectId);
  let resumed = false;
  if (fs.existsSync(target)) {
    const current = peek(target);
    const at = current.commits[source.lastSeq - 1];
    if (!at || at.hash !== source.lastHash) {
      throw new BoardError('already-exists', 'a different history already exists for ' + projectId, { status: 409, details: { projectId, localLastSeq: current.lastSeq } });
    }
    resumed = true;
  } else {
    assertRootFree(service, root, projectId);
    const staging = path.join(service.projectsDir, '.import-' + crypto.randomBytes(6).toString('hex'));
    fs.mkdirSync(staging, { recursive: true });
    copyProjectDir(path.resolve(sourceDir), staging);
    fs.renameSync(staging, target);
  }
  service.registerProjectDir(projectId);
  const handle = await service.open(projectId);
  if (canonicalKey(handle.workspacePath) !== canonicalKey(root)) {
    await handle.command({
      cmdId: 'cmd_import_rebind_' + crypto.randomBytes(8).toString('hex'),
      actor: { kind: 'system', via: 'system' },
      op: 'project.relocate',
      workspacePath: root,
    });
  } else {
    syncMainBinding(service, projectId, root, 'imported');
  }
  return { projectId, workspacePath: handle.workspacePath, rev: handle.rev, resumed, importedLastSeq: source.lastSeq };
}

/** Dry-run: what migrating implicit legacy bindings would persist. Writes nothing. */
export function planMigration(service) {
  service.reloadBindings({ strict: true });
  const index = service.bindings();
  const actions = [];
  for (const [projectId, meta] of [...service.metas].sort(([a], [b]) => a.localeCompare(b))) {
    const main = index.mainOf(projectId);
    const root = main ? main.root : meta.project.workspacePath;
    let rootExists = false;
    try { rootExists = fs.statSync(root).isDirectory(); } catch { rootExists = false; }
    actions.push({ projectId, root, rootExists, bindingId: main ? main.bindingId : legacyBindingId(projectId, root), action: main && !main.implicit ? 'keep' : 'persist' });
  }
  const conflicts = [];
  for (const list of index.byKey.values()) {
    const ids = [...new Set(list.map((b) => b.projectId))];
    if (ids.length > 1) conflicts.push({ root: list[0].root, projectIds: ids });
  }
  const registryRev = service.registryRev;
  const planHash = sha256(canonicalJSON({ registryRev, actions, conflicts }));
  return { registryRev, actions, conflicts, planHash };
}

export function migrate(service, { confirm, actor }) {
  assertOperator(actor, 'migrate');
  const plan = planMigration(service);
  if (confirm !== plan.planHash) throw new BoardError('stale-revision', 'confirm with the current planHash from the dry-run', { status: 409, details: { planHash: plan.planHash } });
  if (plan.conflicts.length > 0) throw new BoardError('identity-conflict', 'resolve binding conflicts before migrating', { status: 409, details: { conflicts: plan.conflicts } });
  const pending = plan.actions.filter((a) => a.action === 'persist');
  if (pending.length > 0) {
    updateRegistry(service.rootDir, (registry) => {
      if (registry.rev !== plan.registryRev) throw new BoardError('stale-revision', 'registry changed since the dry-run', { status: 409 });
      for (const a of pending) registry.bindings.push(makeBinding({ projectId: a.projectId, root: a.root, role: 'main', actor, bindingId: a.bindingId }));
    });
    service.reloadBindings();
  }
  return { persisted: pending.length, planHash: plan.planHash };
}
