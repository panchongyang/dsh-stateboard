// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectHandle } from '../../lib/core/handle.js';
import { JsonlStore, commitHash, makeCommit } from '../../lib/core/store.js';
import { replay } from '../../lib/core/store/format.js';

export const NOW = Date.parse('2026-01-02T03:04:05.000Z');
export const TASK = 'tsk_matrix';
export const TOKEN = 42;
export const actor = (kind = 'agent', sessionId = 'owner') => ({ kind, sessionId, agentId: sessionId });

// Child processes get no inherited credentials, migration opt-ins or Node injection.
export function isolatedEnv(root) {
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'PATH']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const dirs = {
    HOME: 'home', USERPROFILE: 'home', DSH_HOME: 'dsh', DSH_AGENTS_HOME: 'agents',
    APPDATA: 'appdata', LOCALAPPDATA: 'localappdata', TEMP: 'tmp', TMP: 'tmp',
    TMPDIR: 'tmp', XDG_CONFIG_HOME: 'xdg/config', XDG_CACHE_HOME: 'xdg/cache',
    XDG_DATA_HOME: 'xdg/data', XDG_STATE_HOME: 'xdg/state', XDG_RUNTIME_DIR: 'xdg/runtime',
    XDG_CONFIG_DIRS: 'xdg/config-dirs', XDG_DATA_DIRS: 'xdg/data-dirs',
    npm_config_cache: 'npm-cache', npm_config_prefix: 'npm-prefix',
  };
  for (const [key, relative] of Object.entries(dirs)) {
    env[key] = path.join(root, relative);
    fs.mkdirSync(env[key], { recursive: true });
  }
  for (const [key, name] of [['npm_config_userconfig', 'user.npmrc'], ['npm_config_globalconfig', 'global.npmrc']]) {
    env[key] = path.join(root, name);
    fs.writeFileSync(env[key], '');
  }
  env.PB_MATRIX_ISOLATION = root;
  env.PB_COMMAND_EVIDENCE = 'off';
  return env;
}

export function assertIsolation() {
  const root = process.env.PB_MATRIX_ISOLATION;
  assert.ok(root, 'matrix worker must run through its isolated launcher');
  for (const key of ['HOME', 'USERPROFILE', 'DSH_HOME', 'DSH_AGENTS_HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_DIRS', 'XDG_DATA_DIRS', 'npm_config_cache', 'npm_config_prefix', 'npm_config_userconfig', 'npm_config_globalconfig']) {
    const relative = path.relative(root, process.env[key] || '');
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), key + ' is isolated');
  }
  assert.equal(path.resolve(os.homedir()), path.resolve(process.env.HOME));
  // Host plugin default is os.homedir()/.dsh/project-board when DSH_HOME is absent.
  assert.ok(path.relative(root, path.join(os.homedir(), '.dsh', 'project-board')).startsWith('home'));
  for (const key of Object.keys(process.env)) {
    assert.ok(!/^(NODE_OPTIONS|NODE_PATH|PB_MIGRATION_PROJECT|.*API_KEY|.*EXECUTION_KEY)$/i.test(key), 'forbidden inherited variable: ' + key);
  }
}

