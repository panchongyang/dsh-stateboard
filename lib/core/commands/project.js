// Project-level commands: rename/pause/policy updates and workspace relocation.
//
// Bodies are verbatim moves from service.js with `this` rebound to the handle.
// applyRelocate still writes meta.json and the service registries; keep the order
// (commit first, then relocate) because command() calls it after the append.

import fs from 'node:fs';
import path from 'node:path';
import { BoardError } from '../errors.js';
import { clone } from '../model.js';
import { policyOf } from '../normalize.js';
import { releasedTask, taskStateEvent } from '../contracts.js';
import { canonicalKey, resolveWorkspacePath, writeJson } from '../util.js';
import { readMarker } from '../identity/discover.js';
import { syncMainBinding } from '../identity/ops.js';
import { makeBinding, updateRegistry } from '../identity/registry.js';

function liveWork(handle) {
  const now = handle._nowMs();
  const inProgress = Object.values(handle.state.tasks)
    .filter((task) => task.state === 'in_progress')
    .map((task) => task.id);
  const leases = [...handle.leases.values()]
    .filter((lease) => Date.parse(lease.expiresAt) > now)
    .map((lease) => lease.taskId);
  const openIntents = Object.values(handle.state.intents)
    .filter((intent) => intent.status === 'open')
    .map((intent) => intent.id);
  return {
    inProgress: inProgress.slice(0, 20),
    leases: leases.slice(0, 20),
    openIntents: openIntents.slice(0, 20),
  };
}

export function projectUpdate(handle, cmd) {
  if (!cmd.actor || (cmd.actor.kind !== 'human' && cmd.actor.kind !== 'system')) {
    throw new BoardError('forbidden-role', 'project.update is human/system only', { status: 403 });
  }
  const current = handle.state.project;
  // Defense in depth: the command bus already rejects every non-unarchive write
  // on an archived project. Keep the handler honest if it is called directly.
  if (current.phase === 'archived' && cmd.phase !== 'active' && cmd.phase !== 'paused') {
    throw new BoardError('project-archived', 'an archived project only accepts unarchive', { status: 409, details: { phase: current.phase } });
  }
  if (cmd.phase === 'archived' && current.phase !== 'archived') {
    const work = liveWork(handle);
    if (work.inProgress.length > 0 || work.leases.length > 0 || work.openIntents.length > 0) {
      throw new BoardError('project-has-live-work', 'finish, release, or reconcile live work before archiving', {
        status: 409,
        details: work,
      });
    }
  }
  if (cmd.policy?.verification === 'auto') throw new BoardError('invalid-command', 'automatic verification is retired; submit records materials for human review', { status: 400 });
  const next = clone(current);
  if (typeof cmd.name === 'string' && cmd.name.trim() !== '') next.name = cmd.name.trim();
  if (['active', 'paused', 'archived'].includes(cmd.phase)) next.phase = cmd.phase;
  if (cmd.policy && typeof cmd.policy === 'object') next.policy = { ...policyOf(next), ...cmd.policy };
  next.updatedAt = new Date().toISOString();
  const events = [{ type: 'project/updated', data: next }];
  if (current.phase === 'archived' && (cmd.phase === 'active' || cmd.phase === 'paused')) {
    // Unarchive carries recovery in the same commit: no second recover commit,
    // and no archived event is ever written outside this transition.
    for (const task of Object.values(handle.state.tasks)) {
      if (task.state === 'in_progress') events.push(taskStateEvent(releasedTask(handle, task, next.updatedAt)));
    }
  }
  return { events };
}

export function projectRelocate(handle, cmd) {
  if (!cmd.actor || (cmd.actor.kind !== 'human' && cmd.actor.kind !== 'system')) {
    throw new BoardError('forbidden-role', 'project.relocate is human/system only', { status: 403 });
  }
  let target;
  try {
    target = resolveWorkspacePath(cmd.workspacePath);
  } catch {
    throw new BoardError('invalid-command', 'workspacePath is required', { status: 400 });
  }
  let stat;
  try { stat = fs.statSync(target); } catch { stat = null; }
  if (!stat || !stat.isDirectory()) throw new BoardError('invalid-command', 'target workspace does not exist or is not a directory: ' + target, { status: 400 });
  const from = handle.state.project.workspacePath;
  const fromKey = canonicalKey(from);
  const toKey = canonicalKey(target);
  if (fromKey === toKey) return { events: [] };
  // Fresh disk read before the commit: a binding or move made by another process
  // since this service started must refuse the move, not surface post-commit.
  const index = handle.service.refreshFromDisk({ strict: true });
  const others = index.byRoot(target).filter((b) => b.projectId !== handle.id);
  const claimant = others.length > 0 ? others[0].projectId : handle.service.claimantOf(target, handle.id);
  if (claimant) {
    throw new BoardError('already-exists', 'another project already owns ' + target, { status: 409, details: { projectId: claimant } });
  }
  const marker = readMarker(target);
  if (marker && marker.projectId !== handle.id) {
    throw new BoardError('identity-conflict', 'target carries a marker for ' + marker.projectId, { status: 409, details: { root: target, markerProjectId: marker.projectId } });
  }
  reserveRoot(handle, target);
  const next = clone(handle.state.project);
  next.workspacePath = target;
  next.updatedAt = new Date().toISOString();
  return { events: [{ type: 'project/updated', data: next }], relocate: { from, to: target } };
}

/**
 * Claim the target root under the registry lock before the commit, as a
 * same-project worktree binding: root uniqueness then serialises this move with
 * any concurrent bind/create/relocate. syncMainBinding promotes it after the
 * commit; if the commit fails, the leftover reservation still names this
 * project and never moves its main workspace.
 */
function reserveRoot(handle, target) {
  const key = canonicalKey(target);
  try {
    updateRegistry(handle.service.rootDir, (registry) => {
      const here = registry.bindings.filter((b) => b.status === 'active' && canonicalKey(b.root) === key);
      if (here.some((b) => b.projectId === handle.id)) return;
      registry.bindings.push({ ...makeBinding({ projectId: handle.id, root: target, role: 'worktree' }), purpose: 'relocate-reservation' });
    });
  } catch (error) {
    if (error && error.code === 'identity-conflict') {
      throw new BoardError('already-exists', 'another project already owns ' + target, { status: 409, details: error.details });
    }
    throw error;
  } finally {
    handle.service.reloadBindings();
  }
}

export function applyRelocate(handle, relocate) {
  const metaFile = path.join(handle.meta.dir, 'meta.json');
  const project = handle.state.project;
  writeJson(metaFile, {
    schemaVersion: 3,
    projectId: project.id,
    project,
    createdAt: handle.meta.createdAt || project.createdAt,
  }, handle.store.fs);
  handle.meta.project = project;
  handle.meta.projectId = project.id;
  handle.service.metas.set(project.id, handle.meta);
  syncMainBinding(handle.service, project.id, relocate.to, 'relocated');
}

export const PROJECT_HANDLERS = {
  'project.update': projectUpdate,
  'project.relocate': projectRelocate,
};
