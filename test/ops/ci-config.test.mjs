/**
 * 测试职责：防止 CI 配置移除强制质量门禁、离线子集或客户端产物一致性检查。
 * 典型流程：读取工作流与 package scripts → 匹配命令和矩阵 → 排除软失败配置。
 * 覆盖边界：覆盖 配置文本中的门禁接线与双平台性能预算；不覆盖 GitHub runner 真正执行结果。
 * 外部前置：无；需要仓库 CI 配置。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { suiteFiles } from '../suite-manifest.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');

// 责任：工作流必须执行 audit:check 和 test:ci，不能以仅报告的 audit 替代硬门禁。
test('CI runs the hard maintainability gate and the offline test subset', () => {
  assert.match(ci, /npm run audit:check/);
  assert.match(ci, /npm run test:ci/);
  assert.doesNotMatch(ci, /run: npm run audit\s*$/m, 'report-only audit must not remain the gate');
});

// 责任：客户端构建必须安装隔离工具链，并用 git diff 拒绝生成产物漂移。
test('CI rebuilds the client and fails on source/artifact drift', () => {
  assert.match(ci, /npm run build:client/);
  assert.match(ci, /git diff --exit-code -- lib\/client\.js lib\/client\.js\.map/);
  assert.match(ci, /npm --prefix tools\/build install/);
});

// 责任：Windows/Linux 均须跑性能门禁且不得容忍失败；性能/恢复独立于 core，并由 strict 串行调用。
test('CI enforces performance budgets on Windows and Linux without a skip switch', () => {
  assert.match(ci, /os: \[ubuntu-latest, windows-latest\]/);
  assert.match(ci, /run: npm run test:perf/);
  assert.doesNotMatch(ci, /continue-on-error:\s*true/);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const name of ['prompt-health-isolation.test.mjs', 'project-list-performance.test.mjs']) {
    assert.ok(suiteFiles('perf').includes('test/ops/' + name));
    assert.ok(!suiteFiles('core').includes('test/ops/' + name));
  }
  assert.ok(suiteFiles('recovery').includes('test/ops/recovery-drill.test.mjs'));
  assert.ok(!suiteFiles('core').includes('test/ops/recovery-drill.test.mjs'));
  assert.equal(pkg.scripts['check:strict'], 'npm run audit:check && npm test && npm run test:perf && npm run test:recovery && npm run test:stores -- --gate && npm run check:release');
  assert.equal(pkg.scripts['test:perf'], 'node scripts/run-suite.mjs perf');
  assert.equal(pkg.scripts['test:recovery'], 'node scripts/run-suite.mjs recovery');
  assert.match(pkg.scripts['test:core'], /check-test-size\.mjs/);
  assert.match(ci, /run: npm run test:recovery/);
});

// 责任：工作流必须说明 host 测试仅本地运行与宿主 peer 未完整发布的原因。
test('CI documents why host tests are local-only', () => {
  assert.match(ci, /test:host/);
  assert.match(ci, /unpublished|not fully published|peers/i);
});
