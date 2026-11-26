/**
 * 测试职责：模型私有工作态、物理回执、发布失败屏障及生命周期原子性。
 * 典型流程：合成 disk/memory 项目 → 故障注入 → 重试或冷回放 → 对照提交事实。
 * 覆盖边界：覆盖业务拒绝、物理失败、发布失败、共享权限及离线修复；不覆盖真实硬件断电。
 * 外部前置：无，统一由候选离线 runner 隔离环境。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectService } from '../../lib/core/service.js';
import { MemoryStore, JsonlStore, makeCommit } from '../../lib/core/store.js';
import { createWorkingContext } from '../../lib/core/transaction/work.js';
import { TransactionModel } from '../../lib/core/transaction/model.js';
import { digestFromPublished } from '../../lib/core/projection/views.js';

const actor = { kind: 'agent', sessionId: 'tx-session', agentId: 'tx-agent' };
const human = { kind: 'human', via: 'test' };
let n = 0;
const command = (op, extra = {}) => ({ cmdId: 'tx-' + ++n, actor, op, ...extra });
async function setup(t, options = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-model-tx-'));
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-model-tx-ws-'));
  const svc = await new ProjectService({ rootDir, ...options }).init();
  t.after(() => svc.close());
  const h = await svc.createProject({ workspacePath, name: 'transaction' });
  return { svc, h, rootDir, workspacePath };
}
async function claimed(h) {
  await h.attach({ ...actor, source: 'test' });
  const created = await h.command(command('task.create', { title: 'leased', acceptance: [{ text: 'done' }] }));
  const taskId = created.events.find(e => e.type === 'task/created').taskId;
  assert.equal(h.state.tasks[taskId].state, 'ready');
  await h.command(command('task.claim', { taskId, expected: { entityRev: h.state.tasks[taskId].rev } }));
  return taskId;
}

for (const memory of [false, true]) {
  // 责任：磁盘与内存均由一个物理回执发布一次事实，相同命令先去重再判断版本。
  test((memory ? 'memory' : 'disk') + ': one receipt publishes one command and cmdId dedupes before stale revision', async t => {
    const { h } = await setup(t, memory ? { storeFactory: (_dir, meta) => new MemoryStore(meta) } : {});
    let writes = 0;
    const physical = h.store.commitPhysical.bind(h.store);
    h.store.commitPhysical = commit => { writes++; return physical(commit); };
    const before = h.committedSnapshot();
    const cmd = command('task.create', { title: 'one record', acceptance: [{ text: 'done' }], expected: { projectRev: h.rev } });
    const result = await h.command(cmd);
    assert.equal(result.committed, true);
    assert.equal(writes, 1);
    const taskId = result.events.find(e => e.type === 'task/created').taskId;
    assert.equal(before.state.tasks[taskId], undefined);
    assert.equal(h.state.tasks[taskId].title, 'one record');
    assert.equal((await h.command(cmd)).deduped, true);
    assert.equal(writes, 1);
    const replay = new MemoryStore(h.meta, h.store.commits);
    assert.deepEqual(replay.open().state, h.state);
  });
}

// 责任：私有命令工作态不提供写者能力，修改工作态不能污染已提交值。
test('command workspace has no writer, service, store, or live-state authority', async t => {
  const { svc, h } = await setup(t);
  const work = createWorkingContext(h.model, { service: svc, store: h.store, meta: h.meta, clock: h.clock });
  for (const key of ['store', 'service', 'command', 'recover', 'close', '_appendEvents']) assert.equal(work[key], undefined, key);
  assert.throws(() => { work.state.project.name = 'private'; }, TypeError);
  work.leases.set('fake', {});
  assert.equal(h.name, 'transaction');
  assert.equal(h.leases.has('fake'), false);
});

for (const operation of ['attach', 'detach', 'recover']) {
  // 责任：绑定、解绑及恢复写入失败均保留原租约、绑定、水位和恢复标志。
  test(operation + ' failure does not publish leases, bindings, recovery flag or revision', async t => {
    const { h } = await setup(t);
    const taskId = await claimed(h);
    const before = h.committedSnapshot();
    if (operation === 'recover') h.recovered = false;
    const physical = h.store.commitPhysical.bind(h.store);
    h.store.commitPhysical = () => { throw Object.assign(new Error('synthetic write failure'), { code: 'EIO' }); };
    const invoke = () => operation === 'attach' ? h.attach({ sessionId: actor.sessionId })
      : operation === 'detach' ? h.detach(actor.sessionId) : Promise.resolve().then(() => h.recover());
    await assert.rejects(invoke(), { code: 'EIO' });
    assert.deepEqual(h.committedSnapshot(), before);
    if (operation === 'recover') assert.equal(h.recovered, false);
    h.store.commitPhysical = physical;
    await invoke();
    assert.equal(h.leases.has(taskId), false);
    assert.equal(h.rev, before.lastSeq + 1);
  });
}

// 责任：同步落盘后发布失败必须关闭写门，冷回放及相同命令重试只能看见一条事实。
test('publication failure after fsync closes writer; cold replay sees exactly one durable fact', async t => {
  const { svc, h, rootDir } = await setup(t);
  const cmd = command('task.create', { title: 'durable unpublished', acceptance: [{ text: 'done' }] });
  const before = h.committedSnapshot();
  const physical = h.store.commitPhysical.bind(h.store);
  h.store.commitPhysical = commit => {
    const receipt = physical(commit);
    return { get seq() { throw new Error('synthetic post-fsync receipt observation failure'); }, hash: receipt.hash };
  };
  await assert.rejects(h.command(cmd), { code: 'log-write-uncertain' });
  assert.equal(h.readOnly, true);
  assert.deepEqual(h.committedSnapshot(), before);
  await assert.rejects(h.command(cmd), { code: 'read-only' });
  const id = h.id;
  await svc.close();
  const cold = await new ProjectService({ rootDir }).init();
  t.after(() => cold.close());
  const reopened = await cold.open(id);
  assert.equal((await reopened.command(cmd)).deduped, true);
  assert.equal(Object.values(reopened.state.tasks).filter(task => task.title === 'durable unpublished').length, 1);
  assert.equal(reopened.store.commits.filter(c => c.cmdId === cmd.cmdId).length, 1);
});

for (const privilegedFirst of [false, true]) {
  // 责任：两种打开顺序均隔离各服务内嵌写权限，并共享同一个版本串行区。
  test('shared writer preserves per-service inline authority; privileged opener=' + privilegedFirst, async t => {
    const { svc, h, rootDir } = await setup(t, { privilegedInlineWrites: privilegedFirst });
    const other = await new ProjectService({ rootDir, privilegedInlineWrites: !privilegedFirst }).init();
    t.after(() => other.close());
    const second = await other.open(h.id);
    const privileged = privilegedFirst ? h : second;
    const normal = privilegedFirst ? second : h;
    const doc = command('doc.put', { title: 'authorized only', body: 'synthetic body', actor: human });
    const before = h.rev;
    await assert.rejects(normal.command(doc), { code: 'inline-write-disabled' });
    assert.equal(h.rev, before);
    assert.equal((await privileged.command(doc)).committed, true);
    assert.equal(h.rev, second.rev);
    const rev = h.rev;
    const results = await Promise.allSettled([normal.command(command('session.checkpoint', { note: 'a', expected: { projectRev: rev } })),
      privileged.command(command('session.checkpoint', { note: 'b', expected: { projectRev: rev } }))]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.code, 'stale-revision');
  });
}

// 责任：可信活性仅更新运行时，不消耗显式续期次数、不落快照，普通查询不续租。
test('trusted activity is runtime-only; snapshots and unrelated commits never persist it', async t => {
  let now = Date.parse('2030-01-01T00:00:00Z');
  const { h } = await setup(t, { clock: () => new Date(now) });
  const taskId = await claimed(h);
  const before = h.committedSnapshot();
  const durableSeen = h.model.persistedState.bindings[actor.sessionId].lastSeenAt;
  now += 10000;
  h.touch(actor.sessionId);
  assert.equal(h.state.bindings[actor.sessionId].lastSeenAt, new Date(now).toISOString());
  assert.equal(before.state.bindings[actor.sessionId].lastSeenAt, durableSeen);
  assert.equal(h.leases.get(taskId).renewCount, 0, 'trusted activity is not an explicit renewal');
  assert.ok(Date.parse(h.leases.get(taskId).expiresAt) > Date.parse(before.leases.get(taskId).expiresAt));
  await h.command(command('session.checkpoint', { note: 'runtime isolation' }));
  h.store.saveSnapshot();
  const snapshot = JSON.parse(fs.readFileSync(h.store.snapshotFile, 'utf8'));
  assert.equal(snapshot.state.bindings[actor.sessionId].lastSeenAt, durableSeen);
  assert.equal(h.state.bindings[actor.sessionId].lastSeenAt, new Date(now).toISOString());
  const checkpoint = h.store.commits.at(-1).events.find(e => e.type === 'session/checkpoint');
  assert.equal(checkpoint.data.at, new Date(now).toISOString());
  const saved = h.committedSnapshot();
  for (const view of ['board', 'brief', 'events', 'docs']) h.query(view);
  assert.deepEqual(h.committedSnapshot(), saved, 'ordinary queries changed runtime or committed data');
});

// 责任：冷恢复失败不能缓存或共享半初始化写者，重试成功后不重复恢复。
test('failed cold recovery never caches or shares a half-initialized writer', async t => {
  const { svc, h, rootDir } = await setup(t);
  const taskId = await claimed(h);
  const id = h.id;
  const rev = h.rev;
  await svc.close();
  const cold = await new ProjectService({ rootDir, storeFactory: (dir, meta) => {
    const store = new JsonlStore(dir, meta);
    store.commitPhysical = () => { throw Object.assign(new Error('synthetic recovery failure'), { code: 'EIO' }); };
    return store;
  } }).init();
  t.after(() => cold.close());
  await assert.rejects(cold.open(id), { code: 'EIO' });
  assert.equal(cold.handles.size, 0);
  assert.equal(cold.lookupLiveWriter(id), null);
  assert.equal(fs.existsSync(path.join(h.meta.dir, 'lock.json')), false);
  cold.storeFactory = (dir, meta) => new JsonlStore(dir, meta);
  const recovered = await cold.open(id);
  assert.equal(recovered.rev, rev + 1);
  assert.equal(recovered.state.tasks[taskId].state, 'ready');
  const second = await new ProjectService({ rootDir }).init();
  t.after(() => second.close());
  const shared = await second.open(id);
  assert.equal(shared.rev, recovered.rev, 'second service repeated recovery');
  assert.equal(shared.store, recovered.store);
});

// 责任：未改实体保持结构共享，后续提交不急切复制整条时间线或改变旧读值。
test('prepare shares untouched entities and does not flatten the full timeline on every commit', async t => {
  const { h } = await setup(t);
  const one = await h.command(command('task.create', { title: 'unchanged', acceptance: [{ text: 'done' }] }));
  const id = one.events.find(e => e.type === 'task/created').taskId;
  const stable = h.state.tasks[id];
  const timeline = h.timeline;
  const flat = Array.prototype.flat;
  let historyFlattens = 0;
  Array.prototype.flat = function (...args) {
    if (this.some(rows => Array.isArray(rows) && rows.some(row => row?.cmdId === one.cmdId))) historyFlattens++;
    return flat.apply(this, args);
  };
  try { await h.command(command('session.checkpoint', { note: 'one row' })); }
  finally { Array.prototype.flat = flat; }
  assert.equal(historyFlattens, 0, 'commit eagerly flattened the actual retained timeline');
  assert.equal(h.state.tasks[id], stable, 'untouched entity was unnecessarily cloned');
  assert.equal(h.timeline.length, timeline.length + 1);
  assert.equal(timeline.at(-1).seq, h.rev - 1, 'prior timeline value changed');
});

async function damagedAcceptance(h) {
  const taskId = await claimed(h);
  const original = structuredClone(h.state.tasks[taskId].acceptance);
  const historical = original.map(acc => ({ ...acc, met: true, evidenceIds: ['fixture-evidence'] }));
  const replace = acceptance => {
    // Historical corruption exists only in this synthetic CLOSED-writer fixture.
    // Reopen its verified log without lifecycle recovery; retain volatile leases
    // separately so this fixture does not invent persistent lease resurrection.
    const leases = structuredClone(h.leases), meta = h.meta;
    const commit = makeCommit(h.rev + 1, h.lastHash, human, 'synthetic-history-' + ++n, h.rev,
      [{ type: 'task/updated', taskId, data: { ...structuredClone(h.state.tasks[taskId]), acceptance, rev: h.state.tasks[taskId].rev + 1 } }]);
    const file = h.store.commitsFile;
    h.close();
    fs.appendFileSync(file, JSON.stringify(commit) + '\n');
    const store = new JsonlStore(meta.dir, meta);
    const data = store.open();
    store.model = new TransactionModel(data, { leases });
    h.store = store; h.model = store.model;
    h.closed = false;
    assert.deepEqual(h.leases, leases, 'synthetic constructor failed to preserve supplied runtime facts');
  };
  replace(historical);
  replace([]);
  const other = await h.command(command('task.create', { title: 'never overwrite', acceptance: [{ text: 'keep' }] }));
  const otherId = other.events.find(e => e.type === 'task/created').taskId;
  return { taskId, historical, otherId };
}

// 责任：冷热修复都只用一次版本比较提交原历史验收项，不覆盖非空项、不隐式恢复，并保持幂等。
for (const cold of [false, true]) test('offline acceptance repair has one CAS transaction, exact history and no recovery; cold=' + cold, async t => {
  const { svc, h, rootDir } = await setup(t, { offlineMaintenance: true });
  const { taskId, historical, otherId } = await damagedAcceptance(h);
  const id = h.id;
  const expectedRev = h.rev;
  const expectedHash = h.lastHash;
  const state = h.state.tasks[taskId].state;
  const other = structuredClone(h.state.tasks[otherId]);
  let maintenance = svc;
  if (cold) {
    await svc.close();
    maintenance = await new ProjectService({ rootDir, offlineMaintenance: true }).init();
    t.after(() => maintenance.close());
  }
  const req = { expectedRev, expectedHash, taskIds: [taskId, otherId, taskId] };
  await assert.rejects(maintenance.restoreHistoricalAcceptance(id, { ...req, expectedHash: 'wrong' }), { code: 'stale-revision' });
  await assert.rejects(maintenance.restoreHistoricalAcceptance(id, { ...req, events: [] }), { code: 'invalid-command' });
  const result = await maintenance.restoreHistoricalAcceptance(id, req);
  assert.equal(result.seq, expectedRev + 1);
  assert.equal(result.count, 1);
  const read = maintenance.peekProjectState(id);
  assert.deepEqual(read.tasks[taskId].acceptance, historical, 'repair reset IDs or accepted evidence');
  assert.equal(read.tasks[taskId].state, state, 'repair performed a lifecycle recovery');
  assert.deepEqual(read.tasks[otherId], other, 'repair overwrote nonempty current acceptance');
  const commits = fs.readFileSync(h.store.commitsFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(commits.at(-1).actor.kind, 'system');
  assert.equal(commits.at(-1).actor.via, 'repair');
  assert.equal(commits.at(-1).events.length, 1);
  assert.equal(commits.at(-1).events[0].type, 'task/updated');
  assert.equal(await maintenance.restoreHistoricalAcceptance(id, { ...req, expectedRev: result.seq, expectedHash: result.hash }), null);
  await assert.rejects(maintenance.restoreHistoricalAcceptance(id, req), { code: 'stale-revision' });
  assert.equal(maintenance.handles.size, cold ? 0 : 1, 'maintenance-only writer escaped into ordinary registry');
  if (cold) assert.equal(maintenance.lookupLiveWriter(id), null);
});

// 责任：普通服务不能借用运维权限，活服务共享时拒绝修复，并发修复只允许一个版本成功。
test('offline authority cannot be borrowed or bypass a shared live service', async t => {
  const { h, svc, rootDir } = await setup(t, { offlineMaintenance: true });
  const { taskId } = await damagedAcceptance(h);
  const req = { expectedRev: h.rev, expectedHash: h.lastHash, taskIds: [taskId] };
  const normal = await new ProjectService({ rootDir }).init();
  t.after(() => normal.close());
  await assert.rejects(normal.restoreHistoricalAcceptance(h.id, req), { code: 'forbidden-role' });
  const ordinary = await normal.open(h.id);
  const raw = fs.readFileSync(ordinary.store.commitsFile), before = ordinary.committedSnapshot();
  const binding = [{ kind: 'lifecycle.attach', args: { sessionId: 'other-session' } }];
  const repair = [{ kind: 'lifecycle.restoreAcceptance', args: req }];
  const system = { kind: 'system', via: 'repair' };
  const identity = { cmdId: 'wrong-source', actor };
  for (const [who, ops] of [[actor, binding], [actor, repair], [system, repair]]) {
    assert.throws(() => ordinary.model.lifecycle({ ...identity, actor: who }, ops, ordinary._transactionPorts(normal)), { code: 'forbidden-role' });
  }
  assert.throws(() => ordinary._systemOperations(identity, binding), { code: 'forbidden-role' });
  assert.throws(() => ordinary._systemOperations({ ...identity, actor: system }, repair), { code: 'forbidden-role' });
  assert.deepEqual(ordinary.committedSnapshot(), before);
  assert.deepEqual(fs.readFileSync(ordinary.store.commitsFile), raw);
  await assert.rejects(svc.restoreHistoricalAcceptance(h.id, req), { code: 'log-busy' });
  await normal.close();
  const results = await Promise.allSettled([svc.restoreHistoricalAcceptance(h.id, req), svc.restoreHistoricalAcceptance(h.id, req)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'stale-revision');
  assert.equal(h.rev, req.expectedRev + 1);
});

// 责任：过期清理物理写入失败保留实时租约和任务状态，重试才一起发布清理事实。
test('expiry sweep failure keeps the live lease table and committed task intact', async t => {
  let now = Date.parse('2030-01-01T00:00:00Z');
  const { h } = await setup(t, { clock: () => new Date(now) });
  const id = await claimed(h);
  now += 86400000;
  const before = h.committedSnapshot();
  const append = h.store.commitPhysical;
  h.store.commitPhysical = () => { throw Object.assign(new Error('expiry physical failure'), { code: 'EIO' }); };
  assert.throws(() => h._expireLeases(), { code: 'EIO' });
  assert.deepEqual(h.committedSnapshot(), before);
  h.store.commitPhysical = append;
  h._expireLeases();
  assert.equal(h.leases.has(id), false);
  assert.equal(h.state.tasks[id].state, 'ready');
  assert.equal(h.rev, before.lastSeq + 1);
});

// 责任：同步落盘后的回执字段读取失败必须只读停写，冷回放后重试按命令去重。
test('receipt hash observation failure after durable append gates writer and cold retry dedupes', async t => {
  const { svc, h, rootDir } = await setup(t);
  const id = h.id;
  const cmd = command('task.create', { title: 'durable receipt uncertainty', acceptance: [{ text: 'done' }] });
  const before = h.committedSnapshot();
  const physical = h.store.commitPhysical.bind(h.store);
  h.store.commitPhysical = commit => {
    const receipt = physical(commit);
    return { seq: receipt.seq, get hash() { throw new Error('synthetic receipt hash observation fault'); } };
  };
  await assert.rejects(h.command(cmd), error => error.code === 'log-write-uncertain' && error.details.phase === 'publish');
  assert.deepEqual(h.committedSnapshot(), before);
  assert.equal(h.store.readOnly, true);
  assert.equal(h.store.heartbeatTimer, null);
  await assert.rejects(h.command(command('task.create', { title: 'blocked' })), { code: 'read-only' });
  await svc.close();
  const cold = await new ProjectService({ rootDir }).init();
  t.after(() => cold.close());
  const reopened = await cold.open(id);
  assert.equal(reopened.rev, before.lastSeq + 1);
  assert.equal((await reopened.command(cmd)).deduped, true);
  assert.equal(reopened.store.commits.filter(c => c.cmdId === cmd.cmdId).length, 1);
});

// 责任：物理回执身份不符时拒绝发布且关闭写门，旧提交快照保持完整。
test('physical receipt must identify exactly the requested durable commit', async t => {
  const { h } = await setup(t);
  const physical = h.store.commitPhysical.bind(h.store);
  const before = h.committedSnapshot();
  h.store.commitPhysical = commit => ({ ...physical(commit), hash: 'wrong-receipt' });
  await assert.rejects(h.command(command('task.create', { title: 'wrong receipt', acceptance: [{ text: 'done' }] })), { code: 'log-write-uncertain' });
  assert.deepEqual(h.committedSnapshot(), before);
  assert.equal(h.store.readOnly, true);
});

// 责任：普通视图和提示只捕获轻量发布值，禁止复制命令全集或摊平时间线，延迟历史固定在原水位。
test('published values capture large history lazily and remain pinned after later commands', async t => {
  const { svc, h } = await setup(t);
  for (let i = 0; i < 256; i++) await h.command(command('session.checkpoint', { note: 'synthetic history ' + i }));
  const first = command('session.checkpoint', { note: 'captured checkpoint' });
  await h.command(first);
  const rev = h.rev, hash = h.lastHash;
  const calibration = new Set([first.cmdId]);
  // Probe the real collection behaviors, not a clone returned by a getter.
  // This still detects an eager clone inside a public cmdIds facade itself.
  const originals = { set: Set.prototype[Symbol.iterator], forEach: Set.prototype.forEach,
    array: Array.prototype[Symbol.iterator], slice: Array.prototype.slice, flat: Array.prototype.flat,
    clone: globalThis.structuredClone };
  const has = Set.prototype.has, some = Array.prototype.some;
  const historyBearing = array => some.call(array, row => row === first.cmdId || row?.cmdId === first.cmdId
    || (Array.isArray(row) && some.call(row, item => item === first.cmdId || item?.cmdId === first.cmdId)));
  Set.prototype[Symbol.iterator] = function () {
    if (has.call(this, first.cmdId)) throw new Error('command ID scan');
    return originals.set.call(this);
  };
  Set.prototype.forEach = function (...args) {
    if (has.call(this, first.cmdId)) throw new Error('command ID scan');
    return originals.forEach.apply(this, args);
  };
  for (const [key, original] of [[Symbol.iterator, originals.array], ['slice', originals.slice], ['flat', originals.flat]]) {
    Array.prototype[key] = function (...args) {
      if (historyBearing(this)) throw new Error('full history copy');
      return original.apply(this, args);
    };
  }
  globalThis.structuredClone = function (value, ...args) {
    if ((value instanceof Set && has.call(value, first.cmdId)) || (Array.isArray(value) && historyBearing(value))) throw new Error('full history copy');
    return originals.clone(value, ...args);
  };
  let published;
  try {
    assert.throws(() => new Set(calibration), /command ID scan/, 'probe cannot detect an actual eager Set clone');
    assert.throws(() => originals.slice.call([first.cmdId]).slice(), /full history copy/, 'probe cannot detect an actual eager array clone');
    published = svc.publishedState(h.id);
    assert.deepEqual(svc.publishedRevision(h.id), { lastSeq: rev, lastHash: hash });
    const board = await svc.query(h.id, 'board');
    assert.equal(board.projectRev, rev);
    assert.match(digestFromPublished(published, actor.sessionId, {}, Date.now()), /captured checkpoint/);
    assert.equal(Array.isArray(published.commits), true);
    assert.equal(published.commits.at(-1).cmdId, first.cmdId);
    assert.throws(() => published.commits.push({}), TypeError);
    assert.throws(() => { published.commits[0] = {}; }, TypeError);
    assert.throws(() => Object.defineProperty(published.commits, '0', { value: {} }), TypeError);
  } finally {
    Set.prototype[Symbol.iterator] = originals.set;
    Set.prototype.forEach = originals.forEach;
    Array.prototype[Symbol.iterator] = originals.array;
    Array.prototype.slice = originals.slice;
    Array.prototype.flat = originals.flat;
    globalThis.structuredClone = originals.clone;
  }
  const next = command('session.checkpoint', { note: 'later checkpoint' });
  await h.command(next);
  assert.equal(published.commits.length, rev);
  assert.equal(published.commits[rev], undefined);
  assert.equal(rev in published.commits, false);
  assert.equal(Object.getOwnPropertyDescriptor(published.commits, String(rev)), undefined);
  assert.equal(Object.keys(published.commits).length, rev);
  assert.equal(published.commits.slice().at(-1).cmdId, first.cmdId);
  assert.equal([...published.commits].at(-1).cmdId, first.cmdId);
  assert.equal(published.timeline.at(-1).cmdId, first.cmdId);
  assert.equal(published.cmdIds.has(first.cmdId), true);
  assert.equal(published.cmdIds.has(next.cmdId), false);
  published.cmdIds.clear();
  assert.equal(h.cmdIds.has(first.cmdId), true);
});

// 责任：冷态兼容查询只走隔离读端口，不打开写者、不恢复租约、不改日志或创建锁。
test('service query cold compatibility never opens a writer or performs recovery', async t => {
  const { svc, h, rootDir } = await setup(t);
  const id = h.id, rev = h.rev, dir = h.meta.dir;
  await svc.close();
  const log = path.join(dir, 'commits.jsonl');
  const before = fs.readFileSync(log, 'utf8');
  const cold = await new ProjectService({ rootDir,
    storeFactory: () => { throw new Error('read opened writable store'); },
  }).init();
  t.after(() => cold.close());
  cold.open = cold._openSync = () => { throw new Error('read opened writer'); };
  const value = await cold.query(id, 'summary');
  assert.equal(value.projectRev, rev);
  assert.equal(value.id, id);
  assert.equal(cold.handles.size, 0);
  assert.equal(cold.publishedRevision(id), null);
  assert.equal(fs.existsSync(path.join(dir, 'lock.json')), false);
  assert.equal(fs.readFileSync(log, 'utf8'), before);
});

// 责任：归档项目的绑定与解绑只修改模型运行态草稿，不写日志、不污染持久快照，解档后显式绑定才成为事实。
test('archived lifecycle bindings remain ephemeral until a later explicit persistent attach', async t => {
  const { h } = await setup(t);
  await h.attach({ ...actor, source: 'test' });
  await h.command(command('project.update', { actor: human, phase: 'archived' }));
  const durable = structuredClone(h.model.persistedState.bindings);
  const revision = h.rev, hash = h.lastHash, bytes = fs.readFileSync(h.store.commitsFile);
  const next = await h.attach({ ...actor, source: 'archived-read' });
  assert.equal(next.epoch, durable[actor.sessionId].epoch + 1);
  assert.equal(h.state.bindings[actor.sessionId].source, 'archived-read');
  await h.detach(actor.sessionId);
  assert.ok(h.state.bindings[actor.sessionId].detachedAt);
  assert.equal(h.rev, revision);
  assert.equal(h.lastHash, hash);
  assert.deepEqual(fs.readFileSync(h.store.commitsFile), bytes);
  assert.deepEqual(h.model.persistedState.bindings, durable);
  h.store.saveSnapshot();
  assert.deepEqual(JSON.parse(fs.readFileSync(h.store.snapshotFile, 'utf8')).state.bindings, durable);
  await h.command(command('project.update', { actor: human, phase: 'active' }));
  assert.deepEqual(h.model.persistedState.bindings, durable, 'unrelated unarchive persisted ephemeral binding');
  const final = await h.attach({ ...actor, source: 'reopened' });
  assert.equal(h.model.persistedState.bindings[actor.sessionId].epoch, final.epoch);
  assert.equal(h.store.commits.at(-1).events.at(-1).type, 'session/bound');
});

// 责任：生命周期只暴露固定名称与参数，不接受预制状态或事件，公开命令注册表不能调用生命周期私钥。
test('lifecycle bootstrap rejects arbitrary payloads and is absent from the public command surface', async t => {
  const { h } = await setup(t);
  const before = h.committedSnapshot();
  await assert.rejects(h.command(command('lifecycle.bootstrap')), { code: 'invalid-command' });
  for (const args of [{ events: [] }, { project: structuredClone(h.state.project) }, {}]) {
    assert.throws(() => h._systemOperations({ op: 'lifecycle.bootstrap', actor: human, cmdId: 'forged-bootstrap-' + ++n },
      [{ kind: 'lifecycle.bootstrap', args }]), error => ['invalid-command', 'illegal-transition'].includes(error.code));
  }
  assert.deepEqual(h.committedSnapshot(), before);
});

for (const memory of [false, true]) {
  // 责任：非有限权重必须在写前拒绝，内存/磁盘任务、租约、版本和日志不变；成功有限值与冷回放严格相等。
  test((memory ? 'memory' : 'disk') + ': non-finite weights reject without publication and finite success matches cold replay', async t => {
    const { h } = await setup(t, memory ? { storeFactory: (_dir, meta) => new MemoryStore(meta) } : {});
    const created = await h.command(command('task.create', { title: 'finite weight oracle', weight: 2.5, acceptance: [{ text: 'valid' }] }));
    const taskId = created.events.find(row => row.type === 'task/created').taskId;
    let writes = 0;
    const physical = h.store.commitPhysical.bind(h.store);
    h.store.commitPhysical = commit => { writes++; return physical(commit); };
    for (const weight of [Infinity, -Infinity, NaN]) {
      const before = h.committedSnapshot();
      const commits = structuredClone([...h.store.commits]);
      const bytes = memory ? null : fs.readFileSync(h.store.commitsFile);
      for (const op of ['task.create', 'task.update']) {
        const args = op === 'task.create' ? { title: 'reject nonfinite', acceptance: [{ text: 'valid' }] }
          : { taskId, expected: { entityRev: h.state.tasks[taskId].rev } };
        await assert.rejects(h.command(command(op, { ...args, weight })), { code: 'invalid-command' });
        assert.deepEqual(h.committedSnapshot(), before);
        assert.deepEqual([...h.store.commits], commits);
        if (!memory) assert.deepEqual(fs.readFileSync(h.store.commitsFile), bytes);
        assert.equal(writes, 0, op + ' reached persistence for a non-finite weight');
      }
    }
    const changed = await h.command(command('task.update', { taskId, weight: 3.75, expected: { entityRev: h.state.tasks[taskId].rev } }));
    assert.equal(changed.committed, true);
    assert.equal(writes, 1);
    assert.equal(h.state.tasks[taskId].weight, 3.75);
    const expected = structuredClone(h.model.persistedState), meta = h.meta;
    const retained = structuredClone([...h.store.commits]);
    h.close();
    const replay = memory ? new MemoryStore(meta, retained) : new JsonlStore(meta.dir, meta);
    try { assert.deepEqual(replay.open().state, expected); } finally { replay.close(); }
  });
}


// 责任：模型输入是数据；不得在规范化时执行字段 getter、自定义数组迭代器或内嵌回调。
test('model rejects executable operation payloads without evaluating them', async t => {
  const { h } = await setup(t);
  const before = h.committedSnapshot(), bytes = fs.readFileSync(h.store.commitsFile);
  let calls = 0;
  const op = { kind: 'task.createStandalone', args: { title: 'not executed', acceptance: [{ text: 'ok' }] } };
  const invalid = [{ ...op, get args() { calls++; return op.args; } }];
  const iterable = [op];
  Object.defineProperty(iterable, Symbol.iterator, { value: function* () { calls++; yield op; } });
  for (const value of [invalid, iterable, [{ ...op, args: { ...op.args, callback() { calls++; } } }]]) {
    const { sample } = h.model.beginCommand({ cmdId: 'inert-only', actor }, [{ kind: 'lease.normalizeBeforeCommand', args: {} }], h._transactionPorts(h.service));
    assert.throws(() => h.model.submitOperations(sample, value), { code: 'invalid-command' });
    assert.equal(calls, 0);
    assert.deepEqual(h.committedSnapshot(), before);
    assert.deepEqual(fs.readFileSync(h.store.commitsFile), bytes);
  }
});

// 责任：隔离模型只在构造时取得独立克隆的运行态，公开租约/幂等值是快照，不能靠活模型setter或万能提交入口建夹具。
test('constructor clones runtime lease facts and live read collections never grant mutation authority', async t => {
  const { h } = await setup(t);
  const taskId = await claimed(h);
  const leases = h.leases, data = h.model.snapshot();
  const initial = structuredClone(leases);
  const fixture = new TransactionModel(data, { leases });
  assert.deepEqual(fixture.leases, initial);
  leases.get(taskId).expiresAt = '2000-01-01T00:00:00.000Z';
  leases.clear();
  assert.deepEqual(fixture.leases, initial, 'constructor retained caller-owned runtime aliases');
  h.leases.clear();
  fixture.leases.clear();
  assert.deepEqual(h.leases, initial);
  assert.deepEqual(fixture.leases, initial);
  fixture.cmdIds.clear();
  assert.deepEqual(fixture.cmdIds, data.cmdIds);
  assert.throws(() => { fixture.leases = new Map(); }, TypeError);
  for (const method of ['commitRecord', 'publish', 'runtimeBindings']) assert.equal(fixture[method], undefined, method);
  assert.equal(h.store.append, undefined);
});
