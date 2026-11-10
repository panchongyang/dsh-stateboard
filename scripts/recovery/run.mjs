import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { root, repo, inside } from './harness.mjs';
import { exercise, specifications } from './cases.mjs';

fs.mkdirSync(inside(path.join(root, 'steps')));
fs.mkdirSync(inside(path.join(root, 'cases')));
const started = performance.now();
const results = [];
for (const [name, expected] of specifications) {
  const start = performance.now();
  try {
    const result = await exercise(name);
    results.push({ name, expected, ...result, totalMs: Math.round(performance.now() - start) });
  } catch (error) {
    results.push({ name, expected, status: 'fail', totalMs: Math.round(performance.now() - start),
      actual: error.stack || String(error), issueRequired: 'Parent must create an issue after distinguishing fixture error from production recovery failure' });
  }
  console.log(JSON.stringify(results.at(-1)));
}
const report = { schemaVersion: 1, syntheticOnly: true, root, repo, node: process.version, platform: process.platform,
  createdAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started),
  pass: results.filter((r) => r.status === 'pass').length, fail: results.filter((r) => r.status === 'fail').length,
  skip: 0, results, limitations: [
    'Application-level synthetic fixtures only: not OS sandboxing, power-loss durability, kernel or disk fault simulation.',
    'No DSH/HTTP/UI/service operation; user performs real DSH maintenance manually.',
    'Missing meta restoration uses pre-agreed fixture backup; no automatic missing-meta recovery.',
    'Physical orphan blob retained; no GC, no health enumeration of physical orphans.',
    'Data-loss confirmation applies to synthetic fixture only; real suffix loss needs explicit human RPO approval.',
  ] };
const reportFile = inside(path.join(root, 'report.json'));
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ report: reportFile, pass: report.pass, fail: report.fail, skip: report.skip, durationMs: report.durationMs }));
process.exitCode = report.fail ? 1 : 0;
