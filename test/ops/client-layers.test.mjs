/**
 * 测试职责：验证前端分层门禁的 import 方向、唯一 fetch、规模上限、迁移豁免与失败诊断。
 * 典型流程：构造合成前端树 → checkClientLayers → 断言 violations/legacy 与规则。
 * 覆盖边界：覆盖分层规则、字符串/注释/动态 import/JSX/fetch 解析；不覆盖真实构建或浏览器。
 * 外部前置：仅 Node；不需要真实前端依赖、网络或宿主服务。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkClientLayers } from '../../scripts/check-client-layers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'client-layers-'));
  for (const [relative, body] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return root;
}

function withFixture(t, files) {
  const root = fixture(files);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function rules(result) {
  return result.violations.map((violation) => violation.rule);
}

// 责任：合法分层树应通过，legacy 为空。
test('a valid layered tree passes', (t) => {
  const root = withFixture(t, {
    'src/client/api/transport.js': "export async function get() { return fetch('/x'); }\n",
    'src/client/utils/format.js': 'export const fmt = 1;\n',
    'src/client/model/store.js': "import { fmt } from '../utils/format.js';\nexport const s = fmt;\n",
    'src/client/hooks/use-store.js': "import { s } from '../model/store.js';\nexport function useStore() { return s; }\n",
    'src/client/components/card.js': "import React from 'react';\nimport { s } from '../model/store.js';\nexport function Card() { return React.createElement('div', null, s); }\n",
    'src/client/pages/page.js': "import { Card } from '../components/card.js';\nimport { useStore } from '../hooks/use-store.js';\nexport function Page() { return [Card(), useStore()]; }\n",
  });
  const result = checkClientLayers({ root });
  assert.equal(result.ok, true, JSON.stringify(result.violations));
  assert.equal(result.legacy.length, 0);
});

// 责任：根 React/CSS ambient shim 可保留，但任意其他根声明仍不能绕过 strict legacy 门禁。
test('strict mode keeps only the named host React and CSS shims', (t) => {
  const root = withFixture(t, {
    'src/client/react.d.ts': "declare module 'react' { export const Fragment: unknown; }\n",
    'src/client/css.d.ts': "declare module '*.css' { const css: string; export default css; }\n",
    'src/client/other.d.ts': 'declare const other: unknown;\n',
  });
  const result = checkClientLayers({ root, strict: true });
  assert.deepEqual(result.violations.map(({ file, rule }) => ({ file, rule })), [
    { file: 'src/client/other.d.ts', rule: 'legacy' },
  ]);
});

// 责任：components 反向依赖 hooks 应被拒绝。
test('components must not import hooks', (t) => {
  const root = withFixture(t, {
    'src/client/components/x.js': "import { useX } from '../hooks/use-x.js';\nexport function X() { return useX(); }\n",
    'src/client/hooks/use-x.js': 'export function useX() { return 1; }\n',
  });
  const result = checkClientLayers({ root });
  assert.equal(result.ok, false);
  assert.ok(rules(result).includes('cross-layer'));
});

// 责任：非 api/transport 的直接 fetch（含旧 views）应被拒绝。
test('fetch outside api/transport fails, including legacy views', (t) => {
  const root = withFixture(t, {
    'src/client/views/health.js': "export function Health() { return fetch('/health'); }\n",
    'src/client/components/x.js': "export function X() { return fetch('/x'); }\n",
  });
  const result = checkClientLayers({ root });
  assert.equal(result.ok, false);
  assert.equal(rules(result).filter((rule) => rule === 'fetch').length, 2);
});

// 责任：Node 内建与后端层 import 应被拒绝。
test('node builtins and backend imports are rejected', (t) => {
  const root = withFixture(t, {
    'src/client/model/x.js': "import fs from 'node:fs';\nimport path from 'path';\nexport const x = fs.path;\n",
    'src/client/utils/y.js': "import { service } from '../../../lib/core/service.js';\nexport const y = service;\n",
    'lib/core/service.js': 'export const service = 1;\n',
  });
  const result = checkClientLayers({ root });
  assert.equal(result.ok, false);
  const found = rules(result);
  assert.ok(found.includes('node-builtin'));
  assert.ok(found.includes('outside-client'));
});

// 责任：model/utils/api 引入 React 应被拒绝。
test('model/utils/api must not import React', (t) => {
  const root = withFixture(t, {
    'src/client/model/x.js': "import React from 'react';\nexport const x = React;\n",
    'src/client/api/y.js': "import { useState } from 'react';\nexport const y = useState;\n",
  });
  const result = checkClientLayers({ root });
  assert.equal(result.ok, false);
  assert.equal(rules(result).filter((rule) => rule === 'react-layer').length, 2);
});

// 责任：同层循环依赖应被拒绝。
test('same-layer cycles are rejected', (t) => {
  const root = withFixture(t, {
    'src/client/model/a.js': "import { b } from './b.js';\nexport const a = b;\n",
    'src/client/model/b.js': "import { a } from './a.js';\nexport const b = a;\n",
  });
  const result = checkClientLayers({ root });
  assert.equal(result.ok, false);
  assert.ok(rules(result).includes('cycle'));
});

// 责任：分层代码不得依赖旧扁平文件。
test('layered code must not import legacy flat files', (t) => {
  const root = withFixture(t, {
    'src/client/old.js': 'export const old = 1;\n',
    'src/client/pages/p.js': "import { old } from '../old.js';\nexport const p = old;\n",
  });
  const result = checkClientLayers({ root });
  assert.equal(result.ok, false);
  assert.ok(rules(result).includes('layered-to-legacy'));
});

// 责任：migration 模式豁免旧文件，strict 模式不豁免。
test('migration mode exempts legacy files; strict mode does not', (t) => {
  const root = withFixture(t, {
    'src/client/index.ts': 'export const entry = 1;\n',
    'src/client/styles.ts': 'export const styles = 1;\n',
    'src/client/old.js': "import { v } from './views/v.js';\nexport const old = v;\n",
    'src/client/views/v.js': 'export const v = 1;\n',
  });
  const migration = checkClientLayers({ root });
  assert.equal(migration.ok, true, JSON.stringify(migration.violations));
  assert.equal(migration.legacy.length, 4);

  const strict = checkClientLayers({ root, strict: true });
  assert.equal(strict.ok, false);
  assert.equal(rules(strict).filter((rule) => rule === 'legacy').length, 2);
});

// 责任：超长文件与未允许的包应被拒绝。
test('oversized files and unexpected packages are rejected', (t) => {
  const oversized = Array.from({ length: 451 }, (_, index) => `export const v${index} = ${index};`).join('\n') + '\n';
  const root = withFixture(t, {
    'src/client/utils/big.js': oversized,
    'src/client/components/x.js': "import lodash from 'lodash';\nexport const x = lodash;\n",
  });
  const result = checkClientLayers({ root });
  assert.equal(result.ok, false);
  const found = rules(result);
  assert.ok(found.includes('size'));
  assert.ok(found.includes('external'));
});

// 责任：字符串/注释不能隐藏或伪造 import。
test('strings and comments cannot hide or fake imports', (t) => {
  const root = withFixture(t, {
    'src/client/model/x.js': [
      'const url = "https://example.test";',
      "const fake = \"import fs from 'node:fs'\";",
      '/* one',
      'two',
      'three */',
      "import fs from 'node:fs';",
      'export const x = [url, fake, fs];',
    ].join('\n') + '\n',
  });
  const result = checkClientLayers({ root });
  assert.equal(result.ok, false);
  const node = result.violations.filter((violation) => violation.rule === 'node-builtin');
  assert.equal(node.length, 1);
  assert.equal(node[0].line, 6);
});

