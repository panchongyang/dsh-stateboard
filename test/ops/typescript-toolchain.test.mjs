/**
 * 测试职责：保证隔离 TypeScript 工具链支持后端 JS/TS 共存并隔离浏览器和 Node 类型。
 * 典型流程：加载 tools/typescript 编译器 → 真配置及临时 TS/JS 正反例 → 比较诊断、退出码和无产物。
 * 覆盖边界：覆盖 noEmit、类型错误门禁、DOM/Node 隔离与 CI 接线；不覆盖全库严格类型化或业务运行。
 * 外部前置：需要安装 tools/typescript 的 TypeScript 与 @types/node；不增加运行时依赖。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { suiteFiles } from '../suite-manifest.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const require = createRequire(path.join(root, 'tools/typescript/package.json'));
const ts = require('typescript');
const compiler = require.resolve('typescript/bin/tsc');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-types-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function diagnostics(config) {
  const input = ts.readConfigFile(config, ts.sys.readFile);
  assert.equal(input.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(input.config, ts.sys, path.dirname(config));
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  return { parsed, errors: [...parsed.errors, ...ts.getPreEmitDiagnostics(program)] };
}

function run(config) {
  return spawnSync(process.execPath, [compiler, '-p', config, '--pretty', 'false'], {
    cwd: root, encoding: 'utf8',
  });
}

// 责任：后端真实 JS 试点配置须无诊断、noEmit 且排除客户端，公开 typecheck 命令须 exit 0。
test('backend command checks its real JS pilot without emitting or including the client', () => {
  const config = path.join(root, 'tsconfig.backend.json');
  const { parsed, errors } = diagnostics(config);
  assert.deepEqual(errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')), []);
  assert.ok(parsed.fileNames.some((name) => name.endsWith('/scripts/typecheck.mjs')));
  for (const layer of ['core', 'host', 'shared']) {
    assert.ok(parsed.fileNames.some((name) => name.includes('/lib/' + layer + '/')));
  }
  assert.ok(parsed.fileNames.every((name) => !name.includes('/src/client/') && !name.endsWith('/lib/client.js')));
  assert.equal(parsed.options.noEmit, true);
  assert.equal(parsed.options.allowJs, true);
  assert.equal(parsed.options.checkJs, false);
  assert.equal(parsed.options.strict, false);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/typecheck.mjs')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

// 责任：后端 include 须发现新增 TS 并允许 any/旧 JS 共存，但错误 number 赋值须 TS2322 且不产物。
test('backend include discovers new TS, accepts explicit any and JS coexistence, rejects type errors', (t) => {
  const dir = fixture(t);
  const backend = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.backend.json'), 'utf8'));
  fs.copyFileSync(path.join(root, 'tsconfig.base.json'), path.join(dir, 'tsconfig.base.json'));
  // Only relocate dependency lookup; preserve the actual backend include and rules.
  backend.compilerOptions.typeRoots = [path.join(root, 'tools/typescript/node_modules/@types')];
  const config = path.join(dir, 'tsconfig.backend.json');
  fs.writeFileSync(config, JSON.stringify(backend));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  const host = path.join(dir, 'lib/host');
  fs.mkdirSync(host, { recursive: true });
  fs.writeFileSync(path.join(host, 'legacy.js'), '/** @type {number} */\nexport const legacy = "unchecked JS";\n');
  const pilot = path.join(host, 'pilot.ts');
  fs.writeFileSync(pilot, 'import { legacy } from "./legacy.js";\nimport { basename } from "node:path";\nconst flexible: any = legacy;\nexport const name: string = basename(flexible);\n');
  let result = run(config);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(fs.readdirSync(host).sort(), ['legacy.js', 'pilot.ts'], 'no emitted JS or declarations');
  fs.writeFileSync(pilot, 'export const broken: number = "wrong";\n');
  result = run(config);
  assert.equal(result.status, 2, result.stderr + result.stdout);
  assert.match(result.stdout, /TS2322/);
});

// 责任：浏览器继承基础配置后可用 DOM/JSX，但 process 和 node:fs 不得因已安装 Node types 偷漏进来。
test('browser independently extends base with DOM/Bundler/JSX and no ambient Node globals', (t) => {
  const dir = fixture(t);
  const base = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.base.json'), 'utf8'));
  for (const key of ['module', 'moduleResolution', 'typeRoots', 'jsx']) assert.equal(base.compilerOptions[key], undefined);
  assert.equal(base.include, undefined);
  assert.deepEqual(base.compilerOptions.types, []);
  assert.deepEqual(base.compilerOptions.lib, ['ES2022']);
  const config = path.join(dir, 'tsconfig.json');
  fs.writeFileSync(config, JSON.stringify({
    extends: path.join(root, 'tsconfig.base.json'),
    compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler', lib: ['ES2022', 'DOM'], jsx: 'preserve',
      typeRoots: [path.join(root, 'tools/typescript/node_modules/@types')] },
    include: ['browser.tsx'],
  }));
  const browser = path.join(dir, 'browser.tsx');
  fs.writeFileSync(browser, 'export const label: string = document.title;\nconst loose: any = window;\n');
  assert.deepEqual(diagnostics(config).errors, []);
  fs.writeFileSync(browser, 'export const accidental = process.cwd();\nimport fs from "node:fs";\n');
  const codes = diagnostics(config).errors.map((error) => error.code);
  assert.ok(codes.includes(2591), 'Node process must not leak through installed @types/node');
  assert.ok(codes.includes(2307), 'Node built-ins must not resolve without opting into Node types');
});

// 责任：默认测试和 CI 必须接隔离类型工具链，产品运行时依赖不得因此增加。
test('default tests and CI wire the isolated toolchain without adding runtime dependencies', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(suiteFiles('core').includes('test/ops/typescript-toolchain.test.mjs'));
  assert.equal(pkg.scripts.typecheck, 'node scripts/typecheck.mjs');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /npm --prefix tools\/typescript ci/);
  assert.match(ci, /npm run typecheck/);
});
