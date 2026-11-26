/**
 * 测试职责：已提交读值不能被工作态或后续提交污染，失败不能丢写。
 * 典型流程：合成项目 → 保留快照 → 提交/拒绝 → 对比旧值和最新读模型。
 * 覆盖边界：覆盖发布水位、嵌套防回写、日志载荷防别名；不覆盖真实磁盘硬件。
 * 外部前置：无；仅临时合成数据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectService } from '../../lib/core/service.js';
import { assertStateAttached } from '../../lib/core/handle.js';

async function setup(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-committed-'));
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-committed-ws-'));
  const service = await new ProjectService({ rootDir }).init();
  t.after(() => service.close());
  return { service, handle: await service.createProject({ workspacePath, name: 'committed-values' }) };
}
const actor = { kind: 'agent', sessionId: 'alias-session' };

// 责任：成功提交保留旧快照，拒绝命令不改变最新事实和发布水位。
test('committed values preserve writes across successful and rejected commands', async t => {
  const { handle } = await setup(t);
  const initial = handle.committedSnapshot();
  const result = await handle.command({ cmdId: 'alias-create', op: 'task.create', actor, title: 'alias', acceptance: [{ text: 'done' }] });
  const taskId = result.events.find(e => e.type === 'task/created').taskId;
  const committed = handle.committedSnapshot();
  assert.equal(initial.state.tasks[taskId], undefined, 'old committed value changed');
  assert.equal(committed.state.tasks[taskId].rev, 1);
  assert.equal(committed.state.project.rev, committed.lastSeq);
  assert.equal(committed.lastHash, handle.store.lastHash);
  assert.equal(committed.lastSeq, handle.store.lastSeq);
  await assert.rejects(handle.command({ cmdId: 'alias-reject', op: 'task.claim', actor, taskId, expected: { entityRev: 42 } }), { code: 'stale-revision' });
  assert.equal(handle.rev, committed.lastSeq);
  assert.deepEqual(handle.committedSnapshot().state, committed.state);
  assert.equal(handle.query('task', { taskId }).task.id, taskId);
  assertStateAttached(handle);
});

// 责任：禁止嵌套读引用回写，调用方修改返回事件或集合不能污染已提交状态与历史。
test('published state cannot be detached or mutated through nested read references', async t => {
  const { handle } = await setup(t);
  const result = await handle.command({ cmdId: 'alias-create-2', op: 'task.create', actor, title: 'safe', acceptance: [{ text: 'done' }] });
  const taskId = result.events.find(e => e.type === 'task/created').taskId;
  assert.throws(() => { handle.state = structuredClone(handle.state); }, TypeError);
  const snapshot = handle.committedSnapshot();
  assert.throws(() => { snapshot.state.tasks[taskId].acceptance[0].text = 'corrupted'; }, TypeError);
  result.events.find(e => e.type === 'task/created').data.title = 'caller-mutated';
  assert.equal(handle.state.tasks[taskId].title, 'safe', 'command event aliases published value');
  assert.equal(handle.store.commits.at(-1).events.find(e => e.type === 'task/created').data.title, 'safe', 'caller rewrote retained history');
  snapshot.cmdIds.clear(); snapshot.leases.set('injected', {});
  assert.equal(handle.cmdIds.has('alias-create-2'), true);
  assert.equal(handle.leases.has('injected'), false);
  assertStateAttached(handle);
});
