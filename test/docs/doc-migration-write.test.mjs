/**
 * 测试职责：保证获授权的内嵌转外置迁移保留身份和历史档案，失败可恢复且零部分写入。
 * 典型流程：临时多版本文档和恢复验证备份 → migrate/故障注入/冷开 → 对照映射、日志和旧证据。
 * 覆盖边界：覆盖 授权、备份、WAL 原子性、幂等续跑及旧读者拒绝；不覆盖真实用户文件搬运或生产迁移。
 * 外部前置：无；CLI 和全部备份均为合成临时目录。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { ProjectService } from '../../lib/core/service.js';
import { JsonlStore, MemoryStore, makeCommit } from '../../lib/core/store.js';
import { EVENT_REGISTRY } from '../../lib/shared/events.js';
import { assertEventSupported } from '../../lib/core/model.js';
import { assertDocEventsInLog } from '../../lib/core/documents/external-model.js';
import { checkMigrationBackup } from '../../lib/core/documents/migration-backup.js';
import { migrateInlineDocuments } from '../../lib/core/documents/migration.js';
import { readInlineArchive } from '../../lib/core/documents/migration-archive.js';
import { normalizeEvidence, auditEvidence } from '../../lib/core/evidence.js';
import { checkState } from '../../lib/core/fsck.js';
import { scanPrefix } from '../../lib/core/repair.js';
import { sha256 } from '../../lib/core/util.js';
import { scan } from '../../scripts/stores-replay.mjs';
import { validateCommits } from '../../lib/core/store/format.js';
import { docMigrate } from '../../lib/core/commands/doc-migration.js';

const human = (op, fields = {}) => ({ op, cmdId: randomUUID(), actor: { kind: 'human', via: 'test' }, ...fields });
function tree(root, result = {}, base = root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) tree(full, result, base);
    else result[path.relative(base, full)] = sha256(fs.readFileSync(full));
  }
  return result;
}

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-d6-write-'));
  const ws = path.join(root, 'workspace');
  fs.mkdirSync(ws);
  const svc = new ProjectService({ rootDir: path.join(root, 'board'), privilegedInlineWrites: true });
  await svc.init();
  const h = await svc.createProject({ workspacePath: ws });
  t.after(async () => { await svc.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const task = await h.command(human('task.create', { title: 'Linked', acceptance: [{ text: 'spec' }] }));
  const taskId = task.events[0].data.id;
  const created = await h.command(human('doc.put', { title: 'Spec', body: 'old\r\n', links: { taskIds: [taskId] } }));
  const docId = created.events[0].data.id;
  await h.command(human('doc.put', { docId, baseRev: 1, title: 'Spec', body: 'new\n' }));
  await h.command(human('doc.link', { docId, links: { taskIds: [taskId] } }));
  const source = structuredClone(h.state.docs[docId]);
  const file = path.join(ws, 'spec.md');
  fs.writeFileSync(file, 'new\n');
  const backupDir = path.join(root, 'backup');
  fs.cpSync(h.meta.dir, backupDir, { recursive: true });
  const backup = { directory: backupDir, restoreTested: true };
  const mapping = { sourceDocId: docId, sourceRev: source.rev, sourceHash: source.hash,
    locator: { bindingId: svc.bindings().mainOf(h.id).bindingId, relPath: 'spec.md' } };
  const run = (fields = {}) => h.command(human('doc.external.migrate', { authorized: true, backup, ...mapping, ...fields }));
  return { root, ws, svc, h, taskId, docId, source, file, backup, mapping, run };
}

// 责任：迁移只改元数据并保留 docId/links，历史映射完整不可变且不改工作区或 blob。
test('migration is metadata-only, keeps identity/links and exports exhaustive immutable archive mapping', async (t) => {
  const { h, ws, docId, source, run } = await setup(t);
  const files = tree(ws);
  const idsBefore = Object.keys(h.state.docs).sort();
  const blobs = tree(h.store.blobsDir);
  const first = await run();
  assert.deepEqual(Object.keys(h.state.docs).sort(), idsBefore, 'migration must never add a document or drop an existing identity');
  assert.equal(first.events[0].type, 'doc/external-migrated');
  assert.equal(first.events[0].sourceDocId, docId);
  assert.equal(first.events[0].sourceRev, 3);
  assert.equal(first.events[0].sourceHash, sha256('new\n'));
  const doc = h.state.docs[docId];
  assert.equal(doc.source, 'external');
  assert.equal(doc.rev, source.rev + 1);
  assert.deepEqual(doc.links, source.links);
  assert.equal(doc.hash, undefined);
  assert.deepEqual(first.mapping.history.map((row) => row.sourceRev), [1, 2, 3]);
  assert.equal(first.mapping.history[1].sourceHash, first.mapping.history[2].sourceHash);
  assert.equal(readInlineArchive(h, docId, 1).body, 'old\r\n');
  assert.equal(readInlineArchive(h, docId, 1).source, 'inline-archive');
  assert.equal(readInlineArchive(h, docId, 1).gitManaged, false);
  assert.deepEqual(tree(ws), files);
  assert.deepEqual(tree(h.store.blobsDir), blobs);
  assert.ok(checkState(h.state).checks.filter((row) => row.name.startsWith('doc-')).every((row) => row.ok));
  const rev = h.rev;
  assert.deepEqual((await run()).mapping, first.mapping);
  assert.equal(h.rev, rev);
  await assert.rejects(run({ sourceHash: sha256('wrong') }), { code: 'migration-conflict' });
});

// 责任：缺人工授权、恢复验证备份或源 rev/hash 匹配时必须拒绝且日志零写入。
test('authorization, intact restore-tested backup and source revision/hash are mandatory, rejection writes nothing', async (t) => {
  const { h, backup, run } = await setup(t);
  const bytes = fs.readFileSync(h.store.commitsFile);
  await assert.rejects(run({ authorized: false }), { code: 'migration-authorization-required' });
  await assert.rejects(run({ actor: { kind: 'agent' } }), { code: 'forbidden-role' });
  await assert.rejects(run({ backup: null }), { code: 'migration-backup-required' });
  await assert.rejects(run({ backup: { ...backup, restoreTested: false } }), { code: 'migration-backup-required' });
  await assert.rejects(run({ sourceRev: 2 }), { code: 'stale-revision' });
  assert.ok(checkMigrationBackup(h, backup).hash);
  fs.appendFileSync(path.join(backup.directory, 'commits.jsonl'), '{');
  await assert.rejects(run());
  assert.deepEqual(fs.readFileSync(h.store.commitsFile), bytes);
});

// 责任：历史不可恢复或目标已有不同字节须明确报错，绝不能覆盖用户目标文件。
test('unrecoverable history and different existing target bytes are explicit; user files are never overwritten', async (t) => {
  const { h, file, run, source } = await setup(t);
  fs.writeFileSync(file, 'user content');
  await assert.rejects(run(), { code: 'migration-conflict' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'user content');
  fs.writeFileSync(file, 'new\n');
  fs.unlinkSync(path.join(h.store.blobsDir, sha256('old\r\n')));
  await assert.rejects(run(), { code: 'migration-unrecoverable' });
  assert.equal(h.state.docs[source.id].source, undefined);
});

// 责任：两次校验间 blob 或导出源发生变化时必须拒绝，不得留下迁移事件。
test('blob and exported source file changes between verification reads are detected without an event', async (t) => {
  const { h, file, run } = await setup(t);
  const before = fs.readFileSync(h.store.commitsFile);
  const original = h.store.readMigrationBlob.bind(h.store);
  let reads = 0;
  h.store.readMigrationBlob = (hash) => {
    reads++;
    if (reads === 8) fs.writeFileSync(file, 'concurrent edit');
    return original(hash);
  };
  // Inventory reads three revision blobs; target preflight reads the current one;
  // the second source history pass runs before final target verification.
  await assert.rejects(run(), (error) => ['migration-source-changed', 'migration-conflict'].includes(error.code));
  assert.deepEqual(fs.readFileSync(h.store.commitsFile), before);
  fs.writeFileSync(file, 'new\n');
  reads = 0;
  h.store.readMigrationBlob = (hash) => {
    if (++reads === 8) fs.writeFileSync(path.join(h.store.blobsDir, sha256('old\r\n')), 'changed original');
    return original(hash);
  };
  await assert.rejects(run(), { code: 'migration-source-changed' });
  assert.deepEqual(fs.readFileSync(h.store.commitsFile), before);
  fs.writeFileSync(path.join(h.store.blobsDir, sha256('old\r\n')), Buffer.from([0xff]));
  h.store.readMigrationBlob = original;
  assert.equal(h.store.readMigrationBlob(sha256('old\r\n')), null, 'invalid UTF-8 is not decoded with replacement');
  await assert.rejects(run(), { code: 'migration-unrecoverable' });
});

// 责任：批次中断或部分失败后须能续跑，重复输入不得重复追加同一迁移。
test('batch interruption/partial failure is resumable and a duplicate input never appends twice', async (t) => {
  const { h, svc, mapping, backup, file } = await setup(t);
  const first = await migrateInlineDocuments(h, { mappings: [mapping, { ...mapping, sourceDocId: 'doc_absent', locator: { ...mapping.locator, relPath: 'absent.md' } }], authorized: true, backup });
  assert.equal(first.mappings.length, 1);
  assert.equal(first.problems[0].code, 'not-found');
  const rev = h.rev;
  const retry = await migrateInlineDocuments(h, { mappings: [mapping], authorized: true, backup });
  assert.deepEqual(retry.mappings, first.mappings);
  assert.equal(h.rev, rev);
  // Durable commit, lost response/process: close/reopen, then retry with fresh cmdId.
  const id = h.id;
  await svc.close();
  const reader = new JsonlStore(h.meta.dir, h.meta, { lock: false });
  reader.open();
  assert.equal(reader.state.docs[mapping.sourceDocId].source, 'external');
  assert.equal(fs.readFileSync(file, 'utf8'), 'new\n');
  assert.equal(reader.commits.filter((commit) => commit.events.some((event) => event.type === 'doc/external-migrated')).length, 1);
  assert.equal(reader.state.project.id, id);
});

// 责任：WAL 部分写失败须回滚，已持久化但未确认的迁移冷续跑不得重复提交。
test('partial WAL failure rolls back; a durable but unacknowledged migration resumes cold without duplicate', async (t) => {
  const { h, svc, root, mapping, backup, run } = await setup(t);
  const before = fs.readFileSync(h.store.commitsFile);
  h.store.fs = { ...fs, writeFileSync(fd, bytes) {
    fs.writeSync(fd, bytes.subarray(0, 17));
    throw Object.assign(new Error('injected partial write'), { code: 'EIO' });
  } };
  await assert.rejects(run(), { code: 'EIO' });
  assert.deepEqual(fs.readFileSync(h.store.commitsFile), before);
  assert.equal(h.state.docs[mapping.sourceDocId].source, undefined);
  let once = true;
  h.store.fs = { ...fs, closeSync(fd) {
    fs.closeSync(fd);
    if (once) { once = false; throw new Error('injected lost acknowledgement'); }
  } };
  await assert.rejects(run(), { code: 'log-write-uncertain' });
  assert.equal(h.readOnly, true);
  h.store.fs = fs;
  const id = h.id;
  await svc.close();
  const reopenedService = new ProjectService({ rootDir: path.join(root, 'board'), privilegedInlineWrites: true });
  t.after(() => reopenedService.close());
  await reopenedService.init();
  const reopened = await reopenedService.open(id);
  const rev = reopened.rev;
  const result = await migrateInlineDocuments(reopened, { mappings: [mapping], authorized: true, backup });
  assert.equal(result.mappings.length, 1);
  assert.deepEqual(result.problems, []);
  assert.equal(reopened.rev, rev);
  assert.equal(reopened.store.commits.filter((commit) => commit.events.some((event) => event.type === 'doc/external-migrated')).length, 1);
  await reopenedService.close();
});

// 责任：残片冷开只修不完整帧，续跑后须恰有一份映射且不用人工清理。
test('crash-fragment cold open repairs only incomplete framing and resumes with one mapping, no manual cleanup', async (t) => {
  const { h, svc, root, mapping, backup } = await setup(t);
  const planned = docMigrate(h, human('doc.external.migrate', { authorized: true, backup, ...mapping }));
  const commit = makeCommit(h.rev + 1, h.lastHash, { kind: 'human' }, randomUUID(), h.rev, planned.events);
  const file = h.store.commitsFile;
  const count = h.store.commits.length;
  const id = h.id;
  await svc.close();
  fs.appendFileSync(file, JSON.stringify(commit).slice(0, 41)); // process died mid-WAL, not a complete event
  const reopenedService = new ProjectService({ rootDir: path.join(root, 'board'), privilegedInlineWrites: true });
  t.after(() => reopenedService.close());
  await reopenedService.init();
  const reopened = await reopenedService.open(id);
  assert.equal(reopened.store.commits.length, count);
  const result = await migrateInlineDocuments(reopened, { mappings: [mapping], authorized: true, backup });
  assert.deepEqual(result.problems, []);
  const rev = reopened.rev;
  const again = await migrateInlineDocuments(reopened, { mappings: [mapping], authorized: true, backup });
  assert.deepEqual(again, result);
  assert.equal(reopened.rev, rev);
  const log = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.doesNotThrow(() => validateCommits(log));
  assert.equal(log.length, count + 1);
  assert.equal(log.filter((row) => row.events.some((event) => event.type === 'doc/external-migrated')).length, 1);
  await reopenedService.close();
});

// 责任：迁移后的历史档案即使人工重开内嵌写也不得被编辑。
test('migrated archives stay read-only even when a human re-enables inline writes', async (t) => {
  const { h, run, docId } = await setup(t);
  await run();
  assert.equal(h.state.project.inlineWritesDisabled, true);
  const blobs = tree(h.store.blobsDir);
  const events = h.store.commits.length;
  await assert.rejects(h.command(human('doc.put', { docId, baseRev: 4, title: 'No', body: 'no' })), { code: 'inline-write-disabled' });
  await assert.rejects(h.command(human('doc.link', { docId, links: {} })), { code: 'inline-write-disabled' });
  assert.deepEqual(tree(h.store.blobsDir), blobs);
  assert.equal(h.store.commits.length, events);
  // Re-opening the project fence does not resurrect the archive.
  await h.command(human('doc.inline_policy', { authorized: true, disabled: false, expected: { projectRev: h.rev } }));
  await assert.rejects(h.command(human('doc.put', { docId, baseRev: 4, title: 'No', body: 'no' })), { code: 'inline-write-disabled' });
  await assert.rejects(h.command(human('doc.link', { docId, links: { taskIds: [] } })), { code: 'inline-write-disabled' });
  // The fence itself is human-only; an agent cannot open it.
  await assert.rejects(
    h.command({ cmdId: randomUUID(), op: 'doc.inline_policy', actor: { kind: 'agent', sessionId: 's1' }, authorized: true, disabled: false, expected: { projectRev: h.rev } }),
    { code: 'forbidden-role' },
  );
});

// 责任：迁移不得改变历史 fixed/legacy 证据的原始哈希域。
test('historical fixed/legacy evidence stays in its original hash domain after migration', async (t) => {
  const { h, taskId, docId, run } = await setup(t);
  const task = h.state.tasks[taskId];
  const pinned = { kind: 'doc', ref: docId + '@1', hash: sha256('old\r\n') };
  const bare = { kind: 'doc', ref: docId, hash: sha256('new\n') };
  await run();
  const normalized = normalizeEvidence(h, task, { kind: 'doc', ref: docId + '@1' }, 'now', { kind: 'human' });
  assert.equal(normalized.hash, pinned.hash);
  assert.equal(normalized.ref, pinned.ref);
  assert.equal(normalized.fixedState, undefined);
  assert.deepEqual(auditEvidence(h, { ...task, evidence: [pinned, bare] }), []);
});

// 责任：裸内嵌证据迁移后仍须遵守冻结 head 漂移守卫，不能被新工作区内容蒙混。
test('bare inline evidence keeps its frozen-head drift gate after migration and workspace edits', async (t) => {
  const { h, root, ws, svc, taskId } = await setup(t);
  await h.attach({ sessionId: 'bare-drift', agentId: 'bare-drift', source: 'test', role: 'worker' });
  await h.command(human('task.gate', { taskId, expected: { entityRev: h.state.tasks[taskId].rev }, requiresAudit: true }));
  const agent = (op, fields = {}) => ({ ...human(op, fields), actor: { kind: 'agent', sessionId: 'bare-drift' } });
  const created = await h.command(human('doc.put', { title: 'Bare drift', body: 'revision one' }));
  const docId = created.events[0].data.id;
  await h.command(agent('task.claim', { taskId, expected: { entityRev: h.state.tasks[taskId].rev } }));
  await h.command(agent('task.begin', { taskId, expected: { entityRev: h.state.tasks[taskId].rev },
    fencingToken: h.leases.get(taskId).token, summary: 'capture bare inline evidence' }));
  await h.command(agent('task.submit', { taskId, expected: { entityRev: h.state.tasks[taskId].rev },
    fencingToken: h.leases.get(taskId).token, evidence: [{ kind: 'doc', ref: docId,
      acceptanceId: h.state.tasks[taskId].acceptance[0].id }] }));
  assert.equal(h.state.tasks[taskId].state, 'review');
  const submitted = structuredClone(h.state.tasks[taskId].evidence[0]);
  assert.equal(submitted.ref, docId);
  assert.equal(submitted.hash, sha256('revision one'));
  await h.command(human('doc.put', { docId, baseRev: 1, title: 'Bare drift', body: 'revision two' }));
  const assertDrift = async () => {
    const warnings = auditEvidence(h, h.state.tasks[taskId]);
    assert.ok(warnings.some((row) => row.code === 'doc-drift' && row.severity === 'error'), JSON.stringify(warnings));
    await assert.rejects(h.command(human('task.verify', { taskId, expected: { entityRev: h.state.tasks[taskId].rev } })), { code: 'evidence-drift' });
    assert.equal(h.state.tasks[taskId].state, 'review');
  };
  await assertDrift();
  const file = path.join(ws, 'bare.md');
  fs.writeFileSync(file, 'revision two');
  const directory = path.join(root, 'bare-drift-backup');
  fs.cpSync(h.meta.dir, directory, { recursive: true });
  await h.command(human('doc.external.migrate', { authorized: true, sourceDocId: docId, sourceRev: 2,
    sourceHash: sha256('revision two'), backup: { directory, restoreTested: true },
    locator: { bindingId: svc.bindings().mainOf(h.id).bindingId, relPath: 'bare.md' } }));
  assert.ok(h.state.docs[docId].migration.history.some((row) => row.sourceHash === submitted.hash));
  await assertDrift();
  fs.writeFileSync(file, 'a later workspace edit');
  await assertDrift();
  const task = h.state.tasks[taskId];
  const pinned = normalizeEvidence(h, task, { kind: 'doc', ref: docId + '@1' }, 'now', { kind: 'human' });
  assert.equal(pinned.hash, submitted.hash);
  assert.equal(readInlineArchive(h, docId, 1).body, 'revision one');
  assert.deepEqual(auditEvidence(h, { ...task, evidence: [pinned] }), []);
  const frozenHead = { ...submitted, hash: h.state.docs[docId].migration.sourceHash };
  assert.deepEqual(auditEvidence(h, { ...task, evidence: [frozenHead] }), [], 'bare references compare to the frozen inline head, not the mutable workspace');
});

// 责任：CLI 只用显式合成 store，备份检查须只读，应用后冷重放结果必须一致。
test('CLI uses explicit synthetic stores, checks backups read-only, applies and replays identically', async (t) => {
  const { h, svc, root, mapping, backup } = await setup(t);
  const source = h.meta.dir;
  const id = h.id;
  const before = fs.readFileSync(h.store.commitsFile);
  const check = JSON.parse(execFileSync(process.execPath, ['scripts/doc-migration.mjs', '--store', source,
    '--authorized-read', '--check-backup', '--backup', backup.directory, '--restore-tested'], { encoding: 'utf8' }));
  assert.equal(check.projectId, id);
  assert.deepEqual(fs.readFileSync(h.store.commitsFile), before);
  const input = path.join(root, 'mappings.json');
  fs.writeFileSync(input, JSON.stringify([mapping]));
  await svc.close();
  const args = ['scripts/doc-migration.mjs', '--apply', '--board', path.join(root, 'board'), '--project', id,
    '--backup', backup.directory, '--mappings', input, '--authorized-read', '--authorized-migrate', '--restore-tested'];
  const first = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8' }));
  const bytes = fs.readFileSync(path.join(source, 'commits.jsonl'));
  const second = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8' }));
  assert.deepEqual(first, second);
  assert.equal(first.mappings.length, 1);
  assert.deepEqual(first.problems, []);
  assert.deepEqual(fs.readFileSync(path.join(source, 'commits.jsonl')), bytes);
});

// 责任：重放不变量中登记只计一次，迁移不得被算成新建文档。
test('existing stores-replay invariant gate counts registration once and migration never as a new document', async (t) => {
  const { h, svc, root, ws, run } = await setup(t);
  await run();
  fs.writeFileSync(path.join(ws, 'other.md'), 'other');
  await h.command(human('doc.external.register', { title: 'Other', relPath: 'other.md' }));
  const id = h.id;
  await svc.close();
  const checked = await scan(path.join(root, 'board', 'projects'));
  assert.deepEqual(checked.problems, []);
  assert.equal(checked.report[id].docs, 2);
  assert.equal(checked.report[id].docCreated, 2);
});

// 责任：冷重放和快照须保留历史，坏映射与不认识迁移事件的旧注册表必须 fail closed。
test('cold replay, snapshot anchor and strict old registry preserve history and fail closed on bad mapping', async (t) => {
  const { h, run, docId } = await setup(t);
  await run();
  h.store.saveSnapshot();
  const file = h.store.commitsFile;
  const raw = fs.readFileSync(file, 'utf8');
  const commits = raw.trim().split('\n').map(JSON.parse);
  const migrated = commits.at(-1);
  const oldRegistry = { ...EVENT_REGISTRY };
  delete oldRegistry['doc/external-migrated'];
  assert.throws(() => assertEventSupported(h.state, migrated.events[0], migrated, oldRegistry), { code: 'incompatible-event' });
  assert.equal(scanPrefix(file, { registry: oldRegistry }).lines.length, commits.length - 1);
  assert.equal(scanPrefix(file).lines.length, commits.length);
  const reader = new JsonlStore(h.meta.dir, h.meta, { lock: false });
  assert.deepEqual(reader.open().state.docs, h.state.docs);
  assert.equal(reader.commits.length, commits.length);
  const duplicate = makeCommit(migrated.seq + 1, migrated.hash, { kind: 'human' }, randomUUID(), migrated.seq, migrated.events);
  const replayed = new MemoryStore(h.meta, structuredClone([...commits, duplicate])).open();
  assert.deepEqual(replayed.state.docs[docId], h.state.docs[docId]);
  const bad = structuredClone(commits);
  bad.at(-1).events[0].data.migration.history.pop();
  assert.throws(() => assertDocEventsInLog(bad), { code: 'invalid-external-doc' });
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
});