// 责任：字符串/正则不能伪造 fetch 调用。
test('strings and regexes cannot fake fetch calls', (t) => {
  const root = withFixture(t, {
    'src/client/utils/x.js': [
      'const a = "fetch(\'/x\')";',
      'const re = /fetch\\(/;',
      'export const x = [a, re];',
    ].join('\n') + '\n',
  });
  const result = checkClientLayers({ root });
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

// 责任：计算属性访问的 fetch 仍应被识别。
test('computed fetch is still fetch', (t) => {
  const root = withFixture(t, {
    'src/client/components/x.js': "export function X() { return globalThis[\"fetch\"]('/x'); }\n",
  });
  const result = checkClientLayers({ root });
  assert.equal(result.ok, false);
  assert.ok(rules(result).includes('fetch'));
});

// 责任：模板字面量动态 import 需解析并检查分层。
test('dynamic import with a template literal resolves and checks layers', (t) => {
  const root = withFixture(t, {
    'src/client/components/x.js': "export async function X() { return import(`../hooks/use-x.ts`); }\n",
    'src/client/hooks/use-x.ts': 'export const useX = 1;\n',
  });
  const result = checkClientLayers({ root });
  assert.equal(result.ok, false);
  assert.ok(rules(result).includes('cross-layer'));
});

// 责任：strict 仅允许根 index/styles，不允许 views/index.js。
test('strict keeps only root index/styles, not views/index.js', (t) => {
  const root = withFixture(t, {
    'src/client/index.ts': 'export const entry = 1;\n',
    'src/client/styles.ts': 'export const styles = 1;\n',
    'src/client/views/index.js': 'export const view = 1;\n',
  });
  const strict = checkClientLayers({ root, strict: true });
  assert.equal(strict.ok, false);
  const legacy = strict.violations.filter((violation) => violation.rule === 'legacy');
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].file, 'src/client/views/index.js');
});

