/**
 * 测试职责：提供与 writer 无共享缓存的冷重放进程，拒绝隔离根外的 store 参数。
 * 典型流程：断言最小环境 → 校验 rootDir/projectId → 打开临时项目并输出 state/cmdIds → 关闭服务。
 * 覆盖边界：覆盖 进程级冷重放与参数隔离；不覆盖故障注入本身或真实 store。
 * 外部前置：必须由故障 fixture 传入隔离根与项目 id；需要可启动 Node 子进程。
 */
// Separate Node process: no shared handle/store/module cache from the writer.
import assert from 'node:assert/strict';
import path from 'node:path';
import { ProjectService } from '../../lib/core/service.js';
import { assertIsolation } from '../helpers/fault-isolation.mjs';
// 分段职责：先校验隔离环境及入参范围，禁止子进程打开隔离根外项目。
const fixture = assertIsolation();
const [rootDir, projectId] = process.argv.slice(2);
const relative = path.relative(fixture, rootDir);
assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
assert.match(projectId, /^prj_[a-zA-Z0-9_]+$/);
// 分段职责：以独立 service 冷开项目并输出 state/cmdIds，finally 必须释放服务。
const service = new ProjectService({ rootDir, privilegedInlineWrites: true });
try {
  await service.init();
  const handle = await service.open(projectId);
  process.stdout.write(JSON.stringify({ state: handle.state, cmdIds: [...handle.cmdIds] }));
} finally {
  await service.close();
}
