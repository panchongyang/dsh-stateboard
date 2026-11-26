// Composition for the two trusted tool entrances. This cache owns open services, not workspace identities.
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import { BoardError } from '../core/errors.js';
import { ProjectService } from '../core/service.js';
import { createHostReader } from './reader.js';
import { executionGrant } from './agent-context.js';

const deny = () => new BoardError('project-forbidden', 'No authorized owning space for this call', { status: 403 });

export function createSpaceRuntime(ctx) {
  const opened = new Map(), pending = new Set(), calls = new AsyncLocalStorage();
  let closing;
  async function nativeRoot(agent) {
    const cwd = agent?.session?.header?.cwd;
    if (!agent?.id || typeof cwd !== 'string' || !cwd) throw deny();
    try {
      const registry = ctx.workspaceRegistry ?? ctx.get?.('workspaceRegistry');
      const workspace = await registry?.resolveByPath(cwd);
      if (workspace?.path) return workspace.path;
    } catch { /* An unregistered/unavailable session directory grants no access. */ }
    throw deny();
  }
  function local(root, existingOnly) {
    root = fs.realpathSync.native(root);
    let item = opened.get(root);
    if (!item && existingOnly) return;
    if (!item) {
      const service = new ProjectService({ spaceRoot: root, assertAccess: () => calls.getStore()?.() });
      item = { ctx, service, reader: createHostReader(service), ready: service.init(), sessionProjects: new Map(), sessionProjectRefs: new Map(), promptFibers: new Map() };
      opened.set(root, item);
    }
    return item;
  }
  async function execute(exec, action, existingOnly) {
    const grant = executionGrant(exec);
    if (grant && (!grant.spaceRoot || typeof grant.assertCurrent !== 'function')) throw deny();
    const check = () => { if (closing) throw deny(); grant?.assertCurrent(); };
    check();
    const root = grant ? grant.spaceRoot : await nativeRoot(exec?.agent);
    check();
    return calls.run(check, async () => {
      const item = local(root, existingOnly);
      if (!item) return;
      await item.ready;
      check(); item.service.spaceHome.check();
      if (!item.service.metas.size) item.service.refreshFromDisk();
      const result = await action(item);
      check(); item.service.spaceHome.check();
      return result;
    });
  }
  return {
    use(exec, action, { existingOnly = false } = {}) {
      const work = execute(exec, action, existingOnly); pending.add(work);
      return work.finally(() => pending.delete(work));
    },
    close() {
      return closing ??= Promise.allSettled(pending).then(async () => {
        try {
          await Promise.all([...opened.values()].map(async item => {
            try { await item.closeAgentTools?.(); } finally { try { await item.reader.close(); } finally { await item.service.close(); } }
          }));
        } finally { opened.clear(); calls.disable(); }
      });
    },
  };
}
