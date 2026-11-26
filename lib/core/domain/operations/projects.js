// 项目身份的具名模型操作：阶段、搬迁目标与内嵌写策略。
// 目标目录保留/绑定取证由命令在事务外完成；模型只发布项目记录与随归档解除的恢复事实。
import { BoardError } from '../../errors.js';
import { policyOf } from '../../normalize.js';
import { releasedTask, taskStateEvent } from '../../contracts.js';
import { updateProjectPhase } from '../project-transitions.js';

function requireRole(request, allowed, label) {
  if (!allowed.includes(request?.actor?.kind)) throw new BoardError('forbidden-role', label, { status: 403 });
}

function assertFields(args, allowed) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new BoardError('invalid-command', 'operation arguments must be an object', { status: 400 });
  }
  for (const key of Object.keys(args)) if (!allowed.includes(key)) {
    throw new BoardError('invalid-command', 'unsupported project operation field: ' + key, { status: 400 });
  }
}

function leaseValues(leases) {
  if (!leases) return [];
  return typeof leases.values === 'function' ? [...leases.values()] : Object.values(leases);
}

function liveWork(read) {
  const now = read.clock().getTime();
  const inProgress = Object.values(read.state.tasks)
    .filter((task) => task.state === 'in_progress')
    .map((task) => task.id);
  const leases = leaseValues(read.leases)
    .filter((lease) => Date.parse(lease.expiresAt) > now)
    .map((lease) => lease.taskId);
  const openIntents = Object.values(read.state.intents || {})
    .filter((intent) => intent.status === 'open')
    .map((intent) => intent.id);
  return {
    inProgress: inProgress.slice(0, 20),
    leases: leases.slice(0, 20),
    openIntents: openIntents.slice(0, 20),
  };
}

export function updateProject(work, args, request) {
  requireRole(request, ['human', 'system'], 'project.update is human/system only');
  assertFields(args, ['name', 'phase', 'policy']);
  if (args.phase !== undefined && !['active', 'paused', 'archived'].includes(args.phase)) {
    throw new BoardError('invalid-command', 'phase must be active, paused or archived', { status: 400 });
  }
  const current = work.state.project;
  if (current.phase === 'archived' && args.phase !== 'active' && args.phase !== 'paused') {
    throw new BoardError('project-archived', 'an archived project only accepts unarchive', { status: 409, details: { phase: current.phase } });
  }
  if (args.phase === 'archived' && current.phase !== 'archived') {
    const pending = liveWork(work);
    if (pending.inProgress.length || pending.leases.length || pending.openIntents.length) throw new BoardError('project-has-live-work', 'finish, release, or reconcile live work before archiving', { status: 409, details: pending });
  }
  if (args.policy?.verification === 'auto') throw new BoardError('invalid-command', 'automatic verification is retired; submit records materials for human review', { status: 400 });
  const next = structuredClone(current);
  if (typeof args.name === 'string' && args.name.trim() !== '') next.name = args.name.trim();
  updateProjectPhase(next, args.phase);
  if (args.policy && typeof args.policy === 'object') next.policy = { ...policyOf(next), ...args.policy };
  next.updatedAt = work.clock().toISOString();
  const events = [{ type: 'project/updated', data: next }];
  if (current.phase === 'archived' && (args.phase === 'active' || args.phase === 'paused')) {
    // 归档期间不存在合法租约；解除归档在同一提交里释放残留运行态并恢复任务，
    // 不另开恢复提交。
    if (typeof work.leases?.clear === 'function') work.leases.clear();
    for (const task of Object.values(work.state.tasks)) {
      if (task.state === 'in_progress') events.push(taskStateEvent(releasedTask(work, task, next.updatedAt)));
    }
  }
  return { events };
}

export function relocateProject(work, args, request) {
  requireRole(request, ['human', 'system'], 'project.relocate is human/system only');
  assertFields(args, ['workspacePath']);
  if (typeof args.workspacePath !== 'string' || args.workspacePath === '') {
    throw new BoardError('invalid-command', 'workspacePath is required', { status: 400 });
  }
  const next = structuredClone(work.state.project);
  next.workspacePath = args.workspacePath;
  next.updatedAt = work.clock().toISOString();
  return { events: [{ type: 'project/updated', data: next }] };
}

/** 人工显式授权的内嵌写策略；显式 projectRev 防止覆盖并发项目写。 */
export function updateInlinePolicy(work, args, request) {
  requireRole(request, ['human'], 'doc.inline_policy is human-only');
  if (request.authorized !== true) throw new BoardError('migration-authorization-required', 'explicit policy authorization is required', { status: 403 });
  assertFields(args, ['disabled', 'expectedProjectRev']);
  if (!Number.isInteger(args.expectedProjectRev) || args.expectedProjectRev !== work.rev) {
    throw new BoardError('stale-revision', 'expected.projectRev is required', { status: 409 });
  }
  if (typeof args.disabled !== 'boolean') throw new BoardError('invalid-command', 'disabled must be boolean', { status: 400 });
  if ((work.state.project.inlineWritesDisabled !== false) === args.disabled) return { events: [] };
  const next = { ...structuredClone(work.state.project), inlineWritesDisabled: args.disabled, updatedAt: work.clock().toISOString() };
  return { events: [{ type: 'project/updated', data: next }] };
}

export const projectOperations = Object.freeze({
  'project.applyUpdate': updateProject,
  'project.moveWorkspace': relocateProject,
  'project.setInlineWritePolicy': updateInlinePolicy,
});
