/**
 * 测试职责：约束 v2 人工门到 v3 审计门迁移的离线预检、备份与可续跑性。
 * 典型流程：合成全状态旧日志/草案 → dry-run 或 apply → 验证备份、旧前缀、新事件及冷重放。
 * 覆盖边界：覆盖 授权工具数据安全、标签迁移和侧文件恢复；不覆盖真实生产 store 或人工发布。
 * 外部前置：无；全部 store 与备份为临时合成数据。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateGateV3, storeHashes } from '../../scripts/migrate-gate-v3.mjs';
import { JsonlStore } from '../../lib/core/store.js';
import { makeCommit, validateCommits } from '../../lib/core/store/format.js';

const at = '2026-01-01T00:00:00.000Z';
function fixture({ drafts = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-gate-migrate-test-'));
  const dir = path.join(root, 'prj_fixture');
  fs.mkdirSync(dir);
  const project = { id: 'prj_fixture', name: 'Synthetic v2', phase: 'active', workspacePath: root, schemaVersion: 2, rev: 1, createdAt: at, updatedAt: at, focusPlanId: null };
  const meta = { schemaVersion: 2, projectId: project.id, project, createdAt: at };
  const states = ['backlog', 'ready', 'in_progress', 'review', 'blocked', 'interrupted', 'done', 'canceled'];
  const tasks = states.map((state, index) => ({
    id: 'tsk_' + state, title: state, state, rev: 1, priority: 100, weight: 1,
    labels: index % 2 ? ['gate:human', 'sample'] : ['sample'], requiresHumanReview: index % 2 === 1,
    deps: [], planRef: null, orphaned: state === 'backlog', evidence: [],
    acceptance: [{ id: 'acc_' + index, text: 'Synthetic', requiredKinds: [], met: false, evidenceIds: [] }],
    owner: state === 'in_progress' ? { sessionId: 'worker', agentId: 'worker', fencingToken: 1 } : null,
    assignee: null, work: null, createdAt: at, updatedAt: at,
    ...(state === 'done' ? { verifiedAt: at, verifiedBy: 'policy' } : {}),
  }));
  const events = [{ type: 'project/created', data: project }, ...tasks.map((data) => ({ type: 'task/created', taskId: data.id, rev: data.rev, data }))];
  if (drafts) events.push({ type: 'plan/created', data: {
    id: 'pln_draft', title: 'Draft', status: 'draft', rev: 1, currentVersion: 0, createdAt: at, updatedAt: at,
    draft: { goal: '', assumptions: [], risks: [], steps: [{ id: 'draft', title: 'Draft phase', tasks: [{ key: 'future', title: 'Future task', requiresHumanReview: true, labels: ['gate:human'], acceptance: [{ text: 'Check' }] }] }] },
  } });
  const commit = makeCommit(1, 'genesis', { kind: 'human', sessionId: 'synthetic-author' }, 'fixture-v2', 0, events);
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta) + '\n');
  fs.writeFileSync(path.join(dir, 'commits.jsonl'), JSON.stringify(commit) + '\n');
  fs.mkdirSync(path.join(dir, 'blobs'));
  fs.writeFileSync(path.join(dir, 'blobs', 'untouched'), 'original blob bytes');
  return { dir, root, meta, tasks, commit };
}
function commits(dir) { return fs.readFileSync(path.join(dir, 'commits.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); }
function open(dir) {
  const store = new JsonlStore(dir, JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')), { lock: false });
  try { return structuredClone(store.open().state); } finally { store.close(); }
}

// 责任：v2 日志须被运行时拒绝，默认迁移预检要完整列出任务/草案且零写入。
test('v2 runtime refuses; default preflight is zero-write and describes every task/draft', () => {
  const { dir, root } = fixture();
  const before = storeHashes(dir);
  const entries = fs.readdirSync(root);
  assert.throws(() => open(dir), (error) => error.code === 'schema-migration-required');
  const result = migrateGateV3({ dir });
  assert.equal(result.fromSchema, 2);
  assert.equal(result.tasks, 8);
  assert.equal(result.gated, 4);
  assert.equal(result.plannedEvents, 10);
  assert.deepEqual(result.legacyDrafts, ['pln_draft']);
  assert.equal(result.dryRun, true);
  assert.deepEqual(storeHashes(dir), before);
  assert.deepEqual(fs.readdirSync(root), entries);
});

// 责任：apply 必须先备份并保留旧日志前缀，终态/孤立任务与草案门迁移后可冷开。
test('apply backs up before append, preserves old bytes, migrates terminal/orphan tasks and draft gates, then opens cold', () => {
  const { dir, tasks } = fixture();
  const before = storeHashes(dir);
  const originalLog = fs.readFileSync(path.join(dir, 'commits.jsonl'));
  const result = migrateGateV3({ dir, apply: true });
  assert.deepEqual(storeHashes(result.backup), before);
  assert.equal(result.events, 10);
  assert.equal(result.health.ok, true, JSON.stringify(result.health.warnings));
  assert.deepEqual(result.newWarnings, []);
  assert.deepEqual(new Set(result.eventTypes), new Set(['project/updated', 'plan/updated', 'task/updated']));
  assert.equal(fs.readFileSync(path.join(dir, 'commits.jsonl')).subarray(0, originalLog.length).equals(originalLog), true);
  const log = commits(dir);
  validateCommits(log);
  assert.equal(log.length, 2);
  assert.equal(log[0].hash, result.beforeHash);
  const state = open(dir);
  assert.equal(state.schemaVersion, 3);
  assert.equal(state.project.schemaVersion, 3);
  for (const old of tasks) {
    const next = state.tasks[old.id];
    assert.equal(next.state, old.state);
    assert.equal(next.rev, old.rev + 1);
    assert.equal(next.requiresAudit, old.requiresHumanReview);
    assert.equal(Object.hasOwn(next, 'requiresHumanReview'), false);
    assert.equal(next.labels.includes('gate:human'), false);
    assert.equal(next.labels.includes('gate:audit'), old.requiresHumanReview);
    assert.equal(next.orphaned, old.orphaned);
  }
  assert.equal(state.tasks.tsk_done.verifiedBy, 'policy');
  assert.equal(state.tasks.tsk_done.verifiedAt, at);
  const draft = state.planHeads.pln_draft.draft.steps[0].tasks[0];
  assert.equal(draft.requiresAudit, true);
  assert.equal(Object.hasOwn(draft, 'requiresHumanReview'), false);
  assert.deepEqual(draft.labels, ['gate:audit']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8')).state.schemaVersion, 3);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).schemaVersion, 3);
  assert.equal(fs.existsSync(path.join(dir, 'lock.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'lock.json.claim')), false);
  // A complete rerun makes no extra backup/event/revision.
  const migrated = storeHashes(dir);
  const entries = fs.readdirSync(path.dirname(dir)).sort();
  assert.equal(migrateGateV3({ dir, apply: true }).noOp, true);
  assert.deepEqual(storeHashes(dir), migrated);
  assert.deepEqual(fs.readdirSync(path.dirname(dir)).sort(), entries);
  // Backup-only rollback: restored bytes are exactly the old reader's input.
  const restored = path.join(path.dirname(dir), 'restored-v2');
  fs.cpSync(result.backup, restored, { recursive: true });
  assert.deepEqual(storeHashes(restored), before);
  assert.equal(migrateGateV3({ dir: restored }).fromSchema, 2);
  assert.throws(() => open(restored), (error) => error.code === 'schema-migration-required');
});

// 责任：无草案时只追加项目/任务事件，旧 gate:human 标签也须转换为审计门。
test('no draft uses only project/updated and task/updated; labels-only legacy gate is preserved', () => {
  const { dir } = fixture({ drafts: false });
  const log = commits(dir);
  const row = log[0].events.find((event) => event.taskId === 'tsk_ready');
  delete row.data.requiresHumanReview;
  // Rebuild valid synthetic history after changing the fixture; never real history.
  const fixed = makeCommit(1, 'genesis', log[0].actor, 'label-only-fixture', 0, log[0].events);
  fs.writeFileSync(path.join(dir, 'commits.jsonl'), JSON.stringify(fixed) + '\n');
  const result = migrateGateV3({ dir, apply: true });
  assert.deepEqual(result.eventTypes, ['project/updated', 'task/updated']);
  assert.equal(open(dir).tasks.tsk_ready.requiresAudit, true);
});

// 责任：已有锁不得删除或抢占，预检失败须保持源数据哈希不变。
test('existing lock is never removed or taken over; preflight failure changes no data', () => {
  const { dir } = fixture();
  const lock = path.join(dir, 'lock.json');
  fs.writeFileSync(lock, '{"pid":99999999,"nonce":"do-not-steal"}');
  const bytes = fs.readFileSync(lock);
  const before = storeHashes(dir);
  assert.throws(() => migrateGateV3({ dir, apply: true }), /resolve its lock/);
  assert.deepEqual(fs.readFileSync(lock), bytes);
  assert.deepEqual(storeHashes(dir), before);
});

// 责任：不完整尾部、坏哈希链或不安全备份位置必须拒绝，不能修写源日志。
test('incomplete tail, invalid chain and unsafe backup all refuse without rewriting source', () => {
  for (const kind of ['tail', 'hash', 'backup']) {
    const { dir } = fixture();
    if (kind === 'tail') fs.appendFileSync(path.join(dir, 'commits.jsonl'), '{"partial":');
    if (kind === 'hash') {
      const log = commits(dir);
      log[0].hash = 'sha256:' + '0'.repeat(64);
      fs.writeFileSync(path.join(dir, 'commits.jsonl'), JSON.stringify(log[0]) + '\n');
    }
    const before = storeHashes(dir);
    assert.throws(() => migrateGateV3({ dir, apply: true, ...(kind === 'backup' ? { backup: path.join(dir, 'nested-backup') } : {}) }));
    assert.deepEqual(storeHashes(dir), before);
    assert.equal(fs.existsSync(path.join(dir, 'lock.json')), false);
    assert.equal(fs.existsSync(path.join(dir, 'lock.json.claim')), false);
  }
});

// 责任：备份目标须是未使用的外部位置，已有无关内容不得覆盖。
test('backup destination must be unused and external; unrelated existing content stays intact', () => {
  const { dir, root } = fixture();
  const backup = path.join(root, 'existing');
  fs.mkdirSync(backup);
  fs.writeFileSync(path.join(backup, 'keep'), 'keep me');
  const before = storeHashes(dir);
  assert.throws(() => migrateGateV3({ dir, apply: true, backup }), /already exists/);
  assert.deepEqual(storeHashes(dir), before);
  assert.equal(fs.readFileSync(path.join(backup, 'keep'), 'utf8'), 'keep me');
});

// 责任：迁移已提交但侧文件未完成时重跑须补齐侧文件，不能再次追加迁移事件。
test('rerun completes side files after a committed migration without appending another event', () => {
  const { dir, meta } = fixture();
  migrateGateV3({ dir, apply: true });
  const logBefore = fs.readFileSync(path.join(dir, 'commits.jsonl'));
  // Synthetic crash point: committed log survived, derived side files did not.
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta) + '\n');
  const snapshot = path.join(dir, 'snapshot.json');
  assert.equal(path.dirname(snapshot), dir);
  fs.unlinkSync(snapshot);
  assert.equal(migrateGateV3({ dir }).sideFilesNeedRepair, true);
  const repaired = migrateGateV3({ dir, apply: true });
  assert.equal(repaired.sideFilesRepaired, true);
  assert.equal(repaired.events, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'commits.jsonl')).equals(logBefore), true);
  assert.equal(open(dir).schemaVersion, 3);
  assert.equal(JSON.parse(fs.readFileSync(snapshot, 'utf8')).state.schemaVersion, 3);
  assert.equal(migrateGateV3({ dir, apply: true }).noOp, true);
});

// 责任：即使重放会派生 createdBy，迁移也必须保持原历史提交哈希不变。
test('legacy history hash is preserved even when replay would stamp missing createdBy fields', () => {
  const { dir, commit } = fixture();
  const originalHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'commits.jsonl'))).digest('hex');
  assert.equal(Object.hasOwn(commit.events[1].data, 'createdBy'), false);
  const result = migrateGateV3({ dir, apply: true });
  assert.equal(storeHashes(result.backup)['commits.jsonl'], originalHash);
  assert.equal(commits(dir)[0].hash, commit.hash);
  assert.equal(Object.hasOwn(commits(dir)[0].events[1].data, 'createdBy'), false);
});
