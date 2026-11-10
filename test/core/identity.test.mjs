/**
 * 测试职责：维护随机稳定项目 id、路径绑定、旧路径哈希兼容与 worktree 发现规则。
 * 典型流程：临时服务/旧日志/本地 Git 仓库 → 创建、迁移、搬迁或重开 → 比较 id、registry、证据根。
 * 覆盖边界：覆盖 路径发现、显式身份迁移和磁盘新鲜度；不覆盖真实跨机 import 或宿主页面。
 * 外部前置：worktree 场景需要 Git；其他场景仅临时目录。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectService } from '../../lib/core/service.js';
import { makeCommit } from '../../lib/core/store.js';
import { canonicalKey, readJson, sha256 } from '../../lib/core/util.js';
import { normalizeEvidence } from '../../lib/core/evidence.js';
import { MARKER_FILE, mainWorktreeOf, writeMarker } from '../../lib/core/identity/discover.js';
import { bindWorktree, migrate, planMigration } from '../../lib/core/identity/ops.js';
import { REGISTRY_FILE, legacyBindingId } from '../../lib/core/identity/registry.js';

const tmp = (prefix) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')));
const human = (op, extra = {}) => ({ cmdId: 'cmd_' + crypto.randomUUID(), actor: { kind: 'human', via: 'test' }, op, ...extra });
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const fileSha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const registryOf = (root) => readJson(path.join(root, REGISTRY_FILE), null);
const projectDirs = (root) => fs.readdirSync(path.join(root, 'projects')).filter((n) => n.startsWith('prj_')).sort();

async function service(rootDir) {
  const svc = new ProjectService({ rootDir });
  await svc.init();
  return svc;
}

async function restart(svc) {
  await svc.close();
  return service(svc.rootDir);
}

/** Exactly what the pre-identity code wrote: path-hash id, no registry entry. */
function legacyProject(rootDir, workspacePath, { schemaVersion = 3 } = {}) {
  const projectId = 'prj_' + sha256(canonicalKey(workspacePath)).slice(0, 16);
  const dir = path.join(rootDir, 'projects', projectId);
  fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true });
  const at = '2026-10-01T00:00:00.000Z';
  const project = { schemaVersion: 3, id: projectId, workspacePath, name: 'Legacy', phase: 'active', rev: 0, policy: {}, focusPlanId: null, createdAt: at, updatedAt: at };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ schemaVersion, projectId, project, createdAt: at }, null, 2));
  const commit = makeCommit(1, 'genesis', { kind: 'system', via: 'system' }, 'cmd_create_' + projectId, 0, [{ type: 'project/created', data: project }]);
  fs.writeFileSync(path.join(dir, 'commits.jsonl'), JSON.stringify(commit) + '\n');
  return { projectId, dir };
}

async function addTask(handle, title) {
  const result = await handle.command(human('task.create', { title, acceptance: [{ text: 'done' }] }));
  assert.equal(result.ok, true);
  return Object.keys(handle.state.tasks).length;
}

// 责任：新项目 id 须随机且不由路径哈希派生，同根重试与重启后仍复用同身份。
test('new projects get random stable ids decoupled from the path', async () => {
  const root = tmp('pb-id-root');
  const wsA = tmp('pb-id-a');
  const wsB = tmp('pb-id-b');
  let svc = await service(root);
  const a = await svc.createProject({ workspacePath: wsA });
  const b = await svc.createProject({ workspacePath: wsB });
  assert.match(a.id, /^prj_[0-9a-f]{16}$/);
  assert.notEqual(a.id, 'prj_' + sha256(canonicalKey(wsA)).slice(0, 16), 'id is not derived from the path');
  assert.notEqual(a.id, b.id);
  assert.equal((await svc.createProject({ workspacePath: wsA })).id, a.id, 'same root is idempotent');
  const reg = registryOf(root);
  assert.equal(reg.schemaVersion, 1);
  assert.deepEqual(reg.bindings.filter((x) => x.status === 'active').map((x) => [x.projectId, x.role]).sort(), [[a.id, 'main'], [b.id, 'main']].sort());
  svc = await restart(svc);
  assert.equal((await svc.openByWorkspace(wsA)).id, a.id, 'restart keeps the binding');
  assert.deepEqual(projectDirs(root), [a.id, b.id].sort());
  await svc.close();
});

