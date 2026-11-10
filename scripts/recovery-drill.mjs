#!/usr/bin/env node
// No root/output/real-data options: every invocation owns a new synthetic fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isolatedEnvironment } from '../test/helpers/fault-isolation.mjs';

assert.equal(process.argv.length, 2, 'recovery-drill accepts no arguments or real root');
const repo = fs.realpathSync.native(path.resolve(import.meta.dirname, '..'));
const parent = fs.realpathSync.native(os.tmpdir());
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, 'pb-recovery-')));
assert.equal(path.dirname(root), parent);
const token = crypto.randomUUID();
fs.writeFileSync(path.join(root, 'synthetic-only.json'), JSON.stringify({ token, repo, root }), { flag: 'wx' });
const env = { ...isolatedEnvironment(root), PB_RECOVERY_ROOT: root, PB_RECOVERY_TOKEN: token };
console.log('synthetic recovery root: ' + root);
const result = spawnSync(process.execPath, [path.join(repo, 'scripts/recovery/run.mjs')], {
  cwd: repo, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
});
fs.writeFileSync(path.join(root, 'runner.stdout.log'), result.stdout || '', { flag: 'wx' });
fs.writeFileSync(path.join(root, 'runner.stderr.log'), result.stderr || '', { flag: 'wx' });
console.log(result.stdout || '');
if (result.stderr) console.error(result.stderr);
if (result.error) console.error(result.error.message);
process.exitCode = result.error ? 1 : (result.status ?? 1);
