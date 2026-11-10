import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { root, repo, fixture, json, put, backup, worker, cli, treeHashes, digest } from './harness.mjs';

export const specifications = [
  ['tail-no-lf', 'Complete JSON without LF is retained; append and cold reopen preserve all data'],
  ['tail-partial', 'Unparseable unterminated suffix is discarded; committed prefix is retained'],
  ['middle-json', 'Fail closed; read-only salvage; explicit RPO confirmation and exact-byte repair backup'],
  ['snapshot-ahead', 'Ignore ahead snapshot and replay authoritative log without data loss'],
  ['snapshot-hash', 'Ignore hash-mismatched snapshot and replay authoritative log without data loss'],
  ['snapshot-missing', 'Replay log without snapshot without data loss'],
  ['lock-takeover', 'Refuse live writer, then take over our naturally exited child lock in a fresh process'],
  ['meta-missing', 'Missing meta is not auto-recovered; restore pre-agreed fixture backup'],
  ['path-drift', 'Discover real committed relocate with stale meta cache and heal it'],
  ['blob-orphan', 'Rejected baseRev leaves physical blob unreferenced; retain it and continue business'],
  ['business-chain', 'plan/claim/begin; cold restart/reconcile; artifact/submit/human verify; cold reopen'],
];

function changeSnapshot(f, name) {
  const file = path.join(f.dir, 'snapshot.json');
  if (name === 'snapshot-missing') { fs.unlinkSync(file); return; }
  const snap = json(file);
  if (name === 'snapshot-ahead') snap.seq += 100;
  else snap.hash = 'untrusted-synthetic-cache';
  // Poison the untrusted cache: retention assertions prove the log actually replayed.
  snap.state.tasks = {};
  snap.state.docs = {};
  put(file, snap);
}

async function leaveOwnLock(f) {
  const args = [path.join(repo, 'scripts/recovery/worker.mjs'), f.name, 'hold'];
  const child = spawn(process.execPath, args, { cwd: repo, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], timeout: 15_000 });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = once(child, 'exit');
  const ready = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => reject(new Error('fixture holder exited before readiness: ' + stderr)));
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes('"ready":true')) resolve();
    });
  });
  try {
    await ready;
    const live = worker(f, 'live-refusal');
    assert.equal(json(path.join(f.dir, 'lock.json')).pid, child.pid);
    return { ownerPid: child.pid, liveRefusal: live.log, command: [process.execPath, ...args] };
  } finally {
    child.stdin.end('natural fixture exit\n');
    const [code, signal] = await exited;
    put(path.join(f.base, 'holder-process.json'), { command: [process.execPath, ...args], pid: child.pid, stdout, stderr, code, signal });
    assert.equal(code, 0, stderr);
    assert.equal(signal, null);
    assert.ok(fs.existsSync(path.join(f.dir, 'lock.json')), 'our child intentionally left lock');
  }
}

function middleDamage(f) {
  const file = path.join(f.dir, 'commits.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  const boundary = JSON.parse(lines[1]);
  lines[2] = '{synthetic damaged middle JSON}';
  fs.writeFileSync(file, lines.join('\n') + '\n');
  put(path.join(f.base, 'expected.json'), { rev: 2, tasks: 1, docs: 0 });
  return { validSeq: 2, validHash: boundary.hash, lostCommittedSuffix: 2, lostBusiness: ['Kept document', 'Suffix task'] };
}

function repairMiddle(f, rpo) {
  const file = path.join(f.dir, 'commits.jsonl');
  const damaged = fs.readFileSync(file);
  worker(f, 'fail-open');
  assert.deepEqual(fs.readFileSync(file), damaged, 'failed cold open must not alter log');
  const before = treeHashes(f.data);
  const salvage = cli(f, 'salvage-log', ['--view', 'board'], 2, true);
  const out = JSON.parse(salvage.stdout);
  assert.equal(out.current, false);
  assert.equal(out.readOnly, true);
  assert.equal(out.validSeq, rpo.validSeq);
  assert.equal(out.validHash, rpo.validHash);
  assert.deepEqual(treeHashes(f.data), before, 'salvage is read only');
  const mode = ['--truncate-to-valid-prefix'];
  const dry = cli(f, 'repair-log', mode, 0, true);
  assert.match(dry.stdout, /RPO: validSeq=2/);
  const refusal = cli(f, 'repair-log', [...mode, '--apply'], 1);
  assert.deepEqual(treeHashes(f.data), before, 'no data loss confirmation means no writes');
  put(path.join(f.base, 'rpo-confirmation.json'), { ...rpo, confirmedBy: 'synthetic drill policy only; NEVER real-data approval' });
  const applied = cli(f, 'repair-log', [...mode, '--apply', '--confirm-data-loss', rpo.validHash]);
  const backups = fs.readdirSync(f.dir).filter((name) => name.startsWith('commits.jsonl.bak-'));
  assert.equal(backups.length, 1);
  const backupFile = path.join(f.dir, backups[0]);
  assert.deepEqual(fs.readFileSync(backupFile), damaged, 'repair backup must equal original damaged log byte for byte');
  return { salvage: salvage.log, dryRun: dry.log, missingConfirmationRefusal: refusal.log, apply: applied.log,
    repairBackup: backupFile, exactBackupSha256: digest(damaged) };
}

export async function exercise(name) {
  worker({ name }, 'seed');
  const f = fixture(name);
  const pristine = backup(f, 'pristine');
  let rpo = { validSeq: 4, lostCommittedSuffix: 0 };
  let detail = {};
  const file = path.join(f.dir, 'commits.jsonl');
  if (name === 'tail-no-lf') {
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.at(-1), 10);
    fs.writeFileSync(file, bytes.subarray(0, -1));
  } else if (name === 'tail-partial') fs.appendFileSync(file, '{"v":1,"seq":5,"incomplete":');
  else if (name === 'middle-json') rpo = middleDamage(f);
  else if (name.startsWith('snapshot-')) changeSnapshot(f, name);
  else if (name === 'lock-takeover') detail = await leaveOwnLock(f);
  else if (name === 'meta-missing') fs.unlinkSync(path.join(f.dir, 'meta.json'));
  else if (name === 'path-drift') {
    const oldMeta = fs.readFileSync(path.join(f.dir, 'meta.json'));
    worker(f, 'relocate');
    fs.writeFileSync(path.join(f.dir, 'meta.json'), oldMeta);
    rpo.validSeq = 5;
  } else if (name === 'blob-orphan') worker(f, 'orphan');
  else if (name === 'business-chain') worker(f, 'chain-begin');
  else throw new Error('unrecognized case ' + name);
  const damaged = backup(f, 'damaged');
  const start = performance.now();
  if (name === 'middle-json') detail = repairMiddle(f, rpo);
  if (name === 'meta-missing') {
    worker(f, 'missing-meta');
    fs.copyFileSync(path.join(pristine.dir, 'meta.json'), path.join(f.dir, 'meta.json'));
    detail.manualRestore = 'consistent pristine fixture meta backup, not service auto-recovery';
  }
  if (name === 'business-chain') {
    worker(f, 'chain-finish');
    worker(f, 'chain-verify');
    detail = json(path.join(f.base, 'chain-final.json'));
    rpo.validSeq = json(path.join(f.base, 'chain.json')).beforeRestartRev;
  } else {
    worker(f, name === 'path-drift' ? 'discover' : 'continue');
    worker(f, 'verify');
  }
  return { status: 'pass', recoveryMs: Math.round(performance.now() - start), pristine, damaged, rpo,
    actual: 'expected behavior asserted; real business committed and retained after another cold process reopen', detail };
}
