/**
 * 测试职责：用正常模型命令产生 session.checkpoint，替代测试里已移除的 store.append。
 * 典型流程：openLockWriter 打开 ProjectService/handle → checkpoint 发 session.checkpoint → close。
 * 覆盖边界：只用于锁/竞态夹具；不直接构造 commit，不写 store state。
 * 外部前置：调用方提供合成的 stateDir 与项目 id。
 */
import crypto from 'node:crypto';
import { ProjectService } from '../../lib/core/service.js';

const DEFAULT_ACTOR = { kind: 'agent', sessionId: 'lock-fixture', via: 'system' };

export function checkpointCommand(handle, note, { cmdId, actor = DEFAULT_ACTOR } = {}) {
  return handle.command({
    op: 'session.checkpoint',
    cmdId: cmdId || 'cmd_lock_' + crypto.randomUUID(),
    note,
    actor,
  });
}

export async function openLockWriter({ stateDir, projectId }) {
  const service = new ProjectService({ rootDir: stateDir });
  await service.init();
  const handle = await service.open(projectId);
  return {
    service,
    handle,
    checkpoint: (note, options) => checkpointCommand(handle, note, options),
    async close() {
      await service.close();
    },
  };
}
