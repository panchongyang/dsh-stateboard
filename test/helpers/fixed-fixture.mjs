// @ts-check
/**
 * 测试职责：为固定证据相关入口提供独立本地 Git 仓库、字节哈希和自动来源引导 fixture。
 * 典型流程：创建临时仓库并提交初始文档 → 通过正常任务 submit 建来源 → 返回测试使用的证据身份。
 * 覆盖边界：覆盖 仅构造合成 fixture；不覆盖独立断言、不验证生产仓库或运行宿主服务。
 * 外部前置：需要 Git；支持传入 sha1/sha256 对象格式，所有配置仅写临时仓库。
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

/**
 * Record the automatic Git source by submitting one clean external doc through
 * the normal command path. Later `get_fixed` reads need that source.
 */
// 分段职责：通过正常 create/claim/begin/submit 原子登记来源，避免 fixture 直接伪造审批。
export async function bootstrapPin(h, docId) {
  const created = await h.command(command('task.create', { title: '固定来源引导', acceptance: [{ text: '记录来源' }] }));
  const taskId = created.events[0].data.id;
  await h.command(command('task.claim', { taskId, expected: { entityRev: h.state.tasks[taskId].rev } }));
  await h.command(command('task.begin', { taskId, fencingToken: h.leases.get(taskId).token, expected: { entityRev: h.state.tasks[taskId].rev }, summary: '引导自动来源' }));
  await h.command(command('task.submit', {
    taskId,
    fencingToken: h.leases.get(taskId).token,
    expected: { entityRev: h.state.tasks[taskId].rev },
    evidence: [{ kind: 'doc', ref: docId, acceptanceId: h.state.tasks[taskId].acceptance[0].id }],
  }));
  return h.state.tasks[taskId].evidence[0];
}

