/**
 * 测试职责：统一合成 service、临时存储和项目的所有权与失败清理。
 * 典型流程：先登记 t.after → 初始化 service → create/open 项目 → 测试结束关闭并清理。
 * 覆盖边界：只显式使用临时 root/workspace，不读取真实 HOME/store；不隐式 bootstrap 固定证据。
 * 外部前置：需要可写临时目录；Git 仓库仍由 fixed-fixture 构造，不在这里复制 Git 引导。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ProjectService } from '../../lib/core/service.js';
import { temp, command as fixedCommand } from './fixed-fixture.mjs';

// 用途：构造命令载荷；默认沿用固定证据角色，也允许调用点显式保留原 actor/cmdId。
export function command(op, extra = {}) {
  return fixedCommand(op, extra);
}

// 同一用例先逆序关闭全部 service，再清根；冷重开失败时也不会先删仍打开的 store。
const disposals = new WeakMap();
function disposalFor(t) {
  if (!disposals.has(t)) {
    const stack = { services: [], dirs: [] };
    disposals.set(t, stack);
    t.after(async () => {
      const errors = [];
      for (const svc of stack.services.toReversed()) {
        try { await svc.close(); } catch (error) { errors.push(error); }
      }
      for (const dir of stack.dirs.toReversed()) {
        try { await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, '合成 service fixture 清理失败');
    });
  }
  return disposals.get(t);
}

// 用途：创建并 init 独立 service；t 必传，初始化抛错也关闭句柄并清临时根。
// 边界：只删除自己创建的 base；调用者传入的 rootDir/workspacePath 始终借用，不接管删除所有权。
export async function makeService(t, { rootDir, workspacePath, ...serviceOptions } = {}) {
  const disposal = disposalFor(t);
  const base = temp();
  disposal.dirs.push(base);
  const stateDir = rootDir || path.join(base, 'board');
  const wsDir = workspacePath || path.join(base, 'workspace');
  const svc = new ProjectService({ ...serviceOptions, rootDir: stateDir });
  disposal.services.push(svc);
  fs.mkdirSync(wsDir, { recursive: true });
  await svc.init();
  return { svc, base, stateDir, board: stateDir, wsDir, workspacePath: wsDir };
}

// 用途：create 新项目或按 projectId open；不 attach、不发布、不登记来源，首次只读语义由调用点决定。
export async function withProject(t, { projectId, name, actor, ...options } = {}) {
  const fixture = await makeService(t, options);
  const h = projectId ? await fixture.svc.open(projectId)
    : await fixture.svc.createProject({ workspacePath: fixture.wsDir, ...(name ? { name } : {}), ...(actor ? { actor } : {}) });
  return { ...fixture, h };
}
