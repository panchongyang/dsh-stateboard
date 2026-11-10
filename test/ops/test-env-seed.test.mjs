/**
 * 测试职责：保证独立测试环境播种幂等且 URL/认证解析不接触生产源或执行注入脚本。
 * 典型流程：临时环境准备 → seed/重复 seed 或解析 URL/JSON 全局 → 对照合成任务与拒绝。
 * 覆盖边界：覆盖 播种数据、生命周期锁及回环来源约束；不覆盖真实浏览器打开或生产服务。
 * 外部前置：需要目录链接能力用于临时 profile；不启动真实 DSH 服务。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectService } from '../../lib/core/service.js';
import { resolveWorkspacePath } from '../../lib/core/util.js';
import { createEnvironment, prepareEnvironment } from '../../scripts/test-env/environment.mjs';
import { seedEnvironment } from '../../scripts/test-env-seed.mjs';
import { injectedGlobal, localUrl } from '../../scripts/test-env-verify.mjs';
import { authenticationUrl } from '../../scripts/test-env-open.mjs';

async function fixture(t) {
  const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-test-env-seed-')));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const env = createEnvironment({ repoRoot });
  await prepareEnvironment(env);
  return env;
}

// 责任：HTTP verifier 只接受独立回环 HTTP 源，生产端口、远端、HTTPS 和带凭据 URL 都须拒绝。
test('HTTP verifier refuses production, remote and credential-bearing origins', () => {
  assert.equal(localUrl('http://127.0.0.1:3081/').port, '3081');
  for (const url of ['http://127.0.0.1:3080/', 'http://example.com:3081/', 'https://127.0.0.1:3081/', 'http://user:secret@127.0.0.1:3081/']) {
    assert.throws(() => localUrl(url), /independent loopback/);
  }
});

// 责任：浏览器 opener 只接受同测试 origin 且仅含 launch token 的认证 URL。
test('browser opener accepts only the same test origin and a launch-token URL', () => {
  const state = { url: 'http://127.0.0.1:3081/', authUrl: 'http://127.0.0.1:3081/?token=synthetic' };
  assert.equal(authenticationUrl(state), state.authUrl);
  for (const authUrl of ['http://127.0.0.1:3080/?token=synthetic', 'http://127.0.0.1:3082/?token=synthetic', 'http://127.0.0.1:3081/', 'http://127.0.0.1:3081/?token=synthetic&other=value']) {
    assert.throws(() => authenticationUrl({ ...state, authUrl }));
  }
});

// 责任：注入全局只准 JSON.parse，缺全局或可执行表达式须拒绝，不能 eval。
test('HTTP verifier parses only JSON globals and never executes injected script', () => {
  const value = { base: '/project-board/api', token: 'only-a-synthetic-token' };
  const html = '<script>globalThis["__PROJECT_BOARD__"] = ' + JSON.stringify(value) + '</script>';
  assert.deepEqual(injectedGlobal(html, '__PROJECT_BOARD__'), value);
  assert.throws(() => injectedGlobal('', '__PROJECT_BOARD__'), /missing/);
  assert.throws(() => injectedGlobal('<script>globalThis["__PROJECT_BOARD__"] = (() => 42)()</script>', '__PROJECT_BOARD__'), SyntaxError);
});

// 责任：首次 seed 须仅创建一条带门 review、两条 ready 和一份文档，无活租约/开放意图。
test('test-env seed creates only a synthetic gated review plus two ready tasks', async (t) => {
  const env = await fixture(t);
  const seeded = await seedEnvironment(env);
  assert.equal(seeded.seeded, true);
  const service = new ProjectService({ rootDir: env.board });
  t.after(() => service.close());
  await service.init();
  const handle = await service.open(seeded.projectId);
  assert.equal(handle.workspacePath, resolveWorkspacePath(env.workspace));
  assert.match(handle.name, /TEST/);
  assert.equal(Object.keys(handle.state.tasks).length, 3);
  assert.equal(Object.values(handle.state.tasks).filter((task) => task.state === 'ready').length, 2);
  const review = handle.state.tasks[seeded.reviewTaskId];
  assert.equal(review.state, 'review');
  assert.equal(review.requiresAudit, true);
  assert.ok(review.labels.includes('gate:audit'));
  assert.equal(handle.state.schemaVersion, 3);
  for (const task of Object.values(handle.state.tasks)) {
    assert.equal(task.requiresAudit, true, 'every seeded task retains its audit gate after reopening');
    assert.ok(task.labels.includes('gate:audit'));
    assert.equal(Object.hasOwn(task, 'requiresHumanReview'), false, 'no legacy task field persists');
    assert.equal(task.labels.includes('gate:human'), false, 'no legacy gate label persists');
  }
  const board = handle.query('board');
  assert.equal(board.columns.ready.length, 2);
  for (const card of [...board.columns.ready, ...board.columns.review]) {
    assert.equal(card.requiresAudit, true, 'ready/review read models retain the audit gate');
    assert.ok(card.labels.includes('gate:audit'));
    assert.equal(Object.hasOwn(card, 'requiresHumanReview'), false);
  }
  assert.equal(review.evidence.length, 1);
  assert.equal(review.evidence[0].kind, 'doc');
  assert.equal(Object.keys(handle.state.docs).length, 1);
  assert.equal(handle.leases.size, 0);
  assert.equal(Object.values(handle.state.intents).some((intent) => intent.status === 'open'), false);
  assert.equal(fs.existsSync(path.join(env.home, 'project-board')), false, 'explicit test board root, not a shared default');
});

// 责任：重复 seed 不得重置已有历史或用户在测试 fixture 的编辑。
test('re-seeding preserves existing fixture history and user test edits', async (t) => {
  const env = await fixture(t);
  const first = await seedEnvironment(env);
  const service = new ProjectService({ rootDir: env.board });
  await service.init();
  const handle = await service.open(first.projectId);
  const task = handle.state.tasks[first.taskIds[0]];
  await handle.command({ cmdId: 'cmd_user_test_edit', actor: { kind: 'human' }, op: 'task.update', taskId: task.id, expected: { entityRev: task.rev }, title: 'User test edit — keep me' });
  const logFile = handle.store.commitsFile;
  const before = fs.readFileSync(logFile, 'utf8');
  await service.close();
  const second = await seedEnvironment(env);
  assert.equal(second.seeded, false);
  assert.equal(second.reason, 'existing-test-data-preserved');
  assert.deepEqual(second.projectIds, [first.projectId]);
  assert.equal(fs.readFileSync(logFile, 'utf8'), before);
});

// 责任：生命周期锁活跃时 seed 须拒绝，不得创建项目数据。
test('seed refuses an active lifecycle lock without creating project data', async (t) => {
  const env = await fixture(t);
  fs.writeFileSync(env.lockFile, JSON.stringify({ purpose: 'test-owned-busy-marker' }));
  await assert.rejects(seedEnvironment(env), /busy|lock/);
  assert.equal(fs.existsSync(path.join(env.board, 'projects')), false);
  assert.equal(fs.existsSync(path.join(env.root, 'fixture.json')), false);
  fs.unlinkSync(env.lockFile);
});
