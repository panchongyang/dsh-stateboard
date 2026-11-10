/**
 * 测试职责：保证项目身份冲突、导入与创建中断不造成覆盖历史或重复看板。
 * 典型流程：临时 marker/registry/历史 store → 复制、绑定、导入或故障/进程竞态 → 比较身份和磁盘快照。
 * 覆盖边界：覆盖 显式 connect/fork/import、原子 registry 与目标预留；不覆盖真实跨机器传输或生产修复。
 * 外部前置：需要启动 Node 子进程；链接反例依赖平台链接能力。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ProjectService } from '../../lib/core/service.js';
import { JsonlStore } from '../../lib/core/store.js';
import { canonicalKey, readJson } from '../../lib/core/util.js';
import { MARKER_FILE, writeMarker } from '../../lib/core/identity/discover.js';
import { bindWorktree, forkWorkspace, importProject, unbind } from '../../lib/core/identity/ops.js';
import { REGISTRY_FILE, makeBinding, updateRegistry } from '../../lib/core/identity/registry.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = (prefix) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')));
const human = (op, extra = {}) => ({ cmdId: 'cmd_' + crypto.randomUUID(), actor: { kind: 'human', via: 'test' }, op, ...extra });
const system = { kind: 'system', via: 'test' };
const fileSha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const projectDirs = (root) => fs.readdirSync(path.join(root, 'projects')).filter((n) => n.startsWith('prj_')).sort();
const registryText = (root) => (fs.existsSync(path.join(root, REGISTRY_FILE)) ? fs.readFileSync(path.join(root, REGISTRY_FILE), 'utf8') : null);

async function service(rootDir) {
  const svc = new ProjectService({ rootDir });
  await svc.init();
  return svc;
}

async function restart(svc) {
  await svc.close();
  return service(svc.rootDir);
}

/** Snapshot of everything a refusal must leave untouched. */
function state(root, workspaces) {
  const logs = {};
  for (const id of projectDirs(root)) logs[id] = fileSha(path.join(root, 'projects', id, 'commits.jsonl'));
  const markers = workspaces.map((ws) => (fs.existsSync(path.join(ws, MARKER_FILE)) ? fs.readFileSync(path.join(ws, MARKER_FILE), 'utf8') : null));
  return { logs, registry: registryText(root), markers };
}

// 责任：复制带 marker 的工作区须先拒绝，显式 fork 后新 id/空历史且原项目日志不变。
test('a copied/cloned marked workspace is refused until the human chooses connect or fork', async () => {
  const root = tmp('pb-idc-copy');
  const original = tmp('pb-idc-orig');
  const copy = tmp('pb-idc-copy-ws');
  let svc = await service(root);
  const h = await svc.createProject({ workspacePath: original });
  await h.command(human('task.create', { title: 'original-only', acceptance: [{ text: 'x' }] }));
  writeMarker(original, h.id);
  fs.copyFileSync(path.join(original, MARKER_FILE), path.join(copy, MARKER_FILE));
  const before = state(root, [original, copy]);
  assert.throws(() => svc.resolveWorkspace(copy), (e) => e.code === 'binding-required' && e.details.reason === 'copied-or-forked');
  await assert.rejects(svc.createProject({ workspacePath: copy }), (e) => e.code === 'binding-required');
  assert.deepEqual(state(root, [original, copy]), before, 'refusal has no side effect');

  const forked = await forkWorkspace(svc, { workspacePath: copy, name: 'Fork', actor: system });
  assert.notEqual(forked.handle.id, h.id);
  assert.equal(forked.forkedFrom, h.id);
  assert.equal(readJson(path.join(copy, MARKER_FILE)).projectId, forked.handle.id, 'the copy now carries its own id');
  assert.equal(Object.keys(forked.handle.state.tasks).length, 0, 'fork starts with fresh history');
  assert.equal(fileSha(path.join(root, 'projects', h.id, 'commits.jsonl')), before.logs[h.id], 'original history untouched');
  await assert.rejects(forkWorkspace(svc, { workspacePath: copy, actor: system }), (e) => e.code === 'identity-conflict', 'fork twice is refused');

  svc = await restart(svc);
  assert.equal((await svc.openByWorkspace(original)).id, h.id);
  assert.equal((await svc.openByWorkspace(copy)).id, forked.handle.id);
  assert.equal(projectDirs(root).length, 2);
  await svc.close();
});

