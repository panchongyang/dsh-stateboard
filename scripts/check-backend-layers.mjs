#!/usr/bin/env node
/**
 * Backend six-layer gate (entry point).
 *
 * The implementation is split by responsibility under scripts/backend-layers/:
 *   config.mjs       layers, direction matrix, capability names, script policy
 *   ast.mjs          TypeScript parsing and AST helpers
 *   capabilities.mjs receiver/ref classification (app.command vs service/handle)
 *   lib-rules.mjs    import, state, publish, write, query, clock rules
 *   script-rules.mjs maintenance CLI modes, gates and private-write rules
 *   report.mjs       orchestration and output
 *
 * Usage:
 *   node scripts/check-backend-layers.mjs
 *   node scripts/check-backend-layers.mjs --json
 *   node scripts/check-backend-layers.mjs --root <repo>
 *
 * Exit codes: 0 = no violation, 1 = violations or toolchain/parse error.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPO_ROOT, RULES, SCRIPT_MODULES, SCRIPT_POLICY, checkBackendLayers, layerOf, printHuman,
} from './backend-layers/report.mjs';

export { REPO_ROOT, RULES, SCRIPT_MODULES, SCRIPT_POLICY, checkBackendLayers, layerOf };

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: node scripts/check-backend-layers.mjs [--json] [--root <repo>]');
    return 0;
  }
  const rootIndex = argv.indexOf('--root');
  const root = rootIndex === -1 ? REPO_ROOT : path.resolve(argv[rootIndex + 1] || '');
  let result;
  try {
    result = checkBackendLayers({ root });
  } catch (error) {
    console.error('[backend-layers] ' + (error && error.message ? error.message : String(error)));
    return 1;
  }
  if (argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
