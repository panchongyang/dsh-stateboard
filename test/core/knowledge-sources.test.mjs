/**
 * 测试职责：逐项核对计划、内嵌档案、证据、旧审查、会话与固定内容的留存来源。
 * 典型流程：正常领域命令生成多版本 → 人工列出预期原文 → 搜索并精确读回。
 * 覆盖边界：覆盖留存来源逐项对照；不覆盖工作区扫描或命令证据执行。
 * 外部前置：固定内容用例需要本地 Git，仅操作合成仓库。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createKnowledgeReader } from '../../lib/core/knowledge/reader.js';
import { withProject } from '../helpers/service-fixture.mjs';
import { bootstrapPin, repository, git, put } from '../helpers/fixed-fixture.mjs';
import { knowledgeFixture, addTask, cmd, registerFile, tree } from '../helpers/knowledge-fixture.mjs';

async function submit(h, taskId, evidence) {
  const expected = () => ({ entityRev: h.state.tasks[taskId].rev });
  await h.command(cmd('task.claim', { taskId, expected: expected() }));
  const fencingToken = h.leases.get(taskId).token;
  await h.command(cmd('task.begin', { taskId, expected: expected(), fencingToken, summary: 'syntheticintent' }));
  await h.command(cmd('task.submit', { taskId, expected: expected(), fencingToken,
    evidence: evidence.map(row => ({ ...row, acceptanceId: h.state.tasks[taskId].acceptance[0].id })) }));
}

// 责任：旧计划、同一内嵌文档的旧版本和 additive 会话说明均保留原文。
test('immutable plans, inline revisions and additive session notes all retain their original wording', async t => {
  const f = await knowledgeFixture(t);
  await f.h.command(cmd('plan.publish', { title: 'Plan fixture', goal: 'legacyplanword',
    steps: [{ id: 's1', title: 'First', tasks: [{ key: 'x', title: 'Member', acceptance: [{ text: 'pass' }] }] }] }));
  const planId = f.h.state.project.focusPlanId;
  await f.h.command(cmd('plan.revise', { planId, baseVersion: 1, goal: 'currentplanword', steps: [{ id: 's1', title: 'First' }] }));
  const doc = await f.h.command(cmd('doc.put', { title: 'Archive', body: 'inlineoldword 第一版' }));
  const docId = doc.events[0].data.id;
  await f.h.command(cmd('doc.put', { docId, baseRev: 1, title: 'Archive', body: 'inlinenewword 第二版' }));
  assert.equal(f.h.state.docs[docId].rev, 2);
  await f.h.command(cmd('session.checkpoint', { actor: { kind: 'agent', sessionId: 'synthetic-history' }, note: 'checkpointword 继续核验原始边界' }));
  f.h.store.saveSnapshot();
  for (const [query, kind, expected] of [['legacyplanword', 'plan', 'legacyplanword'], ['currentplanword', 'plan', 'currentplanword'],
    ['inlineoldword', 'content', 'inlineoldword 第一版'], ['inlinenewword', 'content', 'inlinenewword 第二版'],
    ['checkpointword', 'session', 'checkpointword 继续核验原始边界']]) {
    const found = await f.search(query, { kinds: [kind] });
    assert.ok(found.hits.length, query);
    const read = await f.read(found.hits[0].ref);
    assert.ok(read.records[0].content.includes(expected), query);
  }
  const plans = await f.search('legacyplanword', { kinds: ['plan'] });
  const history = await f.search('legacyplanword', { kinds: ['plan'], historyRef: plans.hits[0].ref });
  const oldPlan = history.hits.find(row => row.eventType === 'plan/published');
  assert.equal(oldPlan.version, 1);
  const planRecord = JSON.parse((await f.read(oldPlan.ref)).records[0].content);
  assert.equal(planRecord.data.goal, 'legacyplanword');
  assert.ok(planRecord.head, 'the saved event head is part of the public original record');
});

// 责任：明确文档版本的证据只能展开对应旧版，再沿引用读到其原正文。
test('explicit evidence revision expands the saved document version, not current metadata', async t => {
  const f = await knowledgeFixture(t);
  const taskId = await addTask(f.h, 'Version binding');
  const first = await f.h.command(cmd('doc.put', { title: 'Versioned doc', body: 'boundoldbody' }));
  const docId = first.events[0].data.id;
  await submit(f.h, taskId, [{ kind: 'doc', ref: docId + '@1', summary: 'boundevidencemarker' }]);
  await f.h.command(cmd('doc.put', { docId, baseRev: 1, title: 'Versioned doc', body: 'boundnewbody' }));
  const evidence = (await f.search('boundevidencemarker', { kinds: ['evidence'] })).hits[0];
  const context = await f.read(evidence.ref, { mode: 'context' });
  const document = context.related.find(row => row.via.reason === 'evidence.document');
  assert.equal(document.revision, 1);
  assert.equal(document.via.scope, 'explicit-version');
  const expanded = await f.read(document.ref, { mode: 'context' });
  const content = expanded.related.find(row => row.via.reason === 'source.content');
  assert.equal((await f.read(content.ref)).records[0].content, 'boundoldbody');
});

// 责任：任务重开后仍能读取旧证据和审查，命令材料不会被执行。
test('superseded evidence and prior audit survive reopen; command refs are records only', async t => {
  const f = await knowledgeFixture(t);
  const taskId = await addTask(f.h, 'Audit fixture');
  await submit(f.h, taskId, [{ kind: 'note', ref: 'evidenceoldword' }, { kind: 'command', ref: 'never_execute_fixture_command', summary: 'commandmarker' }]);
  await f.h.command(cmd('task.verify', { taskId, expected: { entityRev: f.h.state.tasks[taskId].rev }, note: 'auditoldword 原始验收说明留存并不代表后来仍然适用' }));
  await f.h.command(cmd('task.reopen', { taskId, expected: { entityRev: f.h.state.tasks[taskId].rev }, reason: 'New work changes context' }));
  assert.equal(f.h.state.tasks[taskId].lastAudit, null);
  await submit(f.h, taskId, [{ kind: 'note', ref: 'evidencenewword' }]);
  const before = tree(f.h.meta.dir);
  for (const [word, kind] of [['auditoldword', 'audit'], ['evidenceoldword', 'evidence'], ['commandmarker', 'evidence'], ['syntheticintent', 'event']]) {
    const result = await f.search(word, { kinds: [kind] });
    assert.ok(result.hits.length, word);
    if (word === 'evidenceoldword') assert.equal(result.hits[0].fragment, word);
    assert.ok((await f.read(result.hits[0].ref)).records[0].content.includes(word));
  }
  assert.deepEqual(tree(f.h.meta.dir), before);
});

// 责任：文件证据核对内容 hash 并隐藏绝对路径，撤销登记后停止当前正文读取。
test('file evidence is hash-bound, absolute paths are hidden, and unregistered docs stop automatic body reads', async t => {
  const f = await knowledgeFixture(t);
  const taskId = await addTask(f.h, 'File evidence fixture');
  const file = path.join(f.wsDir, 'evidence.txt');
  fs.writeFileSync(file, 'evidencebodyword retained only on disk');
  await submit(f.h, taskId, [{ kind: 'file', ref: file }]);
  const found = await f.search('evidencebodyword', { kinds: ['content'] });
  assert.equal(found.hits.length, 1);
  assert.ok(!JSON.stringify(found).includes(f.wsDir));
  assert.ok(!JSON.stringify(await f.read(found.hits[0].ref)).includes(f.wsDir.replaceAll('\\', '\\\\')));
  fs.writeFileSync(file, 'changed');
  assert.equal((await f.read(found.hits[0].ref)).records[0].availability, 'source-changed');
  const registered = await registerFile(f, 'registered.md', 'unregisteredmarker');
  const observed = (await f.search('unregisteredmarker', { kinds: ['content'] })).hits[0];
  await f.h.command(cmd('doc.external.unregister', { docId: registered.docId, expectedMetaRev: 1 }));
  assert.equal((await f.read(observed.ref)).records[0].availability, 'source-unregistered');
  assert.equal((await f.search('unregisteredmarker', { kinds: ['content'] })).hits.length, 0);
});

// 责任：固定 Git 内容独立于工作区变化，丢失对象时不给出伪造正文。
test('recorded Git content is readable after the workspace changes and missing objects are explicit', async t => {
  const { root } = repository('sha1', t);
  put(root, 'history.md', 'fixedhistoryword original Git bytes\n');
  git(root, 'add', 'history.md');
  git(root, 'commit', '-m', 'fixed history fixture');
  const { svc, h } = await withProject(t, { workspacePath: root });
  const registered = await h.command(cmd('doc.external.register', { title: 'History', relPath: 'history.md' }));
  const evidence = await bootstrapPin(h, registered.docId);
  assert.ok(evidence.fixed);
  put(root, 'history.md', 'changed workspace bytes');
  const reader = createKnowledgeReader(svc);
  t.after(() => reader.close());
  const found = await reader.search({ projectId: h.id, query: 'fixedhistoryword', kinds: ['content'], relatedLimit: 0 });
  assert.equal(found.hits.length, 1);
  const read = () => reader.read({ projectId: h.id, refs: [found.hits[0].ref] });
  assert.equal((await read()).records[0].hashDomain, 'git-blob-bytes');
  assert.equal((await read()).records[0].content, 'fixedhistoryword original Git bytes\n');
  const object = path.join(root, '.git', 'objects', evidence.fixed.blobOid.slice(0, 2), evidence.fixed.blobOid.slice(2));
  fs.renameSync(object, object + '.saved');
  assert.notEqual((await read()).records[0].availability, 'available');
  assert.equal((await read()).records[0].content, null);
});
