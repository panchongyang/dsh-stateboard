/**
 * 测试职责：防止 tracked 测试入口漏接默认/core/host/CI 门禁及遗漏矩阵 worker。
 * 典型流程：读取 package scripts、Git tracked 清单及 launcher → 比较必含入口和门禁串联。
 * 覆盖边界：覆盖 入口发现与脚本接线；不覆盖测试业务行为或未跟踪私有测试。
 * 外部前置：优先需要 Git，缺少时回退目录枚举；不执行宿主测试。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { suites, suiteFiles, trackedTests, validateManifest } from '../suite-manifest.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

/**
 * Test files that belong to the public source are the tracked ones. A local
 * checkout may also hold untracked developer-only tests (worktree helpers); those
 * are not part of the shipped suite and must not force a package.json wiring.
 */
function testFiles() {
  return trackedTests();
}

// 责任：每个 tracked 入口恰有一个叶 suite；别名共用 manifest，性能/恢复不能混入默认门禁。
test('every tracked test/**/*.test.mjs has exactly one manifest leaf suite', () => {
  assert.doesNotThrow(validateManifest);
  const invalid = testFiles().filter(file => Object.values(suites).filter(suite => suite.files.includes(file)).length !== 1);
  assert.deepEqual(invalid, [], 'test files require exactly one primary suite');
  for (const name of Object.keys(suites)) {
    assert.equal(pkg.scripts['test:' + name], 'node scripts/run-suite.mjs ' + name);
    assert.ok(Number.isSafeInteger(suites[name].budgetMs) && suites[name].budgetMs > 0);
  }
  const client = suiteFiles('client');
  for (const file of ['bundle-contract', 'styles-contract', 'views-render']) {
    assert.ok(client.includes('test/client/' + file + '.test.mjs'), file + ' belongs to test:client');
  }
  assert.ok(!client.includes('test/client/client-races.test.mjs'), 'client-races belongs only to core unit');
  assert.deepEqual(client.filter(file => file.includes('/unit/')), suiteFiles('unit:client'));
  assert.equal(pkg.scripts['test:unit:client'], 'node scripts/run-suite.mjs unit:client');
  assert.equal(pkg.scripts['test:client'], 'node scripts/run-suite.mjs client');
  assert.equal(pkg.scripts['test:core'], 'node scripts/check-test-size.mjs && node scripts/run-suite.mjs core');
  for (const file of [...suites.perf.files, ...suites.recovery.files]) {
    for (const name of ['core', 'fast']) assert.ok(!suiteFiles(name).includes(file), file + ' must not enter ' + name);
    assert.ok(suiteFiles('coverage').includes(file), file + ' requires coverage wiring');
  }
  assert.deepEqual([...suiteFiles('coverage')].sort(), [...testFiles(), 'test/host/host-preflight.mjs'].sort());
});

// Only executable split-path constructions are forbidden, not release manifest data.
function privatePathConstructions(source) {
  const calls = source.match(/\bpath\.(?:join|resolve)\((?:[^()]|\([^()]*\))*\)/g) || [];
  const separator = String.raw`\s*(?:,|\+\s*['"\x60][/\\]['"\x60]\s*\+)\s*`;
  const quoted = (value) => `['"\x60]${value}['"\x60]`;
  const forbidden = new RegExp([
    quoted('bin') + separator + quoted('wt\\.mjs'),
    quoted('lib') + separator + quoted('scripts'),
    quoted('test') + separator + `['"\x60]wt\\.[^'"\x60]*['"\x60]`,
  ].join('|'));
  return calls.filter((call) => forbidden.test(call));
}