// 责任：同机 clone 可显式绑为原项目 worktree，解绑后重开仍须提示 binding-required。
test('connect: a same-machine clone can be bound as a worktree of the existing project instead', async () => {
  const root = tmp('pb-idc-connect');
  const original = tmp('pb-idc-c-orig');
  const clone = tmp('pb-idc-c-clone');
  let svc = await service(root);
  const h = await svc.createProject({ workspacePath: original });
  writeMarker(original, h.id);
  writeMarker(clone, h.id);
  const b = bindWorktree(svc, { projectId: h.id, workspacePath: clone, actor: system });
  const found = svc.resolveWorkspace(clone);
  assert.deepEqual([found.projectId, found.role, found.bindingId], [h.id, 'worktree', b.bindingId]);
  assert.equal(canonicalKey((await svc.openByWorkspace(clone)).workspacePath), canonicalKey(original));
  assert.throws(() => unbind(svc, { bindingId: svc.resolveWorkspace(original).bindingId, actor: system }), (e) => e.code === 'invalid-command', 'a main binding only moves by relocate');
  unbind(svc, { bindingId: b.bindingId, reason: 'done', actor: system });
  svc = await restart(svc);
  assert.throws(() => svc.resolveWorkspace(clone), (e) => e.code === 'binding-required');
  await svc.close();
});

// 责任：marker 指向不存在看板数据时须 board-data-missing，不能自动创建空替代品。
test('a marker whose board data is absent reports board-data-missing and creates nothing', async () => {
  const root = tmp('pb-idc-nodata');
  const ws = tmp('pb-idc-nodata-ws');
  fs.mkdirSync(path.join(ws, 'src'));
  writeMarker(ws, 'prj_00112233aabbccdd');
  const svc = await service(root);
  assert.throws(() => svc.resolveWorkspace(path.join(ws, 'src')), (e) => e.code === 'board-data-missing' && e.details.projectId === 'prj_00112233aabbccdd');
  await assert.rejects(svc.createProject({ workspacePath: ws }), (e) => e.code === 'board-data-missing');
  assert.deepEqual(projectDirs(root), []);
  assert.equal(registryText(root), null);
  await svc.close();
});

