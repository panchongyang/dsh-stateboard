/**
 * 测试职责：区分已持久化的业务提交与后续 meta/快照写失败，避免误报回滚或重复项目。
 * 典型流程：临时目录阻断 meta/快照写入 → relocate/创建任务 → 冷开并对照日志恢复结果。
 * 覆盖边界：覆盖 提交后警告、元数据自愈和快照非致命失败；不覆盖真实断电或文件系统驱动故障。
 * 外部前置：无；通过目录占位注入写失败。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectService } from '../../lib/core/service.js';
import { canonicalKey, readJson } from '../../lib/core/util.js';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
}

function cmd(op, extra = {}) {
  return { cmdId: 'cmd_' + crypto.randomUUID(), actor: { kind: 'agent', sessionId: 's1' }, op, ...extra };
}

function humanCmd(op, extra = {}) {
  return { cmdId: 'cmd_' + crypto.randomUUID(), actor: { kind: 'human', via: 'test' }, op, ...extra };
}

async function setup() {
  const rootDir = tmp('pb-commit-state');
  const workspacePath = tmp('pb-commit-ws');
  const svc = new ProjectService({ rootDir });
  await svc.init();
  const h = await svc.createProject({ workspacePath, name: 'Commit boundary' });
  await h.attach({ sessionId: 's1', agentId: 's1', source: 'test', role: 'worker' });
  return { svc, h, rootDir, workspacePath };
}

// 责任：迁移工作区时 meta 写失败仍返回 committed 与警告，冷开须从日志修复路径和索引。
test('relocate meta write failure still returns committed + warning, and the next open heals meta', async () => {
  const { svc, h, rootDir } = await setup();
  const target = tmp('pb-commit-target');
  const metaPath = path.join(h.meta.dir, 'meta.json');
  const backup = path.join(h.meta.dir, 'meta.backup.json');
  fs.renameSync(metaPath, backup);
  fs.mkdirSync(metaPath);
  try {
    const result = await h.command(humanCmd('project.relocate', { workspacePath: target }));
    assert.equal(result.ok, true);
    assert.equal(result.committed, true);
    assert.equal(canonicalKey(h.state.project.workspacePath), canonicalKey(target));
    assert.equal(result.warnings[0].code, 'relocate-meta-failed');
    assert.equal(h.meta.project.workspacePath !== target, true, 'in-memory meta may still be stale after failure');
    const rev = h.rev;
    const projectId = h.id;
    await svc.close();

    // Restore the pre-command meta (simulating the failed write leaving it stale).
    fs.rmSync(metaPath, { recursive: true, force: true });
    fs.renameSync(backup, metaPath);

    const svc2 = new ProjectService({ rootDir });
    await svc2.init();
    const h2 = await svc2.open(projectId);
    assert.equal(h2.rev, rev);
    assert.equal(canonicalKey(h2.state.project.workspacePath), canonicalKey(target));
    const healed = readJson(metaPath, null);
    assert.equal(canonicalKey(healed.project.workspacePath), canonicalKey(target), 'meta.json was healed from the log');
    assert.equal(svc2.pathIndex.get(canonicalKey(target)), projectId);
    assert.equal(svc2.pathIndex.has(canonicalKey(h.meta.project.workspacePath || '')), false);
    await svc2.close();
  } finally {
    fs.rmSync(metaPath, { recursive: true, force: true });
    if (fs.existsSync(backup)) fs.renameSync(backup, metaPath);
    try { await svc.close(); } catch { /* already closed */ }
  }
});

// 责任：迁移后从新路径打开/创建必须找到原项目，不得因旧 meta 产生第二块看板。
test('opening or creating from the new workspace finds the relocated project instead of duplicating it', async () => {
  const { svc, h, rootDir } = await setup();
  const target = tmp('pb-commit-target-2');
  const metaPath = path.join(h.meta.dir, 'meta.json');
  const backup = path.join(h.meta.dir, 'meta.backup-2.json');
  fs.renameSync(metaPath, backup);
  fs.mkdirSync(metaPath);
  try {
    await h.command(humanCmd('project.relocate', { workspacePath: target }));
    const projectId = h.id;
    await svc.close();
    fs.rmSync(metaPath, { recursive: true, force: true });
    fs.renameSync(backup, metaPath);

    const svc2 = new ProjectService({ rootDir });
    await svc2.init();
    const byPath = await svc2.openByWorkspace(target);
    assert.ok(byPath, 'openByWorkspace must discover the project from the log');
    assert.equal(byPath.id, projectId);
    assert.equal(canonicalKey(readJson(metaPath, null).project.workspacePath), canonicalKey(target), 'meta was healed on discovery');
    const created = await svc2.createProject({ workspacePath: target, name: 'must not duplicate' });
    assert.equal(created.id, projectId, 'createProject must not create a second board');
    assert.equal(svc2.listProjects().length, 1);
    await svc2.close();
  } finally {
    fs.rmSync(metaPath, { recursive: true, force: true });
    if (fs.existsSync(backup)) fs.renameSync(backup, metaPath);
    try { await svc.close(); } catch { /* already closed */ }
  }
});

// 责任：快照写失败不得改变任务提交成功结果，移除阻挡后冷开须重放该任务。
test('a snapshot write failure is non-fatal and does not change the command result', async () => {
  const { svc, h, rootDir } = await setup();
  const snapshotPath = path.join(h.meta.dir, 'snapshot.json');
  fs.rmSync(snapshotPath, { force: true });
  fs.mkdirSync(snapshotPath);
  try {
    // Direct saveSnapshot must swallow the failure; a following command still commits.
    h.store.saveSnapshot();
    const result = await h.command(humanCmd('task.create', { title: 'After snapshot failure', acceptance: [{ text: 'x' }] }));
    assert.equal(result.committed, true);
    assert.equal(result.warnings, undefined);
    const rev = h.rev;
    const projectId = h.id;
    await svc.close();
    fs.rmSync(snapshotPath, { recursive: true, force: true });
    const svc2 = new ProjectService({ rootDir });
    await svc2.init();
    const h2 = await svc2.open(projectId);
    assert.equal(h2.rev, rev);
    assert.equal(Object.values(h2.state.tasks).some((task) => task.title === 'After snapshot failure'), true);
    await svc2.close();
  } finally {
    fs.rmSync(snapshotPath, { recursive: true, force: true });
    try { await svc.close(); } catch { /* already closed */ }
  }
});
