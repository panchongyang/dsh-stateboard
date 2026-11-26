/**
 * 测试职责：验证 restore-acceptance CLI 的 dry-run、apply、重复运行与非法 project ID，使用合成日志和隔离临时 root。
 * 典型流程：创建项目/任务 → 用历史 task/updated 事件清空 acceptance → 跑 CLI → 对比同 ID/met 恢复与提交数。
 * 覆盖边界：覆盖脚本入口、offline-maintenance 调用、水位传递、路径分量拒绝与幂等；不覆盖真实库、真实 home 或 service 内部实现。
 * 外部前置：仅 Node 与临时目录；spawn 的 CLI 使用显式 --root，不读取真实 DSH_HOME。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { command, withProject } from '../helpers/service-fixture.mjs';
import { ProjectService } from '../../lib/core/service.js';
import { makeCommit } from '../../lib/core/store.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(repoRoot, 'scripts/restore-acceptance.mjs');

function projectPaths(fixture, projectId) {
  const dir = path.join(fixture.stateDir, 'projects', projectId);
  return {
    dir,
    commits: path.join(dir, 'commits.jsonl'),
    lock: path.join(dir, 'lock.json'),
  };
}

function readCommits(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function runCli(fixture, args) {
  const result = spawnSync(process.execPath, [script, '--root', fixture.stateDir, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return result;
}

async function peekAcceptance(fixture, projectId, taskId) {
  const svc = new ProjectService({ rootDir: fixture.stateDir });
  await svc.init();
  try {
    const state = svc.peekProjectState(projectId);
    return state.tasks[taskId].acceptance;
  } finally {
    await svc.close();
  }
}

async function legacyTask(t) {
  const fixture = await withProject(t, { name: 'Synthetic acceptance repair' });
  const created = await fixture.h.command(command('task.create', {
    title: 'Legacy task with wiped acceptance',
    acceptance: [
      { text: 'first historical criterion', requiredKinds: ['file'] },
      { text: 'second historical criterion' },
    ],
  }));
  const taskId = created.events.find((event) => event.type === 'task/created').taskId;
  const original = structuredClone(fixture.h.state.tasks[taskId].acceptance);
  const task = fixture.h.state.tasks[taskId];
  const next = structuredClone(task);
  next.acceptance = [];
  next.rev = task.rev + 1;
  next.updatedAt = new Date(Date.now() + 1000).toISOString();
  // Simulate the historical bug only after closing this synthetic writer.
  // Production has no caller-supplied event/state mutation capability.
  const commit = makeCommit(fixture.h.rev + 1, fixture.h.lastHash,
    { kind: 'system', via: 'fixture' }, 'cmd_fixture_wipe_' + Date.now(), fixture.h.rev,
    [{ type: 'task/updated', taskId, rev: next.rev, data: next }]);
  const paths = projectPaths(fixture, fixture.h.id);
  fixture.h.close();
  fs.appendFileSync(paths.commits, JSON.stringify(commit) + '\n');
  return { fixture, projectId: fixture.h.id, taskId, original, paths };
}

// 责任：dry-run 必须只读盘点，列出目标但不写日志、不建锁。
test('restore-acceptance dry-run inventories without writing', async (t) => {
  const { fixture, taskId, paths } = await legacyTask(t);
  const before = readCommits(paths.commits);
  const result = runCli(fixture, ['--project', fixture.h.id]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /restore\s+1 task\(s\)/);
  assert.match(result.stdout, new RegExp(taskId));
  assert.match(result.stdout, /dry run only/);
  assert.equal(fs.existsSync(paths.lock), false);
  assert.equal(readCommits(paths.commits).length, before.length);
  assert.deepEqual(await peekAcceptance(fixture, fixture.h.id, taskId), []);
});

// 责任：apply 只通过 offline command 恢复同 ID/met，并追加恰好一个提交。
test('restore-acceptance apply restores the same ids and is idempotent', async (t) => {
  const { fixture, projectId, taskId, original, paths } = await legacyTask(t);
  const before = readCommits(paths.commits);
  const applied = runCli(fixture, ['--project', projectId, '--apply']);
  assert.equal(applied.status, 0, applied.stderr);
  const jsonStart = applied.stdout.indexOf('{');
  const jsonEnd = applied.stdout.lastIndexOf('}');
  const report = JSON.parse(applied.stdout.slice(jsonStart, jsonEnd + 1));
  assert.equal(report.ok, true);
  assert.equal(report.expectedRev, before.at(-1).seq);
  assert.equal(report.expectedHash, before.at(-1).hash);
  assert.deepEqual(report.taskIds, [taskId]);
  assert.equal(report.result.count, 1);

  const after = readCommits(paths.commits);
  assert.equal(after.length, before.length + 1);
  assert.deepEqual(await peekAcceptance(fixture, projectId, taskId), original);

  const repeat = runCli(fixture, ['--project', projectId, '--apply']);
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.match(repeat.stdout, /nothing to restore/);
  assert.equal(readCommits(paths.commits).length, after.length);
});

// 责任：非法 project id 是路径分量，必须在任何 fs 访问前拒绝；正字段仍能工作。
test('restore-acceptance rejects an unsafe project id component', async (t) => {
  const { fixture, projectId, paths } = await legacyTask(t);
  const before = fs.readFileSync(paths.commits, 'utf8');
  for (const invalid of ['not-a-project', 'prj_UPPER', 'prj_ok.extra', 'prj_ok extra', 'prj_']) {
    const result = runCli(fixture, ['--project', invalid, '--apply']);
    assert.notEqual(result.status, 0, invalid + ' must be rejected');
    assert.match(result.stderr, /invalid --project id/);
    assert.equal(fs.readFileSync(paths.commits, 'utf8'), before);
    assert.equal(fs.existsSync(paths.lock), false);
  }
  const dryRun = runCli(fixture, ['--project', projectId]);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /restore\s+1 task\(s\)/);
});