// 责任：当前 schema 的旧路径哈希项目须原样打开，不能为只读发现偷偷写 registry。
test('path-hash identity projects on current schema open unchanged before identity migration', async () => {
  const root = tmp('pb-id-legacy');
  const ws = tmp('pb-id-legacy-ws');
  const { projectId, dir } = legacyProject(root, ws);
  let svc = await service(root);
  const h = await svc.openByWorkspace(ws);
  assert.equal(h.id, projectId);
  await addTask(h, 'kept');
  const logSha = fileSha(path.join(dir, 'commits.jsonl'));
  assert.equal(fs.existsSync(path.join(root, REGISTRY_FILE)), false, 'opening a legacy project writes no registry');
  svc = await restart(svc);
  const again = await svc.openByWorkspace(path.join(ws, '.'));
  assert.equal(again.id, projectId);
  assert.equal(Object.values(again.state.tasks)[0].title, 'kept');
  assert.equal(svc.resolveWorkspace(ws).implicit, true);
  await svc.close();
  assert.equal(fileSha(path.join(dir, 'commits.jsonl')), logSha);
});

// 责任：身份迁移默认须 dry-run，只有精确计划哈希匹配才可持久化绑定。
test('migration is dry-run first and needs the exact plan hash to persist bindings', async () => {
  const root = tmp('pb-id-mig');
  const wsLive = tmp('pb-id-mig-live');
  const wsGone = path.join(tmp('pb-id-mig-parent'), 'removed');
  const live = legacyProject(root, wsLive);
  const gone = legacyProject(root, wsGone, { schemaVersion: 2 });
  const logBefore = [live, gone].map((p) => fileSha(path.join(p.dir, 'commits.jsonl')));
  let svc = await service(root);
  const plan = planMigration(svc);
  assert.equal(fs.existsSync(path.join(root, REGISTRY_FILE)), false, 'plan writes nothing');
  assert.deepEqual(plan.actions.map((a) => [a.projectId, a.action, a.rootExists]).sort(), [[live.projectId, 'persist', true], [gone.projectId, 'persist', false]].sort());
  assert.throws(() => migrate(svc, { confirm: 'nope', actor: { kind: 'system' } }), (e) => e.code === 'stale-revision');
  assert.throws(() => migrate(svc, { confirm: plan.planHash, actor: { kind: 'agent' } }), (e) => e.code === 'forbidden-role');
  assert.equal(fs.existsSync(path.join(root, REGISTRY_FILE)), false, 'refusals write nothing');
  assert.equal(migrate(svc, { confirm: plan.planHash, actor: { kind: 'system' } }).persisted, 2);
  const reg = registryOf(root);
  assert.equal(reg.bindings.find((b) => b.projectId === live.projectId).bindingId, legacyBindingId(live.projectId, wsLive), 'binding id is the one the dry-run showed');
  svc = await restart(svc);
  assert.ok(planMigration(svc).actions.every((a) => a.action === 'keep'));
  assert.equal((await svc.openByWorkspace(wsLive)).id, live.projectId);
  const replay = planMigration(svc);
  assert.equal(migrate(svc, { confirm: replay.planHash, actor: { kind: 'system' } }).persisted, 0, 'migration is idempotent');
  await svc.close();
  assert.deepEqual([live, gone].map((p) => fileSha(path.join(p.dir, 'commits.jsonl'))), logBefore, 'history is never rewritten');
});

