// Git observation for one workspace path (contract §2.4). Read-only, bounded:
// every call has a timeout and an output cap, prompts/optional locks/fsmonitor
// are off, and configured filter drivers are neutralized so `git status` never
// runs a clean/process filter from the repository config.

import { spawnSync } from 'node:child_process';
import { assertReadOnlyGitArgs, resolveGitExecutable } from '../git-exec.js';

export const GIT_TIMEOUT_MS = 3000;
const MAX_OUTPUT = 1024 * 1024;

const BASE_ENV_DROP = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_EXTERNAL_DIFF', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT'];

function gitEnv() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GCM_INTERACTIVE: 'never' };
  for (const key of BASE_ENV_DROP) delete env[key];
  return env;
}

function run(root, args, safety = []) {
  let execPath;
  try { execPath = resolveGitExecutable([root]); } catch (error) { return { ok: false, unavailable: true, detail: error?.code || 'git-unavailable' }; }
  const result = spawnSync(execPath, ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...safety, ...assertReadOnlyGitArgs(args)], {
    cwd: root,
    env: gitEnv(),
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) return { ok: false, unavailable: true, detail: result.error.code || result.error.message };
  if (result.signal) return { ok: false, unavailable: true, detail: 'signal ' + result.signal };
  return { ok: result.status === 0, status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

const unavailable = (detail) => ({ state: 'git_unavailable', detail });

// With its filter disabled, Git compares untransformed bytes against the index,
// so modified/committed would be a guess. The filter itself is never run.
const transformed = (attributes) => ({ state: 'git_unavailable', detail: 'unsupported-content-transform', ...attributes });

/** `-c filter.<name>.clean= ...` for every configured filter driver. */
function filterSafety(root) {
  const listed = run(root, ['config', '-z', '--get-regexp', '^filter\\.']);
  if (listed.unavailable) return { error: listed.detail };
  const names = new Set();
  for (const entry of (listed.stdout || '').split('\0')) {
    const key = entry.split('\n')[0];
    const match = /^filter\.(.+)\.[^.]+$/.exec(key);
    if (match) names.add(match[1]);
  }
  const args = [];
  for (const name of names) {
    for (const field of ['clean', 'smudge', 'process']) args.push('-c', 'filter.' + name + '.' + field + '=');
    args.push('-c', 'filter.' + name + '.required=false');
  }
  return { args };
}

function attributesOf(root, relPath, safety) {
  const attr = run(root, ['check-attr', '-z', 'filter', '--', relPath], safety);
  if (!attr.ok) return {};
  const parts = attr.stdout.split('\0');
  const value = parts[2];
  if (!value || value === 'unspecified' || value === 'unset') return {};
  return { filtered: true, ...(value === 'lfs' ? { lfs: true } : {}) };
}

/** HEAD commit of the repository containing `root`, or null. Never throws. */
export function gitHeadOid(root) {
  const head = run(root, ['rev-parse', '--verify', '-q', 'HEAD']);
  if (!head.ok) return null;
  const oid = head.stdout.trim();
  return /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(oid) ? oid : null;
}

/**
 * Git state of `relPath` under `root`:
 * `{ state: untracked|ignored|modified|committed|not_a_repo|git_unavailable, ...flags }`.
 */
export function observeGit(root, relPath) {
  const top = run(root, ['rev-parse', '--show-toplevel']);
  if (top.unavailable) return unavailable(top.detail);
  if (!top.ok) return /not a git repository/i.test(top.stderr) ? { state: 'not_a_repo' } : unavailable('rev-parse exit ' + top.status);
  const safety = filterSafety(root);
  if (safety.error) return unavailable(safety.error);
  const pathspec = ':(literal)' + relPath;
  const status = run(root, ['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=all', '--no-renames', '--', pathspec], safety.args);
  if (!status.ok) return unavailable(status.unavailable ? status.detail : 'status exit ' + status.status);
  const attributes = attributesOf(root, relPath, safety.args);
  const entry = status.stdout.split('\0').find((line) => line.length >= 3);
  if (entry) {
    const code = entry.slice(0, 2);
    if (code === '??') return { state: 'untracked' };
    if (code === '!!') return { state: 'ignored' };
    if (attributes.filtered) return transformed(attributes);
    return { state: 'modified', staged: code[0] !== ' ', unstaged: code[1] !== ' ', ...attributes };
  }
  const tracked = run(root, ['ls-files', '-z', '--', pathspec], safety.args);
  if (!tracked.ok) return unavailable(tracked.unavailable ? tracked.detail : 'ls-files exit ' + tracked.status);
  if (tracked.stdout === '') return { state: 'untracked', detail: 'not-in-index' };
  if (attributes.filtered) return transformed(attributes);
  return { state: 'committed', ...attributes };
}
