#!/usr/bin/env node
/** Shared timed runner. No directory globs: only manifest-wired, Git-tracked tests run. */
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { root, suites, offline, hostPreflight, suiteFiles, validateManifest } from '../test/suite-manifest.mjs';

export function runCommand(args, { name, budgetMs, cwd = root } = {}) {
  if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0) throw new Error('Invalid wall-clock budget');
  const start = performance.now();
  console.log(`[suite:${name}] budget=${budgetMs / 1000}s`);
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd, stdio: 'inherit', windowsHide: true, detached: process.platform !== 'win32' });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`[suite:${name}] TIMEOUT: terminating this runner's child process tree`);
      if (process.platform === 'win32') {
        const killed = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'inherit', windowsHide: true });
        if (killed.status !== 0) child.kill();
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    }, budgetMs);
    child.on('error', error => console.error(error.message));
    child.on('close', code => {
      clearTimeout(timer);
      const elapsed = performance.now() - start;
      const result = timedOut || elapsed > budgetMs ? 124 : (code ?? 1);
      console.log(`[suite:${name}] elapsed=${(elapsed / 1000).toFixed(3)}s budget=${budgetMs / 1000}s exit=${result}`);
      resolve(result);
    });
  });
}

async function runSuite(name) {
  const files = suiteFiles(name);
  const preflight = name === 'host' ? [hostPreflight] : [];
  const budgetMs = suites[name]?.budgetMs ?? 480000;
  const concurrency = name === 'perf' || name === 'recovery' ? 1 : 4;
  return runCommand(['--test', '--test-reporter=tap', `--test-concurrency=${concurrency}`, ...preflight, ...files], { name, budgetMs });
}

export async function main(name) {
  validateManifest();
  if (name === 'core' || name === 'ci' || name === 'fast') {
    const layers = name === 'fast' ? ['unit', 'integration'] : offline;
    for (const layer of layers) {
      const code = await runSuite(layer);
      if (code) return code;
    }
    return 0;
  }
  if (name === 'coverage') {
    // Keep Node's native loaded-project denominator (test files/node_modules excluded by Node).
    // SKIP callbacks are not executed; no invented covered ranges or skip credits.
    const files = suiteFiles('coverage');
    console.log(`[coverage] ${files.length} wired tracked entries; line>=90 branch>=80 functions>=90; SKIP is not covered`);
    return runCommand(['--test', '--test-reporter=tap', '--test-concurrency=1', '--experimental-test-coverage',
      '--test-coverage-lines=90', '--test-coverage-branches=80', '--test-coverage-functions=90', ...files],
    { name, budgetMs: 1800000 });
  }
  return runSuite(name);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).then(code => { process.exitCode = code; }).catch(error => { console.error(error); process.exitCode = 1; });
}
