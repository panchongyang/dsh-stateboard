/**
 * 测试职责：保证冷启动清理持久 owner 时与任务恢复同提交记录 lease/expired 审计。
 * 典型流程：临时项目留已开始/仅领取任务 → 关闭服务再冷开或解归档 → 比较 owner 与恢复事件。
 * 覆盖边界：覆盖 restart 原因、未知字段不伪造及归档延迟恢复；不覆盖真实断电或网络租约。
 * 外部前置：无；服务关闭模拟冷启动，全部数据合成。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectService } from '../../lib/core/service.js';
import { appendSyntheticHistory } from '../helpers/core-matrix-fixture.mjs';

// R2: a cold-started writer must audit the lease it terminates. A regular
// expiry sweep expires the live lease; after a restart the table is empty, so
// the record is rebuilt from the persisted owner only (reason 'restart',
// unknown fields omitted) and rides in the SAME commit as the task transition.

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
}

function cmd(op, extra = {}) {
  return { cmdId: 'cmd_' + crypto.randomUUID(), actor: { kind: 'agent', sessionId: 's1' }, op, ...extra };
}

function humanCmd(op, extra = {}) {
  return { cmdId: 'cmd_' + crypto.randomUUID(), actor: { kind: 'human', via: 'test' }, op, ...extra };
}

function commits(handle) {
  return fs.readFileSync(path.join(handle.meta.dir, 'commits.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

async function openService(rootDir) {
  const svc = new ProjectService({ rootDir });
  await svc.init();
  return svc;
}

async function createTask(handle, title) {
  const result = await handle.command(cmd('task.create', { title, acceptance: [{ text: 'audited' }] }));
  return result.events.find((event) => event.type === 'task/created').taskId;
}

async function claimWith(handle, taskId, sessionId) {
  const result = await handle.command(cmd('task.claim', {
    taskId,
    actor: { kind: 'agent', sessionId },
    expected: { entityRev: handle.state.tasks[taskId].rev },
  }));
  assert.equal(result.committed, true);
  return result.events.find((event) => event.type === 'lease/granted').data.token;
}

/** Two in_flight tasks with a live owner, then a real cold stop (lock released). */
async function seedWork({ staleMeta = false } = {}) {
  const rootDir = tmp('pb-restart-state');
  const svc = await openService(rootDir);
  const handle = await svc.createProject({ workspacePath: tmp('pb-restart-ws'), name: 'Restart audit' });
  await handle.attach({ sessionId: 's1', agentId: 's1', source: 'test', role: 'worker' });
  await handle.attach({ sessionId: 's2', agentId: 's2', source: 'test', role: 'worker' });
  const interrupted = await createTask(handle, 'In flight when the process died');
  const readied = await createTask(handle, 'Claimed, never begun');
  const tokenA = await claimWith(handle, interrupted, 's1');
  await handle.command(cmd('task.begin', {
    taskId: interrupted,
    actor: { kind: 'agent', sessionId: 's1' },
    fencingToken: tokenA,
    expected: { entityRev: handle.state.tasks[interrupted].rev },
    summary: 'side effects possible when the process died',
  }));
  const tokenB = await claimWith(handle, readied, 's2');
  if (staleMeta) await handle.command(humanCmd('project.update', { name: 'Name committed only to the log' }));
  const snapshot = {
    rootDir,
    projectId: handle.id,
    interrupted,
    readied,
    tokenA,
    tokenB,
    before: commits(handle),
    ownerA: structuredClone(handle.state.tasks[interrupted].owner),
    ownerB: structuredClone(handle.state.tasks[readied].owner),
  };
  await svc.close();
  return snapshot;
}

