#!/usr/bin/env node
/**
 * Plan v2 migration dry-run: copy one project store to a temp directory, open
 * the copy with a lock-free read-only store, and print the derived planHeads,
 * the unplanned/orphan task counts and a health summary.
 *
 * This is the safe verification entry for the planHeads migration. It never
 * opens the original directory, never appends history events, never adopts
 * tasks and never rewrites a snapshot: the source is only read for hashing and
 * for the copy. See docs/operations/MIGRATION.md for the derivation rules and rollback
 * boundaries.
 *
 * Usage:
 *   node scripts/migrate-plans.mjs --project prj_... --dry-run
 *   node scripts/migrate-plans.mjs --project C:\path\to\projects\prj_... --dry-run
 *   node scripts/migrate-plans.mjs --project prj_... --root D:\data --dry-run
 *   node scripts/migrate-plans.mjs --help
 *
 * --project accepts a project id (looked up under <root>/projects) or a store
 * directory that contains commits.jsonl. --dry-run is the default and the only
 * mode; the migration is derived, so there is nothing to apply.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectService } from '../lib/core/service.js';
import { JsonlStore } from '../lib/core/store.js';

const HELP = `migrate-plans: verify the planHeads (plan v2) migration on a copy of a store

  node scripts/migrate-plans.mjs --project <id|dir> [--root <rootDir>] [--dry-run] [--help]

    --project   project id (looked up under <root>/projects/<id>) or a store
                directory containing commits.jsonl
    --root      project-board root dir for id lookup (default: DSH_HOME or
                ~/.dsh, then <root>/project-board)
    --dry-run   default mode; the script never writes anything
    --help      this text

  The source directory is only read: the script hashes its files, copies it to
  a temp dir, opens the copy lock-free (no lock.json, no recover commits, no
  snapshot writes) and prints derived planHeads, unplanned/orphan counts and a
  health summary. History events are never rewritten and tasks are never
  adopted.`;

const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const i = args.indexOf('--' + name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}
function has(flag) {
  return args.includes(flag);
}

const source = arg('project');
if (has('--help') || has('-h') || (!source || source === '')) {
  if (!has('--help') && !has('-h') && (!source || source === '')) {
    console.error('[migrate-plans] --project <id|dir> is required (see --help)');
    process.exit(1);
  }
  console.log(HELP);
  process.exit(0);
}
if (has('--apply')) {
  console.error('[migrate-plans] --apply is not supported: the planHeads migration is derived on open and writes nothing. Run with --dry-run (the default).');
  process.exit(1);
}

function rootDir() {
  const explicit = arg('root');
  if (explicit) return path.resolve(explicit);
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME.trim() : path.join(os.homedir(), '.dsh');
  return path.join(home, 'project-board');
}

function locateStore(source) {
  const direct = path.resolve(source);
  if (fs.existsSync(path.join(direct, 'commits.jsonl'))) return direct;
  const byId = path.join(rootDir(), 'projects', source);
  if (fs.existsSync(path.join(byId, 'commits.jsonl'))) return byId;
  throw new Error('migration source not found: ' + source + ' (tried ' + direct + ' and ' + byId + ')');
}

/** sha256 over every regular file, keyed by relative name. */
function dirHashes(dir) {
  const out = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    out[entry.name] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, entry.name))).digest('hex');
  }
  return out;
}

const readOnlyFactory = (dir, meta) => new JsonlStore(dir, meta, { lock: false });

try {
  const dir = locateStore(source);
  const before = dirHashes(dir);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const projectId = meta.projectId;

  const copyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-migrate-plans-'));
  const copyDir = path.join(copyRoot, 'projects', projectId);
  fs.mkdirSync(copyDir, { recursive: true });
  fs.cpSync(dir, copyDir, { recursive: true });
  fs.rmSync(path.join(copyDir, 'lock.json'), { force: true });

  const svc = new ProjectService({ rootDir: copyRoot, storeFactory: readOnlyFactory });
  await svc.init();
  const handle = await svc.open(projectId);
  const state = handle.state;
  const tasks = Object.values(state.tasks);

  const planHeads = Object.values(state.planHeads || {}).map((head) => ({
    id: head.id,
    title: head.title,
    status: head.status,
    currentVersion: head.currentVersion,
    focus: state.project.focusPlanId === head.id,
  })).sort((a, b) => a.id.localeCompare(b.id));

  const health = handle.health();
  const summary = {
    ok: true,
    dryRun: true,
    source: dir,
    copy: copyDir,
    project: {
      id: handle.id,
      name: state.project.name,
      workspacePath: state.project.workspacePath,
      rev: handle.rev,
      readOnly: handle.readOnly,
      schemaVersion: state.schemaVersion,
    },
    planHeads,
    counts: {
      tasks: tasks.length,
      canceled: tasks.filter((task) => task.state === 'canceled').length,
      unplanned: tasks.filter((task) => !task.planRef).length,
      orphaned: tasks.filter((task) => task.orphaned).length,
      planHeads: planHeads.length,
      active: planHeads.filter((head) => head.status === 'active').length,
      draft: planHeads.filter((head) => head.status === 'draft').length,
      archived: planHeads.filter((head) => head.status === 'archived').length,
      currentPlans: Object.keys(state.currentPlans || {}).length,
      planVersions: Object.keys(state.plans || {}).length,
    },
    focusPlanId: state.project.focusPlanId ?? null,
    health: {
      ok: health.ok,
      warnings: health.warnings,
      hashChain: health.hashChain,
      seq: health.seq,
      readOnly: health.readOnly,
    },
    sourceUnchanged: JSON.stringify(dirHashes(dir)) === JSON.stringify(before),
  };
  handle.close();
  await svc.close();
  fs.rmSync(copyRoot, { recursive: true, force: true });
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.sourceUnchanged || !summary.health.ok || summary.health.hashChain !== 'ok') {
    process.exitCode = 1;
  }
} catch (error) {
  console.error('[migrate-plans] ' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
