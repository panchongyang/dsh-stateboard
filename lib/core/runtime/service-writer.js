// Writer capability ownership: shared locks, per-service authority and offline repair.
import fs from 'node:fs';
import path from 'node:path';
import { BoardError } from '../errors.js';
import { projectDataDir } from '../store/space-home.js';
import { actorSystem } from '../normalize.js';
import { makeBinding, retire, updateRegistry } from '../identity/registry.js';
import { commitFirstCommand } from './serial-command.js';
import { ensureDir, readJson, writeJson } from '../util.js';
import { assertCommittedProject } from '../transaction/records.js';
import { acceptanceRepairPorts } from '../transaction/lifecycle-authority.js';
import { ProjectHandle } from '../handle.js';
import { restoreHistoricalAcceptance, validateAcceptanceRepair } from '../transaction/repair-acceptance.js';

// Plugin reload shares one writer per log to keep a single revision counter.
// References keep the handle alive while either service still uses it.
export const SHARED_HANDLES = new Map();

export function shareHandle(dir, handle) {
  const entry = SHARED_HANDLES.get(dir);
  if (entry && !entry.handle.closed) {
    entry.refs += 1;
    return entry.handle;
  }
  SHARED_HANDLES.set(dir, { handle, refs: 1 });
  return handle;
}

