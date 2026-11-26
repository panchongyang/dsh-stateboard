/**
 * 测试职责：冷复制后的普通文件证据只从当前 space 提交、复核和读取。
 * 典型流程：A 冷复制到 B → B 提交同名文件 → 复核与 reader 读回 → 改名保留 B 文件后明确缺失。
 * 覆盖边界：覆盖 B 的普通文件证据提交、复核、正文回读和缺失回报；不覆盖外置文档、Git 固定内容或其他读写边界。
 * 外部前置：Node 与隔离临时目录；通过候选 p1-isolate runner 执行，不需要 Git 或网络。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectService } from '../../lib/core/service.js';
import { auditEvidence } from '../../lib/core/evidence.js';
import { createKnowledgeReader } from '../../lib/core/knowledge/reader.js';
import { addTask, cmd } from '../helpers/knowledge-fixture.mjs';

const sha256 = text => createHash('sha256').update(text).digest('hex');

// 责任：相同历史 ID 不得使 B 的文件证据回到 A；B 缺失时也不能借 A 的同名文件补读。
test('file evidence in a cold space copy submits, audits and reads only its own ordinary file', async t => {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-space-file-evidence-')));
  const A = path.join(tmp, 'A'), B = path.join(tmp, 'B');
  const opened = [];
  const open = async spaceRoot => {
    const svc = new ProjectService({ spaceRoot });
    opened.push(svc);
    await svc.init();
    return svc;
  };
  // 合成目录和改名后的文件保留；只关闭本用例自己打开的 service/reader。
  t.after(async () => { for (const svc of opened.toReversed()) await svc.close(); });
  fs.mkdirSync(A);
  const seed = await open(A);
  const original = await seed.createProject({ workspacePath: A, actor: { kind: 'human', via: 'test' } });
  const projectId = original.id;
  const taskId = await addTask(original, 'Synthetic ordinary file evidence');
  const name = 'evidence.txt';
  const aBody = 'onlyAordinaryevidence 合成 A 文件\n';
  const bBody = 'onlyBordinaryevidence 合成 B 文件\n';
  fs.writeFileSync(path.join(A, name), aBody, { flag: 'wx' });
  await seed.close();
  fs.cpSync(A, B, { recursive: true, errorOnExist: true, force: false });
  fs.writeFileSync(path.join(B, name), bBody);

  const a = await open(A), b = await open(B);
  assert.equal(a.resolveWorkspace(A).projectId, projectId);
  assert.equal(b.resolveWorkspace(B).projectId, projectId);
  const ah = await a.open(projectId), bh = await b.open(projectId);
  assert.ok(ah.state.tasks[taskId], 'A 和 B 保留同一历史 task ID');
  assert.ok(bh.state.tasks[taskId], '复制后的 B 使用相同历史 task ID');
  const expected = () => ({ entityRev: bh.state.tasks[taskId].rev });
  await bh.command(cmd('task.claim', { taskId, expected: expected() }));
  const fencingToken = bh.leases.get(taskId).token;
  await bh.command(cmd('task.begin', { taskId, expected: expected(), fencingToken, summary: 'Submit synthetic B file' }));
  const submitted = await bh.command(cmd('task.submit', {
    taskId, expected: expected(), fencingToken,
    evidence: [{ kind: 'file', ref: name, acceptanceId: bh.state.tasks[taskId].acceptance[0].id }],
  }));
  assert.equal(submitted.committed, true);
  assert.equal(bh.state.tasks[taskId].state, 'review');
  const evidence = bh.state.tasks[taskId].evidence[0];
  assert.equal(evidence.hash, sha256(bBody), '提交必须记录 B 文件的 SHA-256');
  assert.notEqual(evidence.hash, sha256(aBody));
  assert.deepEqual(auditEvidence(bh, bh.state.tasks[taskId]), [], '文件证据复核只核对 B');
  await bh.command(cmd('task.verify', { taskId, expected: expected() }));
  assert.equal(bh.state.tasks[taskId].state, 'done');
  assert.equal(ah.state.tasks[taskId].evidence.length, 0, 'B 的提交不写入 A');

  // read_project_knowledge 的现有底层 reader，使用 B service，不注入历史根或伪造记录。
  const reader = createKnowledgeReader(b);
  t.after(() => reader.close());
  const found = await reader.search({ projectId, query: 'onlyBordinaryevidence', kinds: ['content'], relatedLimit: 0 });
  assert.equal(found.hits.length, 1, 'B 的文件正文可被现有 reader 找到');
  const ref = found.hits[0].ref;
  const read = () => reader.read({ projectId, refs: [ref] });
  const record = (await read()).records[0];
  assert.equal(record.availability, 'available');
  assert.equal(record.content, bBody);
  assert.equal(record.contentHash, sha256(bBody));
  const wrongRoot = await reader.search({ projectId, query: 'onlyAordinaryevidence', kinds: ['content'], relatedLimit: 0 });
  assert.equal(wrongRoot.hits.length, 0, '不得暴露 A 的同名文件正文');

  const bFile = path.join(B, name), saved = path.join(B, name + '.saved');
  assert.equal(path.dirname(bFile), B);
  assert.equal(path.dirname(saved), B);
  fs.renameSync(bFile, saved);
  assert.equal(fs.readFileSync(saved, 'utf8'), bBody, 'B 的合成文件改名保留而非删除');
  assert.equal(fs.readFileSync(path.join(A, name), 'utf8'), aBody, 'A 的同名文件仍然存在');
  const warnings = auditEvidence(bh, bh.state.tasks[taskId]);
  assert.deepEqual(warnings.map(row => [row.evidenceId, row.code, row.severity]), [[evidence.id, 'file-missing', 'error']]);
  const missing = (await read()).records[0];
  assert.equal(missing.availability, 'file-missing', 'B 缺失必须明确报告，不能从 A 补读');
  assert.equal(missing.content, null);
  assert.equal(bh.state.tasks[taskId].evidence[0].hash, sha256(bBody), '缺失不改变已记录的 B hash');
});