// 责任：子目录须归属最近项目，遇到嵌套仓库时发现不能继续向外攀升。
test('subdirectories resolve to the nearest project; a nested repo stops the walk', async () => {
  const root = tmp('pb-id-sub');
  const ws = tmp('pb-id-sub-ws');
  fs.mkdirSync(path.join(ws, 'a', 'b'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'pkg', 'src'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'vendor', 'lib'), { recursive: true });
  git(['init', '-q'], path.join(ws, 'vendor'));
  let svc = await service(root);
  const parent = await svc.createProject({ workspacePath: ws });
  const nested = await svc.createProject({ workspacePath: path.join(ws, 'pkg') });
  assert.notEqual(parent.id, nested.id);
  assert.equal((await svc.openByWorkspace(path.join(ws, 'a', 'b'))).id, parent.id);
  assert.equal((await svc.openByWorkspace(path.join(ws, 'pkg', 'src'))).id, nested.id);
  assert.equal(await svc.openByWorkspace(path.join(ws, 'vendor', 'lib')), null, 'a nested repository is not the parent project');
  assert.equal(await svc.openByWorkspace(path.dirname(ws)), null, 'parents never resolve downward');
  svc = await restart(svc);
  assert.equal((await svc.openByWorkspace(path.join(ws, 'pkg', 'src'))).id, nested.id);
  assert.equal(projectDirs(root).length, 2);
  await svc.close();
});

function repoWithWorktree() {
  const main = tmp('pb-id-git-main');
  fs.mkdirSync(path.join(main, 'docs'));
  fs.writeFileSync(path.join(main, 'docs', 'only-main.md'), 'main\n');
  git(['init', '-q', '-b', 'master'], main);
  git(['config', 'user.email', 'id@test'], main);
  git(['config', 'user.name', 'id'], main);
  git(['config', 'commit.gpgsign', 'false'], main);
  git(['add', '-A'], main);
  git(['commit', '-qm', 'base'], main);
  const wt = path.join(tmp('pb-id-git-wt'), 'feature');
  git(['worktree', 'add', '-q', '-b', 'feature', wt], main);
  fs.mkdirSync(path.join(wt, 'docs', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'only-worktree.md'), 'branch\n');
  return { main, wt: fs.realpathSync.native(wt) };
}

// 责任：linked worktree 须映射同看板，主工作区和文件证据根不得迁到会话 cwd。
test('a linked worktree reaches the same board without moving the main workspace or evidence root', async () => {
  const root = tmp('pb-id-wt');
  const { main, wt } = repoWithWorktree();
  let svc = await service(root);
  const h = await svc.createProject({ workspacePath: main });
  const found = svc.resolveWorkspace(path.join(wt, 'docs', 'deep'));
  assert.equal(found.projectId, h.id);
  assert.equal(found.role, 'worktree');
  assert.equal(found.via, 'git-common-dir');
  assert.equal(canonicalKey(found.root), canonicalKey(wt));
  assert.equal(canonicalKey(found.mainRoot), canonicalKey(main));
  const viaWt = await svc.openByWorkspace(wt);
  assert.equal(viaWt, h, 'one shared handle');
  assert.equal(canonicalKey(viaWt.workspacePath), canonicalKey(main), 'main workspace unchanged');
  assert.equal((await svc.createProject({ workspacePath: wt })).id, h.id, 'create in a worktree joins, never duplicates');
  assert.throws(() => normalizeEvidence(viaWt, {}, { kind: 'file', ref: 'only-worktree.md' }, new Date().toISOString(), {}), (e) => e.code === 'missing-evidence', 'file evidence resolves against the main root');
  assert.throws(() => normalizeEvidence(viaWt, {}, { kind: 'file', ref: path.join(wt, 'only-worktree.md') }, new Date().toISOString(), {}), (e) => e.code === 'invalid-command', 'a worktree path escapes the evidence root');
  assert.equal(normalizeEvidence(viaWt, {}, { kind: 'file', ref: 'docs/only-main.md' }, new Date().toISOString(), {}).hash, fileSha(path.join(main, 'docs', 'only-main.md')));
  const bound = bindWorktree(svc, { projectId: h.id, workspacePath: wt, actor: { kind: 'human' } });
  assert.equal(svc.resolveWorkspace(wt).bindingId, bound.bindingId);
  assert.throws(() => bindWorktree(svc, { projectId: h.id, workspacePath: wt, actor: { kind: 'agent' } }), (e) => e.code === 'forbidden-role');
  svc = await restart(svc);
  const after = await svc.openByWorkspace(path.join(wt, 'docs'));
  assert.equal(after.id, h.id);
  assert.equal(canonicalKey(after.workspacePath), canonicalKey(main));
  assert.equal(projectDirs(root).length, 1);
  await svc.close();
});