export function releaseHandle(dir) {
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

const scopedWrites = new Set(['attach', 'detach', 'touch', 'recover', '_expireLeases', '_systemOperations', '_commandForService', '_preflight', '_applyRelocateSafe']);

export function scopedHandle(service, handle) {
  // 共享的是物理 writer 与模型，不是首次打开者的权限；写方法内部看到的是调用方 service。
  return new Proxy(handle, {
    get(target, key, scope) {
      if (key === 'service') return service;
      // Explicit handle close belongs to the physical writer, just like its in-flight health audit.
      // Service shutdown instead releases its reference and closes only the last writer.
      if (key === 'close') return () => { service._assertOpen(); return target.close(); };
      if (key === 'command') return async (cmd, options) => { service._assertOpen(); return target.command.call(scope, cmd, options); };
      if (scopedWrites.has(key)) return (...args) => { service._assertOpen(); return target[key].apply(scope, args); };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function openLifecycle(service, handle, explicit) {
  if (explicit && !handle.readOnly && !handle.store.readOnly) {
    handle.recover();
    service._healMeta(handle);
  }
  return handle;
}

/** 获取 writer 不执行恢复或修复；仅显式打开可以独立执行生命周期。 */
export function openWriter(service, projectId, { explicit = false } = {}) {
  service._assertOpen();
  const dir = projectDataDir(service, projectId);
  const cached = service.handles.get(projectId);
  if (cached) {
    // A plugin reload can close a handle that another service still caches.
    // Never hand out a closed handle; drop it and rebuild from disk.
    if (!cached.closed) return openLifecycle(service, cached, explicit);
    service.handles.delete(projectId);
  }
  const known = service.metas.get(projectId);
  const meta = known || readJson(path.join(dir, 'meta.json'), null);
  if (!meta || !meta.project) throw new BoardError('not-found', 'project not found: ' + projectId, { status: 404 });
  const fullMeta = { ...meta, dir };
  service.metas.set(projectId, fullMeta);
  if (!known) service.reloadBindings();
  const shared = SHARED_HANDLES.get(fullMeta.dir);
  if (shared && !shared.handle.closed) {
    shared.handle.service.spaceHome?.check();
    const reused = openLifecycle(service, service._serviceHandle(shared.handle), explicit);
    shareHandle(fullMeta.dir, shared.handle);
    service.handles.set(projectId, reused);
    return reused;
  }
  const store = service.storeFactory(fullMeta.dir, fullMeta);
  const data = store.open({ requireCommitted: true });
  const handle = new ProjectHandle(service, fullMeta, store, data);
  const scoped = service._serviceHandle(handle);
  try {
    assertCommittedProject(data.lastSeq, projectId); // custom media must meet the same contract
    openLifecycle(service, scoped, explicit);
  } catch (error) {
    try { handle.close(); } catch { /* half-initialized writer */ }
    throw error;
  }
  service.handles.set(projectId, scoped);
  shareHandle(fullMeta.dir, handle);
  return scoped;
}

/** Constructor-gated offline repair; deliberately absent from command/HTTP DTOs. */
export async function repairAcceptance(service, projectId, request) {
  service._assertOpen();
  if (!service.offlineMaintenance) throw new BoardError('forbidden-role', 'offline maintenance capability is required', { status: 403 });
  const input = validateAcceptanceRepair(request);
  const assertExclusive = () => {
    const shared = SHARED_HANDLES.get(path.join(service.projectsDir, projectId));
    if (shared && !shared.handle.closed && (shared.refs !== 1 || shared.handle.service !== service || !service.handles.has(projectId))) {
      throw new BoardError('log-busy', 'stop other project services before offline maintenance', { status: 503 });
    }
  };
  assertExclusive();
  const run = handle => handle._exclusive(() => {
    service._assertOpen(); assertExclusive();
    return restoreHistoricalAcceptance(handle.model, input, acceptanceRepairPorts(handle._transactionPorts(service), service));
  });
  const live = service.lookupLiveWriter(projectId);
  if (live) return run(live);
  const meta = service.metas.get(projectId);
  if (!meta) throw new BoardError('not-found', 'project not found: ' + projectId, { status: 404 });
  const fullMeta = { ...meta, dir: path.join(service.projectsDir, projectId) };
  const store = service.storeFactory(fullMeta.dir, fullMeta);
  try {
    const data = store.open({ requireCommitted: true });
    assertCommittedProject(data.lastSeq, projectId);
    // Do not run lifecycle recovery or publish a maintenance-only writer.
    return await run(new ProjectHandle(service, fullMeta, store, data));
  } finally { store.close(); }
}

/** Reserve the medium, persist the validated first command and only then publish its writer. */
export function commitCreation(service, meta, actor, ticket) {
  const { projectId, project } = meta;
  // Durable resource reservation is not a successful project. The existing
  // registry lock arbitrates concurrent claims before any project dir is made.
  let binding;
  if (service.spaceHome) service.spaceHome.reserve();
  else {
    binding = makeBinding({ projectId, root: project.workspacePath, role: 'main', actor });
    updateRegistry(service.rootDir, (registry) => { registry.bindings.push(binding); });
  }
  let handle, result;
  try {
    handle = openNewProject(service, meta, service.spaceHome?.state);
    if (ticket) result = commitFirstCommand(handle, ticket);
    else {
      handle._systemOperations({ actor: actor || actorSystem(), cmdId: 'cmd_create_' + projectId },
        [{ kind: 'lifecycle.bootstrap', args: {} }]);
    }
    service.spaceHome?.readMeta(); // Pin the newly committed log before handing the caller a writer.
  } catch (error) {
    if (binding) failedLegacyCreation(service, handle, binding, error);
    else handle?.close(); // Preserve incomplete space media rather than retry or discard an uncertain first write.
    throw error;
  }
  return { handle: publishNewProject(service, handle), result };
}

function failedLegacyCreation(service, handle, binding, error) {
  const { projectId } = binding;
  const cleanupErrors = [];
  try { handle?.close(); } catch (cause) { cleanupErrors.push(cause); }
  // Unknown means keep the reservation even when stat sees no bytes.
  let discarded = false;
  if (error?.code !== 'log-write-uncertain' && !cleanupErrors.length) {
    try { discarded = discardUnbornProject(service.projectsDir, projectId); } catch (cause) { cleanupErrors.push(cause); }
  }
  if (!discarded) {
    try { service.registerProjectDir(projectId); } catch (cause) { cleanupErrors.push(cause); service.reloadBindings(); }
  } else {
    try {
      updateRegistry(service.rootDir, (registry) => {
        const own = registry.bindings.find((b) => b.bindingId === binding.bindingId && b.status === 'active');
        if (own) retire(own, 'create-failed');
      });
    } catch (cause) { cleanupErrors.push(cause); }
    service.reloadBindings();
  }
  if (cleanupErrors.length && error instanceof Error) {
    error.cause = new AggregateError(cleanupErrors, 'project creation recovery also failed', { cause: error.cause });
  }
}

/** Open privately after identity reservation; only a durable creation publishes it. */
export function openNewProject(service, meta, dir = path.join(service.projectsDir, meta.projectId)) {
  ensureDir(dir);
  writeJson(path.join(dir, 'meta.json'), meta);
  const store = service.storeFactory(dir, meta);
  return new ProjectHandle(service, { ...meta, dir }, store, store.open());
}

/** Make the newly committed writer available to readers and other services. */
export function publishNewProject(service, handle) {
  service.metas.set(handle.id, handle.meta);
  const scoped = service._serviceHandle(handle);
  service.handles.set(handle.id, scoped);
  shareHandle(handle.meta.dir, handle);
  service.reloadBindings();
  return scoped;
}

/** Physical recovery only: never remove a log with bytes or an unknown outcome. */
export function discardUnbornProject(projectsDir, projectId) {
  const dir = path.join(projectsDir, projectId);
  let size;
  try { size = fs.statSync(path.join(dir, 'commits.jsonl')).size; }
  catch (error) { if (error?.code !== 'ENOENT') throw error; size = 0; }
  if (size !== 0) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}