// 责任：守卫须命中拆分的私有路径，同时允许发布清单中作为数据的完整路径字符串。
test('private-path guard distinguishes executable split paths from manifest data', () => {
  const call = (...segments) => 'path.join(root, ' + segments.map((segment) => JSON.stringify(segment)).join(', ') + ')';
  for (const segments of [['bin', 'wt.mjs'], ['lib', 'scripts', 'guards.js'], ['test', 'wt.test.mjs']]) {
    assert.equal(privatePathConstructions(call(...segments)).length, 1, segments.join('/'));
  }
  assert.equal(privatePathConstructions("'bin/wt.mjs'").length, 0);
  assert.equal(privatePathConstructions(call('scripts', 'release-tag.mjs')).length, 0);
});

// 责任：core 和 host 接线文件的可执行路径不得依赖被忽略的私有工具或私有测试。
test('wired core and host tests do not construct private tool paths', () => {
  const files = [...suiteFiles('core'), ...suiteFiles('host')];
  assert.ok(files.length > 0, 'no wired test files found');
  for (const file of files) {
    assert.deepEqual(privatePathConstructions(fs.readFileSync(path.join(root, file), 'utf8')), [], file + ' constructs a private path');
  }
});

// 责任：CI 脚本须包含 core/client 且不含 host，保证离线子集边界。
test('test:ci is the offline subset and starts from test:core', () => {
  assert.match(pkg.scripts['test:ci'] || '', /test:core/);
  assert.equal(pkg.scripts['test:ci'], 'npm run test:core');
  for (const file of suiteFiles('client')) assert.ok(suiteFiles('core').includes(file), file + ' must be in offline core');
  assert.equal(new Set(suiteFiles('core')).size, suiteFiles('core').length, 'core must not repeat client files');
  assert.doesNotMatch(pkg.scripts['test:ci'] || '', /test:host/);
});

// 责任：严格门禁链、发布门禁及列出的关键回归入口必须保持接线，host audit 归 host。
test('the named regression, release and R3 matrix gates are wired', () => {
  assert.equal(pkg.scripts['check:strict'], 'npm run audit:check && npm test && npm run test:perf && npm run test:recovery && npm run test:stores -- --gate && npm run check:release');
  assert.equal(pkg.scripts['check:release'], 'node scripts/check-release-purity.mjs');
  assert.equal(pkg.scripts['release:tag'], 'node scripts/release-tag.mjs');
  const core = suiteFiles('core');
  for (const file of ['contract/review-governance.test.mjs', 'contract/gate-migration-v3.test.mjs', 'ops/release-purity.test.mjs', 'ops/release-tag.test.mjs', 'storage/stores-replay.test.mjs', 'storage/event-compat.test.mjs', 'client/client-races.test.mjs', 'ops/scripts.test.mjs', 'contract/tool-schema-snapshot.test.mjs', 'ops/test-discovery.test.mjs', 'ops/hermetic-gate.test.mjs', 'core/core-matrix.test.mjs']) {
    assert.ok(core.includes('test/' + file), file + ' is not in test:core');
  }
  assert.ok(suiteFiles('host').includes('test/host/host-audit.test.mjs'), 'host-audit.test.mjs is not in test:host');
  for (const [name, files] of [['perf', ['core-performance', 'prompt-health-isolation', 'project-list-performance']], ['recovery', ['recovery-drill']]]) {
    for (const file of files) {
      assert.ok(suiteFiles(name).includes('test/ops/' + file + '.test.mjs'));
      assert.ok(!core.includes('test/ops/' + file + '.test.mjs'));
    }
  }
});

// 责任：矩阵目录须恰有三个 worker，隔离 launcher 必须逐个显式启动。
test('the isolated R3 launcher includes every matrix worker', () => {
  const launcher = fs.readFileSync(path.join(root, 'test/core/core-matrix.test.mjs'), 'utf8');
  const workers = fs.readdirSync(path.join(root, 'test/matrix')).filter((name) => name.endsWith('.mjs'));
  assert.deepEqual(workers.sort(), ['core-boundaries.mjs', 'core-lifecycle.mjs', 'core-matrix.mjs']);
  for (const name of workers) assert.ok(launcher.includes('test/matrix/' + name), name + ' is not launched');
});
