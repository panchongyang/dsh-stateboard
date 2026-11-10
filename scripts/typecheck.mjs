// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// 开发工具独立解析，不依赖全局 tsc，也不触碰根目录的宿主 junction。
const root = path.resolve(import.meta.dirname, '..');
const compiler = path.join(root, 'tools/typescript/node_modules/typescript/bin/tsc');
if (!fs.existsSync(compiler)) {
  console.error('Missing dev-only TypeScript toolchain. Run: npm --prefix tools/typescript ci');
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, [compiler, '--project', path.join(root, 'tsconfig.backend.json')], {
    cwd: root, stdio: 'inherit',
  });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
}
