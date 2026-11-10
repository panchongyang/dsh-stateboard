/**
 * 测试职责：验证客户端 TS 配置、classic JSX、DOM/Node 边界与 noEmit 类型检查。
 * 典型流程：合成 .ts/.tsx fixture + tsconfig → tsc/typecheck-client → 断言状态与诊断。
 * 覆盖边界：覆盖客户端配置和类型边界；不覆盖真实浏览器或生产迁移。
 * 外部前置：需要 Node 与 tools/typescript 依赖；不需要网络或宿主服务。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tsc = path.join(repoRoot, 'tools', 'typescript', 'node_modules', 'typescript', 'bin', 'tsc');
const clientConfig = path.join(repoRoot, 'tsconfig.client.json').replace(/\\/g, '/');

const reactShim = `
// Classic JSX needs an intrinsic element shape when noImplicitAny is enabled.
declare namespace JSX { interface IntrinsicElements { div: { children?: unknown } } }
declare module 'react' {
  export function createElement(type: string, props?: Record<string, unknown> | null, ...children: unknown[]): unknown;
  export function createElement<P extends Record<string, unknown>>(type: (props: P) => unknown, props: P, ...children: unknown[]): unknown;
  const React: { createElement: typeof createElement; Fragment: unknown };
  export default React;
}
`;

function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'client-types-'));
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    extends: clientConfig,
    include: ['./**/*.ts', './**/*.tsx'],
  }, null, 2));
  return root;
}

// 责任：客户端 tsconfig 保留 DOM、classic JSX、noEmit 与 TS include。
test('client config keeps DOM, classic JSX, noEmit and TS includes', () => {
  const config = JSON.parse(fs.readFileSync(clientConfig, 'utf8'));
  assert.equal(config.compilerOptions.noEmit, true);
  assert.equal(config.compilerOptions.strict, true);
  assert.equal(config.compilerOptions.allowJs, false);
  assert.deepEqual(config.compilerOptions.types, []);
  assert.equal(config.compilerOptions.jsx, 'react');
  assert.equal(config.compilerOptions.jsxFactory, 'React.createElement');
  assert.ok(config.compilerOptions.lib.includes('DOM'));
  assert.ok(config.include.includes('src/client/**/*.ts'));
  assert.ok(config.include.includes('src/client/**/*.tsx'));
});

function run(root) {
  const result = spawnSync(process.execPath, [tsc, '--project', path.join(root, 'tsconfig.json')], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  });
  return { status: result.status, output: (result.stdout || '') + (result.stderr || '') };
}

// 责任：DOM 与 classic JSX 正例应通过类型检查。
test('DOM and classic JSX typecheck cleanly', (t) => {
  const root = project({
    'react.d.ts': reactShim,
    'dom.ts': "export const el = document.createElement('div');\n",
    'jsx.tsx': [
      "import React from 'react';",
      'interface Props { count: number }',
      'export function Card(props: Props) { return <div>{props.count}</div>; }',
      'export const view = <Card count={1} />;',
    ].join('\n') + '\n',
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = run(root);
  assert.equal(result.status, 0, result.output);
  const emitted = fs.readdirSync(root).filter((name) => name.endsWith('.js'));
  assert.deepEqual(emitted, [], 'no emit');
});

// 责任：客户端配置应拒绝 Node 内建模块。
test('Node builtins are rejected by the client config', (t) => {
  const root = project({
    'node.ts': "import fs from 'node:fs';\nexport const x = fs;\n",
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /node:fs|Cannot find module/);
});

// 责任：JSX props 错误反例应被类型检查拒绝。
test('JSX prop mismatches are rejected', (t) => {
  const root = project({
    'react.d.ts': reactShim,
    'jsx.tsx': [
      "import React from 'react';",
      'interface Props { count: number }',
      'export function Card(props: Props) { return <div>{props.count}</div>; }',
    ].join('\n') + '\n',
    'bad.tsx': [
      "import React from 'react';",
      "import { Card } from './jsx.tsx';",
      'export const bad = <Card count="x" />;',
    ].join('\n') + '\n',
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /bad\.tsx.*TS2322|not assignable to type 'number'/);
});

// 责任：当前客户端树应通过 npm run typecheck:client。
test('the current client tree passes npm run typecheck:client', () => {
  const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'typecheck-client.mjs')], {
    cwd: repoRoot, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, (result.stdout || '') + (result.stderr || ''));
});
