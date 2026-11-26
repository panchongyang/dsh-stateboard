// 业务政策只看已提交值；不依赖写入器或持久化，也不在入口再判一次。
import { BoardError } from '../errors.js';

/** 判断一个公开写命令能否在项目当前生命周期中开始；返回是否为解档。 */
export function projectCommandWindow(project, cmd) {
  if (project.phase !== 'archived') return false;
  if (cmd.op === 'project.update' && ['active', 'paused'].includes(cmd.phase)) return true;
  throw new BoardError('project-archived', 'the project is archived; unarchive it before any write', {
    status: 409, details: { projectId: project.id, phase: 'archived', allowed: ['project.update(phase=active|paused)'] },
  });
}
