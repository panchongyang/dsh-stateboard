// @ts-check
/**
 * 测试职责：为固定证据相关入口提供独立本地 Git 仓库、字节哈希和自动来源引导 fixture。
 * 典型流程：创建临时仓库并提交初始文档 → 追加合法的旧日志 fixture → 返回测试使用的证据身份。
 * 覆盖边界：覆盖 仅构造合成 fixture；不覆盖独立断言、不验证生产仓库或运行宿主服务。
 * 外部前置：需要 Git；支持传入 sha1/sha256 对象格式，所有配置仅写临时仓库。
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCommit } from '../../lib/core/store.js';
import { locateRelationOwner } from '../../lib/core/domain/document-relations.js';

// 用途：创建合成临时根；传入 t 时由创建者负责失败清理，异步重试 Windows EPERM/ENOTEMPTY，不吞清理错误。
/** @param {import('node:test').TestContext} [t] */
export const temp = (t = undefined) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-fixed-')));
  if (t) t.after(() => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return root;
};
export const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
export const command = (op, extra = {}) => ({ cmdId: 'cmd_' + crypto.randomUUID(), actor: { kind: 'human', sessionId: 'fixed-test' }, op, ...extra });
// 分段职责：Git helper 只在调用者给出的临时根执行，禁 hooks 并限制超时/输出。
export function git(root, ...args) {
  return execFileSync('git', ['-c', 'core.hooksPath=', ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
export function put(root, name, value) {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), value);
}
// 分段职责：初始化合成 Git 配置并提交已知正文，返回确定可查的 HEAD 身份。
/** @param {string} [format] @param {import('node:test').TestContext} [t] */
export function repository(format = 'sha1', t = undefined) {
  const root = temp(t);
  git(root, 'init', '--object-format=' + format);
  git(root, 'config', 'user.name', 'Fixed Test');
  git(root, 'config', 'user.email', 'fixed@example.invalid');
  git(root, 'config', 'core.autocrlf', 'false');
  put(root, 'docs/spec.md', 'version one\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', '测试初始版本 ' + path.basename(root));
  return { root, oid: git(root, 'rev-parse', 'HEAD') };
}

// 仅 fixture：不让产品补写旧 Git 事件。以明确的旧记录形状冷重放同一合成日志。
export function appendLegacyFacts(h, events) {
  const base = fs.realpathSync.native(os.tmpdir());
  const file = fs.realpathSync.native(h.store.commitsFile);
  const relative = path.relative(base, file);
  if (!relative || path.isAbsolute(relative) || relative.split(path.sep)[0] === '..') throw new Error('Legacy fixture must be isolated');
  const commit = makeCommit(h.rev + 1, h.lastHash, { kind: 'human', sessionId: 'legacy-fixture' },
    'cmd_' + crypto.randomUUID(), h.rev, events, new Date().toISOString());
  fs.appendFileSync(file, JSON.stringify(commit) + '\n');
  if (h.refresh() !== commit.seq) throw new Error('Legacy fixture refresh did not publish the synthetic record');
  return commit;
}

// Git 仅用于工程合成数据构造；项目运行时从不调用此 helper。
export function legacyGitMaterial(h, docId, { synthetic = false } = {}) {
  const doc = h.state.docs[docId];
  const root = h.workspacePath;
  const pathAtCommit = doc.locator.relPath;
  const objectFormat = synthetic ? 'sha1' : git(root, 'rev-parse', '--show-object-format');
  const commitOid = synthetic ? 'a'.repeat(40) : git(root, 'rev-parse', 'HEAD');
  const blobOid = synthetic ? 'b'.repeat(40) : git(root, 'rev-parse', commitOid + ':' + pathAtCommit);
  const body = synthetic ? Buffer.from('synthetic recorded Git source')
    : execFileSync('git', ['-c', 'core.hooksPath=', 'cat-file', 'blob', blobOid],
      { cwd: root, timeout: 5000, maxBuffer: 20 * 1024 * 1024, windowsHide: true });
  const blobContentHash = sha(body);
  const fixed = { v: 1, projectId: h.id, objectFormat, commitOid, pathAtCommit, blobOid, blobContentHash };
  const data = { kind: 'doc', ref: docId, hash: blobContentHash, fixed };
  const source = h.state.project.gitContentRepository ?? { v: 1, objectFormat, anchorCommitOid: commitOid, bindingIds: [doc.locator.bindingId] };
  return { data, source };
}

export async function bootstrapPin(h, docId, options) {
  const { data, source } = legacyGitMaterial(h, docId, options);
  appendLegacyFacts(h, [
    { type: 'project/updated', data: { ...h.state.project, gitContentRepository: source } },
    { type: 'doc/content-fixed', docId, data },
  ]);
  return { ...data, fixedState: 'pinned' };
}

export function seedLegacyGitRelation(h, { from, to }) {
  const relationId = 'rel_' + crypto.randomBytes(10).toString('hex');
  const sourceOwnerId = locateRelationOwner(h.store.commits, from);
  if (!sourceOwnerId || to.kind !== 'git-fixed') throw new Error('Legacy relation fixture needs an existing exact source');
  appendLegacyFacts(h, [{ type: 'doc/relation-added', docId: to.docId, data: {
    relationId, relationKind: 'reference', fromVersion: from, toVersionRef: to, sourceOwnerId,
  } }]);
  return { relationId, relationState: 'exact', toVersionRef: to };
}

export const legacyRelation = (h, from, to) => seedLegacyGitRelation(h, { from, to });