// 责任：非 Git 项目须靠显式绑定，破损 .git 文件不得被猜测成 linked worktree。
test('non-git projects bind explicitly; a broken .git file is not a worktree', async () => {
  const root = tmp('pb-id-nogit');
  const ws = tmp('pb-id-nogit-ws');
  fs.mkdirSync(path.join(ws, 'notes'));
  const fake = tmp('pb-id-fakegit');
  fs.writeFileSync(path.join(fake, '.git'), 'gitdir: ' + path.join(fake, 'missing') + '\n');
  assert.equal(mainWorktreeOf(fake), null);
  const svc = await service(root);
  const h = await svc.createProject({ workspacePath: ws });
  assert.equal((await svc.openByWorkspace(path.join(ws, 'notes'))).id, h.id);
  assert.equal(svc.resolveWorkspace(ws).via, 'binding');
  assert.equal(await svc.openByWorkspace(fake), null);
  await svc.close();
});

// 责任：带 marker 目录移动后须要求显式 relocate，不能按新路径再建项目。
test('rename/move of a marked directory requires an explicit relocate and never duplicates', async () => {
  const root = tmp('pb-id-move');
  const parent = tmp('pb-id-move-parent');
  const before = path.join(parent, 'before');
  const after = path.join(parent, 'after');
  fs.mkdirSync(before);
  let svc = await service(root);
  const h = await svc.createProject({ workspacePath: before });
  await addTask(h, 'travels');
  writeMarker(before, h.id);
  fs.renameSync(before, after);
  assert.throws(() => svc.resolveWorkspace(after), (e) => e.code === 'binding-required' && e.details.reason === 'moved' && e.details.projectId === h.id);
  await assert.rejects(svc.createProject({ workspacePath: after }), (e) => e.code === 'binding-required');
  assert.deepEqual(projectDirs(root), [h.id], 'no duplicate project');
  const result = await h.command(human('project.relocate', { workspacePath: after }));
  assert.equal(result.committed, true);
  assert.equal(result.warnings, undefined);
  const reg = registryOf(root);
  assert.deepEqual(reg.bindings.filter((b) => b.role === 'main').map((b) => [b.role, b.status, path.basename(b.root)]).sort(), [['main', 'active', 'after'], ['main', 'retired', 'before']]);
  assert.deepEqual(reg.bindings.filter((b) => b.role === 'worktree').map((b) => [b.status, b.reason, b.purpose]), [['retired', 'promoted-to-main', 'relocate-reservation']]);
  svc = await restart(svc);
  const reopened = await svc.openByWorkspace(after);
  assert.equal(reopened.id, h.id);
  assert.equal(Object.values(reopened.state.tasks)[0].title, 'travels');
  assert.equal(await svc.openByWorkspace(before), null, 'the retired root is not reused');
  await svc.close();
});

// 责任：无 marker 的移动须在迁移 dry-run 中暴露 missing root。
test('an unmarked move is visible in the dry-run as a missing root', async () => {
  const root = tmp('pb-id-move2');
  const ws = path.join(tmp('pb-id-move2-parent'), 'x');
  fs.mkdirSync(ws);
  const svc = await service(root);
  const h = await svc.createProject({ workspacePath: ws });
  fs.renameSync(ws, ws + '-renamed');
  const plan = planMigration(svc);
  assert.deepEqual(plan.actions.map((a) => [a.projectId, a.action, a.rootExists]), [[h.id, 'keep', false]]);
  await svc.close();
});

