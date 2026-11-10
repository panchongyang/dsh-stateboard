#!/usr/bin/env node
// Offline maintenance only. Dry-run is zero-write; apply always backs up first.
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite, readJsonLines } from '../lib/core/util.js';
import { planRepair, scanPrefix } from '../lib/core/repair.js';
import { replay, validateCommit } from '../lib/core/store/format.js';
import { JsonlStore } from '../lib/core/store.js';
import { BoardError } from '../lib/core/errors.js';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes('--' + name);
const fail = (message) => { throw new Error(message); };
const print = (message) => process.stdout.write(message + '\n');

function assertRepairStructure(commit, line) {
  const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const reject = (reason) => {
    throw new BoardError('hash-chain-broken', reason + ' at line ' + line + '; repair refuses structural errors', {
      status: 503, details: { line, reason },
    });
  };
  if (!record(commit)) reject('invalid-commit');
  if (!Array.isArray(commit.events)) reject('invalid-events');
  for (const event of commit.events) {
    if (!record(event) || typeof event.type !== 'string' || event.type === '') reject('invalid-events');
  }
}

function refuseUnsupported(text) {
  // Inspect every parseable line, including the discarded suffix. Structural
  // refusal is independent of chain errors; seq/hash must not hide its reason.
  // Malformed JSON itself is diagnosed by the shared prefix scan.
  text.split('\n').forEach((line, index) => {
    let commit;
    try { commit = JSON.parse(line); } catch { return; }
    assertRepairStructure(commit, index + 1);
    try { validateCommit(commit, { line: index + 1, validSeq: 0, validHash: 'genesis' }, { strictEvents: true }); }
    catch (error) {
      if (['invalid-commit', 'invalid-events', 'unsupported-version', 'unknown-event'].includes(error.details?.reason)) throw error;
    }
  });
}

function prefixPlan(file, original, meta) {
  const text = original.toString('utf8');
  const scan = scanPrefix(file);
  if (!scan.diagnostic) return { action: 'none', reason: 'log has no corrupt prefix boundary' };
  const { reason, line, validSeq, validHash } = scan.diagnostic.details;
  if (!['invalid-json', 'incomplete-tail', 'seq-mismatch', 'prev-mismatch', 'hash-mismatch'].includes(reason)) {
    fail('prefix truncation refuses ' + reason);
  }
  if (!validSeq) fail('prefix truncation refuses an empty prefix');
  // Ensure understood event payloads actually replay before authorizing a write.
  replay(meta, structuredClone(scan.lines));
  const physical = text.split('\n');
  if (text.endsWith('\n')) physical.pop();
  let startByte = 0;
  for (let i = 1; i < line; i++) startByte = original.indexOf(10, startByte) + 1;
  const keptBytes = original.subarray(0, startByte);
  const endByte = original.length;
  print('DATA LOSS: discard physical lines ' + line + '..' + physical.length + ', bytes=' + (endByte - startByte) + ', byte range [' + startByte + ',' + endByte + ')');
  print('RPO: validSeq=' + validSeq + ', validHash=' + validHash + '; all subsequent commits/fragments are lost; suffix seq range is untrusted');
  print('boundary: ' + JSON.stringify(scan.diagnostic.details));
  return { action: 'repair', kept: scan.lines, body: keptBytes, validHash };
}

function legacyPlan(file) {
  // No filtered line numbers: malformed JSON reports its actual physical line.
  const { lines, diagnostic } = readJsonLines(file);
  if (diagnostic) throw diagnostic;
  const plan = planRepair(lines, { keep: flag('keep', 'tail') });
  if (plan.action === 'repair') {
    print('fork detected: ' + plan.problem);
    print('keeping ' + (plan.keepHead ? 'head' : 'tail') + '; dropping ' + plan.dropped.length + ' commits');
    plan.body = plan.kept.map((commit) => JSON.stringify(commit)).join('\n') + '\n';
  }
  return plan;
}

function writeBackup(file, original) {
  const backup = file + '.bak-' + Date.now() + '-' + process.pid;
  const fd = fs.openSync(backup, 'wx');
  try { fs.writeFileSync(fd, original); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  print('backup: ' + backup);
  return backup;
}

function applyPrefix(dir, file, meta, plan, original) {
  if (has('force')) fail('--force is not supported with prefix truncation');
  if (flag('confirm-data-loss') !== plan.validHash) fail('--apply requires --confirm-data-loss ' + plan.validHash);
  const lock = new JsonlStore(dir, meta);
  if (fs.existsSync(lock.lockFile) || fs.existsSync(lock.lockFile + '.claim')) fail('existing lock/claim; stop writers and resolve locks manually');
  try {
    // Reuse the normal cooperative writer lock, never remove or take over an
    // existing maintenance lock. This is not a fence against rogue OS writers.
    lock.acquireLock();
    if (lock.readOnly || !lock.ownsLockFile()) fail('could not acquire maintenance writer lock');
    if (!fs.readFileSync(file).equals(original)) fail('log changed since planning');
    writeBackup(file, original);
    if (!lock.ownsLockFile() || !fs.readFileSync(file).equals(original)) fail('lock or log changed before replacement');
    atomicWrite(file, plan.body);
    print('written: ' + plan.kept.length + ' commits; prefix repair applied');
  } finally { lock.close(); }
}

function main() {
  const root = flag('root');
  const project = flag('project', '');
  if (!root || !path.isAbsolute(root) || !/^[a-zA-Z0-9_-]+$/.test(project)) fail('explicit absolute --root and --project <id> are required');
  const dir = path.join(root, 'projects', project);
  const file = path.join(dir, 'commits.jsonl');
  const original = fs.readFileSync(file);
  const text = original.toString('utf8');
  refuseUnsupported(text);
  const prefix = has('truncate-to-valid-prefix');
  const meta = prefix ? JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) : null;
  const plan = prefix ? prefixPlan(file, original, meta) : legacyPlan(file);
  if (plan.action === 'none') { print('ok: ' + plan.reason); return; }
  if (plan.action !== 'repair') fail(plan.reason);
  if (!has('apply')) { print('dry-run only; no files written; --apply requires explicit data-loss confirmation in prefix mode'); return; }
  if (prefix) { applyPrefix(dir, file, meta, plan, original); return; }
  const lockFile = path.join(dir, 'lock.json');
  if ((fs.existsSync(lockFile) || fs.existsSync(lockFile + '.claim')) && !has('force')) fail('existing lock/claim; stop writers first (legacy fork mode supports --force)');
  if (!fs.readFileSync(file).equals(original)) fail('log changed since planning');
  writeBackup(file, original);
  atomicWrite(file, plan.body);
  print('written: ' + plan.kept.length + ' commits');
}

try { main(); }
catch (error) {
  process.stderr.write(JSON.stringify({ error: { code: error.code || 'repair-refused', message: error.message, details: error.details || null } }) + '\n');
  process.exitCode = 1;
}