// 责任：业务入口的拒绝、幂等、合法空操作和已知追加失败都不能先发布恢复；真正提交才处理本代次。
test('cold business recovery waits for a durable command and preserves intent and actor attribution', async t => {
  const seed = await seedWork({ staleMeta: true });
  const { projectId, interrupted, readied } = seed;
  const service = await openService(seed.rootDir);
  const survivor = await openService(seed.rootDir);
  t.after(async () => { await service.close(); await survivor.close(); });
  const dir = path.join(seed.rootDir, 'projects', projectId);
  const files = () => ['commits.jsonl', 'meta.json'].map(name => fs.readFileSync(path.join(dir, name)));
  const beforeBytes = files(), before = service.peekProjectState(projectId);
  assert.notEqual(JSON.parse(beforeBytes[1]).project.name, before.project.name, '合成旧 meta 与权威日志不一致');
  const projectRev = before.lastSeq, entityRev = before.tasks[readied].rev;
  const owner = { kind: 'human', via: 'web' };
  const fresh = { kind: 'agent', sessionId: 'new-cold-session' };
  const withSource = { agentSessionSource: 'tool' };
  const update = humanCmd('task.update', { actor: owner, taskId: readied, title: 'Edited with the cold read version' });
  const read = svc => svc.query(projectId, 'task', { taskId: readied }, owner);
  const baseline = await read(service);
  assert.equal(baseline.projectRev, projectRev);
  assert.equal(baseline.task.rev, entityRev);
  assert.equal(baseline.task.state, 'in_progress');
  assert.equal(baseline.lease, null);
  assert.equal(service.handles.size, 0);

  await assert.rejects(service.command(projectId, { ...update, expected: { projectRev: projectRev - 1, entityRev } }),
    err => err.code === 'stale-revision' && err.details.currentRev === projectRev);
  await assert.rejects(service.command(projectId, { ...update, expected: { projectRev, entityRev: entityRev - 1 } }),
    err => err.code === 'stale-revision' && err.details.currentRev === entityRev);
  // 工作区既有项目的首写路径也只能在私稿准备恢复，此处未知依赖由模型拒绝。
  await assert.rejects(service.commandInWorkspace(before.project.workspacePath,
    cmd('task.create', { actor: fresh, title: 'Rejected inside model', acceptance: [{ text: 'ok' }], deps: ['tsk_missing'], expected: { projectRev } }),
    withSource), { code: 'invalid-command', message: 'unknown dependency tsk_missing' });
  const duplicate = await survivor.command(projectId, cmd('task.create', { cmdId: seed.before.at(-1).cmdId,
    actor: fresh, expected: { projectRev: 0, entityRev: 0 } }), withSource);
  assert.equal(duplicate.deduped, true);
  assert.equal(duplicate.projectRev, projectRev);
  const noop = await survivor.command(projectId, cmd('task.gate', { actor: owner, taskId: readied, requiresAudit: false,
    expected: { projectRev, entityRev } }));
  assert.deepEqual(noop, { ok: true, committed: false, deduped: false, projectRev, events: [] });
  const handle = service.handles.get(projectId), shared = survivor.handles.get(projectId);
  assert.equal(handle.store, shared.store);
  const physical = handle.store.commitPhysical.bind(handle.store);
  handle.store.commitPhysical = packet => {
    assert.equal(packet.cmdId, update.cmdId);
    assert.ok(packet.events.some(event => event.type === 'lease/expired'));
    throw Object.assign(new Error('known append failure'), { code: 'EIO' });
  };
  try {
    await assert.rejects(survivor.command(projectId, { ...update, expected: { projectRev, entityRev } }), { code: 'EIO' });
    assert.deepEqual(files(), beforeBytes);
    assert.deepEqual(shared.state, before, 'bindings including lastSeen, intents and revisions stay unchanged');
    assert.equal(shared.leases.size, 0);
    assert.equal(shared.recovered, false);
    const after = await read(survivor);
    assert.equal(after.projectRev, projectRev);
    assert.deepEqual(after.task, baseline.task);
  } finally { handle.store.commitPhysical = physical; }

  await service.close();
  const result = await survivor.command(projectId, { ...update, expected: { projectRev, entityRev } });
  assert.equal(result.projectRev, projectRev + 1);
  assert.equal(shared.recovered, true);
  assert.equal(JSON.parse(files()[1]).project.name, before.project.name, '成功后才允许修复 meta');
  const log = commits(shared), batch = log.at(-1);
  assert.equal(log.length, seed.before.length + 1);
  assert.equal(batch.cmdId, update.cmdId);
  assert.deepEqual(batch.actor, owner);
  assert.deepEqual(batch.events.slice(0, 4).map(event => event.type), ['lease/expired', 'task/interrupted', 'lease/expired', 'task/readied']);
  for (const event of batch.events.slice(0, 4)) assert.deepEqual(event.actor, { kind: 'system', via: 'system' });
  assert.ok(batch.events.some(event => event.type === 'task/updated' && event.taskId === readied && !event.actor));
  for (const [event, token] of [[batch.events[0], seed.tokenA], [batch.events[2], seed.tokenB]]) {
    assert.equal(event.data.reason, 'restart');
    assert.equal(event.data.token, token);
  }
  assert.equal(shared.state.tasks[interrupted].state, 'interrupted');
  assert.equal(shared.state.tasks[interrupted].rev, before.tasks[interrupted].rev + 1);
  assert.equal(shared.state.tasks[readied].state, 'ready');
  assert.equal(shared.state.tasks[readied].rev, entityRev + 2);
  assert.deepEqual(shared.state.intents, before.intents);
  assert.deepEqual(shared.state.bindings, before.bindings);
  assert.equal(shared.leases.size, 0);
  const published = await read(survivor);
  assert.equal(published.projectRev, projectRev + 1);
  assert.equal(published.task.title, update.title);
  shared.recover();
  assert.deepEqual(commits(shared), log, 'explicit recovery on this generation must not repeat the successful batch');
  await survivor.close();
  const reopened = await openService(seed.rootDir);
  t.after(() => reopened.close());
  assert.deepEqual(await read(reopened), published, 'detached cold read sees the same durable result');
});

