/**
 * 测试职责：封住绑定变更、确认上下文和内容过滤器对外置文档观测的竞态漏洞。
 * 典型流程：双服务共享临时绑定/修改读取钩子/配置 Git filter → inspect/confirm → 检查分类与零写入。
 * 覆盖边界：覆盖 跨实例绑定刷新、基线上下文、读中变动及 filter 禁执行；不覆盖真实多进程压力。
 * 外部前置：过滤器用例需要 Git，缺少时显式跳过；其余仅临时文件。
 */
import assert from 'node:assert/strict';
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

// 责任：P5 起外置观测不再运行 Git，任何路径都不执行 Git 命令、不依赖 Git 可用。
test('external observation no longer runs Git for workspace state', () => {
  const ws = tmp('pbx-edge-gitless');
  fs.writeFileSync(path.join(ws, 'a.md'), 'a\n');
  const oldPath = process.env.PATH;
  const empty = tmp('pbx-edge-empty-path');
  try {
    process.env.PATH = empty;
    assert.equal(observeGit(ws, 'a.md'), null, 'missing Git cannot change the observation');
    fs.appendFileSync(path.join(ws, 'a.md'), 'changed\n');
    assert.equal(observeGit(ws, 'a.md'), null);
  } finally {
    process.env.PATH = oldPath;
  }
});

// 责任：可读外置文档的 git 字段恒为 null，正文观测与确认漂移仍独立可用。
test('a readable external doc reports git null while body observation still works', async () => {
  const board = tmp('pbx-edge-gitless-board');
  const ws = tmp('pbx-edge-gitless-ws');
  fs.writeFileSync(path.join(ws, 'a.md'), 'body');
  const svc = await service(board);
  const h = await svc.createProject({ workspacePath: ws });
  const reg = await h.command(human('doc.external.register', { title: 'a', relPath: 'a.md' }));
  const first = inspectExternalDoc(h, reg.docId, { fresh: true });
  assert.equal(first.availability, 'readable');
  assert.equal(first.git, null, 'the git field stays null for compatibility');
  assert.equal(first.confirmation.state, 'unconfirmed');
  fs.writeFileSync(path.join(ws, 'a.md'), 'changed body');
  const second = inspectExternalDoc(h, reg.docId, { fresh: true });
  assert.equal(second.observation.contentHash, sha('changed body'));
  assert.equal(second.git, null);
  await svc.close();
});
