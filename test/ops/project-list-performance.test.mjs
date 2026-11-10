/**
 * 测试职责：约束项目列表热路径零日志读取，冷重放离线程且受缓存、并发和截止预算限制。
 * 典型流程：合成约 10 MiB 日志/受控 Worker → list/HTTP/close/变动日志 → 对照 I/O、响应与 worker 计数。
 * 覆盖边界：覆盖 single-flight、缓存失效、取消及资源预算；不覆盖真实大规模生产 store 或 UI。
 * 外部前置：无；需要 Node worker_threads 和临时目录。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import workerThreads from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { ProjectService } from '../../lib/core/service.js';
import { makeCommit } from '../../lib/core/store.js';
import { projectsRoute } from '../../lib/host/routes/projects.js';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-list-perf-'));
  const workspacePath = path.join(root, 'workspace');
  fs.mkdirSync(workspacePath);
  const service = await new ProjectService({ rootDir: path.join(root, 'state') }).init();
  const handle = await service.createProject({ workspacePath, name: 'Performance fixture' });
  t.after(() => service.close());
  return { root, service, handle, log: path.join(handle.meta.dir, 'commits.jsonl') };
}

function appendSyntheticLog(log, count = 700) {
  // Valid hash-chain envelopes, deliberately not a claim that these padding
  // records went through the user command state machine. ~10 MiB old history.
  const genesis = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').at(-1));
  let prev = genesis.hash;
  const lines = [];
  for (let n = 1; n <= count; n += 1) {
    const commit = makeCommit(genesis.seq + n, prev,
      { kind: 'system', via: 'system', fixturePadding: 'x'.repeat(15_000) },
      'perf_' + n, genesis.seq + n - 1, []);
    prev = commit.hash;
    lines.push(JSON.stringify(commit));
  }
  fs.appendFileSync(log, lines.join('\n') + '\n');
  return genesis.seq + count;
}

function forbidLogRead(t, service) {
  let reads = 0;
  const original = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (file, ...rest) {
    if (String(file).startsWith(service.projectsDir)) {
      reads += 1;
      throw new Error('main-thread store body read is forbidden');
    }
    return original.call(this, file, ...rest);
  });
  return () => reads;
}

function response() {
  return { headers: {}, writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = JSON.parse(body); } };
}

// 责任：热列表及 HTTP 反复读取须复用活 writer，不读日志正文且返回值不可反向污染缓存。
test('hot project listing/HTTP never reopens a live writer or reads log bodies', async (t) => {
  const { service, handle } = await fixture(t);
  const reads = forbidLogRead(t, service);
  for (let n = 0; n < 50; n += 1) {
    const rows = await service.listProjectsAsync();
    assert.equal(rows[0].rev, handle.rev);
    rows[0].name = 'caller mutation';
  }
  const res = response();
  await projectsRoute({}, res, { service }, 'GET');
  assert.equal(res.body.projects[0].name, 'Performance fixture');
  assert.equal(service._projectList.metrics.replayRequests, 0);
  assert.equal(reads(), 0);
  t.mock.restoreAll();
  const before = handle.rev;
  await handle.command({ op: 'session.checkpoint', cmdId: 'list-revision',
    actor: { kind: 'agent', sessionId: 'perf-session' }, note: 'new revision' });
  assert.ok(handle.rev > before);
  assert.equal((await service.listProjectsAsync())[0].rev, handle.rev);
});

// 责任：冷十 MiB 列表须离线程、single-flight、可缓存且不拿锁，定时器不能被同步重放阻塞。
test('cold 10MiB listing is off-thread, single-flight, cached, lock-free and mutation-safe', async (t) => {
  const { service, handle, log } = await fixture(t);
  handle.close();
  const expectedRev = appendSyntheticLog(log);
  const reads = forbidLogRead(t, service);
  let ticks = 0;
  let maxGap = 0;
  let previous = performance.now();
  const timer = setInterval(() => {
    const now = performance.now(); maxGap = Math.max(maxGap, now - previous); previous = now; ticks += 1;
  }, 5);
  let batch;
  try { batch = await Promise.all(Array.from({ length: 20 }, () => service.listProjectsAsync())); }
  finally { clearInterval(timer); }
  assert.equal(batch[0][0].rev, expectedRev);
  assert.equal(service._projectList.metrics.replayRequests, 1, 'one replay, not twenty');
  assert.equal(service._projectList.metrics.coalesced, 19);
  assert.ok(ticks > 0, 'event loop must service timers while history replays');
  // Deliberately looser than the production SLO to tolerate shared CI runners;
  // zero main-thread reads and replay counts are deterministic hard gates.
  assert.ok(maxGap < 500, 'event-loop gap ' + maxGap.toFixed(1) + 'ms exceeds regression budget');
  assert.equal(reads(), 0);
  batch[0][0].name = 'mutated';
  assert.equal(batch[1][0].name, 'Performance fixture');
  for (let n = 0; n < 20; n += 1) assert.equal((await service.listProjectsAsync())[0].rev, expectedRev);
  assert.equal(service._projectList.metrics.replayRequests, 1, 'unchanged log must not replay again');
  assert.equal(fs.existsSync(path.join(handle.meta.dir, 'lock.json')), false);
  t.diagnostic(JSON.stringify({ fixtureBytes: fs.statSync(log).size, maxGapMs: maxGap, ticks,
    ...service._projectList.metrics }));
  t.mock.restoreAll();
});

// 责任：外部追加、同大小损坏及修复替换都必须使列表投影缓存失效。
test('foreign append, same-size corruption and repaired replacement invalidate list projection', async (t) => {
  const { service, handle, log } = await fixture(t);
  handle.close();
  const first = (await service.listProjectsAsync())[0];
  const nextRev = appendSyntheticLog(log, 1);
  assert.equal((await service.listProjectsAsync())[0].rev, nextRev);
  assert.ok(nextRev > first.rev);
  const good = fs.readFileSync(log, 'utf8');
  const broken = good.replace('Performance fixture', 'Xerformance fixture');
  assert.equal(broken.length, good.length);
  fs.writeFileSync(log, broken);
  const bad = (await service.listProjectsAsync())[0];
  assert.equal(bad.phase, 'unknown');
  assert.match(bad.error, /hash/i, 'corruption cannot be reported as healthy cached counts');
  fs.writeFileSync(log, good);
  const repaired = (await service.listProjectsAsync())[0];
  assert.equal(repaired.rev, nextRev);
  assert.equal(repaired.error, undefined);
  assert.equal(service.handles.get(handle.id), handle, 'listing never acquires a new writer');
  assert.equal(handle.closed, true);
});

// 责任：只读 handle 不得当热 writer 复用，service close 必须取消活动列表。
test('read-only handle is never reused and close cancels an active listing', async (t) => {
  const { service, handle, log } = await fixture(t);
  const reader = service._projectList;
  handle.store.readOnly = true;
  assert.equal(reader.live(handle.id), null);
  handle.store.readOnly = false;
  handle.close();
  appendSyntheticLog(log);
  const pending = service.listProjectsAsync();
  const rejection = assert.rejects(pending, /closed/);
  await service.close();
  await rejection;
  await assert.rejects(service.listProjectsAsync(), /closed/);
});

// 责任：热列表微任务发布前 close 时，原调用者和合并调用者都必须拒绝。
test('close before a hot list microtask publishes rejects both original and coalesced callers', async (t) => {
  const { service } = await fixture(t);
  const requests = [service.listProjectsAsync(), service.listProjectsAsync()];
  const results = Promise.allSettled(requests);
  await service.close();
  assert.ok((await results).every((r) => r.status === 'rejected' && /closed/.test(r.reason.message)));
});

function controlledWorkers(t) {
  const workers = [];
  let active = 0;
  let peak = 0;
  class ControlledWorker extends EventEmitter {
    constructor() { super(); workers.push(this); active += 1; peak = Math.max(peak, active); }
    terminate() {
      return this.stopping ||= new Promise((resolve) => {
        this.stop = () => { active -= 1; this.stop = null; resolve(0); };
      });
    }
  }
  // mock.method preserves the real constructor's newTarget/prototype. Return an
  // explicit instance so Node's native Worker.terminate never sees a fake handle.
  t.mock.method(workerThreads, 'Worker', function () { return new ControlledWorker(); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { workers, peak: () => peak };
}

// A deliberately stalled termination is deterministic: no wall-clock sleep,
// fake successful replay, or memory-pressure crash is needed to test backpressure.
// 责任：模拟 worker 延迟退出及消息后 close 时，跨 service worker/队列上限仍须成立。
test('cross-service worker and queue caps survive delayed termination and close-after-message', async (t) => {
  const { workers, peak } = controlledWorkers(t);
  const services = Array.from({ length: 20 }, () => new ProjectService({ rootDir: os.tmpdir() }));
  const results = Promise.allSettled(services.map((s) => s._projectList.replay([])));
  try {
    assert.equal(workers.length, 2, 'only two workers across all services');
    workers[0].emit('message', []);
    await Promise.resolve();
    assert.equal(workers.length, 2, 'a received result does not free a terminating worker slot');
    const closing = services[0].close();
    workers[0].stop();
    await closing;
    assert.equal(workers.length, 3, 'exactly one queued replacement starts after termination');
  } finally {
    const closing = services.map((s) => s.close());
    for (const worker of workers) worker.stop?.();
    await Promise.all(closing);
  }
  const settled = await results;
  assert.equal(peak(), 2);
  assert.equal(settled.filter((r) => r.status === 'rejected' && /busy/.test(r.reason.message)).length, 2);
  assert.equal(settled.filter((r) => r.status === 'rejected' && /closed/.test(r.reason.message)).length, 18,
    'including the result received before close but not yet published');
});

// 责任：排队或运行列表超时须拒绝，但未真正退出的 worker 不能提前释放额度。
test('queued and running listing deadlines reject without freeing a still-terminating worker', async (t) => {
  const { workers } = controlledWorkers(t);
  const services = Array.from({ length: 3 }, () => new ProjectService({ rootDir: os.tmpdir() }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const results = Promise.allSettled(services.map((s) => s._projectList.replay([])));
  t.mock.timers.tick(30_001);
  assert.equal(workers.length, 2, 'queued request expired before a worker slot was released');
  for (const worker of workers) worker.stop?.();
  const settled = await results;
  assert.ok(settled.every((r) => r.status === 'rejected' && /30s budget/.test(r.reason.message)));
  t.mock.timers.reset();
  await Promise.all(services.map((s) => s.close()));
});
