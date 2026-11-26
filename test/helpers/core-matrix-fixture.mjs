// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectHandle, ProjectService } from '../../lib/core/service.js';
import { JsonlStore, commitHash, makeCommit } from '../../lib/core/store.js';
import { TransactionModel } from '../../lib/core/transaction/model.js';
import { assertRecord, restoreRecords } from '../../lib/core/transaction/records.js';
import { validateCommits } from '../../lib/core/store/format.js';

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
  const options = { rootDir: root, clock: () => new Date(NOW), privilegedInlineWrites: false };
  const service = new ProjectService(options);
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'artifact.txt'), 'synthetic matrix artifact\n');
  const at = new Date(NOW).toISOString();
  const project = { schemaVersion: 3, id: 'prj_matrix', name: 'synthetic', workspacePath: workspace, phase: 'active', createdAt: at, updatedAt: at,
    policy: { verification: 'manual', requireIntentFor: 'all', leaseTtlSec: 60, leaseGraceSec: 30, maxInProgress: 10, maxPerSession: 10 } };
  const data = path.join(service.projectsDir, project.id);
  const meta = { schemaVersion: 3, projectId: project.id, project, dir: data };
  const store = new JsonlStore(data, meta);
  fs.mkdirSync(data, { recursive: true });
  const genesis = makeCommit(1, 'genesis', actor('human'), 'cmd_seed', 0, [{ type: 'project/created', data: project }]);
  fs.writeFileSync(store.commitsFile, JSON.stringify(genesis) + '\n');
  fs.writeFileSync(path.join(data, 'meta.json'), JSON.stringify({ schemaVersion: 3, projectId: project.id, project }));
  service.refreshFromDisk();
  const opened = store.open();
  let handle = new ProjectHandle(service, meta, store, opened);
  handle.recover(); // The genesis contains no tasks. Start the matrix on an already running writer.

  function restoreRunningHandle(data, leases) {
    // reset/seed replace only synthetic facts, not the physical lock or this writer generation.
    // In particular, an intentionally missing runtime lease is not evidence of a restart.
    const next = constructSyntheticHandle(service, meta, store, data, leases);
    next.recovered = handle.recovered;
    return next;
  }
  let serial = 0;

  function reset(spec = {}) {
    // Restore only this fixture, serially; no shared/global filesystem patching.
    // Seed the synthetic projection AND its source log, including legacy states.
    const state = structuredClone(opened.state);
    state.project = { ...project, rev: 1, phase: spec.phase || 'active' };
    state.tasks = { [TASK]: {
      id: TASK, title: 'matrix task', state: spec.state || 'in_progress', rev: 7,
      acceptance: [{ id: 'acc_matrix', text: 'artifact', met: false, evidenceIds: [] }], evidence: [], deps: [], labels: [],
      requiresAudit: Boolean(spec.gated), planRef: null, owner: null, assignee: null, work: null,
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
    const runtimeLeases = new Map();
    if (spec.lease && spec.lease !== 'none') {
      const offset = spec.lease === 'expired' ? -30_000 : spec.lease === 'grace' ? -1 : 60_000;
      const lease = { taskId: TASK, sessionId: 'owner', agentId: 'owner', epoch: 0, token: TOKEN,
        acquiredAt: at, grantedAt: at, expiresAt: new Date(NOW + offset).toISOString(), progressAt: at, renewCount: 0 };
      runtimeLeases.set(TASK, lease);
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
    // This fixture alone retains its synthetic physical lock between rows. Restore
    // a new model from a validated historical prefix; never mutate a published
    // business snapshot or add a reset/setter to production. Each checked command
    // still goes through the real model transaction + JSONL fsync + byte oracle.
    fs.writeFileSync(store.commitsFile, baseline);
    const restored = restoreSyntheticRecords(meta, [seed]);
    store.commits = [seed];
    store.lastSeq = restored.state.lastSeq;
    store.lastHash = restored.state.lastHash;
    store._fileSize = Buffer.byteLength(baseline);
    handle = restoreRunningHandle({ ...restored, cmdIds: new Set([seed.cmdId]), readOnly: false }, runtimeLeases);
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
  function seed(events) {
    const runtimeLeases = handle.leases;
    const record = makeCommit(handle.rev + 1, handle.lastHash, actor('human'), 'cmd_history_' + ++serial, handle.rev, events);
    const records = [...store.commits, record];
    const restored = restoreSyntheticRecords(meta, records);
    const baseline = records.map((row) => JSON.stringify(row) + '\n').join('');
    // This known synthetic prefix is fixture setup, never a production transaction.
    fs.writeFileSync(store.commitsFile, baseline);
    store.commits = records;
    store.lastSeq = restored.state.lastSeq;
    store.lastHash = restored.state.lastHash;
    store._fileSize = Buffer.byteLength(baseline);
    handle = restoreRunningHandle({ ...restored, cmdIds: new Set(records.map((row) => row.cmdId)), readOnly: false }, runtimeLeases);
  }
  return { get h() { return handle; }, root, workspace, reset, seed, command, snapshot, check, close() { handle.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

/** Seed only a synthetic fixture log while its writer is CLOSED, then cold-open it.
 * Used for historical combinations that today's public commands must reject.
 * Volatile lease rows are copied separately; replay deliberately never revives them. */
export function reopenSyntheticHistory(handle, events, runtimeLeases = structuredClone([...handle.leases])) {
  const { service, meta } = handle;
  if (events.length) appendSyntheticHistory(handle, events);
  else handle.close(); // Runtime-only reconstruction retains the exact source log.
  const store = new JsonlStore(meta.dir, meta);
  const data = store.open();
  const reopened = constructSyntheticHandle(service, meta, store, data, runtimeLeases);
  reopened.clock = handle.clock;
  return reopened;
}

/** Verify envelope continuity, supported records and replay before installing a fixture. */
function restoreSyntheticRecords(meta, records) {
  validateCommits(records);
  for (const record of records) assertRecord(meta, record);
  return restoreRecords(meta, records);
}

/**
 * Only new isolated models receive seed runtime rows; no live-model mutation.
 * @param {Iterable<[string, any]>} [runtimeLeases]
 */
export function constructSyntheticHandle(service, meta, store, data, runtimeLeases = new Map()) {
  const seeded = { ...data, leases: new Map(structuredClone([...runtimeLeases])) };
  store.model = new TransactionModel(seeded);
  return new ProjectHandle(service, meta, store, seeded);
}

/** Append known historical facts only after closing this synthetic fixture's writer. */
export function appendSyntheticHistory(handle, events) {
  const commitsFile = handle.store.commitsFile;
  const commit = makeCommit(handle.rev + 1, handle.lastHash, { kind: 'human', via: 'synthetic-history-fixture' },
    'cmd_synthetic_history_' + (handle.rev + 1), handle.rev, events);
  // Validate the complete candidate before changing its offline source log.
  restoreSyntheticRecords(handle.meta, [...handle.store.commits, commit]);
  handle.close();
  fs.appendFileSync(commitsFile, JSON.stringify(commit) + '\n');
  return commit;
}