// 责任：显式跨机导入须保留项目 id、历史和关联，仅把主绑定定位到本机目标。
test('explicit cross-machine import keeps id/history/relations and rebinds to the local path', async () => {
  const machineA = tmp('pb-idc-machine-a');
  const wsA = tmp('pb-idc-ws-a');
  const a = await service(machineA);
  const h = await a.createProject({ workspacePath: wsA, name: 'Travelling' });
  await h.command(human('task.create', { title: 'first', acceptance: [{ text: 'x' }] }));
  await h.command(human('task.create', { title: 'second', acceptance: [{ text: 'y' }] }));
  const [t1, t2] = Object.keys(h.state.tasks);
  await h.command(human('task.update', { taskId: t2, expected: { entityRev: h.state.tasks[t2].rev }, deps: [t1] }));
  const exportedSeq = h.rev;
  await a.close();
  const exported = path.join(tmp('pb-idc-export'), h.id);
  fs.cpSync(path.join(machineA, 'projects', h.id), exported, { recursive: true });
  fs.writeFileSync(path.join(exported, 'lock.json'), '{"pid":1,"hostname":"machine-a"}');

  const machineB = tmp('pb-idc-machine-b');
  const wsB = tmp('pb-idc-ws-b');
  writeMarker(wsB, h.id);
  let b = await service(machineB);
  assert.throws(() => b.resolveWorkspace(wsB), (e) => e.code === 'board-data-missing');
  await assert.rejects(importProject(b, { sourceDir: exported, workspacePath: wsB, actor: { kind: 'agent' } }), (e) => e.code === 'forbidden-role');
  const result = await importProject(b, { sourceDir: exported, workspacePath: wsB, actor: system });
  assert.equal(result.projectId, h.id);
  assert.equal(result.importedLastSeq, exportedSeq);
  assert.notEqual(readJson(path.join(machineB, 'projects', h.id, 'lock.json'), {}).hostname, 'machine-a', 'a foreign lock is not imported');
  b = await restart(b);
  const imported = await b.openByWorkspace(wsB);
  assert.equal(imported.id, h.id);
  assert.equal(canonicalKey(imported.workspacePath), canonicalKey(wsB));
  assert.deepEqual(imported.state.tasks[t2].deps, [t1], 'relations survive');
  assert.equal(imported.rev, exportedSeq + 1, 'only one relocate commit was appended');

  const again = await importProject(b, { sourceDir: exported, workspacePath: wsB, actor: system });
  assert.equal(again.resumed, true, 're-import of the same history resumes instead of duplicating');
  assert.equal((await b.open(h.id)).rev, exportedSeq + 1);

  const other = path.join(tmp('pb-idc-other'), h.id);
  fs.cpSync(exported, other, { recursive: true });
  const lines = fs.readFileSync(path.join(other, 'commits.jsonl'), 'utf8');
  fs.writeFileSync(path.join(other, 'commits.jsonl'), lines.split('\n')[0] + '\n');
  const diverged = await service(tmp('pb-idc-diverged'));
  const shortLog = await importProject(diverged, { sourceDir: other, workspacePath: tmp('pb-idc-dv-ws'), actor: system });
  assert.equal(shortLog.importedLastSeq, 1);
  await diverged.close();
  await b.close();
});

// 责任：同 id 已有不同历史时 import 必须拒绝，不得覆盖已有项目。
test('import refuses a different history under the same id and never overwrites it', async () => {
  const src = tmp('pb-idc-src');
  const svcA = await service(src);
  const p = await svcA.createProject({ workspacePath: tmp('pb-idc-src-ws') });
  await p.command(human('task.create', { title: 'a', acceptance: [{ text: 'x' }] }));
  await svcA.close();
  const exported = path.join(tmp('pb-idc-exp2'), p.id);
  fs.cpSync(path.join(src, 'projects', p.id), exported, { recursive: true });

  const local = tmp('pb-idc-local');
  fs.mkdirSync(path.join(local, 'projects', p.id), { recursive: true });
  const fork = path.join(local, 'projects', p.id);
  const metaText = fs.readFileSync(path.join(exported, 'meta.json'), 'utf8');
  fs.writeFileSync(path.join(fork, 'meta.json'), metaText);
  fs.writeFileSync(path.join(fork, 'commits.jsonl'), fs.readFileSync(path.join(exported, 'commits.jsonl'), 'utf8').split('\n')[0] + '\n');
  const svc = await service(local);
  const h = await svc.open(p.id);
  await h.command(human('task.create', { title: 'local divergence', acceptance: [{ text: 'z' }] }));
  const before = fileSha(path.join(fork, 'commits.jsonl'));
  await assert.rejects(importProject(svc, { sourceDir: exported, workspacePath: tmp('pb-idc-local-ws'), actor: system }), (e) => e.code === 'already-exists');
  assert.equal(fileSha(path.join(fork, 'commits.jsonl')), before);
  await svc.close();
});