// 责任：冷开须把 lease/expired 和 interrupted/readied 转移同提交落盘，不能只改任务无审计。
test('cold start writes lease/expired and the task transition in one commit', async () => {
  const seed = await seedWork();
  const svc = await openService(seed.rootDir);
  const handle = await svc.open(seed.projectId);
  const log = commits(handle);
  assert.equal(log.length, seed.before.length + 1, 'recovery appends exactly one commit');
  const recovery = log.at(-1);
  assert.equal(recovery.seq, seed.before.length + 1);
  assert.match(recovery.cmdId, /^cmd_recover_/);
  assert.deepEqual(recovery.actor, { kind: 'system', via: 'system' });
  assert.deepEqual(
    recovery.events.map((event) => event.type),
    ['lease/expired', 'task/interrupted', 'lease/expired', 'task/readied'],
    'each terminated lease is audited in the same commit as its transition',
  );

  const [expiredA, interrupted, expiredB, readied] = recovery.events;
  assert.equal(expiredA.taskId, seed.interrupted);
  assert.deepEqual(expiredA.data, {
    taskId: seed.interrupted,
    sessionId: seed.ownerA.sessionId,
    agentId: seed.ownerA.agentId,
    epoch: seed.ownerA.epoch,
    token: seed.tokenA,
    expiresAt: seed.ownerA.leaseUntil,
    reason: 'restart',
  }, 'the restart record carries exactly the fields the persisted owner knows');
  for (const field of ['acquiredAt', 'grantedAt', 'renewCount', 'progressAt', 'lastRenewedAt']) {
    assert.equal(Object.hasOwn(expiredA.data, field), false, field + ' must not be invented');
  }
  assert.deepEqual(expiredB.data, {
    taskId: seed.readied,
    sessionId: seed.ownerB.sessionId,
    agentId: seed.ownerB.agentId,
    epoch: seed.ownerB.epoch,
    token: seed.tokenB,
    expiresAt: seed.ownerB.leaseUntil,
    reason: 'restart',
  });

  assert.equal(interrupted.data.state, 'interrupted');
  assert.equal(interrupted.data.owner, null);
  assert.equal(interrupted.data.assignee, null);
  assert.equal(interrupted.data.work, null);
  assert.equal(readied.data.state, 'ready');
  assert.equal(handle.state.tasks[seed.interrupted].state, 'interrupted');
  assert.equal(handle.state.tasks[seed.readied].state, 'ready');
  const open = Object.values(handle.state.intents)
    .find((intent) => intent.taskId === seed.interrupted && intent.status === 'open');
  assert.ok(open, 'the open intent survives so reconcile can settle the work');
  assert.equal(handle.leases.size, 0, 'a cold-started writer holds no lease');

  const rev = handle.rev;
  handle.recover();
  assert.equal(handle.rev, rev, 'a second recover on the same handle appends nothing');
  assert.equal(commits(handle).length, log.length);
  await svc.close();

  const again = await openService(seed.rootDir);
  const reopened = await again.open(seed.projectId);
  assert.equal(reopened.rev, rev, 'a second writer finds no in_progress task and appends nothing');
  const tail = commits(reopened);
  assert.deepEqual(tail.map((commit) => commit.seq), log.map((commit) => commit.seq));
  assert.equal(
    tail.flatMap((commit) => commit.events).filter((event) => event.type === 'lease/expired').length,
    2,
    'the termination audit is written once, not again per writer',
  );
  await again.close();
});

