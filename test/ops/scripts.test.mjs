/**
 * 测试职责：约束维护脚本权限沙箱、安装所有权、失败回滚和卸载保留用户数据。
 * 典型流程：临时 profile/源码链接与权限子进程 → assemble/解析参数 → 比较备份、配置和访问拒绝。
 * 覆盖边界：覆盖 隔离安装/卸载和纯守卫函数；不覆盖真实宿主升级、网络依赖安装或服务重启。
 * 外部前置：需要支持 Node permission 的运行时和创建目录链接权限；宿主发现仅作只读。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assemble, discoverHost, parseArgs } from '../../scripts/install.mjs';
import { parseDelaySeconds, removalGuard, removeProjectBoardInsert, nodePermissionFlag } from '../../scripts/guards.mjs';
import { spawnSync } from 'node:child_process';

// 责任：优先稳定 permission 标志，缺能力必须拒绝，子进程写文件和 spawn 都须被只读权限阻止。
test('permission fixture flag is supported, prefers stable, preserves read-only confinement and never skips', () => {
  assert.equal(nodePermissionFlag(new Set(['--permission','--experimental-permission'])), '--permission');
  assert.equal(nodePermissionFlag(new Set(['--experimental-permission'])), '--experimental-permission');
  assert.throws(() => nodePermissionFlag(new Set()), /refusing to run an unconfined/);
  const flag = nodePermissionFlag();
  assert.ok(process.allowedNodeEnvironmentFlags.has(flag));
  const child = spawnSync(process.execPath, [flag, '--allow-fs-read=*', '-e', `
    const assert = require('node:assert/strict');
    assert.throws(() => require('node:fs').writeFileSync('permission-must-deny-write', 'x'), {code: 'ERR_ACCESS_DENIED'});
    assert.throws(() => require('node:child_process').spawnSync(process.execPath, ['--version']), {code: 'ERR_ACCESS_DENIED'});
    console.log('read-only confinement enforced');
  `], {encoding:'utf8'});
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /read-only confinement enforced/);
  console.log('permission flag on ' + process.version + ': ' + flag);
});

function installationFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profileDir = path.join(root, 'custom-home', 'profiles', 'not-web');
  const source = path.join(root, 'source');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(source);
  fs.mkdirSync(path.join(source, 'lib'));
  fs.writeFileSync(path.join(source, 'lib', 'cordis.patch.yml'), '- insert:\n    - id: project-board\n      name: dsh-stateboard\n');
  const manifest = { name: 'fixture', private: true, dependencies: { other: '1' }, dsh: { profile: { bundles: ['other'] } } };
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '# own user config\n[]\n');
  const store = path.join(root, 'custom-home', 'project-board');
  fs.mkdirSync(store); fs.writeFileSync(path.join(store, 'keep'), 'user data');
  return { root, profileDir, source, store, log() {} };
}

// 责任：preview 零写、首次安装备份、重复安装幂等，卸载只移除自身配置且保留用户数据。
test('portable assembly preview, backup, repeat install and ownership-only uninstall preserve data', (t) => {
  const fixture = installationFixture(t);
  const file = path.join(fixture.profileDir, 'package.json');
  const before = fs.readFileSync(file, 'utf8');
  assemble({ ...fixture, dryRun: true });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(fixture.profileDir, 'node_modules')), false);
  assemble(fixture);
  const after = fs.readFileSync(file, 'utf8');
  const receipt = fs.readFileSync(path.join(fixture.profileDir, '.project-board-install.json'), 'utf8');
  assemble(fixture);
  assert.equal(fs.readFileSync(file, 'utf8'), after);
  assert.equal(fs.readFileSync(path.join(fixture.profileDir, '.project-board-install.json'), 'utf8'), receipt);
  const backup = JSON.parse(receipt).backup;
  assert.equal(fs.readFileSync(path.join(backup, 'package.json'), 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(backup, 'cordis.patch.yml'), 'utf8'), '# own user config\n[]\n');
  const manifest = JSON.parse(after); manifest.dependencies.later = '2';
  fs.writeFileSync(file, JSON.stringify(manifest));
  assemble({ ...fixture, uninstall: true });
  const removed = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(removed.dependencies, { other: '1', later: '2' });
  assert.deepEqual(removed.dsh.profile.bundles, ['other']);
  assert.equal(fs.existsSync(path.join(fixture.profileDir, 'node_modules', 'dsh-stateboard')), false);
  assert.equal(fs.readFileSync(path.join(fixture.store, 'keep'), 'utf8'), 'user data');
  assert.equal(fs.readFileSync(path.join(fixture.profileDir, 'cordis.patch.yml'), 'utf8'), '# own user config\n[]\n');
  assemble({ ...fixture, uninstall: true });
});

// 责任：安装/卸载在链接或 manifest 步骤失败时须恢复配置和链接，不能动无关临时文件。
test('assembly rollback restores config and link on install and uninstall failure', (t) => {
  const fixture = installationFixture(t);
  const file = path.join(fixture.profileDir, 'package.json');
  const before = fs.readFileSync(file, 'utf8');
  const unrelatedTemp = file + '.project-board-tmp-' + process.pid;
  fs.writeFileSync(unrelatedTemp, 'pre-existing unrelated file');
  for (const fault of ['failAfterLink', 'failAfterManifest']) {
    assert.throws(() => assemble({ ...fixture, [fault]: true }), /configuration and link restored/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(fs.existsSync(path.join(fixture.profileDir, 'node_modules')), false);
    assert.equal(fs.readFileSync(unrelatedTemp, 'utf8'), 'pre-existing unrelated file');
  }
  assemble(fixture);
  const installed = fs.readFileSync(file, 'utf8');
  const receipt = fs.readFileSync(path.join(fixture.profileDir, '.project-board-install.json'), 'utf8');
  for (const fault of ['failAfterLink', 'failAfterManifest']) {
    assert.throws(() => assemble({ ...fixture, uninstall: true, [fault]: true }), /configuration and link restored/);
    assert.equal(fs.readFileSync(file, 'utf8'), installed);
    assert.equal(fs.readFileSync(path.join(fixture.profileDir, '.project-board-install.json'), 'utf8'), receipt);
    assert.equal(fs.realpathSync(path.join(fixture.profileDir, 'node_modules', 'dsh-stateboard')), fs.realpathSync(fixture.source));
  }
});

// 责任：宿主/profile 缺失或已有冲突安装时须给清晰错误，磁盘不得被部分修改。
test('missing host/profile and conflicting assembly fail readably without mutation', (t) => {
  const fixture = installationFixture(t);
  assert.throws(() => discoverHost(path.join(fixture.root, 'absent')), /DSH host not found.*No files changed/);
  assert.throws(() => assemble({ ...fixture, profileDir: path.join(fixture.root, 'missing') }), /profile is not initialized/);
  const file = path.join(fixture.profileDir, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(file)); manifest.dependencies['dsh-stateboard'] = 'other';
  fs.writeFileSync(file, JSON.stringify(manifest));
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => assemble(fixture), /conflicts with script ownership/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.throws(() => parseArgs(['--runtime']), /Usage/);
  assert.throws(() => parseArgs(['--mystery']), /Usage/);
  const script = fs.readFileSync(new URL('../../scripts/install.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(script, /AIWorker|profiles[\\/'"]+,?[ '"\\]*web/);
});

const PATCH = [
  '- insert:',
  '    - id: other-plugin',
  '      name: some-other-plugin',
  '    - id: project-board',
  '      name: dsh-stateboard',
  '    - id: third-plugin',
  '      name: third',
  '    - id: fourth-plugin',
  '      name: fourth',
  '',
].join('\n');

// 责任：卸载 patch 仅移除 project-board 项，必须保留同列表其他插件。
test('uninstall removes only the project-board item and keeps the list intact', () => {
  const { text, removed } = removeProjectBoardInsert(PATCH);
  assert.equal(removed, 1);
  assert.ok(!text.includes('id: project-board'), 'our entry is gone');
  for (const id of ['other-plugin', 'third-plugin', 'fourth-plugin']) {
    assert.ok(text.includes('id: ' + id), id + ' survived');
  }
  // Structure stays valid YAML: one insert header, every remaining item indented.
  assert.equal(text.split('\n').filter((line) => line === '- insert:').length, 1);
  const items = text.split('\n').filter((line) => line.startsWith('    - id: '));
  assert.deepEqual(items, ['    - id: other-plugin', '    - id: third-plugin', '    - id: fourth-plugin']);
});

// 责任：patch 原本无本插件时卸载须原文不变，不重排用户配置。
test('uninstall on a patch without our entry changes nothing', () => {
  const plain = ['- insert:', '    - id: other-plugin', '      name: x', ''].join('\n');
  const { text, removed } = removeProjectBoardInsert(plain);
  assert.equal(removed, 0);
  assert.equal(text, plain);
});

// 责任：无法解析的 restart delay 须用默认延迟，不能变成零而立即触发。
test('an unparsable restart delay falls back instead of firing immediately', () => {
  for (const bad of ['5m', 'abc', '-3', 'NaN', 'Infinity']) {
    const parsed = parseDelaySeconds(bad);
    assert.equal(parsed.seconds, 60, 'fallback for ' + JSON.stringify(bad));
    assert.equal(parsed.valid, false);
  }
  assert.deepEqual(parseDelaySeconds('30'), { seconds: 30, valid: true, requested: '30' });
  assert.equal(parseDelaySeconds('1').seconds, 5, 'the minimum still applies');
  assert.equal(parseDelaySeconds(undefined).seconds, 60);
  assert.equal(parseDelaySeconds('').seconds, 60, 'no argument means the default');
  assert.equal(parseDelaySeconds('').valid, true);
});
