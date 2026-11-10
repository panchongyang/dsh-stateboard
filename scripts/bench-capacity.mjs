#!/usr/bin/env node
/**
 * Capacity benchmark for the JSONL store.
 *
 *   node scripts/bench-capacity.mjs --generate --size 10000 [--dir <tmp>]
 *   node scripts/bench-capacity.mjs --measure  --size 10000 --dir <tmp> [--repeats 3]
 *
 * Generation and measurement are separate on purpose: the 100k dataset is
 * generated once into a temp directory and never runs in CI. The script writes
 * only temp data unless --out points at a repo file.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { ProjectService } from '../lib/core/service.js';
import { JsonlStore, makeCommit } from '../lib/core/store.js';
import { readJson } from '../lib/core/util.js';

const AT = '2026-01-01T00:00:00.000Z';

function argsOf(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i += 1; } else out[key] = true;
  }
  return out;
}

function usage() {
  console.log('usage: node scripts/bench-capacity.mjs --generate --size <n> [--dir <tmp>]');
  console.log('       node scripts/bench-capacity.mjs --measure  --size <n> --dir <tmp> [--repeats 3]');
  process.exit(2);
}

async function createProject() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-cap-root-'));
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-cap-ws-'));
  const svc = new ProjectService({ rootDir });
  await svc.init();
  const handle = await svc.createProject({ workspacePath, name: 'Capacity' });
  const projectId = handle.id;
  const dir = handle.meta.dir;
  const meta = readJson(path.join(dir, 'meta.json'), null);
  await svc.close();
  return { rootDir, projectId, dir, meta };
}

async function generate(size, dirArg) {
  const base = dirArg
    ? { rootDir: path.dirname(path.dirname(dirArg)), projectId: path.basename(dirArg), dir: dirArg }
    : await createProject();
  if (dirArg) {
    base.meta = readJson(path.join(base.dir, 'meta.json'), null);
    if (!base.meta) throw new Error('missing meta.json in ' + base.dir);
  }
  const { dir, meta, projectId } = base;
  fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true });
  const commitsFile = path.join(dir, 'commits.jsonl');
  const actor = { kind: 'agent', sessionId: 'bench', agentId: 'bench' };
  const project = { ...meta.project, rev: 1 };
  let prev = 'genesis';
  const fd = fs.openSync(commitsFile, 'w');
  const started = performance.now();
  try {
    for (let seq = 1; seq <= size; seq += 1) {
      const events = seq === 1
        ? [{ type: 'project/created', data: project }]
        : [{
          type: 'task/created',
          taskId: 'tsk_bench_' + seq,
          rev: 1,
          data: {
            id: 'tsk_bench_' + seq,
            rev: 1,
            title: 'Bench task ' + seq,
            description: 'capacity fixture',
            state: 'ready',
            priority: 100,
            weight: 1,
            labels: [],
            requiresAudit: false,
            deps: [],
            acceptance: [{ id: 'acc_bench_' + seq, text: 'ok', met: false, evidenceIds: [] }],
            evidence: [],
            planRef: null,
            owner: null,
            assignee: null,
            work: null,
            blocker: null,
            createdAt: AT,
            updatedAt: AT,
          },
        }];
      const commit = makeCommit(seq, prev, actor, 'cmd_bench_' + seq, seq - 1, events);
      fs.writeSync(fd, JSON.stringify(commit) + '\n');
      prev = commit.hash;
    }
  } finally {
    fs.closeSync(fd);
  }
  const generateMs = performance.now() - started;
  // Materialize the snapshot once so the measurement includes the snapshot path.
  const store = new JsonlStore(dir, meta, { heartbeatMs: 0 });
  const snapshotStart = performance.now();
  store.open();
  store.saveSnapshot();
  store.close();
  const snapshotMs = performance.now() - snapshotStart;
  const info = {
    size,
    projectId,
    dir,
    rootDir: base.rootDir,
    commitsBytes: fs.statSync(commitsFile).size,
    generateMs: Math.round(generateMs),
    snapshotMs: Math.round(snapshotMs),
    snapshotBytes: fs.statSync(path.join(dir, 'snapshot.json')).size,
    tasks: size - 1,
  };
  fs.writeFileSync(path.join(dir, 'bench.json'), JSON.stringify(info, null, 2) + '\n');
  console.log(JSON.stringify(info));
  return info;
}

function quantile(values, q) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return Number(sorted[index].toFixed(2));
}

async function measure(size, sourceDir, repeatsArg) {
  // Measure a private copy: the measurement appends 51 commits, and the source
  // fixture must stay pristine so the command is repeatable.
  const measureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-cap-measure-'));
  const dir = path.join(measureRoot, 'projects', path.basename(sourceDir));
  fs.cpSync(sourceDir, dir, { recursive: true });
  const meta = readJson(path.join(dir, 'meta.json'), null);
  if (!meta) throw new Error('missing meta.json in ' + sourceDir);
  const projectId = meta.projectId || meta.project.id;
  const rootDir = path.dirname(path.dirname(dir));
  const repeats = Math.max(1, Math.min(5, Number.parseInt(repeatsArg || '3', 10) || 3));
  const rss = [];
  const sampleRss = () => { const value = process.memoryUsage().rss; rss.push(value); return value; };
  sampleRss();

  const cold = [];
  for (let i = 0; i < repeats; i += 1) {
    const store = new JsonlStore(dir, meta, { lock: false });
    const start = performance.now();
    const data = store.open();
    cold.push(performance.now() - start);
    if (data.lastSeq !== size) throw new Error('cold open lastSeq ' + data.lastSeq + ' != ' + size);
    sampleRss();
    store.close();
  }

  const list = [];
  for (let i = 0; i < repeats; i += 1) {
    const svc = new ProjectService({ rootDir });
    await svc.init();
    const start = performance.now();
    const projects = svc.listProjects();
    list.push(performance.now() - start);
    if (projects.length !== 1 || projects[0].rev !== size) throw new Error('listProjects did not see the fixture');
    sampleRss();
    await svc.close();
  }

  const svc = new ProjectService({ rootDir });
  await svc.init();
  const handle = await svc.open(projectId);
  sampleRss();
  const taskId = Object.keys(handle.state.tasks)[0];
  if (!taskId) throw new Error('fixture has no tasks');
  const firstStart = performance.now();
  let task = handle.state.tasks[taskId];
  await handle.command({
    cmdId: 'cmd_cap_first_' + crypto.randomUUID(),
    actor: { kind: 'agent', sessionId: 'bench' },
    op: 'task.update',
    taskId,
    expected: { entityRev: task.rev },
    title: 'bench first',
  });
  const firstMs = performance.now() - firstStart;
  const steady = [];
  for (let i = 0; i < 50; i += 1) {
    task = handle.state.tasks[taskId];
    const start = performance.now();
    await handle.command({
      cmdId: 'cmd_cap_steady_' + i + '_' + crypto.randomUUID(),
      actor: { kind: 'agent', sessionId: 'bench' },
      op: 'task.update',
      taskId,
      expected: { entityRev: task.rev },
      title: 'bench ' + i,
    });
    steady.push(performance.now() - start);
  }
  sampleRss();
  await handle.close?.();
  await svc.close();

  const result = {
    size,
    projectId,
    sourceDir,
    dir,
    machine: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpus: os.cpus()[0]?.model || 'unknown',
      totalMemBytes: os.totalmem(),
    },
    repeats,
    dataset: {
      tasks: size - 1,
      commitsBytes: fs.statSync(path.join(dir, 'commits.jsonl')).size,
      snapshotBytes: fs.existsSync(path.join(dir, 'snapshot.json')) ? fs.statSync(path.join(dir, 'snapshot.json')).size : 0,
    },
    coldStartMs: { min: quantile(cold, 0), p50: quantile(cold, 0.5), max: quantile(cold, 1), samples: cold.map((v) => Number(v.toFixed(2))) },
    listProjectsMs: { min: quantile(list, 0), p50: quantile(list, 0.5), max: quantile(list, 1), samples: list.map((v) => Number(v.toFixed(2))) },
    firstCommandMs: Number(firstMs.toFixed(2)),
    steadyCommandMs: { p50: quantile(steady, 0.5), p95: quantile(steady, 0.95), max: quantile(steady, 1), samples: steady.map((v) => Number(v.toFixed(2))) },
    rssBytes: { max: Math.max(...rss), min: Math.min(...rss), samples: rss },
  };
  try { fs.rmSync(measureRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(JSON.stringify(result));
  return result;
}

const args = argsOf(process.argv.slice(2));
if (!args.generate && !args.measure) usage();
const size = Number.parseInt(String(args.size || ''), 10);
if (!Number.isInteger(size) || size < 10) usage();
if (args.generate) {
  await generate(size, typeof args.dir === 'string' ? path.resolve(args.dir) : null);
} else {
  if (typeof args.dir !== 'string') usage();
  await measure(size, path.resolve(args.dir), args.repeats);
}
