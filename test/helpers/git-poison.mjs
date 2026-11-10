/**
 * 测试职责：统一 Git 执行面安全测试的伪程序、marker、PATH 与仓库拓扑 fixture。
 * 典型流程：fixed-fixture 创建合成仓库 → 植入陷阱 → 运行 tracked CLI/解析器 → 调用点断言 marker。
 * 覆盖边界：不注册测试、不替代断言；进程环境修改必须 finally restore，不能同进程并发。
 * 外部前置：需要系统 Git；Windows 复用 tracked fake-git.exe，CLI 只使用 tracked release-tag。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { resetGitExecutableCache } from '../../lib/core/git-exec.js';
import { repository as fixedRepository, temp as fixedTemp } from './fixed-fixture.mjs';

// 用途：创建规范化临时目录；传入 t 时登记失败清理，未传 t 时由调用者负责收尾。
export function temp(t) {
  return fixedTemp(t);
}

// 用途：复用唯一 Git bootstrap 并登记仓库清理；不向仓库植入来源或审批。
export function repository(t) {
  return fixedRepository('sha1', t);
}

export const FAKE_EXE = path.resolve(import.meta.dirname, '../fixtures/fake-git/fake-git.exe');
export const FAKE_NAME = process.platform === 'win32' ? 'git.exe' : 'git';
export const RELEASE = path.resolve(import.meta.dirname, '../../scripts/release-tag.mjs');

// 用途：在指定合成目录布置忽略参数的 Git，执行时仅写 PB_GIT_MARKER。
export function plant(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const executable = path.join(dir, FAKE_NAME);
  if (process.platform === 'win32') fs.copyFileSync(FAKE_EXE, executable);
  else fs.writeFileSync(executable, '#!/bin/sh\n: > "$PB_GIT_MARKER"\nexit 0\n', { mode: 0o755 });
  return executable;
}

// 用途：创建独立 marker 路径；传 t 时失败也清理，不预先创建 marker 文件。
export function markerPath(t) {
  return path.join(temp(t), 'marker.txt');
}

// 用途：构造子进程环境，PATH 显式注入时保留可信系统候选；不改父进程。
export function poisonEnv(marker, entries) {
  return { ...process.env, PB_GIT_MARKER: marker,
    ...(entries ? { PATH: [...entries, process.env.PATH].join(path.delimiter) } : {}) };
}

// 用途：在父进程启用陷阱并复位缓存；调用者必须在 finally 调 restore，恢复变量原始存在性。
export function poison(dir) {
  const marker = path.join(dir, 'executed-marker.txt');
  const previous = { PATH: process.env.PATH, PB_GIT_MARKER: process.env.PB_GIT_MARKER };
  const executable = plant(dir);
  process.env.PB_GIT_MARKER = marker;
  process.env.PATH = dir + path.delimiter + (previous.PATH || '');
  resetGitExecutableCache();
  return { marker, executable, restore() {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    resetGitExecutableCache();
  } };
}

// 用途：临时替换完整 PATH；同步回调结束（包括抛错）恢复存在性和解析缓存。
export function withPath(entries, fn) {
  const previous = process.env.PATH;
  process.env.PATH = entries.join(path.delimiter);
  resetGitExecutableCache();
  try { return fn(); } finally {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
    resetGitExecutableCache();
  }
}

// 用途：执行候选程序的 marker 对照；不判定其可信性，由测试断言返回值。
export function runsMarker(executable) {
  const dir = temp();
  const marker = path.join(dir, 'marker.txt');
  try {
    spawnSync(executable, ['--version'], { env: poisonEnv(marker), windowsHide: true });
    return fs.existsSync(marker);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); }
}

// 用途：构造根/子目录/node_modules bin 陷阱；Git bootstrap 仅复用 fixed-fixture。
export function poisonedRepo(t, { bin: includeBin = false } = {}) {
  const { root, oid } = repository(t);
  fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '\n/' + FAKE_NAME + '\n' + (includeBin ? '/node_modules/\n' : ''));
  plant(root);
  const bin = path.join(root, 'node_modules', '.bin');
  if (includeBin) plant(bin);
  const child = path.join(root, 'child');
  fs.mkdirSync(child);
  const marker = markerPath(t);
  return { root, oid, bin, child, marker, env: poisonEnv(marker) };
}

// 用途：从无陷阱 cwd 执行 fixture Git，避免 Windows 先执行仓库内裸 git；不用于被测执行路径。
export function realGit(root, ...args) {
  const clean = temp();
  try {
    return execFileSync('git', ['-c', 'core.hooksPath=', '-C', root, ...args], { cwd: clean, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 10000 }).trim();
  } finally { fs.rmSync(clean, { recursive: true, force: true, maxRetries: 3 }); }
}

// 用途：创建 linked worktree，底层固定使用无陷阱 cwd；只改变合成仓库。
export function addWorktree(root, tree) {
  realGit(root, 'worktree', 'add', '-q', '-b', 'linked', tree);
}

// 用途：运行 tracked Node CLI；只传入合成 cwd/marker，默认 30 秒，不创建真实发布 tag。
export function runCli(script, args, cwd, marker, entries) {
  return spawnSync(process.execPath, [script, ...args], { cwd, env: poisonEnv(marker, entries), encoding: 'utf8', windowsHide: true, timeout: 30000 });
}
