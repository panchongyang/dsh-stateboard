#!/usr/bin/env node
// Developer-only, stopped-host migration. This script is not shipped in npm.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEvent, emptyState, normalizePlanHeads } from '../lib/core/model.js';
import { checkState } from '../lib/core/fsck.js';
import { JsonlStore } from '../lib/core/store.js';
import { makeCommit, validateCommits } from '../lib/core/store/format.js';
import { atomicWrite, readJsonLines } from '../lib/core/util.js';

const HELP = `Developer migration of an unpublished v2 project store to schema v3.
  node scripts/migrate-gate-v3.mjs --store <directory> [--dry-run]
  node scripts/migrate-gate-v3.mjs --store <directory> --apply [--backup <directory>]
Default: read-only dry-run, with no implicit home/store lookup. Stop the host first.
Apply makes a complete sibling backup before appending known events. Old commits
stay byte-identical. Rollback: stop the host, restore that backup and the old build;
switching only the code back is NOT safe. Never delete/recreate a project to upgrade.`;
const TRANSIENT = (name) => name === 'lock.json' || name === 'lock.json.claim';
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const equalPath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

function ordinaryDirectory(input) {
  const dir = path.resolve(input);
  if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) throw new Error('Store must be an ordinary directory');
  if (!equalPath(dir, fs.realpathSync(dir))) throw new Error('Store path must not traverse a link');
  return dir;
}

export function storeHashes(dir) {
  const out = {};
  function visit(current, prefix = '') {
    for (const name of fs.readdirSync(current).sort()) {
      if (prefix === '' && TRANSIENT(name)) continue;
      const file = path.join(current, name);
      const relative = prefix + name;
      const info = fs.lstatSync(file);
      if (info.isSymbolicLink()) throw new Error('Store contains a link: ' + relative);
      if (info.isDirectory()) visit(file, relative + '/');
      else if (info.isFile()) out[relative] = hash(fs.readFileSync(file));
      else throw new Error('Store contains a non-regular entry: ' + relative);
    }
  }
  visit(dir);
  return out;
}

function assertStopped(dir) {
  const locks = fs.readdirSync(dir).filter((name) => name.startsWith('lock.json'));
  if (locks.length) throw new Error('Stop the host and resolve its lock before migration: ' + locks.join(', '));
}

function readStore(dir) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  if (!meta.project || meta.projectId !== meta.project.id) throw new Error('Invalid project metadata identity');
  const { lines: commits, tailIncomplete, diagnostic } = readJsonLines(path.join(dir, 'commits.jsonl'));
  if (tailIncomplete) throw diagnostic || new Error('Incomplete log tail; repair explicitly before migration');
  validateCommits(commits);
  // applyEvent stamps authorship into payloads: never mutate the validated history.
  const state = emptyState(structuredClone(meta.project));
  state.schemaVersion = Number.isInteger(meta.schemaVersion) ? meta.schemaVersion : 2;
  for (const commit of structuredClone(commits)) {
    for (const event of commit.events) {
      applyEvent(state, event, commit);
      if (['project/created', 'project/updated'].includes(event.type) && Number.isInteger(event.data?.schemaVersion)) {
        state.schemaVersion = event.data.schemaVersion;
      }
    }
    state.lastSeq = commit.seq;
    state.lastHash = commit.hash;
    state.project.rev = commit.seq;
  }
  const schemaVersion = state.schemaVersion;
  normalizePlanHeads(state);
  state.schemaVersion = schemaVersion;
  return { meta, commits, state };
}

function hasLegacy(task) {
  return Object.hasOwn(task, 'requiresHumanReview') || (task.labels || []).includes('gate:human');
}

function convertGate(value) {
  const next = structuredClone(value);
  const labels = Array.isArray(next.labels) ? next.labels : [];
  next.requiresAudit = Boolean(next.requiresAudit || next.requiresHumanReview || labels.includes('gate:human') || labels.includes('gate:audit'));
  delete next.requiresHumanReview;
  next.labels = [...new Set(labels.map((label) => label === 'gate:human' ? 'gate:audit' : label))];
  if (next.requiresAudit && !next.labels.includes('gate:audit')) next.labels.push('gate:audit');
  return next;
}

function convertTask(task, at) {
  return { ...convertGate(task), rev: task.rev + 1, updatedAt: at };
}

function legacyDraftHeads(state) {
  return Object.values(state.planHeads || {}).filter((head) => (head.draft?.steps || []).some((step) => (step.tasks || []).some(hasLegacy)));
}