// 责任：旧文件动态 import Node 内建仍应被拒绝。
test('legacy dynamic import of a Node builtin is still rejected', (t) => {
  const root = withFixture(t, {
    'src/client/views/x.js': "export async function X() { return import(`node:fs`); }\n",
  });
  const result = checkClientLayers({ root });
  assert.equal(result.ok, false);
  assert.ok(rules(result).includes('node-builtin'));
});

// 责任：模板表达式应按代码扫描。
test('template expressions are scanned as code', (t) => {
  const root = withFixture(t, {
    'src/client/utils/x.js': [
      'const a = `result: ${fetch("/x")}`;',
      'const b = `${import("node:fs")}`;',
      'export const x = [a, b];',
    ].join('\n') + '\n',
  });
  const result = checkClientLayers({ root });
  assert.equal(result.ok, false);
  const found = rules(result);
  assert.ok(found.includes('fetch'));
  assert.ok(found.includes('node-builtin'));
});

// 责任：非字面量动态 import 应失败关闭。
test('non-literal dynamic imports fail closed', (t) => {
  const root = withFixture(t, {
    'src/client/model/x.js': 'const moduleName = "node:fs";\nexport const x = import(moduleName);\n',
  });
  const result = checkClientLayers({ root });
  assert.equal(result.ok, false);
  assert.ok(rules(result).includes('non-literal-import'));
});

// 责任：JSX 文本不是代码，不能掩盖后续 import。
test('JSX text is not code and does not hide later imports', (t) => {
  const root = withFixture(t, {
    'src/client/components/x.tsx': [
      'const X = () => <div>Don\'t fetch content</div>;',
      'const Y = () => <div>fetch(something)</div>;',
      "import fs from 'node:fs';",
      'export const Z = [X, Y, fs];',
    ].join('\n') + '\n',
  });
  const result = checkClientLayers({ root });
  assert.equal(result.ok, false);
  const found = rules(result);
  assert.ok(found.includes('node-builtin'));
  assert.equal(found.filter((rule) => rule === 'fetch').length, 0);
});

// 责任：import type 节点也应计入分层依赖。
test('import type nodes are layer dependencies', (t) => {
  const root = withFixture(t, {
    'src/client/utils/x.ts': 'export type T = import("node:fs").PathLike;\n',
    'src/client/model/y.ts': 'export type R = import("react").ReactNode;\n',
  });
  const result = checkClientLayers({ root });
  assert.equal(result.ok, false);
  const found = rules(result);
  assert.ok(found.includes('node-builtin'));
  assert.ok(found.includes('react-layer'));
});

// 责任：括号或类型断言包裹的 fetch 仍应被识别。
test('parenthesized and asserted fetch is still fetch', (t) => {
  const root = withFixture(t, {
    'src/client/components/x.ts': [
      'export const a = (fetch)("/a");',
      'export const b = (globalThis.fetch)("/b");',
      'export const c = (fetch as any)("/c");',
    ].join('\n') + '\n',
  });
  const result = checkClientLayers({ root });
  assert.equal(result.ok, false);
  assert.equal(rules(result).filter((rule) => rule === 'fetch').length, 3);
});

// 责任：当前仓库在 strict 模式下必须 0 violation，作为 S3 收口回归。
test('the current repository passes strict closeout', () => {
  const result = checkClientLayers({ root: repoRoot, strict: true });
  assert.equal(result.ok, true, JSON.stringify(result.violations.slice(0, 5)));
  assert.ok(result.files >= 40);
});
