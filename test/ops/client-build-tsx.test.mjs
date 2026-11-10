/**
 * 测试职责：验证 build-client 对 .tsx 入口与 source map 换行的打包契约。
 * 典型流程：调用真实 build-client 打包 fixture → 检查 bundle、external、sourcemap 与参数拒绝。
 * 覆盖边界：覆盖单 bundle、classic JSX、无 jsx-runtime、参数拒绝与 CRLF；不覆盖发布。
 * 外部前置：需要 Node 与 tools/build 依赖；不需要网络或宿主服务。
 */
// The real build script must accept a .tsx entry and keep the single-bundle
// contract: only react is external, JSX is classic, no jsx-runtime.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// 责任：.tsx 入口应打成单 bundle、classic JSX 且无 jsx-runtime。
test('build-client bundles a .tsx entry without jsx-runtime', (t) => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-tsx-build-'));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  const outfile = path.join(outputDir, 'fixture-bundle.js');
  const result = spawnSync(process.execPath, [
    path.join(repoRoot, 'scripts', 'build-client.mjs'),
    '--entry', path.join('test', 'fixtures', 'client-tsx', 'entry.tsx'),
    '--outfile', outfile,
  ], { cwd: repoRoot, encoding: 'utf8', windowsHide: true });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(fs.readdirSync(outputDir).sort(), ['fixture-bundle.js', 'fixture-bundle.js.map']);
  const bundle = fs.readFileSync(outfile, 'utf8');
  assert.equal(bundle.includes('react/jsx-runtime'), false, 'no automatic runtime');
  const requires = [...bundle.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(requires)], ['react'], 'only react is external');
  assert.match(bundle, /createElement/, 'classic JSX transform');
  assert.match(bundle, /window\.__ModuleLoader__\.load/, 'UMD loader shell preserved');
  assert.match(bundle, /fixture-card/, 'component output is present');
  assert.match(bundle, /1 item|items/, 'typed .ts logic is bundled');
});

// 责任：只给 --entry 应拒绝且不覆盖 production bundle。
test('build-client refuses a lone --entry instead of overwriting production', () => {
  const production = path.join(repoRoot, 'lib', 'client.js');
  const before = fs.readFileSync(production, 'utf8');
  const result = spawnSync(process.execPath, [
    path.join(repoRoot, 'scripts', 'build-client.mjs'),
    '--entry', path.join('test', 'fixtures', 'client-tsx', 'entry.tsx'),
  ], { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /used together|needs a value/);
  assert.equal(fs.readFileSync(production, 'utf8'), before, 'production bundle untouched');
});

// 责任：source map 应归一化 CRLF 但保留字面 \r。
test('source map normalizes CRLF but preserves a literal backslash-r', (t) => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-map-'));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  const entry = path.join(outputDir, 'entry.js');
  const source = 'export const a = 1; // \\r\r\nexport const b = 2;\r\n';
  fs.writeFileSync(entry, source);
  const outfile = path.join(outputDir, 'bundle.js');
  const result = spawnSync(process.execPath, [
    path.join(repoRoot, 'scripts', 'build-client.mjs'),
    '--entry', entry,
    '--outfile', outfile,
  ], { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const map = JSON.parse(fs.readFileSync(outfile + '.map', 'utf8'));
  const embedded = map.sourcesContent[0];
  assert.equal(embedded, 'export const a = 1; // \\r\nexport const b = 2;\n');
});
