#!/usr/bin/env node
// Real-store compatibility gate.
//
// Copies every project under the board store root to a temp directory, opens the
// copies with the current code, and reports what the replay produced. The real
// store is never opened: the only guarantee we can make about "read-only" that
// survives implicit writes (locks, heartbeats, snapshots) is "we never point at
// it". Data files are hashed before/after to prove nothing changed.
//
// Modes:
//   default     open + invariants + compare against a local baseline
//   --baseline  override the ignored default at test/fixtures/stores-baseline.json
//   --update    create or replace the baseline from the selected isolated sample
//   --gate      open + invariants only, no baseline (safe for CI when no store exists)
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectService } from '../lib/core/service.js';
import { JsonlStore } from '../lib/core/store.js';
import { canonicalKey, isInside, writeJson } from '../lib/core/util.js';
import { eventClass } from '../lib/shared/events.js';

export const DEFAULT_ROOT = path.join(os.homedir(), '.dsh', 'project-board', 'projects');
const DATA_FILE = /^(meta\.json|commits\.jsonl|blobs[\\/].+)$/;

export function isDataFile(rel) {
  const name = String(rel).replace(/\\/g, '/');
  return DATA_FILE.test(process.platform === 'win32' ? name.toLowerCase() : name);
}

/** SHA-256 of data files relative to one project. Operational files are excluded. */
export function hashTree(root) {
  const out = {};
  const walk = (dir, base) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = base ? base + '/' + entry.name : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile() && isDataFile(rel)) {
        out[rel] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
      }
    }
  };
  walk(root, '');
  return out;
}

/** Hash the projects collection while preserving each project's identity. */
export function hashStore(root) {
  const hashes = {};
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const files = hashTree(path.join(root, entry.name));
    for (const [file, hash] of Object.entries(files)) hashes[entry.name + '/' + file] = hash;
  }
  return hashes;
}

export function sameHashes(before, after) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changed = keys.filter((key) => before[key] !== after[key]);
  return { same: changed.length === 0, changed: changed.slice(0, 5) };
}

function countEvents(commits) {
  const counts = { taskCreated: 0, docCreated: 0, events: { applied: 0, additive: 0 } };
  for (const commit of commits) {
    for (const event of commit.events) {
      counts.events[eventClass(event.type)] += 1;
      if (event.type === 'task/created') counts.taskCreated += 1;
      // Migration preserves an existing docId; only registration creates another.
      else if (event.type === 'doc/created' || event.type === 'doc/external-registered') counts.docCreated += 1;
    }
  }
  return counts;
}

/** Log-derived oracle: every created entity must still be present after replay. */
export function invariantProblems(id, row) {
  const problems = [];
  if (row.tasks !== row.taskCreated) problems.push(id + ': tasks=' + row.tasks + ' but task/created=' + row.taskCreated);
  if (row.docs !== row.docCreated) problems.push(id + ': docs=' + row.docs + ' but doc/created=' + row.docCreated);
  return problems;
}

export function compareReports(expected, actual) {
  const problems = [];
  const expectedProjects = (expected && expected.projects) || {};
  const actualProjects = actual || {};
  for (const id of Object.keys(expectedProjects).sort()) {
    if (!actualProjects[id]) problems.push(id + ': project missing from replay');
  }
  for (const id of Object.keys(actualProjects).sort()) {
    const want = expectedProjects[id];
    if (!want) {
      problems.push(id + ': new project (run --update to accept)');
      continue;
    }
    for (const field of ['tasks', 'docs', 'review', 'plans', 'warnings']) {
      if (want[field] !== actualProjects[id][field]) {
        problems.push(id + ': ' + field + ' ' + want[field] + ' -> ' + actualProjects[id][field]);
      }
    }
  }
  return problems;
}

function copyStore(root, projectsDir) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('store link refused: ' + entry.name);
    if (!entry.isDirectory()) continue;
    const from = path.join(root, entry.name);
    const to = path.join(projectsDir, entry.name);
    fs.cpSync(from, to, {
      recursive: true,
      filter(source) {
        const rel = path.relative(from, source);
        if (fs.lstatSync(source).isSymbolicLink()) throw new Error('store link refused: ' + path.join(entry.name, rel));
        // A copied lock would look like a live owner; the copy is ours to open.
        const name = process.platform === 'win32' ? rel.toLowerCase() : rel;
        return name !== 'lock.json' && name !== 'lock.json.claim' && !name.startsWith('lock.json.hb');
      },
    });
  }
}

function replayProblem(id, error) {
  const hint = error?.code === 'incompatible-event' ? error.details?.hint : null;
  return id + ': open failed: ' + (error?.code ? error.code + ': ' : '') + error?.message
    + (hint ? ' — ' + hint : '');
}

class ReplayStore extends JsonlStore {
  open() {
    const data = super.open();
    // ProjectService recovers the copy after open and can append new events.
    this.sourceCommitCount = data.commits.length;
    return data;
  }
}

