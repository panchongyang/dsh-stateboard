// 项目级命令：改名/暂停/策略更新与工作区搬迁。
// 命令组装参数与工作区观测事实；项目资格、记录与恢复事实由模型操作判定。
// 工作区效果是显式端口，跨资源发布由命令入口在提交后处理。

import { BoardError } from '../errors.js';

export function projectUpdate(read, cmd) {
  return {
    operations: [{ kind: 'project.applyUpdate', args: { name: cmd.name, phase: cmd.phase, policy: cmd.policy } }],
  };
}

export function projectRelocate(read, cmd) {
  if (!cmd.actor || (cmd.actor.kind !== 'human' && cmd.actor.kind !== 'system')) {
    throw new BoardError('forbidden-role', 'project.relocate is human/system only', { status: 403 });
  }
  let target;
  try {
    target = read.workspace.resolveTarget(cmd.workspacePath);
  } catch {
    throw new BoardError('invalid-command', 'workspacePath is required', { status: 400 });
  }
  if (!read.workspace.isDirectory(target)) throw new BoardError('invalid-command', 'target workspace does not exist or is not a directory: ' + target, { status: 400 });
  const from = read.state.project.workspacePath;
  if (read.workspace.sameTarget(from, target)) return { operations: [] };
  // Fresh disk read before the commit: a binding or move made by another process
  // since this service started must refuse the move, not surface post-commit.
  read.workspace.refreshBindings();
  const claimant = read.workspace.otherClaimant(target);
  if (claimant) {
    throw new BoardError('already-exists', 'another project already owns ' + target, { status: 409, details: { projectId: claimant } });
  }
  const marker = read.workspace.readMarker(target);
  if (marker && marker.projectId !== read.state.project.id) {
    throw new BoardError('identity-conflict', 'target carries a marker for ' + marker.projectId, { status: 409, details: { root: target, markerProjectId: marker.projectId } });
  }
  read.workspace.reserveRoot(target);
  return {
    operations: [{ kind: 'project.moveWorkspace', args: { workspacePath: target } }],
  };
}

export const PROJECT_HANDLERS = {
  'project.update': projectUpdate,
  'project.relocate': projectRelocate,
};
