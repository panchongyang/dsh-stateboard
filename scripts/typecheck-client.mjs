// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Client typecheck uses the same isolated compiler as the backend; the
// browser-specific config is separate so DOM/JSX never leak into lib/*.
const root = path.resolve(import.meta.dirname, '..');
const compiler = path.join(root, 'tools/typescript/node_modules/typescript/bin/tsc');
if (!fs.existsSync(compiler)) {
  console.error('Missing dev-only TypeScript toolchain. Run: npm --prefix tools/typescript ci');
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, [compiler, '--project', path.join(root, 'tsconfig.client.json')], {
    cwd: root, stdio: 'inherit',
  });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
}