export function fixture() {
  assertIsolation();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-matrix-fixture-'));
  const workspace = path.join(root, 'workspace');
  const data = path.join(root, 'data');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'artifact.txt'), 'synthetic matrix artifact\n');
  const at = new Date(NOW).toISOString();
  const project = { schemaVersion: 3, id: 'prj_matrix', name: 'synthetic', workspacePath: workspace, phase: 'active', createdAt: at, updatedAt: at,
    policy: { verification: 'manual', requireIntentFor: 'all', leaseTtlSec: 60, leaseGraceSec: 30, maxInProgress: 10, maxPerSession: 10 } };
  const meta = { schemaVersion: 3, projectId: project.id, project, dir: data };
  const store = new JsonlStore(data, meta);
  const opened = store.open();
  const handle = new ProjectHandle({ clock: () => new Date(NOW) }, meta, store, opened);
  handle._appendEvents([{ type: 'project/created', data: project }], actor('human'), 'cmd_seed', 0);
  let serial = 0;

  function reset(spec = {}) {
    // Restore only this fixture, serially; no shared/global filesystem patching.
    // Seed the synthetic projection AND its source log, including legacy states.
    const state = structuredClone(opened.state);
    state.project = { ...project, rev: 1, phase: spec.phase || 'active' };
    state.tasks = { [TASK]: {
      id: TASK, title: 'matrix task', state: spec.state || 'in_progress', rev: 7,
      acceptance: [{ id: 'acc_matrix', text: 'artifact', met: false, evidenceIds: [] }], evidence: [], deps: [], labels: [],
      requiresAudit: false, planRef: null, owner: null, assignee: null, work: null,
      blocker: { resumeTo: spec.resumeTo || 'in_progress' }, createdAt: at, updatedAt: at,
    } };
    state.intents = {};
    state.bindings = {};
    state.counters.leaseToken = TOKEN;
    const task = state.tasks[TASK];
    if (spec.open) {
      state.intents.int_matrix = { id: 'int_matrix', taskId: TASK, status: 'open', token: TOKEN, attempt: 1, summary: 'synthetic', startedAt: at };
      task.work = { intentId: 'int_matrix', attempt: 1, startedAt: at };
    }
    handle.leases = new Map();
    if (spec.lease && spec.lease !== 'none') {
      const offset = spec.lease === 'expired' ? -30_000 : spec.lease === 'grace' ? -1 : 60_000;
      const lease = { taskId: TASK, sessionId: 'owner', agentId: 'owner', epoch: 0, token: TOKEN,
        acquiredAt: at, grantedAt: at, expiresAt: new Date(NOW + offset).toISOString(), progressAt: at, renewCount: 0 };
      handle.leases.set(TASK, lease);
      if (task.state === 'in_progress') task.owner = { sessionId: 'owner', epoch: 0, fencingToken: TOKEN };
    }
    const historicalLease = { taskId: TASK, sessionId: 'owner', agentId: 'owner', epoch: 0, token: TOKEN, acquiredAt: at, expiresAt: at };
    const events = [
      { type: 'project/created', data: state.project },
      { type: 'lease/granted', taskId: TASK, data: historicalLease },
      { type: 'task/created', taskId: TASK, rev: task.rev, data: task },
      ...(spec.open ? [{ type: 'work/intent', taskId: TASK, data: state.intents.int_matrix }] : []),
    ];
    const seed = makeCommit(1, 'genesis', actor('human'), 'cmd_seed', 0, events);
    const baseline = Buffer.from(JSON.stringify(seed) + '\n');
    fs.writeFileSync(store.commitsFile, baseline);
    const rebuilt = replay(meta, [structuredClone(seed)]);
    store.commits = [seed];
    store.timeline = rebuilt.timeline;
    store.cmdIds = new Set(['cmd_seed']);
    store.lastSeq = 1;
    store.lastHash = seed.hash;
    store._fileSize = baseline.length;
    store.state = rebuilt.state;
    handle.state = rebuilt.state;
    handle.timeline = store.timeline;
    handle.cmdIds = store.cmdIds;
    handle.rev = 1;
    handle.lastHash = seed.hash;
    return handle.state.tasks[TASK];
  }

  function command(op, extra = {}) {
    return { cmdId: 'cmd_matrix_' + ++serial, op: op === 'override' ? op : 'task.' + op,
      actor: actor(), taskId: TASK, expected: { entityRev: 7 }, fencingToken: TOKEN,
      summary: 'work', note: 'matrix decision', reason: 'matrix reason', code: 'wait', toState: 'ready', choice: 'discard',
      evidence: [{ kind: 'file', ref: 'artifact.txt', acceptanceId: 'acc_matrix' }], ...extra };
  }

  function snapshot() {
    return { bytes: fs.readFileSync(store.commitsFile), rev: handle.rev, projectRev: handle.state.project.rev,
      leases: structuredClone([...handle.leases]), state: structuredClone(handle.state) };
  }

  async function check(cmd, expected, label = cmd.op) {
    const before = snapshot();
    if (expected.error) {
      const status = { 'invalid-command': 400, 'forbidden-role': 403, 'not-found': 404, 'missing-evidence': 422, 'acceptance-unmet': 422 }[expected.error] || 409;
      await assert.rejects(handle.command(cmd), { code: expected.error, status }, label);
      assert.deepEqual(snapshot(), before, label + ': rejected command changed bytes/revs/leases/state');
      return;
    }
    const result = /** @type {any} */ (await handle.command(cmd));
    assert.deepEqual(result.events.map((event) => event.type), expected.events, label + ': event order');
    assert.equal(handle.state.tasks[TASK].state, expected.state, label + ': state');
    assert.equal(handle.rev, before.rev + 1, label + ': exactly one commit');
    assert.equal(handle.state.project.rev, handle.rev);
    const bytes = fs.readFileSync(store.commitsFile);
    assert.deepEqual(bytes.subarray(0, before.bytes.length), before.bytes, label + ': append only');
    const tail = bytes.subarray(before.bytes.length).toString('utf8').trim().split('\n');
    assert.equal(tail.length, 1);
    const committed = JSON.parse(tail[0]);
    assert.deepEqual(committed.events.map((event) => event.type), expected.events, label + ': persisted event order');
    assert.equal(committed.hash, commitHash(committed));
    return result;
  }
  return { h: handle, root, workspace, reset, command, snapshot, check, close() { handle.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