// 责任：畸形、超大、链接或 traversal marker 均须拒绝且无磁盘副作用。
test('malformed, oversized, linked or traversal markers are refused without side effects', async () => {
  const root = tmp('pb-idc-bad');
  const svc = await service(root);
  const cases = {
    'not json': '{',
    'unknown schema': JSON.stringify({ schemaVersion: 2, projectId: 'prj_00112233aabbccdd' }),
    'extra fields': JSON.stringify({ schemaVersion: 1, projectId: 'prj_00112233aabbccdd', workspacePath: 'C:\\x' }),
    traversal: JSON.stringify({ schemaVersion: 1, projectId: '../../prj_00112233aabbccdd' }),
    'array': '[]',
    oversized: JSON.stringify({ schemaVersion: 1, projectId: 'prj_00112233aabbccdd', pad: 'x'.repeat(5000) }),
  };
  for (const [label, text] of Object.entries(cases)) {
    const ws = tmp('pb-idc-bad-ws');
    fs.writeFileSync(path.join(ws, MARKER_FILE), text);
    assert.throws(() => svc.resolveWorkspace(ws), (e) => e.code === 'invalid-project-marker', label);
    await assert.rejects(svc.createProject({ workspacePath: ws }), (e) => e.code === 'invalid-project-marker', label);
  }
  const dirMarker = tmp('pb-idc-bad-dir');
  fs.mkdirSync(path.join(dirMarker, MARKER_FILE));
  assert.throws(() => svc.resolveWorkspace(dirMarker), (e) => e.code === 'invalid-project-marker');
  const target = tmp('pb-idc-bad-target');
  fs.writeFileSync(path.join(target, 'real.json'), JSON.stringify({ schemaVersion: 1, projectId: 'prj_00112233aabbccdd' }));
  const linked = tmp('pb-idc-bad-link');
  let linkMade = true;
  try { fs.symlinkSync(path.join(target, 'real.json'), path.join(linked, MARKER_FILE), 'file'); } catch { linkMade = false; }
  if (linkMade) assert.throws(() => svc.resolveWorkspace(linked), (e) => e.code === 'invalid-project-marker');
  assert.deepEqual(projectDirs(root), []);
  assert.equal(registryText(root), null);
  await svc.close();
});

// 责任：marker 与绑定不一致或根被双重绑定时须报冲突，不能静默任选一项。
test('marker/binding disagreement and double-bound roots are conflicts, never a silent pick', async () => {
  const root = tmp('pb-idc-conflict');
  const wsA = tmp('pb-idc-cf-a');
  const wsB = tmp('pb-idc-cf-b');
  const svc = await service(root);
  const a = await svc.createProject({ workspacePath: wsA });
  const b = await svc.createProject({ workspacePath: wsB });
  writeMarker(wsA, b.id);
  const before = state(root, [wsA, wsB]);
  assert.throws(() => svc.resolveWorkspace(wsA), (e) => e.code === 'identity-conflict' && e.details.boundProjectId === a.id);
  assert.throws(() => bindWorktree(svc, { projectId: b.id, workspacePath: wsA, actor: system }), (e) => e.code === 'identity-conflict');
  await assert.rejects(a.command(human('project.relocate', { workspacePath: wsB })), (e) => e.code === 'already-exists');
  const other = tmp('pb-idc-cf-other');
  writeMarker(other, b.id);
  await assert.rejects(a.command(human('project.relocate', { workspacePath: other })), (e) => e.code === 'identity-conflict');
  assert.deepEqual(state(root, [wsA, wsB]), before, 'no log, binding or marker was touched');
  await svc.close();

  const reg = JSON.parse(registryText(root));
  reg.bindings.push({ ...reg.bindings[0], bindingId: 'bnd_forged000000', projectId: b.id, role: 'worktree' });
  fs.writeFileSync(path.join(root, REGISTRY_FILE), JSON.stringify(reg));
  const again = await service(root);
  assert.throws(() => again.resolveWorkspace(wsA), (e) => e.code === 'identity-conflict' && e.details.projectIds.length === 2);
  await again.close();
});

