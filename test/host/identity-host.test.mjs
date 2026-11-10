/**
 * 测试职责：保证宿主会话在主 checkout 和 linked worktree 共用项目且证据根不漂移。
 * 典型流程：临时 Git 主树/worktree 与合成工具宿主 → init/发布/提交 → 比较项目和文件取证位置。
 * 覆盖边界：覆盖 会话 cwd 映射和复制 marker 的拒绝提示；不覆盖真实 DSH 会话或 UI。
 * 外部前置：需要 Git 和 DSH peer；所有 Git 工作区均为临时 fixture。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { apply } from '../../lib/index.js';
import { canonicalKey } from '../../lib/core/util.js';
import { MARKER_FILE, writeMarker } from '../../lib/core/identity/discover.js';

const tmp = (prefix) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')));
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

function host(rootDir) {
  const tools = new Map();
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { register(tool) { tools.set(tool.name, tool); } },
    systemPrompt: { section() { return () => {}; }, getSectionOrder() { return 9000; } },
    agents: { list() { return []; } },
    on() { return () => {}; },
    effect(fn) { fn(); return () => {}; },
    get() { return undefined; },
  };
  apply(ctx, { rootDir });
  return tools;
}

const execIn = (id, cwd) => ({ agent: { id, session: { header: { cwd } } }, callId: 'call-' + id });

// 责任：两种 cwd 的 init 须共用同项目，worktree 独有文件不能当主树证据而主树文件可提交。
test('tool sessions in the main checkout and a linked worktree share one board and one main workspace', async () => {
  const rootDir = tmp('pb-idh-root');
  const main = tmp('pb-idh-main');
  fs.writeFileSync(path.join(main, 'shipped.txt'), 'main\n');
  git(['init', '-q', '-b', 'master'], main);
  git(['config', 'user.email', 'id@test'], main);
  git(['config', 'user.name', 'id'], main);
  git(['config', 'commit.gpgsign', 'false'], main);
  git(['add', '-A'], main);
  git(['commit', '-qm', 'base'], main);
  const wt = path.join(tmp('pb-idh-wt'), 'feature');
  git(['worktree', 'add', '-q', '-b', 'feature', wt], main);
  fs.writeFileSync(path.join(wt, 'branch-only.txt'), 'branch\n');

  const tools = host(rootDir);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const session = tools.get('project_session');
  const board = tools.get('project_board');

  const fromWorktree = await session.execute({ op: 'init', name: 'Shared' }, execIn('s-wt', path.join(wt)));
  const fromMain = await session.execute({ op: 'init' }, execIn('s-main', main));
  assert.equal(fromWorktree.projectId, fromMain.projectId, 'init from either checkout is the same project');
  assert.equal(canonicalKey(fromWorktree.project.workspacePath), canonicalKey(main), 'a worktree session never becomes the main workspace');
  assert.equal(fs.readdirSync(path.join(rootDir, 'projects')).filter((n) => n.startsWith('prj_')).length, 1);

  const plan = tools.get('project_plan');
  const published = await plan.execute({ op: 'publish', title: 'P', steps: [{ id: 's', title: 's', tasks: [{ key: 't', title: 'T', acceptance: [{ text: 'a' }] }] }] }, execIn('s-wt', wt));
  assert.equal(published.ok, true);
  const seenFromMain = await board.execute({ view: 'board' }, execIn('s-main', main));
  assert.equal(seenFromMain.project.id, fromMain.projectId);
  assert.equal(seenFromMain.columns.ready.length + seenFromMain.columns.backlog.length, 1, 'the worktree session wrote to the shared board');

  const task = tools.get('project_task');
  const taskId = published.steps[0].tasks[0].id;
  const claimed = await task.execute({ op: 'claim', taskId, expectedRev: 1 }, execIn('s-wt', wt));
  const begun = await task.execute({ op: 'begin', taskId, expectedRev: claimed.task.task.rev, fencingToken: claimed.task.lease.token, summary: 'x' }, execIn('s-wt', wt));
  const acc = begun.task.task.acceptance[0].id;
  await assert.rejects(task.execute({ op: 'submit', taskId, expectedRev: begun.task.task.rev, fencingToken: claimed.task.lease.token, evidence: [{ kind: 'file', ref: 'branch-only.txt', acceptanceId: acc }] }, execIn('s-wt', wt)), /file not found/, 'file evidence still resolves against the main workspace');
  const ok = await task.execute({ op: 'submit', taskId, expectedRev: begun.task.task.rev, fencingToken: claimed.task.lease.token, evidence: [{ kind: 'file', ref: 'shipped.txt', acceptanceId: acc }] }, execIn('s-wt', wt));
  assert.equal(ok.ok, true);
  assert.equal(fs.existsSync(path.join(main, MARKER_FILE)), false, 'tools never write markers into the workspace');
});

// 责任：未绑定的带 marker 副本须提示 binding-required 和下一步，不得新建项目。
test('an unbound marked copy surfaces binding-required with a hint instead of creating a project', async () => {
  const rootDir = tmp('pb-idh-copy-root');
  const original = tmp('pb-idh-orig');
  const copy = tmp('pb-idh-copy');
  const tools = host(rootDir);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const session = tools.get('project_session');
  const created = await session.execute({ op: 'init' }, execIn('s-o', original));
  writeMarker(copy, created.projectId);
  await assert.rejects(session.execute({ op: 'init' }, execIn('s-c', copy)), (error) => {
    const body = JSON.parse(error.message);
    return body.code === 'binding-required' && /do not create a new project/.test(body.next);
  });
  await assert.rejects(tools.get('project_board').execute({ view: 'brief' }, execIn('s-c', copy)), /binding-required/);
  assert.equal(fs.readdirSync(path.join(rootDir, 'projects')).filter((n) => n.startsWith('prj_')).length, 1);
});
