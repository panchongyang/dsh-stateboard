/**
 * 测试职责：固定文件安全边界与 context 多项目生命周期的定向回归。
 * 典型流程：两个项目/两个上下文，验证拒绝、独立身份和全量 detach。
 * 覆盖边界：覆盖 实际两端注册及 HTTP；全部 op/view 比较在默认契约门禁。；不覆盖真实用户数据与 LLM 推理。
 * 外部前置：可写临时目录与回环端口。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, text, error } from '../helpers/agent-parity-fixture.mjs';
import { attachAgent, detachAgent } from '../../lib/host/lifecycle.js';

// 责任：同一原生身份跨项目工作，退出时释放所有项目租约和句柄。
test('native project contexts keep one identity and disposal detaches every project', async t => {
  const f = await fixture(t);
  const otherRoot = path.join(f.base, 'other');
  fs.mkdirSync(otherRoot);
  const other = await f.svc.createProject({ workspacePath: otherRoot });
  const contexts = [];
  for (const project of [f.h, other]) {
    const opened = await f.nativeCall('project_session', { op: 'open', projectId: project.id });
    contexts.push(opened.context);
    await f.nativeCall('project_task', { op: 'create', title: 'owned', acceptance: [{ text: 'done' }], context: opened.context });
    const taskId = Object.keys(project.state.tasks)[0];
    await f.nativeCall('project_task', { op: 'claim', taskId, expectedRev: 1, context: opened.context });
    assert.equal(project.leases.size, 1);
  }
  await assert.rejects(f.nativeCall('project_board', { view: 'health', context: contexts[0] }, { ...f.exec, agent: { ...f.exec.agent, id: 'other-agent' } }), { code: 'work-session-invalid' });
  await assert.rejects(f.nativeCall('project_board', { view: 'health', context: '' }), { code: 'work-session-invalid' });
  await detachAgent(f.runtime, f.exec.agent);
  for (const project of [f.h, other]) {
    assert.equal(project.leases.size, 0);
    assert.ok(project.state.bindings[f.exec.agent.id].detachedAt);
  }
  await assert.rejects(f.nativeCall('project_board', { view: 'health', context: contexts[0] }), { code: 'work-session-invalid' });
});

// 责任：显式跨项目 context 不得污染默认 cwd 的系统提示或后续省略 context 的操作。
test('native context selection preserves the owning workspace prompt and default target', async t => {
  const f = await fixture(t);
  let section;
  f.exec.agent.ctx = { inject(_services, callback) {
    callback({ systemPrompt: { section(value) { section = value; } } });
    return { dispose() {} };
  } };
  await attachAgent(f.runtime, f.exec.agent, 'startup');
  const otherRoot = path.join(f.base, 'other'); fs.mkdirSync(otherRoot);
  const other = await f.svc.createProject({ workspacePath: otherRoot });
  const baseline = section.text();
  assert.ok(baseline.length > 0);
  assert.equal(baseline, f.h.digest(f.exec.agent.id));
  assert.notEqual(baseline, other.digest(f.exec.agent.id));
  const { context } = await f.nativeCall('project_session', { op: 'open', projectId: other.id });
  await f.nativeCall('project_task', { op: 'create', title: 'explicit other', acceptance: [{ text: 'ok' }], context });
  assert.equal(section.text(), baseline);
  await f.nativeCall('project_task', { op: 'create', title: 'default own', acceptance: [{ text: 'ok' }] });
  assert.equal(Object.values(f.h.state.tasks)[0].title, 'default own');
  assert.equal(Object.values(other.state.tasks)[0].title, 'explicit other');
  assert.equal(f.runtime.sessionProjects.get(f.exec.agent.id), f.h);
  assert.equal(f.runtime.sessionHandles.get(f.exec.agent.id).size, 2);
});

// 责任：MCP 项目选择保持逻辑身份与原上下文归属并重查授权。
test('switching MCP project retains actor but never changes another context project', async t => {
  const f = await fixture(t);
  const otherRoot = path.join(f.base, 'other');
  fs.mkdirSync(otherRoot);
  const other = await f.svc.createProject({ workspacePath: otherRoot });
  f.settings.projectIds.push(other.id);
  const one = await f.open();
  const two = await f.open(undefined, { projectId: other.id, context: one.context });
  text(await f.call('project_task', { op: 'create', title: 'first', acceptance: [{ text: 'ok' }], context: one.context }));
  text(await f.call('project_task', { op: 'create', title: 'second', acceptance: [{ text: 'ok' }], context: two.context }));
  assert.equal(Object.values(f.h.state.tasks)[0].title, 'first');
  assert.equal(Object.values(other.state.tasks)[0].title, 'second');
  assert.deepEqual(Object.keys(f.h.state.bindings), Object.keys(other.state.bindings));
  error(await f.call('project_board', { view: 'health', context: '' }), 'work-session-invalid');
  f.settings.projectIds = [f.h.id];
  error(await f.call('project_board', { view: 'health', context: two.context }), 'project-forbidden');
});
