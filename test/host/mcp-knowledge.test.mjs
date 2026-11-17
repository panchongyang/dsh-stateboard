/**
 * 测试职责：知识工具在共同 context 下保持授权、预算和只读语义。
 * 典型流程：合成项目经 MCP 查询、读引用、触发拒绝并核对存储未变。
 * 覆盖边界：覆盖 实际 HTTP；不覆盖真实用户数据与 LLM 推理。
 * 外部前置：本机回环端口。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { knowledgeFixture, addTask, tree } from '../helpers/knowledge-fixture.mjs';
import { denied, listener, READ, success } from '../helpers/mcp-fixture.mjs';

// 责任：知识引用原文、预算和授权在新上下文下保持只读。
test('shared knowledge tools preserve permissions, originals and budgets without leases', async t => {
  const f = await knowledgeFixture(t);
  const taskId = await addTask(f.h, 'MCP历史关键词');
  const mcp = await listener(t, f.svc, { enabled: true, projectIds: [f.projectId] });
  const { context } = await success(mcp, 'project_session', { op: 'open', projectId: f.projectId });
  const before = tree(f.h.meta.dir);
  const found = await success(mcp, 'search_project_knowledge', { context, query: '历史关键词', relatedLimit: 0 });
  assert.equal(found.hits[0].entity, 'task:' + taskId);
  const read = await success(mcp, 'read_project_knowledge', { context, refs: [found.hits[0].ref], mode: 'context' });
  assert.equal(JSON.parse(read.records[0].content).data.title, 'MCP历史关键词');
  assert.equal(f.h.leases.size, 0);
  denied(await mcp.call('search_project_knowledge', { context, query: 'x' }, READ), 'forbidden-role');
  denied(await mcp.call('read_project_knowledge', { context, refs: ['kb1.forged'] }), 'knowledge-reference-invalid');
  denied(await mcp.call('search_project_knowledge', { context, query: 'x', limit: 51 }), 'invalid-command');
  denied(await mcp.call('read_project_knowledge', { context, refs: Array(9).fill(found.hits[0].ref) }), 'invalid-command');
  denied(await mcp.call('search_project_knowledge', { context: 'forged', query: 'x' }), 'work-session-invalid');
  assert.deepEqual(tree(f.h.meta.dir), before);
});
