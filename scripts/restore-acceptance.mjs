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
 *          --apply (write; the offline command verifies the lock and watermark).
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
// The id is also a directory component under the synthetic root: reject
// separators, dot segments and uppercase/unexpected ids before any fs access.
if (!/^prj_[a-z0-9]{1,124}$/.test(project)) fail('invalid --project id (expected prj_<lowercase alphanumeric>, no path component)');
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

// Offline-maintenance command, not a general append. The script passes only
// the task ids and the inventory watermark; the writer verifies the current
// log prefix, task history and idempotency under the project lock itself.
if (typeof ProjectService.prototype.restoreHistoricalAcceptance !== 'function') {
  fail('this build has no service.restoreHistoricalAcceptance offline command');
}
const last = commits[commits.length - 1];
const expectedRev = last.seq;
const expectedHash = last.hash;
const service = new ProjectService({ rootDir: root, offlineMaintenance: true });
await service.init();
try {
  const result = await service.restoreHistoricalAcceptance(project, {
    expectedRev,
    expectedHash,
    taskIds: targets.map((target) => target.taskId),
  });
  process.stdout.write(JSON.stringify({
    ok: true,
    project,
    expectedRev,
    expectedHash,
    taskIds: targets.map((target) => target.taskId),
    result,
  }, null, 2) + '\n');
} finally {
  await service.close().catch(() => {});
}
process.stdout.write('start dsh-web again, then check the board\n');