function migrationCommit(before) {
  const at = new Date().toISOString();
  const project = { ...before.state.project, schemaVersion: 3, updatedAt: at, rev: before.state.lastSeq + 1 };
  const events = [{ type: 'project/updated', data: project }];
  for (const head of legacyDraftHeads(before.state)) {
    const data = structuredClone(head);
    data.draft.steps = data.draft.steps.map((step) => ({ ...step, tasks: (step.tasks || []).map(convertGate) }));
    data.rev += 1;
    data.updatedAt = at;
    events.push({ type: 'plan/updated', data });
  }
  for (const task of Object.values(before.state.tasks)) {
    const data = convertTask(task, at);
    events.push({ type: 'task/updated', taskId: data.id, rev: data.rev, data });
  }
  return makeCommit(before.state.lastSeq + 1, before.state.lastHash,
    { kind: 'human', via: 'maintainer-gate-v3-migration' }, 'gate-v3-' + crypto.randomUUID(), before.state.lastSeq, events);
}

function backupStore(dir, requested, beforeHashes) {
  const backup = path.resolve(requested || dir + '.gate-v2-backup-' + crypto.randomUUID());
  const relative = path.relative(dir, backup);
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Backup must be outside the source directory');
  }
  if (fs.existsSync(backup)) throw new Error('Backup directory already exists: ' + backup);
  ordinaryDirectory(path.dirname(backup));
  fs.mkdirSync(backup);
  for (const name of fs.readdirSync(dir)) {
    if (!TRANSIENT(name)) fs.cpSync(path.join(dir, name), path.join(backup, name), { recursive: true, force: false, errorOnExist: true });
  }
  if (JSON.stringify(storeHashes(backup)) !== JSON.stringify(beforeHashes)) throw new Error('Backup content verification failed; source has not been migrated');
  return backup;
}

// Hold the same claim directory used by the runtime, with no stale takeover.
// Delete only our verified nonce-owned lock entries, never a computed store tree.
function acquireMigrationLock(dir) {
  const claim = path.join(dir, 'lock.json.claim');
  const lock = path.join(dir, 'lock.json');
  const ownerFile = path.join(claim, 'owner.json');
  const owner = { pid: process.pid, hostname: os.hostname(), nonce: crypto.randomUUID(), at: Date.now() };
  fs.mkdirSync(claim);
  let lockCreated = false;
  try {
    fs.writeFileSync(ownerFile, JSON.stringify(owner), { flag: 'wx' });
    const other = fs.readdirSync(dir).filter((name) => name.startsWith('lock.json') && name !== 'lock.json.claim');
    if (other.length) throw new Error('Store acquired a lock during preflight');
    fs.writeFileSync(lock, JSON.stringify(owner), { flag: 'wx' });
    lockCreated = true;
  } catch (error) {
    release();
    throw error;
  }
  function release() {
    if (lockCreated && fs.existsSync(lock) && !fs.lstatSync(lock).isSymbolicLink()) {
      const current = JSON.parse(fs.readFileSync(lock, 'utf8'));
      if (current.nonce === owner.nonce && equalPath(path.dirname(lock), dir)) fs.unlinkSync(lock);
    }
    if (fs.existsSync(ownerFile) && !fs.lstatSync(ownerFile).isSymbolicLink()) {
      const current = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
      if (current.nonce === owner.nonce && equalPath(path.dirname(claim), dir)) {
        fs.unlinkSync(ownerFile);
        fs.rmdirSync(claim);
      }
    }
  }
  return release;
}

