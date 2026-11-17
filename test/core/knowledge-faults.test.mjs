/**
 * 测试职责：验证增量水位、分页失效、源日志损坏/替换与缓存/worker 故障隔离。
 * 典型流程：只修改合成 fixture 或派生缓存 → 搜索/读回 → 检查原始字节和任务流转。
 * 覆盖边界：覆盖合成缓存及来源故障、只读隔离；不覆盖真实数据故障注入。
 * 外部前置：SQLite 原生能力的事务用例在运行时确实缺失时明确跳过。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { commitHash } from '../../lib/core/store.js';
import { createKnowledgeReader } from '../../lib/core/knowledge/reader.js';
import { openKnowledgeIndex } from '../../lib/core/knowledge/sqlite-index.js';
import { readKnowledgeSnapshot } from '../../lib/core/knowledge/snapshot.js';
import { currentIndexState, updateIndex } from '../../lib/core/knowledge/build.js';
import { knowledgeFixture, addTask, cmd, tree, registerFile } from '../helpers/knowledge-fixture.mjs';

// 责任：增量批次公开落后水位并最终无遗漏追赶，旧引用保持可读。
test('incremental commit batches report lag until caught up and preserve all old references', async t => {
  const f = await knowledgeFixture(t, { recordCount: 2 });
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(await addTask(f.h, 'lagmarker ' + i));
  const first = await f.search('lagmarker');
  if (first.engine !== 'fts5') return t.skip('SQLite unavailable: bounded scan is tested separately');
  assert.ok(first.coverage.log.lag > 0);
  const old = first.hits[0].ref;
  let result = first;
  for (let i = 0; result.coverage.log.lag && i < 5; i++) result = await f.search('lagmarker');
  assert.equal(result.coverage.log.lag, 0);
  assert.deepEqual(result.hits.map(hit => hit.entity).sort(), ids.map(id => 'task:' + id).sort());
  assert.equal((await f.read(old)).records[0].availability, 'available');
});

// 责任：扫描降级的零命中窗口仍提供后续读取位置，不隐藏未覆盖历史。
test('fallback scan cursor continues across partial windows even after an empty window', async t => {
  const f = await knowledgeFixture(t, { disableSqlite: true, recordCount: 2 });
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(await addTask(f.h, 'scanwindow ' + i));
  let cursor, found = [];
  do {
    const result = await f.search('scanwindow', { limit: 1, ...(cursor ? { cursor } : {}) });
    found.push(...result.hits.map(hit => hit.entity));
    cursor = result.nextCursor;
  } while (cursor);
  assert.deepEqual(found.sort(), ids.map(id => 'task:' + id).sort());
  const empty = await f.search('absentword');
  assert.equal(empty.hits.length, 0);
  assert.ok(empty.nextCursor, 'zero hits do not hide unscanned history');
});

// 责任：分页期间日志或正文变化必须拒绝混接版本。
test('source and generation cursors expire instead of mixing versions', async t => {
  const f = await knowledgeFixture(t);
  for (let i = 0; i < 3; i++) await addTask(f.h, 'pagesource ' + i);
  const first = await f.search('pagesource', { limit: 1 });
  const second = await f.search('pagesource', { limit: 1, cursor: first.nextCursor });
  assert.notEqual(first.hits[0].ref, second.hits[0].ref);
  await addTask(f.h, 'pagesource newly added');
  await assert.rejects(f.search('pagesource', { limit: 1, cursor: first.nextCursor }), { code: 'knowledge-cursor-stale' });
  const { file } = await registerFile(f, 'paged.txt', 'pagedbody ' + '旧'.repeat(100));
  const body = (await f.search('pagedbody', { kinds: ['content'] })).hits[0];
  const page = (await f.read(body.ref, { maxBytes: 40 })).records[0];
  fs.writeFileSync(file, 'new source');
  await assert.rejects(f.read(body.ref, { cursor: page.nextCursor }), { code: 'knowledge-cursor-stale' });
});

// 责任：冷读保留未结束尾部并标明范围，已热索引也不能掩盖日志损坏。
test('cold reads flag an unfinished tail and reject corruption even when the index is warm', async t => {
  const f = await knowledgeFixture(t);
  await addTask(f.h, 'tailmarker');
  await f.search('tailmarker');
  const file = f.h.store.commitsFile;
  await f.svc.close();
  const original = fs.readFileSync(file, 'utf8');
  fs.appendFileSync(file, '{"partial":');
  const before = fs.readFileSync(file);
  const read = await f.search('tailmarker');
  assert.equal(read.coverage.log.unterminatedTail, true);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.existsSync(path.join(f.h.meta.dir, 'lock.json')), false);
  fs.writeFileSync(file, original.replace('tailmarker', 'tamperedmarker'));
  await assert.rejects(f.search('tailmarker'), { code: 'project-unreadable' });
});

// 责任：日志回退或同序号替换会失效派生缓存和不再存在的引用。
test('rollback and same-sequence replacement invalidate old cache and old source identities', async t => {
  const f = await knowledgeFixture(t);
  await addTask(f.h, 'keepmarker');
  await addTask(f.h, 'removedmarker');
  const original = (await f.search('removedmarker')).hits[0].ref;
  const file = f.h.store.commitsFile;
  await f.svc.close();
  const commits = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  const rolled = commits.slice(0, -1);
  fs.writeFileSync(file, rolled.map(JSON.stringify).join('\n') + '\n');
  assert.equal((await f.search('removedmarker')).hits.length, 0);
  await assert.rejects(f.read(original), { code: 'knowledge-reference-invalid' });
  const replacement = commits.at(-1);
  replacement.events[0].data.title = 'replacementmarker';
  replacement.hash = commitHash(replacement);
  fs.writeFileSync(file, [...rolled, replacement].map(JSON.stringify).join('\n') + '\n');
  assert.equal((await f.search('replacementmarker')).hits.length, 1);
  await assert.rejects(f.read(original), { code: 'knowledge-reference-invalid' });
});

// 责任：磁盘暂时可见但 writer 尚未发布的尾部不进入检索结果。
test('an uncommitted disk tail is excluded by the live published watermark', async t => {
  const f = await knowledgeFixture(t);
  await addTask(f.h, 'publishedmarker');
  const original = fs.readFileSync(f.h.store.commitsFile, 'utf8');
  const previous = f.h.store.commits.at(-1);
  const tentative = structuredClone(previous);
  tentative.seq++;
  tentative.prev = previous.hash;
  tentative.cmdId += 'tentative';
  tentative.events[0].type = 'task/updated';
  tentative.events[0].data.title = 'tentativemarker';
  tentative.events[0].data.rev++;
  tentative.hash = commitHash(tentative);
  fs.appendFileSync(f.h.store.commitsFile, JSON.stringify(tentative) + '\n');
  try {
    const result = await f.search('tentativemarker');
    assert.equal(result.hits.length, 0);
    assert.equal(result.coverage.log.verifiedThrough, previous.seq);
    assert.equal((await f.search('publishedmarker')).hits.length, 1);
  } finally { fs.writeFileSync(f.h.store.commitsFile, original); }
});

// 责任：索引事务中断时来源和水位同时回滚，重试同批次不漏项。
test('failed index transaction rolls back its progress and can replay the same batch', async t => {
  const f = await knowledgeFixture(t);
  await addTask(f.h, 'transactionmarker');
  const snapshot = readKnowledgeSnapshot({ projectId: f.projectId, dir: f.h.meta.dir, rootDir: f.stateDir, now: Date.now() });
  const index = await openKnowledgeIndex(f.stateDir, f.projectId);
  if (index.engine !== 'fts5') return t.skip('SQLite unavailable');
  try {
    let count = 0;
    const failed = { ...index, put(source) { const result = index.put(source); if (++count === 2) throw new Error('synthetic transaction failure'); return result; } };
    assert.throws(() => updateIndex(failed, snapshot), /synthetic transaction failure/);
    assert.equal(index.get('head'), null);
    assert.equal(index.count(), 0);
    assert.equal(updateIndex(index, snapshot).indexed.seq, snapshot.seq);
    assert.equal(index.search('transactionmarker', [], 10, 0).length, 1);
  } finally { index.close(); }
});

// 责任：缓存不可写和 worker 超时不会阻断普通任务提交与验收。
test('cache failures and timeout do not block task submission and acceptance', async t => {
  const f = await knowledgeFixture(t);
  const cache = path.join(f.stateDir, 'knowledge-cache');
  fs.writeFileSync(cache, 'synthetic unwritable cache directory');
  const taskId = await addTask(f.h, 'faultmarker');
  assert.equal((await f.search('faultmarker')).engine, 'scan');
  const slow = createKnowledgeReader(f.svc, { timeoutMs: 1 });
  t.after(() => slow.close());
  await assert.rejects(slow.search({ projectId: f.projectId, query: 'faultmarker' }), { code: 'knowledge-expired' });
  const expected = () => ({ entityRev: f.h.state.tasks[taskId].rev });
  await f.h.command(cmd('task.claim', { taskId, expected: expected() }));
  const fencingToken = f.h.leases.get(taskId).token;
  await f.h.command(cmd('task.begin', { taskId, expected: expected(), fencingToken, summary: 'Fault-isolated task work' }));
  await f.h.command(cmd('task.submit', { taskId, expected: expected(), fencingToken,
    evidence: [{ kind: 'note', ref: 'Synthetic result', acceptanceId: f.h.state.tasks[taskId].acceptance[0].id }] }));
  await f.h.command(cmd('task.verify', { taskId, expected: expected() }));
  assert.equal(f.h.state.tasks[taskId].state, 'done');
  assert.equal((await f.search('faultmarker')).coverage.log.lag, 0);
});

// 责任：损坏缓存可重建，全文表不提供正文存储列或外置正文副本。
test('corrupt cache is rebuilt, and contentless FTS stores no retrievable body column', async t => {
  const f = await knowledgeFixture(t);
  await registerFile(f, 'content.md', 'archiveprobe unique body phrase, exact original punctuation.');
  const first = await f.search('archiveprobe');
  if (first.engine !== 'fts5') return t.skip('SQLite unavailable');
  const { DatabaseSync } = await import('node:sqlite');
  const file = path.join(f.stateDir, 'knowledge-cache', f.projectId + '.sqlite');
  const db = new DatabaseSync(file);
  try { assert.equal(db.prepare('SELECT count(*) AS n FROM matches WHERE body IS NOT NULL').get().n, 0); }
  finally { db.close(); }
  fs.writeFileSync(file, 'corrupt synthetic derived cache');
  const before = tree(f.h.meta.dir);
  const next = await f.search('archiveprobe');
  assert.equal(next.engine, 'fts5');
  assert.equal(next.hits[0].ref, first.hits[0].ref);
  assert.deepEqual(tree(f.h.meta.dir), before);
});

// 责任：正文观测预算不足时轮询推进，并公开不可解码来源的原因。
test('body observation rotates within its budget and reports unreadable formats individually', async t => {
  const f = await knowledgeFixture(t, { bodyCount: 1 });
  await registerFile(f, 'first.md', 'firstbodyword');
  const { file } = await registerFile(f, 'second.md', 'secondbodyword');
  const first = await f.search('secondbodyword', { kinds: ['content'] });
  if (first.engine !== 'fts5') return t.skip('SQLite unavailable');
  assert.equal(first.coverage.bodies.deferred, 1);
  const second = await f.search('secondbodyword', { kinds: ['content'] });
  assert.equal(second.hits.length, 1);
  assert.equal(second.coverage.bodies.deferred, 0);
  fs.writeFileSync(file, Buffer.from([0xc3, 0x28]));
  await f.search('secondbodyword', { kinds: ['content'] });
  const missing = await f.search('secondbodyword', { kinds: ['content'] });
  assert.equal(missing.hits.length, 0);
  assert.equal(missing.coverage.bodies.unavailableReasons.undecodable, 1);
  assert.ok(missing.coverage.bodies.unavailableExamples[0].ref);
});

// 责任：关闭读取端口会取消工作并释放专用并发槽位。
test('close cancels knowledge workers and the independent concurrency slot is released', async t => {
  const f = await knowledgeFixture(t);
  await addTask(f.h, 'closemarker');
  const pending = f.search('closemarker');
  const rejected = assert.rejects(pending, { code: 'closed' });
  await assert.rejects(f.search('closemarker'), { code: 'knowledge-busy' });
  await f.reader.close();
  await rejected;
  await assert.rejects(f.search('closemarker'), { code: 'closed' });
  const next = createKnowledgeReader(f.svc);
  t.after(() => next.close());
  assert.equal((await next.search({ projectId: f.projectId, query: 'closemarker' })).hits.length, 1);
});

// 责任：取消与完成/关闭竞争时回收监听与名额，不能迟到取消其他请求或暴露已取消结果。
test('request abort cleanup is independent from reader close and later requests', async t => {
  const f = await knowledgeFixture(t);
  await addTask(f.h, 'abortmarker');
  const args = { projectId: f.projectId, query: 'abortmarker' };
  const controller = new AbortController();
  const pending = f.reader.search(args, { signal: controller.signal });
  const cancelled = assert.rejects(pending, error => error === null);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort(null);
  await cancelled;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const completed = new AbortController();
  assert.ok((await f.reader.search(args, { signal: completed.signal })).hits.length > 0);
  assert.equal(getEventListeners(completed.signal, 'abort').length, 0);
  completed.abort();
  const racing = new AbortController();
  const duringClose = f.reader.search(args, { signal: racing.signal });
  const refused = assert.rejects(duringClose);
  const closed = f.reader.close();
  racing.abort();
  await closed;
  await refused;
  assert.equal(getEventListeners(racing.signal, 'abort').length, 0);
  const next = createKnowledgeReader(f.svc);
  t.after(() => next.close());
  assert.ok((await next.search(args)).hits.length > 0);
});

// 责任：关联正文丢失时报告尝试和缺口，不能伪装成没有关联材料。
test('context discloses missing associated content instead of silently returning no relations', async t => {
  const f = await knowledgeFixture(t);
  const { file } = await registerFile(f, 'gapdocument.md', 'gap content');
  const source = (await f.search('gapdocument', { kinds: ['document'] })).hits[0];
  fs.renameSync(file, file + '.saved');
  const read = await f.read(source.ref, { mode: 'context' });
  assert.equal(read.records[0].availability, 'available');
  assert.equal(read.related.length, 0);
  assert.deepEqual(read.relatedUnavailable, [{ sourceRef: source.ref, reason: 'source.content', availability: 'file-missing' }]);
  assert.deepEqual(read.coverage.relatedBodies, { attempted: 1, available: 0, unavailable: 1 });
});

// 责任：冷读开始后新出现的 writer 必须再次核对，不能返回其尚未发布的磁盘尾部。
test('a writer becoming visible during a cold read cannot publish tentative knowledge', async t => {
  const f = await knowledgeFixture(t);
  await addTask(f.h, 'durablemarker');
  const file = f.h.store.commitsFile;
  const original = fs.readFileSync(file, 'utf8');
  const previous = f.h.store.commits.at(-1);
  const tentative = structuredClone(previous);
  tentative.seq++;
  tentative.prev = previous.hash;
  tentative.cmdId += 'pending';
  tentative.events[0].type = 'task/updated';
  tentative.events[0].data.title = 'pendingcoldmarker';
  tentative.events[0].data.rev++;
  tentative.hash = commitHash(tentative);
  fs.appendFileSync(file, JSON.stringify(tentative) + '\n');
  const lookup = f.svc.lookupLiveWriter.bind(f.svc);
  let lookups = 0;
  f.svc.lookupLiveWriter = id => ++lookups === 1 ? null : lookup(id);
  try {
    await assert.rejects(f.search('pendingcoldmarker'), { code: 'read-unstable' });
    assert.equal(lookups, 2);
  } finally { f.svc.lookupLiveWriter = lookup; fs.writeFileSync(file, original); }
  assert.equal((await f.search('pendingcoldmarker')).hits.length, 0);
});

// 责任：续页沿用同一个索引代，正文观测由普通搜索继续推进。
test('a next page does not advance the body sweep or invalidate its own generation', async t => {
  const f = await knowledgeFixture(t, { bodyCount: 1 });
  await addTask(f.h, 'pagefixture first');
  await addTask(f.h, 'pagefixture second');
  await registerFile(f, 'first.md', 'first body');
  await registerFile(f, 'second.md', 'second body');
  const options = { kinds: ['task'], limit: 1 };
  const first = await f.search('pagefixture', options);
  if (first.engine !== 'fts5') return t.skip('SQLite unavailable');
  assert.equal(first.coverage.log.lag, 0);
  assert.equal(first.coverage.bodies.observed, 1);
  const next = await f.search('pagefixture', { ...options, cursor: first.nextCursor });
  assert.equal(next.coverage.bodies.observed, 1);
  assert.equal(next.coverage.bodies.refreshed, 0);
  assert.notEqual(next.hits[0].ref, first.hits[0].ref);
  assert.equal(next.nextCursor, null);
  assert.equal((await f.search('pagefixture', options)).coverage.bodies.observed, 2);
  await assert.rejects(f.search('pagefixture', { ...options, cursor: first.nextCursor }), { code: 'knowledge-cursor-stale' });
});

// 责任：写事务返回自身代号，续页在同一读事务读取当前观测快照。
test('index update reports its own generation and continuation loads the committed sweep', async t => {
  const f = await knowledgeFixture(t);
  await registerFile(f, 'first.md', 'first body');
  await registerFile(f, 'second.md', 'second body');
  const snapshot = readKnowledgeSnapshot({ projectId: f.projectId, dir: f.h.meta.dir, rootDir: f.stateDir, now: Date.now() });
  const index = await openKnowledgeIndex(f.stateDir, f.projectId);
  if (index.engine !== 'fts5') return t.skip('SQLite unavailable');
  try {
    let committed = false;
    const interleaved = {
      ...index,
      get(key) { return committed && key === 'generation' ? 'other-generation' : index.get(key); },
      commit() { index.commit(); committed = true; },
    };
    const state = updateIndex(interleaved, snapshot, { bodyCount: 1 });
    assert.equal(state.generation, index.get('generation'));
    assert.equal(state.bodies.observed, 1);
    updateIndex(index, snapshot, { bodyCount: 1 });
    index.beginRead();
    try {
      const current = currentIndexState(index, snapshot);
      assert.equal(current.generation, index.get('generation'));
      assert.equal(current.bodies.observed, 2);
      assert.equal(current.bodies.refreshed, 0);
    } finally { index.commit(); }
  } finally { index.close(); }
});
