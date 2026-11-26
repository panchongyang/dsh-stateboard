/**
 * 测试职责：知识工具在共同 context 下保持授权、预算和只读语义。
 * 典型流程：合成项目经 MCP 查询、读引用、触发拒绝并核对存储未变。
 * 覆盖边界：覆盖 实际 HTTP；不覆盖真实用户数据与 LLM 推理。
 * 外部前置：本机回环端口。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { knowledgeFixture, addTask, tree } from '../helpers/knowledge-fixture.mjs';
import { denied, KNOWLEDGE_JSON, listener, READ, success, WRITE } from '../helpers/mcp-fixture.mjs';

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
  denied(await mcp.callJson('search_project_knowledge', { context, query: 'x' }, READ), 'forbidden-role');
  denied(await mcp.callJson('read_project_knowledge', { context, refs: ['kb1.forged'] }), 'knowledge-reference-invalid');
  denied(await mcp.callJson('search_project_knowledge', { context, query: 'x', limit: 51 }), 'invalid-command');
  denied(await mcp.callJson('read_project_knowledge', { context, refs: Array(9).fill(found.hits[0].ref) }), 'invalid-command');
  denied(await mcp.callJson('search_project_knowledge', { context: 'forged', query: 'x' }), 'work-session-invalid');
  assert.deepEqual(tree(f.h.meta.dir), before);
});

// 责任：新旧协议和缺省协议默认只给模型文本，只有明确机器请求才给原对象 JSON，拒绝时同样不混送。
test('knowledge uses one output representation across protocol versions and failures', async t => {
  const f = await knowledgeFixture(t);
  await addTask(f.h, '知识文本默认来源', { description: '知识文本默认来源：保留这一段原文。' });
  const mcp = await listener(t, f.svc, { enabled: true, projectIds: [f.projectId] });
  const { context } = await success(mcp, 'project_session', { op: 'open', projectId: f.projectId });
  const search = { name: 'search_project_knowledge', arguments: { context, query: '知识文本默认来源', kinds: ['task'], relatedLimit: 0 } };
  const badRead = { name: 'read_project_knowledge', arguments: { context, refs: ['kb1.forged'] } };
  const baseline = await success(mcp, search.name, search.arguments);
  const read = { name: 'read_project_knowledge', arguments: { context, refs: [baseline.hits[0].ref] } };
  const readBaseline = await success(mcp, read.name, read.arguments);
  const model = (result, expected, failed = false) => {
    assert.deepEqual(Object.keys(result).sort(), failed ? ['content', 'isError'] : ['content']);
    if (failed) assert.equal(result.isError, true);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, 'text');
    const text = result.content[0].text;
    assert.match(text, expected);
    assert.throws(() => JSON.parse(text));
    return text;
  };
  for (const protocol of ['2025-11-25', '2025-03-26', null]) {
    const post = async params => (await mcp.post(WRITE, 'tools/call', params, protocol)).result;
    assert.match(model(await post(search), /Knowledge search/u), /保留这一段原文/u);
    assert.match(model(await post(read), /Knowledge read/u), /保留这一段原文/u);
    assert.deepEqual(await post({ ...search, _meta: KNOWLEDGE_JSON }), { content: [{ type: 'text', text: JSON.stringify(baseline) }] });
    assert.deepEqual(await post({ ...read, _meta: KNOWLEDGE_JSON }), { content: [{ type: 'text', text: JSON.stringify(readBaseline) }] });
    model(await post(badRead), /knowledge-reference-invalid/u, true);
    denied({ result: await post({ ...badRead, _meta: KNOWLEDGE_JSON }) }, 'knowledge-reference-invalid');
  }
  model((await mcp.call(search.name, search.arguments, READ)).result, /forbidden-role/u, true);
});