// 责任：registry 不可读时旧路径发现可降级，但身份写操作必须拒绝。
test('an unreadable registry degrades to legacy resolution and refuses identity writes', async () => {
  const root = tmp('pb-idc-corrupt');
  const ws = tmp('pb-idc-corrupt-ws');
  let svc = await service(root);
  const h = await svc.createProject({ workspacePath: ws });
  await svc.close();
  fs.writeFileSync(path.join(root, REGISTRY_FILE), '{ torn');
  svc = await service(root);
  assert.equal((await svc.openByWorkspace(ws)).id, h.id, 'existing projects stay reachable');
  assert.match(svc.registryError, /not valid JSON/);
  await assert.rejects(svc.createProject({ workspacePath: tmp('pb-idc-corrupt-new') }), (e) => e.code === 'bindings-unreadable');
  assert.throws(() => bindWorktree(svc, { projectId: h.id, workspacePath: tmp('pb-idc-corrupt-wt'), actor: system }), (e) => e.code === 'bindings-unreadable');
  assert.equal(fs.readFileSync(path.join(root, REGISTRY_FILE), 'utf8'), '{ torn', 'the damaged file is preserved for a human');
  assert.deepEqual(projectDirs(root), [h.id]);
  await svc.close();
});

// 责任：残留 registry 锁须明确报告，不得自行抢锁或删除。
test('a stale registry lock is reported, not stolen', async () => {
  const root = tmp('pb-idc-lock');
  const svc = await service(root);
  const lock = path.join(root, REGISTRY_FILE + '.lock');
  fs.writeFileSync(lock, '{"pid":1}');
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(lock, old, old);
  await assert.rejects(svc.createProject({ workspacePath: tmp('pb-idc-lock-ws') }), (e) => e.code === 'bindings-locked');
  assert.ok(fs.existsSync(lock));
  assert.deepEqual(projectDirs(root), []);
  await svc.close();
});

// 责任：创建中断后保留 retired 绑定，重试不得生成重复项目。
test('an interrupted create leaves a retired binding and no duplicate on retry', async () => {
  const root = tmp('pb-idc-interrupt');
  const ws = tmp('pb-idc-interrupt-ws');
  let calls = 0;
  const svc = new ProjectService({
    rootDir: root,
    storeFactory: () => { calls += 1; throw new Error('disk full'); },
  });
  await svc.init();
  await assert.rejects(svc.createProject({ workspacePath: ws }), /disk full/);
  assert.equal(calls, 1);
  const reg = JSON.parse(registryText(root));
  assert.deepEqual(reg.bindings.map((b) => [b.status, b.reason]), [['retired', 'create-failed']]);
  await svc.close();
  const retry = await service(root);
  const h = await retry.createProject({ workspacePath: ws });
  assert.equal((await retry.openByWorkspace(ws)).id, h.id);
  assert.equal(JSON.parse(registryText(root)).bindings.filter((b) => b.status === 'active').length, 1);
  await retry.close();
});

// 责任：import 留下 staging 中断后不得误识别为完整项目，重跑须可完成。
test('an interrupted import (staging left behind) is ignored and the import can be rerun', async () => {
  const src = tmp('pb-idc-imp-src');
  const a = await service(src);
  const p = await a.createProject({ workspacePath: tmp('pb-idc-imp-ws') });
  await a.close();
  const exported = path.join(tmp('pb-idc-imp-exp'), p.id);
  fs.cpSync(path.join(src, 'projects', p.id), exported, { recursive: true });
  const local = tmp('pb-idc-imp-local');
  fs.mkdirSync(path.join(local, 'projects', '.import-deadbeef'), { recursive: true });
  fs.cpSync(exported, path.join(local, 'projects', '.import-deadbeef'), { recursive: true });
  let svc = await service(local);
  assert.equal(svc.metas.size, 0, 'a staging copy is never registered');
  const ws = tmp('pb-idc-imp-target');
  await importProject(svc, { sourceDir: exported, workspacePath: ws, actor: system });
  svc = await restart(svc);
  assert.equal((await svc.openByWorkspace(ws)).id, p.id);
  await svc.close();
});

