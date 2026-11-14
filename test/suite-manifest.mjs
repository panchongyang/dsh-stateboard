/**
 * 测试职责：为 runner、discovery、coverage 提供唯一的公开测试接线和预算来源。
 * 典型流程：显式声明叶 suite → 合成 core/client 别名 → 用 Git tracked 清单校验完整性。
 * 覆盖边界：覆盖 文件归属、预算与别名；不覆盖测试业务行为，不执行未跟踪文件。
 * 外部前置：需要 Git 读取 tracked 清单；本文件不注册测试。
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// 分段职责：显式登记各叶 suite 的公开入口和 wall-clock 预算，不使用目录 glob。
export const root = path.resolve(import.meta.dirname, '..');
export const suites = {
  unit: { budgetMs: 480000, files: [
    'test/client/client-races.test.mjs',
    'test/client/unit/bundle-logic.test.mjs',
    'test/client/unit/doc-view.test.mjs',
    'test/client/unit/external-docs.test.mjs',
    'test/client/unit/flow-layout.test.mjs',
    'test/client/unit/logic.test.mjs',
    'test/client/unit/page-lifecycle.test.mjs',
    'test/client/unit/page-navigation.test.mjs',
    'test/client/unit/page-wiring.test.mjs',
    'test/contract/contract-parity.test.mjs',
    'test/core/clock-ttl.test.mjs',
    'test/core/delivery.test.mjs',
    'test/core/digest.test.mjs',
  ] },
  integration: { budgetMs: 480000, files: [
    'test/client/bundle-contract.test.mjs',
    'test/client/styles-contract.test.mjs',
    'test/client/views-render.test.mjs',
    'test/contract/api-surface.test.mjs',
    'test/contract/gate-migration-v3.test.mjs',
    'test/contract/review-governance.test.mjs',
    'test/contract/tool-schema-snapshot.test.mjs',
    'test/core/alias-guard.test.mjs',
    'test/core/archived.test.mjs',
    'test/core/core-matrix.test.mjs',
    'test/core/fsck-intents.test.mjs',
    'test/core/handle-lifecycle.test.mjs',
    'test/core/identity-conflicts.test.mjs',
    'test/core/identity.test.mjs',
    'test/core/knowledge.test.mjs',
    'test/core/knowledge-sources.test.mjs',
    'test/core/knowledge-faults.test.mjs',
    'test/core/intent-settlement.test.mjs',
    'test/core/lease-edit.test.mjs',
    'test/core/lease-reclaim.test.mjs',
    'test/core/lease-renew.test.mjs',
    'test/core/lock-race.test.mjs',
    'test/core/lock.test.mjs',
    'test/core/plan-acceptance.test.mjs',
    'test/core/plan-concurrency.test.mjs',
    'test/core/plan-lifecycle.test.mjs',
    'test/core/plan-stages.test.mjs',
    'test/core/project-reader.test.mjs',
    'test/core/restart-expiry-audit.test.mjs',
    'test/core/state-machine.test.mjs',
    'test/core/store-integrity.test.mjs',
    'test/core/task-lifecycle.test.mjs',
    'test/docs/doc-external-compat.test.mjs',
    'test/docs/doc-external-edges.test.mjs',
    'test/docs/doc-external.test.mjs',
    'test/docs/doc-fixed-auto.test.mjs',
    'test/docs/doc-fixed-edges.test.mjs',
    'test/docs/doc-fixed-evidence.test.mjs',
    'test/docs/doc-fixed-git.test.mjs',
    'test/docs/doc-fixed-head-race.test.mjs',
    'test/docs/doc-fixed-surfaces.test.mjs',
    'test/docs/doc-inline-write-policy.test.mjs',
    'test/docs/doc-migration-write.test.mjs',
    'test/docs/doc-migration.test.mjs',
    'test/docs/doc-read.test.mjs',
    'test/docs/evidence-audit.test.mjs',
    'test/docs/evidence-restart.test.mjs',
    'test/docs/evidence-runner.test.mjs',
    'test/git/git-config-parse.test.mjs',
    'test/git/git-exec-surface.test.mjs',
    'test/git/git-exec.test.mjs',
    'test/git/gitattributes-eol.test.mjs',
    'test/storage/commit-boundary.test.mjs',
    'test/storage/event-compat.test.mjs',
    'test/storage/migration-replay.test.mjs',
    'test/storage/repair-log.test.mjs',
    'test/storage/replay-snapshot.test.mjs',
    'test/storage/salvage-log.test.mjs',
    'test/storage/store-faults.test.mjs',
    'test/storage/stores-replay.test.mjs',
  ] },
  cli: { budgetMs: 300000, files: [
    'test/git/git-exec-repo-root.test.mjs',
    'test/ops/release-tag.test.mjs',
    'test/ops/scripts.test.mjs',
  ] },
  ops: { budgetMs: 300000, files: [
    'test/ops/architecture-map.test.mjs',
    'test/ops/ci-config.test.mjs',
    'test/ops/client-build-tsx.test.mjs',
    'test/ops/client-layers.test.mjs',
    'test/ops/hermetic-gate.test.mjs',
    'test/ops/release-purity.test.mjs',
    'test/ops/release-readiness.test.mjs',
    'test/ops/test-discovery.test.mjs',
    'test/ops/test-docs.test.mjs',
    'test/ops/test-env-seed.test.mjs',
    'test/ops/test-env.test.mjs',
    'test/ops/test-gates.test.mjs',
    'test/ops/test-typecheck.test.mjs',
    'test/ops/typescript-client-toolchain.test.mjs',
    'test/ops/typescript-toolchain.test.mjs',
  ] },
  host: { budgetMs: 300000, files: [
    'test/docs/doc-external-routes.test.mjs',
    'test/docs/doc-external-tools.test.mjs',
    'test/docs/doc-inline-write-boundaries.test.mjs',
    'test/host/host-audit.test.mjs',
    'test/host/host-tools.test.mjs',
    'test/host/identity-host.test.mjs',
    'test/host/knowledge-parity.test.mjs',
    'test/host/mcp-http.test.mjs',
    'test/host/mcp-knowledge.test.mjs',
    'test/host/mcp-lifecycle.test.mjs',
    'test/host/mcp-write.test.mjs',
    'test/host/mcp-parity.test.mjs',
    'test/host/routes.test.mjs',
  ] },
  perf: { budgetMs: 300000, files: [
    'test/ops/knowledge-performance.test.mjs',
    'test/ops/core-performance.test.mjs',
    'test/ops/project-list-performance.test.mjs',
    'test/ops/prompt-health-isolation.test.mjs',
  ] },
  recovery: { budgetMs: 300000, files: [
    'test/ops/recovery-drill.test.mjs',
  ] },
};

export const offline = ['unit', 'integration', 'cli', 'ops'];
export const hostPreflight = 'test/host/host-preflight.mjs';
export const clientFiles = () => [...suites.unit.files, ...suites.integration.files].filter(file => file.startsWith('test/client/') && !file.endsWith('/client-races.test.mjs'));
export function suiteFiles(name) {
  if (name === 'core' || name === 'ci') return offline.flatMap(layer => suites[layer].files);
  if (name === 'fast') return ['unit', 'integration'].flatMap(layer => suites[layer].files);
  if (name === 'client') return clientFiles();
  if (name === 'unit:client') return clientFiles().filter(file => file.startsWith('test/client/unit/'));
  if (name === 'coverage') return [...Object.values(suites).flatMap(suite => suite.files), hostPreflight];
  if (!suites[name]) throw new Error('Unknown suite: ' + name);
  return [...suites[name].files];
}

export function trackedTests() {
  return execFileSync('git', ['ls-files', '-z', 'test'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(file => file.endsWith('.test.mjs')).sort();
}

export function validateManifest() {
  const wired = Object.values(suites).flatMap(suite => suite.files);
  const tracked = trackedTests();
  const duplicate = wired.filter((file, index) => wired.indexOf(file) !== index);
  const missing = tracked.filter(file => !wired.includes(file));
  const untracked = wired.filter(file => !tracked.includes(file));
  if (duplicate.length || missing.length || untracked.length) {
    throw new Error(JSON.stringify({ duplicate, missing, untracked }));
  }
  return { tracked, wired };
}
