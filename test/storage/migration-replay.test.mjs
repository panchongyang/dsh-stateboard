/**
 * 测试职责：保证 store 副本的版本、任务、计划、焦点和健康结果可重复重放，源目录保持只读。
 * 典型流程：合成项目或显式选择源 store → 哈希并复制 → 无锁打开副本多次 → 比较事实与源哈希。
 * 覆盖边界：覆盖 复制重放与旧快照规范化；不覆盖真实数据的写迁移或自动查找用户 store。
 * 外部前置：默认无；真实 store 用例仅在 PB_MIGRATION_PROJECT/--project 显式指定时启用，需额外授权。
 */
// Migration / replay regression (T1): copying a project store and opening
// the copy must reproduce rev, task count, planHeads, focus and health, and
// must never write the original directory.
//
// The hermetic case always runs. The real-store case is opt-in (CI cannot
// depend on a user's home directory): set PB_MIGRATION_PROJECT to a project id
// (looked up under ~/.dsh/project-board/projects) or to a store directory, or
// run this file directly with --project. When it runs, the real store is only
// read (hashed + copied); the copy is opened with a lock-free store factory so
// not even a lock file is written anywhere.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectService } from '../../lib/core/service.js';
import { JsonlStore } from '../../lib/core/store.js';
import { applyEvent, emptyState, normalizePlanHeads } from '../../lib/core/model.js';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
}

function cmd(op, extra = {}) {
  return { cmdId: 'cmd_' + Math.random().toString(36).slice(2), actor: { kind: 'agent', sessionId: 's1' }, op, ...extra };
}

function readOnlyFactory(dir, meta) {
  return new JsonlStore(dir, meta, { lock: false });
}

/** Pure replay over commits.jsonl: the lock-free oracle for a store's contents. */
function replayAll(meta, commits) {
  const state = emptyState(meta.project);
  for (const commit of commits) {
    for (const event of commit.events) applyEvent(state, event, commit);
    state.lastSeq = commit.seq;
    state.lastHash = commit.hash;
    state.project.rev = commit.seq;
  }
  return normalizePlanHeads(state);
}

function readCommits(dir) {
  return fs.readFileSync(path.join(dir, 'commits.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

/** Everything the acceptance cares about, minus the snapshot-sensitive focus. */
function factsOf(state, rev) {
  return {
    rev,
    tasks: Object.keys(state.tasks).length,
    canceled: Object.values(state.tasks).filter((task) => task.state === 'canceled').length,
    unplanned: Object.values(state.tasks).filter((task) => !task.planRef).length,
    orphaned: Object.values(state.tasks).filter((task) => task.orphaned).length,
    planHeads: Object.values(state.planHeads || {}).map((head) => [head.id, head.title, head.status, head.currentVersion]).sort(),
    focusPlanId: state.project.focusPlanId ?? null,
    currentPlans: Object.keys(state.currentPlans || {}).length,
    planVersions: Object.keys(state.plans || {}).length,
    schemaVersion: state.schemaVersion,
  };
}

function factsWithoutFocus(facts) {
  const { focusPlanId, ...rest } = facts;
  return rest;
}

/** sha256 over every regular file in a store dir, keyed by relative name. */
function dirHashes(dir) {
  const out = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    out[entry.name] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, entry.name))).digest('hex');
  }
  return out;
}

function healthFacts(health) {
  return { ok: health.ok, warnings: health.warnings.slice(), hashChain: health.hashChain, seq: health.seq };
}

// 责任：合成 store 复制后反复打开须还原相同 rev/任务/planHeads/focus/health，源文件哈希不变。
test('copying a project store preserves rev/tasks/planHeads/focus/health across opens; the original is untouched', async () => {
  const rootDir = tmp('pb-mig-a');
  const svc = new ProjectService({ rootDir });
  await svc.init();
  const handle = await svc.createProject({ workspacePath: tmp('pb-mig-a-ws'), name: 'Mig' });
  const published = await handle.command(cmd('plan.publish', {
    title: 'Plan A',
    steps: [{ id: 's1', title: 'S', tasks: [{ key: 'a1', title: 'Task A', acceptance: [{ text: 'x' }] }] }],
  }));
  const planA = published.events.find((event) => event.type === 'plan/published').data.id;
  const taskA = Object.values(handle.state.tasks).find((task) => task.planRef && task.planRef.planId === planA);
  await handle.command(cmd('plan.revise', { planId: planA, baseVersion: 1, steps: [{ id: 's1', title: 'S', tasks: [] }] }));
  assert.equal(handle.state.tasks[taskA.id].orphaned, true, 'fixture: one orphaned task');
  await handle.command(cmd('plan.publish', {
    title: 'Plan B',
    steps: [{ id: 's1', title: 'S', tasks: [{ key: 'b1', title: 'Task B', acceptance: [{ text: 'x' }] }] }],
  }));
  const loose = await handle.command(cmd('task.create', { title: 'Loose', acceptance: [{ text: 'x' }] }));
  assert.ok(loose.events.find((event) => event.type === 'task/created'), 'fixture: one unplanned task');

  const beforeFacts = factsOf(handle.state, handle.rev);
  const beforeHealth = healthFacts(handle.health());
  assert.equal(beforeFacts.unplanned, 1);
  assert.equal(beforeFacts.orphaned, 1);
  const id = handle.id;
  const sourceDir = path.join(rootDir, 'projects', id);
  await svc.close();
  const original = dirHashes(sourceDir);

  // Copy the store dir (read-only source) and open the copy twice.
  const copyRoot = tmp('pb-mig-a-copy');
  const copyDir = path.join(copyRoot, 'projects', id);
  fs.mkdirSync(copyDir, { recursive: true });
  fs.cpSync(sourceDir, copyDir, { recursive: true });
  fs.rmSync(path.join(copyDir, 'lock.json'), { force: true });

  const ro = new ProjectService({ rootDir: copyRoot, storeFactory: readOnlyFactory });
  await ro.init();
  const roHandle = await ro.open(id);
  assert.equal(roHandle.readOnly, true, 'the copy opens through a lock-free store');
  assert.deepEqual(factsOf(roHandle.state, roHandle.rev), beforeFacts, 'first open reproduces every fact');
  assert.deepEqual(healthFacts(roHandle.health()), beforeHealth, 'health reproduces on the copy');
  await ro.close();

  const rw = new ProjectService({ rootDir: copyRoot });
  await rw.init();
  const rwHandle = await rw.open(id);
  assert.deepEqual(factsOf(rwHandle.state, rwHandle.rev), beforeFacts, 'a writable reopen reproduces the same facts');
  await rw.close();

  assert.deepEqual(dirHashes(sourceDir), original, 'the original store stays byte-identical');
  assert.deepEqual(Object.keys(dirHashes(sourceDir)).sort(), Object.keys(original).sort());

  // Replay parity: the copy's own log replays to the same facts as the store open.
  const replayed = replayAll(JSON.parse(fs.readFileSync(path.join(copyDir, 'meta.json'), 'utf8')), readCommits(copyDir));
  assert.deepEqual(factsWithoutFocus(factsOf(replayed, replayed.lastSeq)), factsWithoutFocus(beforeFacts), 'pure replay agrees with the store open');
});

