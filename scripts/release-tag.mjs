#!/usr/bin/env node
// Release tag helper: refuse to tag a release that cannot be rolled back.
//
// A release is not "N commits" — it is one semantic change with a declared
// change surface. This script enforces the mechanical parts:
//   - clean working tree
//   - `npm run check:strict` passes (override with --skip-gate for debugging)
//   - event/storage surfaces carry an explicit compat class
//   - the tag records sha, data epoch, client hash and the surface list
//
// Usage: node scripts/release-tag.mjs [--dry-run] [--skip-gate] [--compat <class>] [--base <ref>]
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRepository, resolveGitExecutable } from '../lib/core/git-exec.js';

export const TAG_PREFIX = 'deploy-';
export const COMPAT_CLASSES = ['additive', 'refuse', 'migration'];
const SCHEMA_SURFACES = [
  /^lib\/core\/(model|normalize|evidence|repair)\.js$/,
  /^lib\/core\/store/,
  /^lib\/core\/commands\//,
  /^lib\/shared\/contract\.js$/,
];

/** Local YYYYMMDD; the tag name is deployment-local, not UTC. */
export function dateStamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return '' + year + month + day;
}

/** deploy-YYYYMMDD-N, N independent per day. */
export function nextTagName(tags, date = new Date()) {
  const prefix = TAG_PREFIX + dateStamp(date) + '-';
  const used = (tags || [])
    .filter((tag) => typeof tag === 'string' && tag.startsWith(prefix))
    .map((tag) => Number.parseInt(tag.slice(prefix.length), 10))
    .filter((value) => Number.isInteger(value) && value > 0);
  return prefix + (used.length > 0 ? Math.max(...used) + 1 : 1);
}

/** Split a file list into the surfaces a reviewer has to reason about. */
export function classifyFiles(files) {
  const list = (Array.isArray(files) ? files : []).filter(Boolean);
  return {
    storage: list.filter((file) => SCHEMA_SURFACES.some((re) => re.test(file))),
    client: list.filter((file) => file === 'lib/client.js' || file.startsWith('src/client/')),
    host: list.filter((file) => file.startsWith('lib/host/')),
    total: list.length,
  };
}

/**
 * Pure decision: would this release be safe to tag?
 * Returns { ok, reason?, tag?, surfaces, compat? }.
 */
export function evaluateRelease(input) {
  const surfaces = classifyFiles(input.files);
  if (input.dirty) return { ok: false, reason: 'working tree is dirty; commit or stash before releasing', surfaces };
  if (input.gateCode !== 0) return { ok: false, reason: 'gate failed (npm run check:strict); fix before releasing', surfaces };
  if (surfaces.storage.length > 0 && !COMPAT_CLASSES.includes(input.compat)) {
    return {
      ok: false,
      reason: 'event/storage surfaces changed; declare --compat ' + COMPAT_CLASSES.join('|'),
      surfaces,
    };
  }
  return { ok: true, tag: nextTagName(input.tags, input.date), surfaces, compat: input.compat || null };
}

export function buildTagMessage({ sha, epoch, clientHash, surfaces, compat, gate }) {
  const lines = [
    'release ' + sha,
    'epoch: ' + epoch,
    'compat: ' + (compat || 'none'),
    'client: ' + (clientHash || 'none'),
    'gate: ' + (gate || 'check:strict'),
    'surfaces:',
    '  storage: ' + (surfaces.storage.length ? surfaces.storage.join(', ') : 'none'),
    '  host: ' + (surfaces.host.length ? surfaces.host.join(', ') : 'none'),
    '  client: ' + (surfaces.client.length ? surfaces.client.join(', ') : 'none'),
  ];
  return lines.join('\n');
}

/** Max meta.schemaVersion across projects + project count. */
export function dataEpoch(rootDir = path.join(os.homedir(), '.dsh', 'project-board', 'projects')) {
  let projects = 0;
  let schema = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(rootDir);
  } catch {
    return { projects: 0, schemaVersion: 0, label: 'schema=0 projects=0' };
  }
  for (const id of entries) {
    const metaPath = path.join(rootDir, id, 'meta.json');
    if (!fs.existsSync(metaPath)) continue;
    projects += 1;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const version = Number(meta.schemaVersion || 0);
      if (Number.isFinite(version) && version > schema) schema = version;
    } catch {
      // A broken meta should not block tagging; the epoch just stays lower.
    }
  }
  return { projects, schemaVersion: schema, label: 'schema=' + schema + ' projects=' + projects };
}