export async function scan(projectsDir) {
  const report = {};
  const problems = [];
  const ids = fs.readdirSync(projectsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const svc = new ProjectService({
    rootDir: path.dirname(projectsDir),
    storeFactory: (dir, meta) => new ReplayStore(dir, meta),
  });
  await svc.init();
  try {
    for (const id of ids) {
      if (!svc.metas.has(id)) {
        problems.push(id + ': missing or invalid project metadata');
        continue;
      }
      let handle;
      try {
        handle = await svc.open(id);
        if (handle.readOnly) {
          problems.push(id + ': store copy unexpectedly opened read-only');
          continue;
        }
        // A shared writer is already open, so this scan did not recover it.
        const sourceCommits = handle.store.commits.slice(0, handle.store.sourceCommitCount);
        if (sourceCommits.length === 0) {
          problems.push(id + ': no log commits to validate');
          continue;
        }
        // The store validates the full commit array, including snapshot-covered events.
        const counts = countEvents(sourceCommits);
        if (counts.events.applied + counts.events.additive === 0) {
          problems.push(id + ': no source events to validate');
          continue;
        }
        const tasks = Object.values(handle.state.tasks);
        const row = {
          tasks: tasks.length,
          docs: Object.keys(handle.state.docs).length,
          review: tasks.filter((task) => task.state === 'review').length,
          plans: Object.keys(handle.state.planHeads || {}).length,
          warnings: handle.health().warnings.length,
          ...counts,
        };
        problems.push(...invariantProblems(id, row));
        report[id] = row;
      } catch (error) {
        problems.push(replayProblem(id, error));
      } finally {
        await handle?.close();
      }
    }
  } finally {
    await svc.close();
  }
  return { report, problems };
}

export function parseArgs(argv) {
  const args = { root: null, baseline: null, update: false, gate: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [option, inline] = arg.split(/=(.*)/s, 2);
    if (option === '--root' || option === '--baseline') {
      const value = inline ?? argv[++i];
      if (!value || value.startsWith('--')) throw new Error(option + ' requires a path');
      args[option.slice(2)] = value;
    } else if (arg === '--update') args.update = true;
    else if (arg === '--gate') args.gate = true;
    else if (arg === '--json') args.json = true;
    else throw new Error('unexpected store replay argument');
  }
  return args;
}

function printHuman(report) {
  for (const id of Object.keys(report).sort()) {
    const row = report[id];
    console.log(id + ' tasks=' + row.tasks + ' docs=' + row.docs + ' review=' + row.review + ' plans=' + row.plans + ' warnings=' + row.warnings
      + ' applied=' + row.events.applied + ' additive=' + row.events.additive);
  }
}

/** Resolve existing ancestors so a missing baseline under a junction cannot alias source data. */
function baselineTarget(file) {
  if (fs.lstatSync(file, { throwIfNoEntry: false })) return canonicalKey(fs.realpathSync(file));
  const parent = path.dirname(file);
  if (parent === file) throw new Error('baseline path has no accessible ancestor');
  return path.join(baselineTarget(parent), path.basename(file));
}

export async function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  let args;
  try { args = parseArgs(argv); }
  catch (error) {
    console.error('FAIL ' + error.message);
    return 1;
  }
  const root = path.resolve(cwd, args.root || DEFAULT_ROOT);
  const baselinePath = path.resolve(cwd, args.baseline || path.join('test', 'fixtures', 'stores-baseline.json'));
  if (!fs.existsSync(root)) {
    if (args.gate && !args.root) {
      console.log('SKIP no store root at ' + root);
      return 0;
    }
    console.error('FAIL store root not found: ' + root);
    return 1;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-stores-'));
  const projectsDir = path.join(tmp, 'projects');
  fs.mkdirSync(projectsDir);
  try {
    if (!fs.lstatSync(root).isDirectory()) throw new Error('store root must be a physical directory');
    const before = hashStore(root);
    copyStore(root, projectsDir);
    const { report, problems } = await scan(projectsDir);
    if (!Object.keys(report).length && !problems.length) {
      if (args.gate && !args.root) {
        console.log('SKIP no projects in store root at ' + root);
        return 0;
      }
      problems.push('no projects in store root: ' + root);
    }
    const after = hashStore(root);
    const hashes = sameHashes(before, after);
    if (!hashes.same) {
      problems.push('real store changed during scan: ' + hashes.changed.join(', '));
    }
    if (args.update) {
      if (isInside(canonicalKey(root), baselineTarget(baselinePath))) {
        problems.push('baseline must be outside the source store root');
      }
      if (problems.length === 0) {
        writeJson(baselinePath, { version: 1, projects: report });
        console.log('baseline updated: ' + baselinePath);
      }
    } else if (!args.gate) {
      if (!fs.existsSync(baselinePath)) {
        problems.push('baseline missing: ' + baselinePath + ' (run --update once)');
      } else {
        const expected = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
        problems.push(...compareReports(expected, report));
      }
    }
    if (args.json) console.log(JSON.stringify({ root, report, problems }, null, 2));
    else printHuman(report);
    if (problems.length > 0) {
      for (const problem of problems) console.error('FAIL ' + problem);
      return 1;
    }
    console.log('PASS store replay (' + Object.keys(report).length + ' project(s)' + (args.gate ? ', gate' : '') + ')');
    return 0;
  } catch (error) {
    console.error('FAIL store replay: ' + error.message);
    return 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(await main());