function migrationSource() {
  const env = String(process.env.PB_MIGRATION_PROJECT || process.env.PB_MIGRATION_DIR || '').trim();
  const idx = process.argv.indexOf('--project');
  const arg = idx >= 0 ? String(process.argv[idx + 1] || '').trim() : '';
  return env || arg;
}

function locateStore(source) {
  const direct = path.resolve(source);
  if (fs.existsSync(path.join(direct, 'commits.jsonl'))) return direct;
  const root = String(process.env.PB_MIGRATION_ROOT || '').trim() || path.join(os.homedir(), '.dsh', 'project-board');
  const byId = path.join(root, 'projects', source);
  if (fs.existsSync(path.join(byId, 'commits.jsonl'))) return byId;
  throw new Error('migration source not found: ' + source + ' (tried ' + direct + ' and ' + byId + ')');
}

const source = migrationSource();
if (!source) {
  // 责任：未显式指定真实 store 时该分支必须 skip，不能自行访问用户目录。
  test('real-store migration replay (opt-in)', { skip: 'set PB_MIGRATION_PROJECT to a project id or store dir (or run this file directly with --project) to exercise a real store copy' }, () => {});
} else {
  // 责任：显式启用真实 store 副本重放时须保持关键事实一致，源目录任何文件不得被写入。
  test('real-store copy replay preserves rev/tasks/planHeads/focus/health and never writes the original', async () => {
    const dir = locateStore(source);
    const before = dirHashes(dir);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    const baseline = replayAll(meta, readCommits(dir));
    const baseFacts = factsOf(baseline, baseline.lastSeq);

    const copyRoot = tmp('pb-mig-real');
    const copyDir = path.join(copyRoot, 'projects', meta.projectId);
    fs.mkdirSync(copyDir, { recursive: true });
    fs.cpSync(dir, copyDir, { recursive: true });
    fs.rmSync(path.join(copyDir, 'lock.json'), { force: true });

    const first = new ProjectService({ rootDir: copyRoot, storeFactory: readOnlyFactory });
    await first.init();
    const handle = await first.open(meta.projectId);
    const openFacts = factsOf(handle.state, handle.rev);
    // Replay oracle vs store open: everything except the snapshot-sensitive
    // focus (legacy logs may inherit focus only via the persisted snapshot).
    assert.deepEqual(factsWithoutFocus(openFacts), factsWithoutFocus(baseFacts), 'copy open equals the pure replay of the same log');
    assert.equal(openFacts.rev, baseFacts.rev, 'rev is unchanged by the copy open');
    const health = handle.health();
    assert.equal(health.ok, true, 'no new health warnings on the copy: ' + JSON.stringify(health.warnings));
    assert.equal(health.hashChain, 'ok');
    assert.equal(health.seq, openFacts.rev);
    await first.close();

    const second = new ProjectService({ rootDir: copyRoot, storeFactory: readOnlyFactory });
    await second.init();
    const again = await second.open(meta.projectId);
    assert.deepEqual(factsOf(again.state, again.rev), openFacts, 'the copy can be reopened with identical facts');
    await second.close();

    assert.deepEqual(dirHashes(dir), before, 'the original store stays byte-identical');
    // The unplanned/orphan populations must stay exactly as they are: this test
    // never adopts, never rewrites history, never issues a single command.
    console.log('# real-store facts: ' + JSON.stringify({
      project: meta.projectId,
      rev: openFacts.rev,
      tasks: openFacts.tasks,
      canceled: openFacts.canceled,
      unplanned: openFacts.unplanned,
      orphaned: openFacts.orphaned,
      planHeads: openFacts.planHeads.length,
      currentPlans: openFacts.currentPlans,
      planVersions: openFacts.planVersions,
      focusPlanId: openFacts.focusPlanId,
      health: healthFacts(health),
    }));
  });
}
