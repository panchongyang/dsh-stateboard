#!/usr/bin/env node
/**
 * Restore acceptance criteria that a plan.revise wiped.
 *
 * Background: a build of `plan.revise` that predates 1981a1f treated an empty
 * acceptance list as "clear it", so every member of a revised plan lost its
 * acceptance criteria (and the evidence kept a dangling acceptanceId). The
 * commit log still holds the last good copy, so this script appends one repair
 * commit per run: it never rewrites history, it only adds a task/updated event
 * that puts the previous acceptance array back verbatim (same acc_ ids, same
 * met flags, same evidenceIds).
 *
 * dsh-web must be stopped: it holds the project lock, and the repair must be the
 * only writer on the log tail.
 *
 *   pm2 stop dsh-web
 *   node scripts/restore-acceptance.mjs --project prj_xxx            # dry run
 *   node scripts/restore-acceptance.mjs --project prj_xxx --apply
 *   pm2 start dsh-web
 *
 * Options: --root <dir> (default %DSH_HOME%/project-board), --only <id,id>,
 *          --apply (write), --force (ignore a stale lock file).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectService } from '../lib/core/service.js';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes('--' + name);

function fail(message) {
  process.stderr.write('restore-acceptance: ' + message + '\n');
  process.exit(1);
}

const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME.trim()
  : path.join(os.homedir(), '.dsh');
const root = path.resolve(flag('root', path.join(home, 'project-board')));
const project = flag('project', '');
if (project === '') fail('--project <prj_...> is required');
const dir = path.join(root, 'projects', project);
const commitsFile = path.join(dir, 'commits.jsonl');
if (!fs.existsSync(commitsFile)) fail('no commits.jsonl at ' + commitsFile);

const only = (flag('only', '') || '').split(',').map((id) => id.trim()).filter(Boolean);
const apply = has('apply');

// ------------------------------------------------------------------ dry read

const commits = fs.readFileSync(commitsFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const current = new Map();   // taskId -> acceptance of the newest event that carried one
const lastGood = new Map();  // taskId -> newest non-empty acceptance (with its seq)
for (const commit of commits) {
  for (const event of commit.events || []) {
    const data = event.data;
    if (!data || !data.id || !Array.isArray(data.acceptance)) continue;
    if (!/^task\/(updated|submitted|verified|created|reconciled)$/.test(event.type)) continue;
    current.set(data.id, { acceptance: data.acceptance, seq: commit.seq });
    if (data.acceptance.length > 0) lastGood.set(data.id, { acceptance: data.acceptance, seq: commit.seq, title: data.title });
  }
}

const targets = [];
for (const [taskId, now] of current) {
  if (only.length > 0 && !only.includes(taskId)) continue;
  if (now.acceptance.length > 0) continue;               // nothing to restore
  const good = lastGood.get(taskId);
  if (!good || good.acceptance.length === 0) continue;    // never had any
  targets.push({ taskId, title: good.title || '', seq: good.seq, acceptance: good.acceptance });
}

process.stdout.write('project   ' + project + '\n');
process.stdout.write('root      ' + root + '\n');
process.stdout.write('commits   ' + commits.length + ' (last seq ' + (commits[commits.length - 1] || {}).seq + ')\n');
if (targets.length === 0) {
  process.stdout.write('nothing to restore: every task still has its acceptance criteria\n');
  process.exit(0);
}
process.stdout.write('restore   ' + targets.length + ' task(s)\n');
for (const target of targets) {
  const met = target.acceptance.filter((item) => item.met).length;
  process.stdout.write('  ' + target.taskId + '  from seq ' + target.seq + '  ' + target.acceptance.length + ' criteria (' + met + ' met)  ' + target.title.slice(0, 40) + '\n');
}

if (!apply) {
  process.stdout.write('\ndry run only; re-run with --apply (dsh-web must be stopped)\n');
  process.exit(0);
}

// ------------------------------------------------------------------- repair

const lockFile = path.join(dir, 'lock.json');
if (!has('force') && fs.existsSync(lockFile)) {
  let lock = null;
  try { lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { /* unreadable */ }
  if (lock && Number.isInteger(lock.pid)) {
    let alive = false;
    try { process.kill(lock.pid, 0); alive = true; } catch (error) { alive = Boolean(error && error.code === 'EPERM'); }
    if (alive) fail('another process holds the lock (pid ' + lock.pid + '); stop dsh-web first, or pass --force if you are sure');
  }
}

const service = new ProjectService({ rootDir: root });
await service.init();
const handle = await service.open(project);
if (handle.readOnly) fail('the project opened read-only; stop the running dsh-web first');

const at = new Date().toISOString();
const events = [];
for (const target of targets) {
  const task = handle.state.tasks[target.taskId];
  if (!task) { process.stderr.write('skip (task vanished): ' + target.taskId + '\n'); continue; }
  if ((task.acceptance || []).length > 0) { process.stderr.write('skip (already restored): ' + target.taskId + '\n'); continue; }
  const next = structuredClone(task);
  next.acceptance = target.acceptance;
  next.rev = (task.rev || 0) + 1;
  next.updatedAt = at;
  events.push({ type: 'task/updated', taskId: task.id, rev: next.rev, data: next });
}

if (events.length === 0) {
  process.stdout.write('nothing written\n');
  await service.close().catch(() => {});
  process.exit(0);
}

const commit = handle._appendEvents(events, { kind: 'system', via: 'repair' }, 'cmd_repair_acceptance_' + Date.now(), handle.rev);
handle.store.saveSnapshot();
await service.close().catch(() => {});
process.stdout.write('\nappended seq ' + commit.seq + ' rev ' + commit.hash.slice(0, 18) + '… with ' + events.length + ' task/updated event(s)\n');
process.stdout.write('start dsh-web again, then check the board\n');
