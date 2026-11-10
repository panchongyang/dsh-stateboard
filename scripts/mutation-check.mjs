#!/usr/bin/env node
// Re-applies the seven mutants that survived the first audit pass and reports
// whether the test suite now kills each of them. Runs on a throwaway copy, so
// the working tree is never touched. Exit code 1 if any mutant escapes.
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

const MUTANTS = [
  {
    name: 'commit hash unchecked',
    file: 'lib/core/store/format.js',
    from: "if (commitHash(commit) !== commit.hash) fail('hash-mismatch', 'bad commit hash');",
    to: '// commit hash validation disabled',
  },
  {
    name: 'seq continuity unchecked',
    file: 'lib/core/store/format.js',
    from: "if (commit.seq !== validSeq + 1) fail('seq-mismatch', 'non-contiguous seq ' + commit.seq);",
    to: '// seq continuity validation disabled',
  },
  {
    name: 'prev chain unchecked',
    file: 'lib/core/store/format.js',
    from: "if (commit.prev !== validHash) fail('prev-mismatch', 'broken prev hash');",
    to: '// prev chain validation disabled',
  },
  {
    name: 'fencing token unchecked',
    file: 'lib/core/lease.js',
    from: 'if (requireToken && Number.isInteger(cmd.fencingToken) && cmd.fencingToken !== lease.token) {',
    to: 'if (false) {',
  },
  {
    name: 'lease owner unchecked',
    file: 'lib/core/lease.js',
    from: 'if (actor.sessionId !== lease.sessionId) {',
    to: 'if (false) {',
  },
  {
    name: 'evidence path containment unchecked',
    file: 'lib/core/evidence.js',
    from: 'if (!isInside(handle.workspacePath, absolute)) throw',
    to: 'if (false) throw',
  },
  {
    name: 'leases never expire',
    file: 'lib/core/lease.js',
    from: 'export function isLeaseReclaimable(handle, lease, now = nowMs(handle)) {',
    to: 'export function isLeaseReclaimable(handle, lease, now = nowMs(handle)) { return false;',
  },
];

// Manual copy: fs.cpSync terminates this Node build on Windows (exit 127) while
// copying lib/, and copyFileSync per file is fine.
function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else if (entry.isFile()) copyFileSync(src, dst);
  }
}

function stage() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pb-mutant-'));
  for (const entry of ['lib', 'test']) copyTree(path.join(root, entry), path.join(dir, entry));
  copyFileSync(path.join(root, 'package.json'), path.join(dir, 'package.json'));
  return dir;
}

const CORE_FILES = ['test/core/task-lifecycle.test.mjs', 'test/core/plan-lifecycle.test.mjs', 'test/core/store-integrity.test.mjs', 'test/core/lease-edit.test.mjs'];
const EXPECTED_FAILURES = [
  'a tampered payload is caught by the commit hash',
  'a duplicated seq is caught even when every hash is rebuilt',
  'a prev hash that skips a commit is caught even when every hash is rebuilt',
  'a stale fencing token cannot begin the task',
  'a different session cannot use the owner token',
  'evidence outside the workspace is rejected before it is hashed',
  'a lease left behind by a dead session expires and releases the task',
];
function runCore(dir) {
  return spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...CORE_FILES], {
    cwd: dir, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  });
}

// A missing import or broken candidate must never masquerade as a killed mutant.
const baseline = stage();
try {
  const run = runCore(baseline);
  if (run.status !== 0 || !/^# tests 70$/m.test(run.stdout || '')) {
    console.error('preflight failed: the unmodified four core suites must pass all 70 tests');
    console.error(run.stdout, run.stderr, run.error || '');
    process.exitCode = 1;
  }
} finally {
  rmSync(baseline, { recursive: true, force: true });
}
if (process.exitCode) process.exit(process.exitCode);
console.log('preflight: 70/70 tests passed across ' + CORE_FILES.join(', '));

const rows = [];
let missed = 0;
for (const mutant of MUTANTS) {
  const dir = stage();
  try {
    const target = path.join(dir, mutant.file);
    const source = readFileSync(target, 'utf8');
    if (!source.includes(mutant.from)) {
      rows.push([mutant.name, 'PATTERN MISSING', 'the guarded line moved; update scripts/mutation-check.mjs']);
      missed += 1;
      continue;
    }
    writeFileSync(target, source.replace(mutant.from, mutant.to));
    const run = runCore(dir);
    const assertions = [...(run.stdout || '').matchAll(/^not ok \d+ - (.+)\r?\n([\s\S]*?)(?=^# Subtest:|^1\.\.|$(?![\s\S]))/gm)]
      .filter((match) => /code: ['"]?ERR_ASSERTION/.test(match[2]));
    const failed = assertions.map((match) => match[1]);
    const expected = EXPECTED_FAILURES[MUTANTS.indexOf(mutant)];
    const caught = run.status === 1 && !run.error && failed.includes(expected);
    if (!caught) missed += 1;
    else console.log('# ' + mutant.name + '\n' + assertions.find((match) => match[1] === expected)[0].trim());
    const file = CORE_FILES[mutant.file.includes('store/') ? 2 : 3];
    rows.push([mutant.name, caught ? 'caught' : 'ESCAPED', mutant.file + ' → ' + file + ': ' + (failed.join(' | ') || 'no assertion failure')]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const width = Math.max(...rows.map((row) => row[0].length));
for (const [name, verdict, detail] of rows) {
  console.log(name.padEnd(width) + '  ' + verdict.padEnd(14) + '  ' + detail);
}
console.log('');
console.log('mutants caught: ' + (MUTANTS.length - missed) + '/' + MUTANTS.length);
process.exit(missed === 0 ? 0 : 1);
