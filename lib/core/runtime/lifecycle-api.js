// Lifecycle capability: writes that need a writer internally and return plain
// values. No read path calls into this module.
import { digestFromPublished } from '../projection/views.js';
import { newId } from '../util.js';

export function createLifecycleApi({ service, read }) {
  const now = () => service.clock().getTime();

  return {
    /** Create a project. Returns its summary value; the handle stays internal. */
    async createProject({ workspacePath, name, actor }) {
      const handle = await service.createProject({ workspacePath, name, actor });
      return read(handle.id, 'summary', {}, actor);
    },

    /** Create if absent and record this session on the project. Returns a value. */
    async ensureProjectForSession({ workspacePath, projectId, name, actor, sessionId, agentId, source }) {
      let handle;
      if (projectId) handle = await openExisting(service, projectId);
      else handle = await service.openByWorkspace(workspacePath);
      if (!handle) {
        if (!actor || !workspacePath) return null;
        handle = await service.createProject({ workspacePath, name, actor });
      }
      await attachOnce(service, handle, { sessionId, agentId: agentId ?? sessionId, source });
      return { projectId: handle.id, rev: handle.rev, name: handle.name, workspacePath: handle.workspacePath };
    },

    /** Lifecycle attach: a write; never called from a read path. Returns a value. */
    async ensureAgentProject({ workspacePath, projectId, sessionId, agentId, source, role = 'worker' }) {
      let handle;
      if (projectId) handle = await openExisting(service, projectId);
      else handle = await service.openByWorkspace(workspacePath);
      if (!handle) return null;
      await attachOnce(service, handle, { sessionId, agentId: agentId ?? sessionId, source, role });
      return { projectId: handle.id, rev: handle.rev, name: handle.name, workspacePath: handle.workspacePath };
    },

    /** Explicit trusted activity signal. Reads never call this. */
    async recordActivity({ projectId, sessionId }) {
      const handle = await openExisting(service, projectId);
      if (!handle) return { projectId, rev: 0 };
      handle.touch(sessionId);
      return { projectId, rev: handle.rev };
    },

    /** Lifecycle detach for one session; reuses an open writer, never opens one. */
    async detachAgentSession({ projectId, sessionId, reason = 'session-closed' }) {
      const handle = service.handles?.get(projectId);
      if (!handle || handle.closed) return { projectId, detached: false };
      await handle.detach(sessionId, reason);
      return { projectId, detached: true };
    },

    /** Prompt digest: synchronous over published values; never pulls a timeline. */
    promptDigest(projectId, sessionId, options = {}) {
      const published = service.publishedState?.(projectId);
      if (!published) return '';
      return digestFromPublished(published, sessionId, options, now());
    },
  };
}

function openExisting(service, projectId) {
  // 显式生命周期即使复用业务取得的 writer，也仍走公开打开语义。
  return service.open(projectId);
}

async function attachOnce(service, handle, { sessionId, agentId, source, role = 'worker' }) {
  // Serialise the presence check with the attach, not only the append. Ensuring
  // an existing (even detached) binding is not permission to rotate its epoch.
  // Explicit handle.attach remains the authorized re-attach capability.
  return handle._exclusive(() => {
    service._assertOpen();
    const binding = handle.state?.bindings?.[sessionId];
    if (binding) return binding;
    const result = handle._systemOperations({ actor: { kind: 'system', via: 'lifecycle' },
      cmdId: 'cmd_ensure_' + newId('x') }, [{ kind: 'lifecycle.attach', args: { sessionId, agentId, source, role } }],
    { ephemeral: handle.readOnly || handle.store.readOnly || handle.state.project.phase === 'archived' });
    return result.binding;
  });
}
