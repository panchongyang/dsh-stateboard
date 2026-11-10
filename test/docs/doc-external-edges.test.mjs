/**
 * 测试职责：封住绑定变更、确认上下文和内容过滤器对外置文档观测的竞态漏洞。
 * 典型流程：双服务共享临时绑定/修改读取钩子/配置 Git filter → inspect/confirm → 检查分类与零写入。
 * 覆盖边界：覆盖 跨实例绑定刷新、基线上下文、读中变动及 filter 禁执行；不覆盖真实多进程压力。
 * 外部前置：过滤器用例需要 Git，缺少时显式跳过；其余仅临时文件。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectService } from '../../lib/core/service.js';
import { bindWorktree, unbind } from '../../lib/core/identity/ops.js';
import { inspectExternalDoc } from '../../lib/core/documents/external-observe.js';
import { observeGit } from '../../lib/core/documents/external-git.js';

const tmp = (prefix) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')));
const human = (op, extra = {}) => ({ cmdId: 'cmd_' + crypto.randomUUID(), actor: { kind: 'human', via: 'test' }, op, ...extra });
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const rejects = (promise, code) => assert.rejects(promise, (e) => { assert.equal(e.code, code, e.message); return true; });

async function service(rootDir) {
  return new ProjectService({ rootDir }).init();
}

function hasGit() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// 责任：另一服务解绑后缓存也须报 missing_binding，新绑定必须立即可用于登记和迁移。
test('bindings retired or added by another process are judged on disk, cache included', async () => {
  const board = tmp('pbx-edge-board');
  const ws = tmp('pbx-edge-ws');
  const old = tmp('pbx-edge-old');
  const fresh = tmp('pbx-edge-new');
  for (const root of [ws, old, fresh]) fs.writeFileSync(path.join(root, 'a.md'), 'body');
  const a = await service(board);
  const h = await a.createProject({ workspacePath: ws });
  const oldBinding = bindWorktree(a, { projectId: h.id, workspacePath: old, actor: { kind: 'human' } });
  const reg = await h.command(human('doc.external.register', { title: 'old', bindingId: oldBinding.bindingId, relPath: 'a.md' }));
  assert.equal(inspectExternalDoc(h, reg.docId).availability, 'readable', 'primes the observation cache');

  const b = await service(board);
  unbind(b, { bindingId: oldBinding.bindingId, actor: { kind: 'human' } });
  const added = bindWorktree(b, { projectId: h.id, workspacePath: fresh, actor: { kind: 'human' } });

  const cached = inspectExternalDoc(h, reg.docId);
  assert.equal(cached.availability, 'missing_binding', 'a cache hit never outlives the binding');
  assert.equal(inspectExternalDoc(h, reg.docId, { fresh: true }).availability, 'missing_binding');
  const rev = h.rev;
  await rejects(h.command(human('doc.external.register', { title: 'x', bindingId: oldBinding.bindingId, relPath: 'a.md' })), 'missing-binding');
  await rejects(h.command(human('doc.external.confirm', { docId: reg.docId, expectedMetaRev: 1, expectedContentHash: sha('body') })), 'missing-binding');
  assert.equal(h.rev, rev);
  const viaNew = await h.command(human('doc.external.register', { title: 'new', bindingId: added.bindingId, relPath: 'a.md' }));
  assert.equal(h.state.docs[viaNew.docId].locator.bindingId, added.bindingId);
  const moved = await h.command(human('doc.external.relocate', { docId: reg.docId, expectedMetaRev: 1, bindingId: added.bindingId }));
  assert.equal(moved.committed, true);
  await b.close();
  await a.close();
});

// 责任：确认后迁移再移回原路径仍须 not_comparable，重绑后也必须重新确认。
test('a baseline only matches in the context it was confirmed in, even after moving back', async () => {
  const board = tmp('pbx-edge-board');
  const ws = tmp('pbx-edge-ws');
  for (const name of ['a.md', 'b.md']) fs.writeFileSync(path.join(ws, name), 'same');
  const svc = await service(board);
  const h = await svc.createProject({ workspacePath: ws });
  const { docId } = await h.command(human('doc.external.register', { title: 'T', relPath: 'a.md' }));
  await h.command(human('doc.external.confirm', { docId, expectedMetaRev: 1, expectedContentHash: sha('same') }));
  assert.equal(inspectExternalDoc(h, docId).confirmation.state, 'matches_baseline');
  await h.command(human('doc.external.relocate', { docId, expectedMetaRev: 2, relPath: 'b.md' }));
  await h.command(human('doc.external.relocate', { docId, expectedMetaRev: 3, relPath: 'a.md' }));
  const back = inspectExternalDoc(h, docId, { fresh: true });
  assert.deepEqual([back.confirmation.state, back.confirmation.reason], ['not_comparable', 'relocated']);
  assert.equal(back.doc.baseline.relPath, 'a.md', 'the old baseline stays for audit');

  const oldBinding = h.state.docs[docId].locator.bindingId;
  const next = tmp('pbx-edge-next');
  fs.cpSync(ws, next, { recursive: true });
  await h.command(human('project.relocate', { workspacePath: next }));
  const newBinding = svc.bindings().mainOf(h.id).bindingId;
  await h.command(human('doc.external.rebind', { fromBindingId: oldBinding, toBindingId: newBinding, expected: { projectRev: h.rev } }));
  await h.command(human('doc.external.confirm', { docId, expectedMetaRev: 5, expectedContentHash: sha('same') }));
  assert.equal(inspectExternalDoc(h, docId, { fresh: true }).confirmation.state, 'matches_baseline');
  await h.command(human('project.relocate', { workspacePath: ws }));
  const restored = svc.bindings().mainOf(h.id).bindingId;
  await h.command(human('doc.external.rebind', { fromBindingId: newBinding, toBindingId: restored, expected: { projectRev: h.rev } }));
  assert.equal(inspectExternalDoc(h, docId, { fresh: true }).confirmation.state, 'not_comparable', 'rebind also needs a new confirmation');
  await svc.close();
});

// 责任：每次读取都改动文件时 confirm 须报 unstable，日志、版本和 baseline 均不变。
test('a file that keeps changing during confirm is refused as unstable with zero writes', async () => {
  const board = tmp('pbx-edge-board');
  const ws = tmp('pbx-edge-ws');
  const file = path.join(ws, 'a.md');
  fs.writeFileSync(file, 'initial');
  const svc = await service(board);
  const h = await svc.createProject({ workspacePath: ws });
  const { docId } = await h.command(human('doc.external.register', { title: 'T', relPath: 'a.md' }));
  const log = path.join(h.meta.dir, 'commits.jsonl');
  const before = fs.readFileSync(log);
  const rev = h.rev;
  const { openSync, readSync, closeSync } = fs;
  let target = null;
  let mutations = 0;
  fs.openSync = (p, ...args) => {
    const fd = openSync.call(fs, p, ...args);
    if (path.resolve(String(p)) === file) target = fd;
    return fd;
  };
  fs.readSync = (fd, ...args) => {
    const n = readSync.call(fs, fd, ...args);
    if (fd === target && n > 0) fs.appendFileSync(file, ' changed' + ++mutations);
    return n;
  };
  fs.closeSync = (fd, ...args) => {
    if (fd === target) target = null;
    return closeSync.call(fs, fd, ...args);
  };
  try {
    await rejects(h.command(human('doc.external.confirm', { docId, expectedMetaRev: 1, expectedContentHash: sha('initial') })), 'unstable');
  } finally {
    Object.assign(fs, { openSync, readSync, closeSync });
  }
  assert.ok(mutations >= 2, 'both read attempts saw a change');
  assert.equal(h.rev, rev);
  assert.deepEqual(fs.readFileSync(log), before);
  assert.equal(h.state.docs[docId].baseline, null);
  assert.equal(h.state.docs[docId].rev, 1);
  await svc.close();
});

// 责任：路径匹配 filter/LFS 时不得宣称干净或修改，须报 git_unavailable 且不执行驱动。
test('a path under a content filter reports git_unavailable and never runs the filter', { skip: !hasGit() && 'git is not installed' }, () => {
  const ws = tmp('pbx-edge-git');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: ws, stdio: 'pipe' });
  git('init', '-q');
  const marker = path.join(ws, 'helper-marker').replaceAll('\\', '/');
  const helper = path.join(ws, 'helper.sh').replaceAll('\\', '/');
  fs.writeFileSync(helper, '#!/bin/sh\nprintf invoked >> "' + marker + '"\ncat\n');
  fs.writeFileSync(path.join(ws, '.gitattributes'), '*.md filter=probe\n*.bin filter=lfs\n');
  git('config', 'filter.probe.clean', 'sh "' + helper + '"');
  git('config', 'filter.probe.smudge', 'cat');
  fs.writeFileSync(path.join(ws, 'a.md'), 'a\n');
  git('add', '.gitattributes', 'a.md');
  git('commit', '-q', '-m', 'base');
  fs.rmSync(marker, { force: true });
  const unsupported = { state: 'git_unavailable', detail: 'unsupported-content-transform', filtered: true };
  assert.deepEqual(observeGit(ws, 'a.md'), unsupported, 'committed is not claimed');
  const past = new Date(Date.now() - 5000);
  fs.utimesSync(path.join(ws, 'a.md'), past, past);
  assert.deepEqual(observeGit(ws, 'a.md'), unsupported);
  fs.appendFileSync(path.join(ws, 'a.md'), 'changed\n');
  assert.deepEqual(observeGit(ws, 'a.md'), unsupported, 'modified is not claimed');
  fs.writeFileSync(path.join(ws, 'b.md'), 'b\n');
  assert.equal(observeGit(ws, 'b.md').state, 'untracked', 'untracked stays reportable');
  fs.writeFileSync(path.join(ws, 'c.bin'), 'c\n');
  git('-c', 'filter.lfs.clean=cat', '-c', 'filter.lfs.required=false', 'add', 'c.bin');
  git('commit', '-q', '-m', 'lfs');
  assert.deepEqual(observeGit(ws, 'c.bin'), { ...unsupported, lfs: true });
  assert.equal(fs.existsSync(marker), false, 'the clean filter was never executed');
});