// 责任：历史 owner 未持久化的身份字段必须省略，restart 审计不得编造值。
test('a restart record never invents identity the log did not persist', async () => {
  const rootDir = tmp('pb-restart-legacy-state');
  const svc = await openService(rootDir);
  const handle = await svc.createProject({ workspacePath: tmp('pb-restart-legacy-ws'), name: 'Legacy restart' });
  const id = await createTask(handle, 'In progress without an owner');
  // Legacy/damaged projection: in_progress with no persisted owner at all.
  const legacy = structuredClone(handle.state.tasks[id]);
  legacy.state = 'in_progress';
  legacy.owner = null;
  legacy.assignee = null;
  legacy.work = null;
  legacy.rev += 1;
  const projectId = handle.id;
  appendSyntheticHistory(handle, [{ type: 'task/updated', data: legacy }]);
  const before = commits(handle).length;
  await svc.close();

  const next = await openService(rootDir);
  const reopened = await next.open(projectId);
  const log = commits(reopened);
  assert.equal(log.length, before + 1);
  const recovery = log.at(-1);
  assert.deepEqual(recovery.events.map((event) => event.type), ['lease/expired', 'task/readied']);
  assert.deepEqual(
    recovery.events[0].data,
    { taskId: id, reason: 'restart' },
    'the task id and the reason are the only facts available',
  );
  assert.equal(reopened.state.tasks[id].state, 'ready');
  await next.close();
});

// 责任：归档项目打开不能写 recover，解归档才可在同次提交携带恢复和租约审计。
test('an archived project takes no recover commit; unarchive carries the recovery', async () => {
  const rootDir = tmp('pb-restart-archived-state');
  const svc = await openService(rootDir);
  const handle = await svc.createProject({ workspacePath: tmp('pb-restart-archived-ws'), name: 'Archived restart' });
  await handle.attach({ sessionId: 's1', agentId: 's1', source: 'test', role: 'worker' });
  const id = await createTask(handle, 'Stranded work');
  const token = await claimWith(handle, id, 's1');
  await handle.command(cmd('task.begin', {
    taskId: id,
    fencingToken: token,
    expected: { entityRev: handle.state.tasks[id].rev },
    summary: 'legacy archived mid-flight',
  }));
  // Simulate legacy damaged data: archived while a task is still in_progress.
  // project.update refuses this today (project-has-live-work), so seed the
  // historical source log only after closing its writer.
  const projectId = handle.id;
  const seeded = appendSyntheticHistory(handle, [
    { type: 'project/updated', data: { ...handle.state.project, phase: 'archived' } },
  ]);
  const before = commits(handle).length;
  const rev = seeded.seq;
  await svc.close();

  const next = await openService(rootDir);
  const reopened = await next.open(projectId);
  assert.equal(reopened.rev, rev, 'a cold open of an archived project writes nothing');
  assert.equal(commits(reopened).length, before);
  assert.equal(reopened.state.tasks[id].state, 'in_progress');

  const unarchive = await reopened.command(humanCmd('project.update', { phase: 'active' }));
  assert.equal(unarchive.committed, true);
  assert.equal(reopened.state.project.phase, 'active');
  assert.equal(reopened.state.tasks[id].state, 'interrupted');
  assert.equal(reopened.state.tasks[id].owner, null);
  assert.equal(reopened.leases.size, 0, 'unarchive clears stale in-memory leases');
  assert.equal(reopened.recovered, true);
  const log = commits(reopened);
  assert.equal(log.length, before + 1, 'recovery rides the unarchive commit, not a second recover commit');
  assert.deepEqual(log.at(-1).events.map((event) => event.type), unarchive.events.map((event) => event.type));
  assert.equal(unarchive.events.filter((event) => event.type === 'project/updated').length, 1);
  assert.equal(unarchive.events.filter((event) => event.type === 'task/interrupted').length, 1);
  await next.close();
});
