/**
 * 测试职责：校验完整留存历史、派生索引生命周期与关键词/原文的两层读取。
 * 典型流程：人工构造旧决策和新记录 → 搜索 → 原文/关联 → 重建与增量。
 * 覆盖边界：覆盖历史原文、索引与降级；不覆盖真实项目或命令证据执行。
 * 外部前置：Node 内置 SQLite 可用时走 FTS5；显式另测扫描降级。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { decodeReference, encodeReference } from '../../lib/core/knowledge/reference.js';
import { createKnowledgeReader } from '../../lib/core/knowledge/reader.js';
import { knowledgeFixture, addTask, cmd, tree, registerFile } from '../helpers/knowledge-fixture.mjs';

// 责任：快照前的旧描述仍可检索，回读与原始人工文本一致且不改权威字节。
test('search reads historical task text before a snapshot and leaves authoritative bytes unchanged', async t => {
  const f = await knowledgeFixture(t);
  const taskId = await addTask(f.h, 'Boundary investigation', { description: '旧约束：不能把相关性作为有效性。接口 restore_context。' });
  await f.h.command(cmd('task.update', { taskId, expected: { entityRev: f.h.state.tasks[taskId].rev }, description: '新描述不再包含旧关键词。' }));
  f.h.store.saveSnapshot();
  const before = tree(f.h.meta.dir);
  const found = await f.search('相关性');
  assert.equal(found.hits.length, 1);
  assert.equal(found.hits[0].revision, 1);
  assert.equal(found.coverage.log.lag, 0);
  assert.equal(found.coverage.absenceMeansNoConstraint, false);
  const read = await f.read(found.hits[0].ref);
  const payload = JSON.parse(read.records[0].content);
  assert.equal(payload.data.description, '旧约束：不能把相关性作为有效性。接口 restore_context。');
  assert.equal(payload.data.id, taskId);
  assert.equal(read.records[0].hashDomain, 'public-record-utf8');
  assert.equal(found.hits[0].contentHash, undefined);
  assert.match(found.hits[0].fragment, /旧约束：不能把相关性作为有效性/);
  assert.deepEqual(tree(f.h.meta.dir), before);
  const identifier = await f.search('restore_context');
  assert.equal(identifier.hits[0].ref, found.hits[0].ref);
  await addTask(f.h, 'Separated words', { description: 'restore context are separate tokens' });
  assert.equal((await f.search('restore_context')).hits.length, 1, 'identifier punctuation is significant');
  const empty = await f.search('unseen_unique_concept');
  assert.equal(empty.hits.length, 0);
  assert.equal(empty.coverage.absenceMeansNoConstraint, false);
});

// 责任：派生缓存重建和连续追赶不改变历史来源引用。
test('derived cache rebuild keeps references; incremental calls neither duplicate nor mutate facts', async t => {
  const f = await knowledgeFixture(t);
  await addTask(f.h, 'rebuilduuid');
  const first = await f.search('rebuilduuid');
  const repeated = await f.search('rebuilduuid');
  assert.deepEqual(repeated.hits.map(row => row.ref), first.hits.map(row => row.ref));
  const cache = path.join(f.stateDir, 'knowledge-cache');
  if (fs.existsSync(cache)) fs.renameSync(cache, cache + '.saved');
  assert.deepEqual((await f.search('rebuilduuid')).hits.map(row => row.ref), first.hits.map(row => row.ref));
  await addTask(f.h, 'freshdelta');
  const next = await f.search('freshdelta');
  assert.equal(next.hits.length, 1);
  assert.equal(next.coverage.log.lag, 0);
  assert.equal((await f.read(first.hits[0].ref)).records[0].availability, 'available');
});

// 责任：记录中的依赖与调用者自由联想分别标注，联想不写入事实。
test('one-hop recorded dependency is separate from unrestricted caller association', async t => {
  const f = await knowledgeFixture(t);
  const dependency = await addTask(f.h, '跨模块硬边界');
  await addTask(f.h, 'searchseed', { deps: [dependency] });
  const result = await f.search('searchseed', { relatedLimit: 10 });
  assert.equal(result.hits.length, 1);
  assert.equal(result.related[0].entity, 'task:' + dependency);
  assert.equal(result.related[0].via.reason, 'task.deps');
  assert.equal(result.related[0].via.scope, 'target-at-read-watermark');
  const before = tree(f.h.meta.dir);
  const arbitrary = await f.search('跨模块', { discovery: { parents: [result.hits[0].ref], reason: '模型联想到别的模块；待核对' } });
  assert.equal(arbitrary.discovery.basis, 'caller-suggested');
  assert.equal(arbitrary.discovery.persisted, false);
  assert.deepEqual(tree(f.h.meta.dir), before);
  const context = await f.read(result.hits[0].ref, { mode: 'context' });
  assert.equal(context.related[0].entity, 'task:' + dependency);
});

// 责任：外置文件改变或丢失后不使用索引伪造旧正文。
test('observed external text is not archived and changes cannot replace an old reference', async t => {
  const f = await knowledgeFixture(t);
  const { file, docId } = await registerFile(f, 'rules.md', '# Rules\nbodymarker 旧正文😀\n');
  const rev = f.h.state.docs[docId].rev;
  const found = await f.search('bodymarker', { kinds: ['content'] });
  assert.equal(found.hits.length, 1);
  const ref = found.hits[0].ref;
  assert.equal((await f.read(ref)).records[0].content, '# Rules\nbodymarker 旧正文😀\n');
  fs.writeFileSync(file, '# Changed\nnewbodymarker\n');
  assert.equal(f.h.state.docs[docId].rev, rev);
  const changed = await f.read(ref);
  assert.equal(changed.records[0].availability, 'source-changed');
  assert.equal(changed.records[0].content, null);
  assert.equal((await f.search('newbodymarker', { kinds: ['content'] })).hits.length, 1);
  fs.renameSync(file, file + '.saved');
  assert.equal((await f.read(ref)).records[0].content, null);
  const missing = await f.search('newbodymarker', { kinds: ['content'] });
  assert.equal(missing.hits.length, 0);
  assert.equal(missing.coverage.bodies.unavailable, 1);
  assert.equal(missing.coverage.bodies.archived, false);
});

// 责任：中文及表情分页可无损拼回，跨项目与伪造来源被拒绝。
test('bounded UTF-8 reads support exact continuation and reject forged identities', async t => {
  const f = await knowledgeFixture(t);
  await registerFile(f, 'long.txt', 'paginationmarker\n' + '跨会话😀'.repeat(100));
  const source = (await f.search('paginationmarker', { kinds: ['content'] })).hits[0];
  let cursor, text = '';
  do {
    const result = await f.read(source.ref, { maxBytes: 127, ...(cursor ? { cursor } : {}) });
    text += result.records[0].content;
    assert.ok(Buffer.byteLength(result.records[0].content) <= 127);
    cursor = result.records[0].nextCursor;
  } while (cursor);
  assert.equal(text, 'paginationmarker\n' + '跨会话😀'.repeat(100));
  const forged = decodeReference(source.ref, f.projectId);
  forged.commitHash = 'sha256:' + '0'.repeat(64);
  await assert.rejects(f.read(encodeReference(forged)), { code: 'knowledge-reference-invalid' });
  await assert.rejects(f.reader.read({ projectId: 'prj_' + 'a'.repeat(16), refs: [source.ref] }), { code: 'knowledge-reference-invalid' });
});

// 责任：原生索引不可用时仍能扫描并沿相同来源引用读取。
test('SQLite unavailable scans with honest coverage and the same exact source references', async t => {
  const normal = await knowledgeFixture(t);
  const taskId = await addTask(normal.h, 'fallbackmarker 知识恢复');
  const first = await normal.search('知识恢复');
  const reader = createKnowledgeReader(normal.svc, { disableSqlite: true });
  t.after(() => reader.close());
  const result = await reader.search({ projectId: normal.projectId, query: '知识恢复', relatedLimit: 0 });
  assert.equal(result.engine, 'scan');
  assert.equal(result.ranking, 'keyword-overlap');
  assert.equal(result.hits[0].entity, 'task:' + taskId);
  assert.equal(result.hits[0].ref, first.hits[0].ref);
  assert.equal(result.coverage.log.lag, 0);
});

// 责任：中文紧邻接口名不导致英文标识漏检，两种引擎保持词法一致。
test('mixed Chinese text preserves embedded English identifiers in FTS and fallback', async t => {
  const f = await knowledgeFixture(t);
  await addTask(f.h, '中英混写', { description: '采用FTS5检索，调用restore_context恢复上下文。' });
  const fallback = createKnowledgeReader(f.svc, { disableSqlite: true });
  t.after(() => fallback.close());
  for (const query of ['FTS5', 'restore_context', '恢复上下文']) {
    const indexed = await f.search(query);
    const scanned = await fallback.search({ projectId: f.projectId, query, relatedLimit: 0 });
    assert.equal(indexed.hits.length, 1, query);
    assert.equal(scanned.hits[0].ref, indexed.hits[0].ref, query);
  }
});

// 责任：实体折叠和关联补位不会丢失历史原文、来源引用或有效续页。
test('folded results retain readable versions and fill unused relation places', async t => {
  const f = await knowledgeFixture(t);
  const taskId = await addTask(f.h, '部署标记', { description: '旧部署版本 oldBuild。' });
  const first = (await f.search('部署标记')).hits[0];
  for (let i = 0; i < 4; i++) {
    await f.h.command(cmd('task.update', { taskId, expected: { entityRev: f.h.state.tasks[taskId].rev },
      description: '已部署 newBuild。' + '说明'.repeat(110) + '\n未主动重启，运行期加载尚未确认。' + i }));
  }
  const otherId = await addTask(f.h, '部署标记 独立任务');
  for (const disableSqlite of [false, true]) {
    const reader = createKnowledgeReader(f.svc, { disableSqlite });
    t.after(() => reader.close());
    const search = args => reader.search({ projectId: f.projectId, query: '部署标记', kinds: ['task'], ...args });
    const page = await search({ limit: 2, relatedLimit: 1 });
    assert.deepEqual(new Set(page.hits.map(hit => hit.entity)), new Set(['task:' + taskId, 'task:' + otherId]));
    assert.equal(page.related.length, 0);
    const current = page.hits.find(hit => hit.entity === 'task:' + taskId);
    assert.equal(current.revision, 5);
    assert.equal(current.historyCount, 5);
    assert.match(current.fragment, /newBuild/);
    assert.match(current.fragment, /未主动重启，运行期加载尚未确认/);
    assert.doesNotMatch(current.fragment, /taskId|contentHash/);
    assert.equal(current.actor, undefined);
    const expanded = await search({ historyRef: current.ref, limit: 5, relatedLimit: 0 });
    assert.equal(expanded.hits.length, 5);
    assert.ok(expanded.hits.some(hit => hit.ref === first.ref));
    assert.match((await f.read(first.ref)).records[0].content, /oldBuild/);
    const one = await search({ limit: 1, relatedLimit: 0 });
    const two = await search({ limit: 1, relatedLimit: 0, cursor: one.nextCursor });
    assert.notEqual(two.hits[0].entity, one.hits[0].entity);
    assert.equal(two.nextCursor, null);
    const byId = await search({ query: taskId, limit: 50, relatedLimit: 0 });
    assert.ok(byId.hits.some(hit => hit.eventType === 'task/updated' && hit.revision === 5 && hit.historyCount === 5));
  }
});

// 责任：双引擎优先精确匹配，放宽词组时保持独立标签和分页。
test('both engines prefer exact and label bounded loose keyword groups', async t => {
  const f = await knowledgeFixture(t);
  const target = await addTask(f.h, '探针验证', { description: '检查宿主重启后的工具注册。' });
  await addTask(f.h, '探针单词');
  await addTask(f.h, '探针备用', { description: '这条也涉及重启。' });
  await addTask(f.h, '标识匹配', { description: '恢复部署 knowledge-cursor-stale。' });
  for (const disableSqlite of [false, true]) {
    const reader = createKnowledgeReader(f.svc, { disableSqlite });
    t.after(() => reader.close());
    const search = (query, args) => reader.search({ projectId: f.projectId, query, kinds: ['task'], relatedLimit: 0, ...args });
    assert.equal((await search('探针 重启')).queryMatch, 'exact');
    const result = await search('探针重启', { limit: 1 });
    assert.equal(result.queryMatch, 'relaxed');
    const next = await search('探针重启', { limit: 1, cursor: result.nextCursor });
    assert.equal(next.queryMatch, 'relaxed');
    assert.notEqual(next.hits[0].ref, result.hits[0].ref);
    const hit = [result.hits[0], next.hits[0]].find(row => row.entity === 'task:' + target);
    assert.deepEqual(hit.matchedGroups, ['探针', '重启']);
    assert.deepEqual(hit.missingGroups, ['针重']);
    assert.equal((await search('探针 关闭 重启')).hits.length, 2);
    assert.equal((await search('探针 关闭')).hits.length, 0);
    assert.equal((await search('knowledge-cursor-stale 恢复 部署')).queryMatch, 'exact');
    assert.equal((await search('knowledge-cursor-typo')).hits.length, 0);
  }
});

// 责任：可用于补位的直接候选成为关联时不重复占位，也不丢掉关联理由。
test('explicit links to non-anchor keyword candidates occupy one place without hiding the links', async t => {
  const f = await knowledgeFixture(t, { disableSqlite: true });
  const extra = await addTask(f.h, 'linked extra');
  const direct = await addTask(f.h, 'linked direct', { description: 'pagekeyword' });
  const dependency = await addTask(f.h, 'linked dependency');
  await addTask(f.h, 'pagekeyword anchor one', { deps: [direct, dependency, extra] });
  await addTask(f.h, 'pagekeyword anchor two');
  const page = await f.search('pagekeyword', { kinds: ['task'], limit: 4, relatedLimit: 2 });
  assert.deepEqual(page.related.map(hit => hit.entity), ['task:' + direct, 'task:' + dependency]);
  assert.equal(page.related[0].via.reason, 'task.deps');
  assert.equal(page.hits[page.related[0].via.fromHit].title, 'pagekeyword anchor one');
  assert.ok(page.relatedTruncated);
  assert.ok(page.hits.every(hit => hit.entity !== 'task:' + direct));
});