// 责任：两个子进程同时创建同根后只能有一个项目与有效绑定。
test('two processes creating the same root concurrently end with exactly one project', async () => {
  const root = tmp('pb-idc-race');
  const ws = tmp('pb-idc-race-ws');
  const child = path.join(here, '../fixtures', 'identity-create-child.mjs');
  const serviceUrl = pathToFileURL(path.join(here, '../..', 'lib', 'core', 'service.js')).href;
  const run = () => new Promise((resolve) => {
    const proc = spawn(process.execPath, [child, serviceUrl, root, ws], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.on('exit', () => resolve(out.trim()));
  });
  const results = (await Promise.all([run(), run(), run(), run()])).map((line) => JSON.parse(line));
  const ok = results.filter((r) => r.ok);
  assert.ok(ok.length >= 1, JSON.stringify(results));
  for (const r of results.filter((x) => !x.ok)) assert.ok(['identity-conflict', 'board-data-missing', 'bindings-locked', 'log-busy', 'read-only'].includes(r.code), JSON.stringify(r));
  assert.equal(new Set(ok.map((r) => r.projectId)).size, 1, 'every winner names the same project');
  assert.equal(projectDirs(root).length, 1, 'exactly one project directory');
  const reg = JSON.parse(registryText(root));
  assert.equal(reg.bindings.filter((b) => b.status === 'active').length, 1);
  const svc = await service(root);
  assert.equal((await svc.openByWorkspace(ws)).id, ok[0].projectId);
  await svc.close();
});

// 责任：另一服务新写绑定后 relocate 必须重新读 registry，在提交前拒绝占用目标。
test('review: relocate re-reads the registry, so a binding written by another process refuses the move pre-commit', async () => {
  const root = tmp('pb-idc-rv-reloc');
  const wsA = tmp('pb-idc-rv-a');
  const target = tmp('pb-idc-rv-target');
  const svc = await service(root);
  const a = await svc.createProject({ workspacePath: wsA });
  const other = new ProjectService({ rootDir: root });
  await other.init();
  const b = await other.createProject({ workspacePath: target });
  await other.close();
  const logBefore = fileSha(path.join(root, 'projects', a.id, 'commits.jsonl'));
  await assert.rejects(a.command(human('project.relocate', { workspacePath: target })), (e) => e.code === 'already-exists' && e.details.projectId === b.id);
  assert.equal(fileSha(path.join(root, 'projects', a.id, 'commits.jsonl')), logBefore, 'nothing was committed');
  await svc.close();
});

// 责任：create 必须先尊重路径自身的绑定和 marker，不能被自动 worktree 映射覆盖。
test('review: create checks the path\'s own binding and marker before any worktree mapping', async () => {
  const root = tmp('pb-idc-rv-create');
  const ws = tmp('pb-idc-rv-ws');
  const svc = await service(root);
  const a = await svc.createProject({ workspacePath: ws });
  writeMarker(ws, 'prj_00112233aabbccdd');
  const before = state(root, [ws]);
  await assert.rejects(svc.createProject({ workspacePath: ws }), (e) => e.code === 'identity-conflict' && e.details.markerProjectId === 'prj_00112233aabbccdd');
  assert.deepEqual(state(root, [ws]), before);
  fs.rmSync(path.join(ws, MARKER_FILE));
  assert.equal((await svc.createProject({ workspacePath: ws })).id, a.id);
  await assert.rejects(svc.createProject({ workspacePath: tmp('pb-idc-rv-x'), ignoreMarker: true, actor: { kind: 'agent' } }), (e) => e.code === 'forbidden-role');
  await assert.rejects(svc.createProject({ workspacePath: tmp('pb-idc-rv-y'), ignoreMarker: true }), (e) => e.code === 'forbidden-role');
  await svc.close();
});

// 责任：genesis 写结果不确定时必须保留绑定与数据，重试不得再生成项目 id。
test('review: an uncertain genesis write keeps the binding and data, so a retry never mints a second project', async () => {
  const root = tmp('pb-idc-rv-genesis');
  const ws = tmp('pb-idc-rv-genesis-ws');
  let injected = true;
  const svc = new ProjectService({
    rootDir: root,
    storeFactory: (dir, meta) => new JsonlStore(dir, meta, {
      fs: { ...fs, closeSync(fd) { fs.closeSync(fd); if (injected) { injected = false; throw new Error('injected close failure after append'); } } },
    }),
  });
  await svc.init();
  await assert.rejects(svc.createProject({ workspacePath: ws }));
  assert.equal(projectDirs(root).length, 1);
  const [id] = projectDirs(root);
  assert.ok(fs.statSync(path.join(root, 'projects', id, 'commits.jsonl')).size > 0, 'genesis bytes reached the log');
  assert.equal(JSON.parse(registryText(root)).bindings.filter((b) => b.status === 'active' && b.projectId === id).length, 1, 'binding kept');
  const retry = await svc.createProject({ workspacePath: ws });
  assert.equal(retry.id, id, 'same-service retry opens the existing project');
  assert.equal(projectDirs(root).length, 1);
  await svc.close();
  const after = await service(root);
  assert.equal((await after.openByWorkspace(ws)).id, id, 'restart agrees');
  await after.close();
});

// 责任：移动后 import 回旧根须真正 relocate，不能被陈旧 cmdId 幂等缓存吞掉。
test('review: import back to an earlier root after a move really relocates (no stale cmdId dedupe)', async () => {
  const src = tmp('pb-idc-rv-imp-src');
  const a = await service(src);
  const p = await a.createProject({ workspacePath: tmp('pb-idc-rv-imp-ws') });
  await a.close();
  const exported = path.join(tmp('pb-idc-rv-imp-exp'), p.id);
  fs.cpSync(path.join(src, 'projects', p.id), exported, { recursive: true });
  const local = tmp('pb-idc-rv-imp-local');
  const wsA = tmp('pb-idc-rv-imp-a');
  const wsB = tmp('pb-idc-rv-imp-b');
  const svc = await service(local);
  await importProject(svc, { sourceDir: exported, workspacePath: wsA, actor: system });
  const h = await svc.open(p.id);
  await h.command(human('project.relocate', { workspacePath: wsB }));
  const again = await importProject(svc, { sourceDir: exported, workspacePath: wsA, actor: system });
  assert.equal(again.resumed, true);
  assert.equal(canonicalKey(again.workspacePath), canonicalKey(wsA));
  assert.equal(svc.resolveWorkspace(wsA).projectId, p.id);
  assert.equal(svc.resolveWorkspace(wsB), null);
  await svc.close();
});

// 责任：仅有 main 绑定而无日志的崩溃残留须报告，并允许显式退休后恢复。
test('review: an orphan main binding (crash between bind and log) is reported and can be explicitly retired', async () => {
  const root = tmp('pb-idc-rv-orphan');
  const ws = tmp('pb-idc-rv-orphan-ws');
  fs.writeFileSync(path.join(root, REGISTRY_FILE), JSON.stringify({ schemaVersion: 1, rev: 1, updatedAt: null, bindings: [{ bindingId: 'bnd_orphan0000001', projectId: 'prj_00112233aabbccdd', root: ws, role: 'main', status: 'active', createdAt: '2026-11-02T00:00:00.000Z', createdBy: 'system' }] }));
  const svc = await service(root);
  await assert.rejects(svc.createProject({ workspacePath: ws }), (e) => e.code === 'board-data-missing');
  assert.deepEqual(projectDirs(root), []);
  await assert.rejects(Promise.resolve().then(() => unbind(svc, { bindingId: 'bnd_orphan0000001', actor: { kind: 'agent' } })), (e) => e.code === 'forbidden-role');
  unbind(svc, { bindingId: 'bnd_orphan0000001', reason: 'orphan', actor: system });
  const h = await svc.createProject({ workspacePath: ws });
  assert.notEqual(h.id, 'prj_00112233aabbccdd');
  await svc.close();
});

// 责任：registry 写失败须保持原字节完全相同，且不遗留临时文件或锁。
test('review: a failed registry write leaves the registry byte-identical and no temp/lock behind', async () => {
  const root = tmp('pb-idc-rv-regfail');
  const svc = await service(root);
  await svc.createProject({ workspacePath: tmp('pb-idc-rv-regfail-a') });
  const file = path.join(root, REGISTRY_FILE);
  const before = fs.readFileSync(file, 'utf8');
  const failing = { ...fs, renameSync() { throw Object.assign(new Error('injected rename failure'), { code: 'EIO' }); } };
  assert.throws(() => updateRegistry(root, (registry) => { registry.bindings.push(makeBinding({ projectId: 'prj_00112233aabbccdd', root: tmp('pb-idc-rv-regfail-b'), role: 'main' })); }, failing), /injected rename failure/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'registry unchanged');
  assert.equal(fs.readdirSync(root).filter((n) => n.includes('.tmp-') || n.endsWith('.lock')).length, 0, 'no temp or lock left behind');
  const again = await restart(svc);
  assert.equal(again.registryError, null);
  await again.close();
});

// 责任：import 在目录 rename 后中断，重跑须续完 rebind 而非重复复制。
test('review: an import interrupted after the rename resumes and finishes the rebind', async () => {
  const src = tmp('pb-idc-rv-imp2-src');
  const a = await service(src);
  const p = await a.createProject({ workspacePath: tmp('pb-idc-rv-imp2-ws') });
  await a.close();
  const exported = path.join(tmp('pb-idc-rv-imp2-exp'), p.id);
  fs.cpSync(path.join(src, 'projects', p.id), exported, { recursive: true });
  const local = tmp('pb-idc-rv-imp2-local');
  fs.cpSync(exported, path.join(local, 'projects', p.id), { recursive: true });
  const ws = tmp('pb-idc-rv-imp2-target');
  let svc = await service(local);
  const result = await importProject(svc, { sourceDir: exported, workspacePath: ws, actor: system });
  assert.equal(result.resumed, true);
  svc = await restart(svc);
  const h = await svc.openByWorkspace(ws);
  assert.equal(h.id, p.id);
  assert.equal(canonicalKey(h.workspacePath), canonicalKey(ws));
  await svc.close();
});

// 责任：relocate 提交期间须在 registry 锁下预留目标，竞态 bind 必须失败。
test('review: relocate reserves the target under the registry lock, so a bind racing the commit loses', async () => {
  const root = tmp('pb-idc-rv-toctou');
  const target = tmp('pb-idc-rv-toctou-target');
  const svc = await service(root);
  const a = await svc.createProject({ workspacePath: tmp('pb-idc-rv-toctou-a') });
  const b = await svc.createProject({ workspacePath: tmp('pb-idc-rv-toctou-b') });
  const second = await service(root);
  const original = a.store.append.bind(a.store);
  let raced = null;
  a.store.append = (commit) => {
    try { bindWorktree(second, { projectId: b.id, workspacePath: target, actor: system }); raced = 'bound'; } catch (error) { raced = error.code; }
    return original(commit);
  };
  const result = await a.command(human('project.relocate', { workspacePath: target }));
  a.store.append = original;
  assert.equal(raced, 'identity-conflict', 'the racing bind is refused');
  assert.equal(result.committed, true);
  assert.equal(result.warnings, undefined, 'no post-commit binding failure');
  assert.equal(svc.resolveWorkspace(target).projectId, a.id);
  await second.close();
  await svc.close();
  const fresh = await service(root);
  assert.equal(fresh.resolveWorkspace(target).projectId, a.id, 'restart agrees');
  await fresh.close();
});
