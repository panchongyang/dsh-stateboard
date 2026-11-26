/**
 * 测试职责：从离线安装包恢复完整 space，核对历史、归档正文和关系。
 * 典型流程：安装候选包并创建合成历史 → 冷备份 → 独立空 profile 重装 → 新进程只读对账。
 * 覆盖边界：覆盖实际本地包安装、清空宿主依赖、Git clone 无历史及备份后独立继续；不覆盖真实 DSH 重装、旧集中库迁移或外置当前文档。
 * 外部前置：本地 Node、npm、Git 和系统临时目录；只打包/安装当前源码，不访问包注册表或真实配置。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { isolatedEnvironment } from '../helpers/fault-isolation.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const npm = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const copy = (a, b) => fs.cpSync(a, b, { recursive: true, force: false, errorOnExist: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function manifest(root) {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter(row => row.isFile()).map(row => {
    const file = path.join(row.parentPath, row.name), bytes = fs.readFileSync(file);
    return [path.relative(root, file), bytes.length, hash(bytes)];
  }).sort(([a], [b]) => a.localeCompare(b));
}
function run(exe, args, cwd, env) {
  const result = spawnSync(exe, args, { cwd, env, windowsHide: true, encoding: 'utf8', timeout: 45000 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr + result.stdout);
  return result.stdout.trim();
}
function profile(dir) {
  const env = isolatedEnvironment(dir);
  return { ...env, NPM_CONFIG_OFFLINE: 'true', NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(dir, 'git-global'), GIT_TERMINAL_PROMPT: '0' };
}
function install(prefix, tar, env) {
  fs.mkdirSync(prefix);
  run(process.execPath, [npm, 'install', '--prefix', prefix, '--offline', '--legacy-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund', tar], prefix, env);
  return pathToFileURL(fs.realpathSync.native(path.join(prefix, 'node_modules/dsh-stateboard/lib/core/service.js'))).href;
}

// 普通文件进程模拟安装后的启动方式。不要把 eval 的 --input-type 传给库自己的文件 worker。
const worker = path.join(repo, 'test/helpers/space-recovery-worker.mjs');
const probe = (env, cwd, mod, root, op, ids = {}) => JSON.parse(run(process.execPath,
  [worker, mod, root, op, JSON.stringify(ids)], cwd, env));

// 责任：用两个物理安装和隔离 profile 读同一备份点；逐字节核对归档并区别只含源码的 Git clone。
test('a fresh offline installation and empty host caches recover a complete space, not a Git clone', { timeout: 90000 }, () => {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'board-p1-reinstall-')));
  const pwd = name => path.join(tmp, name), warm = profile(pwd('warm')), cold = profile(pwd('cold'));
  const archive = pwd('packages'); fs.mkdirSync(archive);
  const [artifact] = JSON.parse(run(process.execPath, [npm, 'pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', archive], repo, warm));
  assert.equal(artifact.name, 'dsh-stateboard'); assert.equal(path.basename(artifact.filename), artifact.filename);
  const tar = path.join(archive, artifact.filename), one = install(pwd('install-a'), tar, warm), A = pwd('A'); fs.mkdirSync(A);
  run('git', ['init', '-q'], A, warm); fs.writeFileSync(path.join(A, '.gitignore'), '.projectboard/\n', { flag: 'wx' });
  run('git', ['add', '.gitignore'], A, warm); run('git', ['-c', 'user.name=fixture', '-c', 'user.email=f@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'synthetic checkout'], A, warm);
  const ids = probe(warm, tmp, one, A, 'seed'), media = root => path.join(root, '.projectboard', 'state');
  const initial = manifest(media(A)), backup = pwd('backup'), B = pwd('restored'); copy(A, backup); copy(backup, B);
  assert.deepEqual(manifest(media(backup)), initial); assert.equal(probe(warm, tmp, one, A, 'advance'), true);
  assert.notDeepEqual(manifest(media(A)), initial); const later = manifest(media(A));
  fs.writeFileSync(path.join(warm.DSH_HOME, 'synthetic-cache-marker'), 'not a board', { flag: 'wx' });
  for (const dir of [cold.DSH_HOME, cold.XDG_CACHE_HOME]) assert.deepEqual(fs.readdirSync(dir), []);
  const two = install(pwd('install-b'), tar, cold); assert.notEqual(one, two);
  const facts = probe(cold, tmp, two, B, 'inspect', ids);
  assert.equal(facts.id, ids.id); assert.equal(facts.body, '第二版\n字段乙'); assert.equal(facts.docRev, 2);
  assert.deepEqual(facts.plan, [ids.taskId]); assert.deepEqual(facts.belongs, { planId: ids.planId, version: 1, stepId: 's1' });
  assert.deepEqual(facts.links.taskIds, [ids.taskId]); assert.deepEqual(facts.links.planRefs, [{ planId: ids.planId, version: 1 }]);
  for (const original of ['第一版\n字段甲', '第二版\n字段乙']) assert.equal(fs.readFileSync(path.join(media(B), 'blobs', hash(original)), 'utf8'), original);
  const checkout = pwd('checkout'); run('git', ['clone', '-q', '--no-local', A, checkout], tmp, cold);
  assert.deepEqual(probe(cold, tmp, two, checkout, 'empty'), { id: null, projects: 0 }); assert.equal(fs.existsSync(media(checkout)), false);
  assert.deepEqual(manifest(media(B)), initial); assert.deepEqual(manifest(media(backup)), initial); assert.deepEqual(manifest(media(A)), later);
});
