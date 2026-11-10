// @ts-check
import crypto from 'node:crypto';
import { ProjectService } from '../../lib/core/service.js';

const [, , rootDir, projectId, taskId] = process.argv;
// Product constructor JSDoc 尚未列出 rootDir；测试侧先窄化，保持运行契约不变。
const Service = /** @type {any} */ (ProjectService);
const svc = new Service({ rootDir });
await svc.init();
const h = await svc.open(projectId);
const task = h.state.tasks[taskId];
const historical = structuredClone(task);
const historicalHash = h.lastHash;
const persistedPolicy = h.state.project.policy.verification;
const effectivePolicy = h.query('board').project.policy.verification;
const error = task.state === 'done' ? null : await h.command({
  cmdId: 'cmd_restart_' + crypto.randomUUID(),
  actor: { kind: 'human', via: 'test' },
  op: 'task.verify',
  taskId,
  expected: { entityRev: task.rev },
}).then(() => null, (err) => err);
console.log(JSON.stringify({
  state: h.state.tasks[taskId].state,
  historical, historicalHash, persistedPolicy, effectivePolicy,
  error: error ? { code: error.code, details: error.details ?? null } : null,
}));
await svc.close();
process.exit(error ? 1 : 0);
