import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { assertIsolation } from '../../test/helpers/fault-isolation.mjs';
import { nodePermissionFlag } from '../../scripts/guards.mjs';

export const repo = fs.realpathSync.native(path.resolve(import.meta.dirname, '../..'));
export const root = assertIsolation();
const marker = JSON.parse(fs.readFileSync(path.join(root, 'synthetic-only.json'), 'utf8'));
assert.equal(fs.realpathSync.native(root), root, 'root must be canonical');
assert.equal(root, process.env.PB_RECOVERY_ROOT);
assert.equal(marker.root, root);
assert.equal(marker.repo, repo);
assert.equal(marker.token, process.env.PB_RECOVERY_TOKEN);
assert.match(path.basename(root), /^pb-recovery-/);

export function inside(file) {
  const rel = path.relative(root, file);
  assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel), file);
  let current = root;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current)) assert.equal(fs.lstatSync(current).isSymbolicLink(), false, current);
  }
  return file;
}

export function json(file) { return JSON.parse(fs.readFileSync(inside(file), 'utf8')); }
export function put(file, value) { fs.writeFileSync(inside(file), JSON.stringify(value, null, 2) + '\n'); }
export function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

export function fixture(name) {
  assert.match(name, /^[a-z-]+$/);
  const base = inside(path.join(root, 'cases', name));
  return { name, base, ...json(path.join(base, 'fixture.json')) };
}

export function backup(f, label) {
  assert.ok(['pristine', 'damaged'].includes(label));
  const dest = inside(path.join(f.base, label));
  assert.equal(fs.existsSync(dest), false, 'backup must not overwrite');
  fs.cpSync(inside(f.dir), dest, { recursive: true });
  const bytes = fs.readFileSync(path.join(dest, 'commits.jsonl'));
  const proof = { dir: dest, logBytes: bytes.length, logSha256: digest(bytes) };
  put(path.join(f.base, label + '-backup.json'), proof);
  return proof;
}

let serial = 0;
export function call(name, script, args = [], expected = 0, flags = []) {
  const result = spawnSync(process.execPath, [...flags, insideOrRepo(script), ...args], {
    cwd: repo, env: process.env, encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
  });
  const record = { command: [process.execPath, ...flags, script, ...args], expectedExit: expected,
    actualExit: result.status, stdout: result.stdout || '', stderr: result.stderr || '', error: result.error?.message };
  const log = inside(path.join(root, 'steps', String(++serial).padStart(3, '0') + '-' + name + '.json'));
  fs.writeFileSync(log, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  assert.ifError(result.error);
  assert.equal(result.status, expected, JSON.stringify(record));
  return { ...record, log };
}

function insideOrRepo(file) {
  const rel = path.relative(repo, file);
  assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel));
  return file;
}

export function worker(f, action) {
  return call(f.name + '-' + action, path.join(repo, 'scripts/recovery/worker.mjs'), [f.name, action]);
}

export function cli(f, script, extra, expected = 0, readOnly = false) {
  return call(f.name + '-' + script, path.join(repo, 'scripts', script + '.mjs'),
    ['--root', f.data, '--project', f.id, ...extra], expected,
    readOnly ? [nodePermissionFlag(), '--allow-fs-read=*'] : []);
}

export function treeHashes(dir) {
  const out = {};
  for (const entry of fs.readdirSync(inside(dir), { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    assert.equal(entry.isSymbolicLink(), false);
    out[entry.name] = entry.isDirectory() ? treeHashes(file) : digest(fs.readFileSync(file));
  }
  return out;
}
