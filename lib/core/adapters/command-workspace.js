// 搬迁跨越项目日志与本机注册表。先保留目标目录，耐久提交后再更新派生元数据。
import fs from 'node:fs';
import path from 'node:path';
import { BoardError } from '../errors.js';
import { canonicalKey, resolveWorkspacePath, writeJson } from '../util.js';
import { readMarker } from '../identity/discover.js';
import { syncMainBinding } from '../identity/ops.js';
import { makeBinding, updateRegistry } from '../identity/registry.js';

/** 注册表锁内声明目标归属；失败的提交不得让它成为主工作区。 */
function reserveRoot(service, id, target) {
  const key = canonicalKey(target);
  try {
    updateRegistry(service.rootDir, registry => {
      const taken = registry.bindings.filter(b => b.status === 'active' && canonicalKey(b.root) === key);
      if (taken.some(b => b.projectId === id)) return;
      registry.bindings.push({ ...makeBinding({ projectId: id, root: target, role: 'worktree' }), purpose: 'relocate-reservation' });
    });
  } catch (error) {
    if (error?.code === 'identity-conflict') throw new BoardError('already-exists', 'another project already owns ' + target, { status: 409, details: error.details });
    throw error;
  } finally { service.reloadBindings(); }
}

/** 供搬迁命令显式调用的目录与身份能力，不让命令持有 service。 */
export function createWorkspacePort(service, id) {
  return Object.freeze({
    resolveTarget: resolveWorkspacePath,
    sameTarget: (a, b) => canonicalKey(a) === canonicalKey(b),
    isDirectory: target => { try { return fs.statSync(target).isDirectory(); } catch { return false; } },
    refreshBindings: () => { service.refreshFromDisk({ strict: true }); },
    otherClaimant: target => service.bindings().byRoot(target).find(b => b.projectId !== id)?.projectId ?? service.claimantOf(target, id),
    readMarker, reserveRoot: target => reserveRoot(service, id, target),
  });
}

/** 只在已提交之后发布。失败由命令入口转为 warning，不能撤销权威日志。 */
export function applyRelocate(handle, relocate) {
  const project = handle.state.project;
  writeJson(path.join(handle.meta.dir, 'meta.json'), {
    schemaVersion: 3, projectId: project.id, project, createdAt: handle.meta.createdAt || project.createdAt,
  }, handle.store.fs);
  handle.meta.project = project;
  handle.meta.projectId = project.id;
  handle.service.metas.set(project.id, handle.meta);
  syncMainBinding(handle.service, project.id, relocate.to, 'relocated');
}
