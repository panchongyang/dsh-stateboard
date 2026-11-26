/**
 * 测试职责：真实原生注册与真实 MCP HTTP 的共享目录、身份与业务回归门禁。
 * 典型流程：合成项目注册七工具，逐项比较 schema，经 HTTP 执行业务后查状态。
 * 覆盖边界：覆盖 接口、输出、权限与租约；真实 SDK 兼容由宿主测试补充。；不覆盖真实用户数据与 LLM 推理。
 * 外部前置：仅 Node 与本机临时回环端口；不依赖 DSH peer，不允许 skip。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, text, error, READ } from '../helpers/agent-parity-fixture.mjs';
import { TOOL_NAMES, TASK_OPS } from '../../lib/shared/contract.js';
import { assertCatalogue } from '../helpers/agent-parity-contract.mjs';

// 责任：真实注册目录逐字段比较，并证明遗漏工具和字段漂移能使门禁失败。
test('all seven actual registrations share the exact catalogue and schemas', async (t) => {
  const f = await fixture(t);
  for (const token of [undefined, READ]) {
    const listed = (await f.post('tools/list', {}, token)).result.tools;
    assert.deepEqual(listed.map((row) => row.name), TOOL_NAMES);
    assertCatalogue(f.native, listed);
    assert.throws(() => assertCatalogue(f.native, listed.slice(1)), 'gate must catch a missing registration');
    const changed = structuredClone(listed);
    changed.find(({ name }) => name === 'project_task').inputSchema.properties.op.enum.pop();
    assert.throws(() => assertCatalogue(f.native, changed), 'gate must catch a missing operation');
    const drift = structuredClone(listed);
    drift[0].inputSchema.properties.context.type = 'integer';
    assert.throws(() => assertCatalogue(f.native, drift), 'gate must catch a parameter type drift');
  }
  assert.deepEqual(f.native.get('project_task').parameters.properties.op.enum, TASK_OPS);
  const old = await f.call('create_task', { projectId: f.h.id });
  assert.equal(old.error.code, -32602, 'old business implementations must not remain callable');
});

// 责任：核对新命令、完整错误与读取续租行为以原生为准。
test('MCP uses DSH fresh-command semantics, task summaries and detailed failures', async (t) => {
  const f = await fixture(t);
  const { context } = await f.open();
  const args = { op: 'create', title: 'Parity', acceptance: [{ text: 'works' }], context };
  text(await f.call('project_task', args));
  text(await f.call('project_task', args));
  assert.equal(Object.keys(f.h.state.tasks).length, 2, 'same call is a new native command');
  const task = Object.values(f.h.state.tasks)[0];
  const result = text(await f.call('project_board', { view: 'task', taskId: task.id, context }));
  assert.match(result, /coverage: summary/);
  assert.match(result, /section=description/);
  const bad = { op: 'ready', taskId: task.id, expectedRev: 999 };
  let native;
  try { await f.nativeCall('project_task', bad); } catch (e) { native = e.boardFailure; }
  const remote = error(await f.call('project_task', { ...bad, context }), 'stale-revision');
  assert.deepEqual(remote, native, 'do not hide error details to manufacture parity');
  text(await f.call('project_task', { op: 'claim', taskId: task.id, expectedRev: f.h.state.tasks[task.id].rev, title: 'native ignores this field', context }));
  const lease = f.h.leases.get(task.id);
  assert.ok(lease);
  const before = lease.expiresAt;
  f.advance(30000);
  // Management reads are projections: at the same trusted activity and clock
  // they must not renew, regardless of the transport.
  text(await f.call('project_board', { view: 'task', taskId: task.id, context, fresh: true }));
  assert.equal(f.h.leases.get(task.id).expiresAt, before, 'MCP management reads do not renew a lease');
  assert.equal(f.h.leases.get(task.id).renewCount, 0);
  await f.nativeCall('project_board', { view: 'task', taskId: task.id, fresh: true });
  assert.equal(f.h.leases.get(task.id).expiresAt, before, 'native management reads do not renew a lease');
  assert.equal(f.h.leases.get(task.id).renewCount, 0);
  // Only the explicit renew command changes runtime liveness.
  const renew = { op: 'renew', taskId: task.id, expectedRev: f.h.state.tasks[task.id].rev, fencingToken: lease.token, context };
  text(await f.call('project_task', renew));
  text(await f.call('project_task', renew));
  assert.equal(f.h.leases.get(task.id).renewCount, 2);
  assert.ok(f.h.leases.get(task.id).expiresAt >= before);
  // A token from another generation is rejected, not silently treated as current.
  error(await f.call('project_task', { op: 'renew', taskId: task.id, expectedRev: f.h.state.tasks[task.id].rev, fencingToken: lease.token + 1, context }), 'fencing-stale');
});

// 责任：拒绝只读提权、其他入口句柄、撤权和过期上下文。
test('read credentials, foreign contexts, allowlist revocation and expiry fail closed', async (t) => {
  const f = await fixture(t);
  const full = await f.open();
  const metadata = await f.open(READ);
  text(await f.call('project_board', { view: 'work_context', context: metadata.context }, READ));
  error(await f.call('project_board', { view: 'health', context: metadata.context }, READ), 'forbidden-role');
  error(await f.call('project_board', { view: 'work_context', context: full.context }, READ), 'work-session-invalid');
  await assert.rejects(f.nativeCall('project_board', { view: 'health', context: full.context }), { code: 'work-session-invalid' });
  f.settings.projectIds = [];
  error(await f.call('project_board', { view: 'health', context: full.context }), 'project-forbidden');
  f.settings.projectIds = [f.h.id];
  f.advance(24 * 3600000);
  error(await f.call('project_board', { view: 'health', context: full.context }), 'work-session-invalid');
});