// 责任：registry 写入须原子，内容不能把 marker 文件误列成绑定项。
test('the registry file is written atomically and lists marker files nowhere', async () => {
  const root = tmp('pb-id-atomic');
  const ws = tmp('pb-id-atomic-ws');
  const svc = await service(root);
  await svc.createProject({ workspacePath: ws });
  assert.equal(fs.readdirSync(root).filter((n) => n.includes('.tmp-') || n.endsWith('.lock')).length, 0);
  assert.equal(fs.existsSync(path.join(ws, MARKER_FILE)), false, 'creating a project never writes into the workspace');
  await svc.close();
});

// 责任：worktree 已显式绑定另一项目时，create 须保留该绑定而非自动归主树项目。
test('review: a linked worktree explicitly bound to another project keeps that binding on create', async () => {
  const root = tmp('pb-id-rv-wt');
  const { main, wt } = repoWithWorktree();
  const svc = await service(root);
  const a = await svc.createProject({ workspacePath: main });
  const elsewhere = tmp('pb-id-rv-b');
  const b = await svc.createProject({ workspacePath: elsewhere });
  await b.command(human('project.relocate', { workspacePath: wt }));
  assert.equal(svc.resolveWorkspace(wt).projectId, b.id);
  assert.equal((await svc.createProject({ workspacePath: wt })).id, b.id, 'own binding wins over common-dir mapping');
  assert.equal((await svc.createProject({ workspacePath: main })).id, a.id);
  assert.equal(projectDirs(root).length, 2);
  await svc.close();
});

// 责任：另一服务持旧视图时身份写操作仍须按新磁盘状态判定，不能覆盖新绑定。
test('review: identity writes judge fresh disk state, not a stale legacy view held by another service', async () => {
  const root = tmp('pb-id-rv-stale');
  const oldWs = tmp('pb-id-rv-old');
  const newWs = tmp('pb-id-rv-new');
  const legacy = legacyProject(root, oldWs);
  const host = await service(root);
  const b = await host.createProject({ workspacePath: tmp('pb-id-rv-b') });
  const other = await service(root);
  await (await other.open(legacy.projectId)).command(human('project.relocate', { workspacePath: newWs }));
  await other.close();
  assert.throws(() => bindWorktree(host, { projectId: b.id, workspacePath: newWs, actor: { kind: 'human' } }), (e) => e.code === 'identity-conflict' && (e.details.projectId === legacy.projectId || e.details.bindings.some((x) => x.projectId === legacy.projectId)));
  await assert.rejects(b.command(human('project.relocate', { workspacePath: newWs })), (e) => e.code === 'already-exists' && e.details.projectId === legacy.projectId);
  assert.equal((await host.createProject({ workspacePath: newWs })).id, legacy.projectId, 'create finds the moved legacy project');
  assert.equal(projectDirs(root).length, 2);
  await host.close();
});

// 责任：worktree 携带主项目 tracked marker 时 create 应加入该项目，不误当独立副本。
test('review: a linked worktree carrying the tracked marker of the main project joins it on create', async () => {
  const root = tmp('pb-id-rv-marked');
  const { main, wt } = repoWithWorktree();
  const svc = await service(root);
  const a = await svc.createProject({ workspacePath: main });
  writeMarker(main, a.id);
  writeMarker(wt, a.id);
  assert.equal(svc.resolveWorkspace(wt).projectId, a.id);
  assert.equal((await svc.createProject({ workspacePath: wt })).id, a.id);
  writeMarker(wt, 'prj_00112233aabbccdd');
  assert.throws(() => svc.resolveWorkspace(wt), (e) => e.code === 'identity-conflict');
  await assert.rejects(svc.createProject({ workspacePath: wt }), (e) => e.code === 'identity-conflict');
  assert.equal(projectDirs(root).length, 1);
  await svc.close();
});
