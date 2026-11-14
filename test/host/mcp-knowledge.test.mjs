/**
 * 测试职责：验证外部 Agent 的搜索 → 引用 → 原文链路及项目工作会话授权。
 * 典型流程：回环 MCP 发现工具 → 无租约读历史 → 越权/非法引用拒绝。
 * 覆盖边界：覆盖 MCP 授权和两层读取；不覆盖真实配置或工作区。
 * 外部前置：本机回环端口。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { listener, success, denied, READ, WRITE } from '../helpers/mcp-fixture.mjs';
import { knowledgeFixture, addTask, tree } from '../helpers/knowledge-fixture.mjs';

// 责任：外部调用无任务租约也能读知识，但概览凭据、跨项目及伪造会话不获正文权限。
test('MCP exposes history only on the authorized project channel and needs no task lease', async t => {
  const f = await knowledgeFixture(t);
  const taskId = await addTask(f.h, 'MCP历史关键词');
  const mcp = await listener(t, f.svc, { enabled: true, projectIds: [f.projectId] });
  const { sessionToken } = await success(mcp, 'open_work_session', { projectId: f.projectId });
  const scope = { projectId: f.projectId, sessionToken };
  const before = tree(f.h.meta.dir);
  const tools = (await mcp.post(WRITE, 'tools/list', {})).result.tools;
  for (const name of ['search_project_knowledge', 'read_project_knowledge']) assert.equal(tools.find(tool => tool.name === name).annotations.readOnlyHint, true);
  assert.ok(!(await mcp.post(READ, 'tools/list', {})).result.tools.some(tool => tool.name === 'search_project_knowledge'));
  assert.ok((await mcp.call('search_project_knowledge', { ...scope, query: '历史关键词' }, READ)).error);
  const found = await success(mcp, 'search_project_knowledge', { ...scope, query: '历史关键词', relatedLimit: 0 });
  assert.equal(found.hits[0].entity, 'task:' + taskId);
  const read = await success(mcp, 'read_project_knowledge', { ...scope, refs: [found.hits[0].ref], mode: 'context' });
  assert.equal(JSON.parse(read.records[0].content).data.title, 'MCP历史关键词');
  assert.equal(f.h.leases.size, 0);
  denied(await mcp.call('search_project_knowledge', { ...scope, projectId: 'prj_' + 'f'.repeat(16), query: 'x' }), 'project-forbidden');
  denied(await mcp.call('read_project_knowledge', { ...scope, refs: ['kb1.forged'] }), 'knowledge-reference-invalid');
  denied(await mcp.call('search_project_knowledge', { ...scope, query: 'x', limit: 51 }), 'invalid-command');
  denied(await mcp.call('read_project_knowledge', { ...scope, refs: Array(9).fill(found.hits[0].ref) }), 'invalid-command');
  const forgedSession = '0'.repeat(32) + '.' + Date.now() + '.' + '0'.repeat(64);
  denied(await mcp.call('search_project_knowledge', { ...scope, sessionToken: forgedSession, query: 'x' }), 'work-session-invalid');
  assert.deepEqual(tree(f.h.meta.dir), before);
});