function applyMigration(dir, before, requestedBackup, beforeHashes) {
  const backup = backupStore(dir, requestedBackup, beforeHashes);
  if (JSON.stringify(storeHashes(dir)) !== JSON.stringify(beforeHashes)) throw new Error('Source changed while backing up; nothing appended');
  const commit = migrationCommit(before);
  const commitsFile = path.join(dir, 'commits.jsonl');
  const original = fs.readFileSync(commitsFile);
  const separator = original.length && original[original.length - 1] !== 10 ? '\n' : '';
  const fd = fs.openSync(commitsFile, 'a');
  try {
    fs.writeFileSync(fd, separator + JSON.stringify(commit) + '\n');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  // The log is authoritative. A crash from this point can be completed by a
  // rerun; rollback always restores the verified backup, not an edited log.
  const after = readStore(dir);
  const health = checkState(after.state);
  const priorHealth = checkState(before.state);
  const newWarnings = health.warnings.filter((warning) => !priorHealth.warnings.includes(warning));
  if (after.state.schemaVersion !== 3 || Object.keys(after.state.tasks).length !== Object.keys(before.state.tasks).length || Object.values(after.state.tasks).some(hasLegacy) || legacyDraftHeads(after.state).length || newWarnings.length) {
    throw new Error('Migration verification failed; restore backup ' + backup + ': ' + newWarnings.join('; '));
  }
  atomicWrite(path.join(dir, 'snapshot.json'), JSON.stringify({ v: 1, seq: after.state.lastSeq, hash: after.state.lastHash, state: after.state }, null, 2) + '\n', 'utf8');
  atomicWrite(path.join(dir, 'meta.json'), JSON.stringify({ ...before.meta, schemaVersion: 3, project: after.state.project }, null, 2) + '\n', 'utf8');
  const store = new JsonlStore(dir, { ...before.meta, schemaVersion: 3, project: after.state.project }, { lock: false });
  try {
    const cold = store.open();
    if (cold.state.schemaVersion !== 3 || cold.lastHash !== commit.hash || Object.keys(cold.state.tasks).length !== Object.keys(before.state.tasks).length) throw new Error('Cold-open parity failed; restore backup ' + backup);
  } finally { store.close(); }
  return { backup, commit, health, newWarnings };
}

export function migrateGateV3({ dir: input, apply = false, backup: requestedBackup } = {}) {
  if (!input || typeof input !== 'string') throw new Error('--store <directory> is required');
  const dir = ordinaryDirectory(input);
  assertStopped(dir);
  const beforeHashes = storeHashes(dir);
  const before = readStore(dir);
  if (![2, 3].includes(before.state.schemaVersion)) throw new Error('Unsupported source schema: ' + before.state.schemaVersion);
  const tasks = Object.values(before.state.tasks);
  const drafts = legacyDraftHeads(before.state);
  const migrated = before.state.schemaVersion === 3 && drafts.length === 0 && tasks.every((task) => typeof task.requiresAudit === 'boolean' && !hasLegacy(task));
  if (before.state.schemaVersion === 3 && !migrated) throw new Error('Schema v3 contains mixed gate data; restore a consistent backup before migration');
  const summary = { ok: true, dryRun: !apply, source: dir, fromSchema: before.state.schemaVersion, toSchema: 3,
    tasks: tasks.length, gated: tasks.filter((task) => task.requiresAudit || task.requiresHumanReview || (task.labels || []).some((label) => ['gate:human', 'gate:audit'].includes(label))).length,
    noOp: migrated, legacyDrafts: drafts.map((head) => head.id), beforeSeq: before.state.lastSeq, beforeHash: before.state.lastHash, backup: null };
  const sideFilesNeedRepair = migrated && before.meta.schemaVersion !== 3;
  if (!apply || (migrated && !sideFilesNeedRepair)) {
    if (JSON.stringify(storeHashes(dir)) !== JSON.stringify(beforeHashes)) throw new Error('Source changed during read-only preflight');
    return { ...summary, sideFilesNeedRepair, sourceUnchanged: true, plannedEvents: migrated ? 0 : 1 + drafts.length + tasks.length };
  }
  // Draft gate definitions use the existing plan/updated event so a later
  // publication preserves the gate. No event type or user approval is added.
  const release = acquireMigrationLock(dir);
  try {
    if (JSON.stringify(storeHashes(dir)) !== JSON.stringify(beforeHashes)) throw new Error('Source changed before migration lock');
    if (sideFilesNeedRepair) {
      const backup = backupStore(dir, requestedBackup, beforeHashes);
      atomicWrite(path.join(dir, 'snapshot.json'), JSON.stringify({ v: 1, seq: before.state.lastSeq, hash: before.state.lastHash, state: before.state }, null, 2) + '\n', 'utf8');
      atomicWrite(path.join(dir, 'meta.json'), JSON.stringify({ ...before.meta, schemaVersion: 3, project: before.state.project }, null, 2) + '\n', 'utf8');
      return { ...summary, backup, noOp: false, sideFilesRepaired: true, events: 0, afterSeq: before.state.lastSeq, afterHash: before.state.lastHash };
    }
    const result = applyMigration(dir, before, requestedBackup, beforeHashes);
    return { ...summary, backup: result.backup, afterSeq: result.commit.seq, afterHash: result.commit.hash,
      events: result.commit.events.length, eventTypes: [...new Set(result.commit.events.map((event) => event.type))], health: result.health, newWarnings: result.newWarnings };
  } finally { release(); }
}

function runCli() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { console.log(HELP); return; }
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (['--apply', '--dry-run'].includes(flag)) values[flag.slice(2)] = true;
    else if (['--store', '--backup'].includes(flag) && args[i + 1] && !args[i + 1].startsWith('--')) values[flag.slice(2)] = args[++i];
    else throw new Error('Unknown or incomplete argument: ' + flag);
  }
  if (values.apply && values['dry-run']) throw new Error('Choose --apply or --dry-run, not both');
  if (values.backup && !values.apply) throw new Error('--backup requires --apply');
  console.log(JSON.stringify(migrateGateV3({ dir: values.store, apply: Boolean(values.apply), backup: values.backup }), null, 2));
}

if (process.argv[1] && equalPath(path.resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  try { runCli(); } catch (error) { console.error('[migrate-gate-v3] ' + error.message); process.exitCode = 1; }
}
