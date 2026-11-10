/**
 * 测试职责：让架构文档的模块路径清单与磁盘文件保持可解析的一致性。
 * 典型流程：读取真实 arch-map 和合成文档 → 展开通配符/解析错误块 → 检查缺失路径列表。
 * 覆盖边界：覆盖 清单去重、路径展开及格式拒绝；不覆盖模块运行行为或依赖分层。
 * 外部前置：无；需要仓库源码与架构文档。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkArchMap,
  expandEntry,
  parseArchMap,
} from '../../scripts/check-architecture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// 责任：读取架构清单后必须无缺失和重复，并保留共享契约、命令、路由及客户端入口。
test('docs/ARCHITECTURE.md arch-map resolves every entry on disk', () => {
  const result = checkArchMap({ root });

  assert.deepEqual(
    result.missing,
    [],
    'module map points at files that no longer exist:\n  - ' + result.missing.join('\n  - '),
  );
  assert.equal(new Set(result.entries).size, result.entries.length, 'arch-map has duplicate entries');
  assert.ok(result.entries.length >= 40, 'arch-map shrank unexpectedly: ' + result.entries.length + ' entries');
  assert.ok(result.entries.includes('lib/shared/contract.js'), 'the shared contract must stay in the map');
  assert.ok(result.entries.includes('lib/core/commands/index.js'), 'the command registry must stay in the map');
  assert.ok(result.entries.includes('lib/host/routes.js'), 'the route dispatcher must stay in the map');
  assert.ok(result.entries.includes('src/client/index.ts'), 'the client entry must stay in the map');
});

// 责任：展开 views 通配符须包含看板模块，无匹配的后缀应得到空数组。
test('arch-map wildcard covers peer modules in a directory', () => {
  const views = expandEntry('src/client/pages/*.tsx', root)
    .map((absolute) => path.relative(root, absolute).split(path.sep).join('/'));

  assert.ok(views.length >= 10, 'expected every view module, got ' + views.length);
  assert.ok(views.includes('src/client/pages/board-page.tsx'));
  assert.deepEqual(expandEntry('src/client/pages/*.nope', root), []);
});

// 责任：移除标记、放入非法目录或同一行多路径时，解析器必须明确拒绝。
test('arch-map parser rejects a malformed block', () => {
  assert.throws(
    () => parseArchMap('no markers here'),
    /arch-map markers not found/,
  );
  assert.throws(
    () => parseArchMap('<!-- arch-map:start -->\nREADME.md\n<!-- arch-map:end -->'),
    /must start with lib\/ or src\//,
  );
  assert.throws(
    () => parseArchMap('<!-- arch-map:start -->\nlib/a.js lib/b.js\n<!-- arch-map:end -->'),
    /one path per line/,
  );
});

// 责任：合成清单含不存在文件时须报告该路径，通配符只返回实际存在模块。
test('a missing path is reported instead of silently accepted', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-arch-map-'));
  try {
    fs.mkdirSync(path.join(temp, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(temp, 'lib', 'present.js'), 'export {};\n');
    fs.mkdirSync(path.join(temp, 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(temp, 'docs', 'ARCHITECTURE.md'),
      '<!-- arch-map:start -->\n'
        + 'lib/present.js\n'
        + 'lib/missing.js\n'
        + 'lib/*.js\n'
        + '<!-- arch-map:end -->\n',
    );

    const result = checkArchMap({ root: temp });
    assert.deepEqual(result.missing, ['lib/missing.js']);
    assert.deepEqual(result.resolved['lib/*.js'], ['lib/present.js']);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