export function clientHash(file) {
  try {
    const data = fs.readFileSync(file);
    return 'sha256:' + crypto.createHash('sha256').update(data).digest('hex');
  } catch {
    return 'none';
  }
}

function git(repo, args) {
  const executable = resolveGitExecutable(repo.roots);
  try {
    return execFileSync(executable, args, { cwd: repo.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

function changedFiles(repo, base) {
  const out = git(repo, ['diff', '--name-only', base + '..HEAD']);
  if (out) return out.split(/\r?\n/).filter(Boolean);
  const fallback = git(repo, ['show', '--pretty=format:', '--name-only', 'HEAD']);
  return fallback.split(/\r?\n/).filter(Boolean);
}

function runGate(cwd) {
  const custom = process.env.PB_RELEASE_GATE_CMD;
  const result = custom
    ? spawnSync(custom, { cwd, shell: true, stdio: 'inherit' })
    : spawnSync('npm', ['run', 'check:strict'], { cwd, shell: true, stdio: 'inherit' });
  return Number.isInteger(result.status) ? result.status : 1;
}

function parseArgs(argv) {
  const args = { dryRun: false, skipGate: false, compat: null, base: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--skip-gate') args.skipGate = true;
    else if (arg === '--compat') args.compat = argv[++i] || null;
    else if (arg.startsWith('--compat=')) args.compat = arg.slice('--compat='.length);
    else if (arg === '--base') args.base = argv[++i] || null;
    else if (arg.startsWith('--base=')) args.base = arg.slice('--base='.length);
  }
  return args;
}

export function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  const args = parseArgs(argv);
  // The repository is found on disk first so its whole tree is a safety root
  // before any Git runs, even when started from a subdirectory.
  let repository;
  try {
    repository = findRepository(cwd);
  } catch (error) {
    console.error('REFUSED: ' + error.message + ' (' + (error?.details?.reason || 'unknown') + ')');
    return 1;
  }
  if (!repository) {
    console.error('REFUSED: not inside a git repository: ' + cwd);
    return 1;
  }
  const repo = { cwd, roots: [cwd, ...repository.roots] };
  try {
    resolveGitExecutable(repo.roots);
  } catch (error) {
    console.error('REFUSED: ' + error.message + ' (' + (error?.details?.reason || 'unknown') + ')');
    return 1;
  }
  const tags = git(repo, ['tag', '--list']).split(/\r?\n/).filter(Boolean);
  const sha = git(repo, ['rev-parse', '--short', 'HEAD']);
  const dirty = git(repo, ['status', '--porcelain']) !== '';
  const lastTag = tags.length > 0 ? git(repo, ['describe', '--tags', '--abbrev=0']) : '';
  const base = args.base || lastTag || 'HEAD~1';
  const files = changedFiles(repo, base);
  const gateCode = args.skipGate ? 0 : runGate(cwd);
  const epoch = dataEpoch().label;
  const client = clientHash(path.join(cwd, 'lib', 'client.js'));

  const decision = evaluateRelease({ dirty, gateCode, files, compat: args.compat, tags });
  if (!decision.ok) {
    console.error('REFUSED: ' + decision.reason);
    if (decision.surfaces && decision.surfaces.storage.length > 0) {
      console.error('storage surfaces: ' + decision.surfaces.storage.join(', '));
    }
    return 1;
  }
  const message = buildTagMessage({
    sha,
    epoch,
    clientHash: client,
    surfaces: decision.surfaces,
    compat: decision.compat,
    gate: args.skipGate ? 'skipped' : 'check:strict',
  });
  console.log('release: ' + decision.tag);
  console.log('sha: ' + sha);
  console.log('epoch: ' + epoch);
  console.log('compat: ' + (decision.compat || 'none'));
  console.log('surfaces: storage=' + decision.surfaces.storage.length + ' host=' + decision.surfaces.host.length + ' client=' + decision.surfaces.client.length);
  if (args.dryRun) {
    console.log('--- tag message ---\n' + message + '\n--- dry run, tag not created ---');
    return 0;
  }
  const tagged = spawnSync(resolveGitExecutable(repo.roots), ['tag', '-a', decision.tag, '-m', message], { cwd, encoding: 'utf8' });
  if (tagged.status !== 0) {
    console.error('failed to create tag: ' + (tagged.stderr || '').trim());
    return 1;
  }
  console.log('tagged ' + decision.tag + ' at ' + sha);
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(main());
