/**
 * 测试职责：用注入时钟约束租约 TTL、宽限期与续期截止时间。
 * 典型流程：临时服务注入固定时间 → 领取后推进时钟/触碰会话 → 比较租约及过期事件。
 * 覆盖边界：覆盖 到期回收、旧 token 拒绝与续期计算；不覆盖真实定时器调度或压力。
 * 外部前置：无；时间通过 fixture 手动推进。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectService } from '../../lib/core/service.js';

const START = Date.parse('2026-10-23T00:00:00.000Z');
const TTL_MS = 900 * 1000;
const GRACE_MS = 900 * 1000;

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
}

function cmd(op, extra = {}) {
  return { cmdId: 'cmd_' + Math.random().toString(36).slice(2), actor: { kind: 'agent', sessionId: 's1' }, op, ...extra };
}

async function harness(prefix) {
  let now = START;
  const svc = new ProjectService({ rootDir: tmp(prefix), clock: () => new Date(now) });
  await svc.init();
  const handle = await svc.createProject({ workspacePath: tmp(prefix + '-ws'), name: 'P' });
  await handle.attach({ sessionId: 's1', agentId: 's1', source: 'test', role: 'worker' });
  const tick = (ms) => { now += ms; };
  return { svc, handle, tick, now: () => now };
}

async function makeTask(handle, title) {
  const res = await handle.command(cmd('task.create', { title, acceptance: [{ text: 'ok' }] }));
  const id = res.events.find((event) => event.type === 'task/created').taskId;
  return id;
}

// 责任：到期前再次领取须报 lease-held，超过宽限后新领取须原子回收旧任务并发放新租约。
test('a lease survives TTL inside the grace window and is reclaimed after grace', async () => {
  const { svc, handle, tick, now } = await harness('pb-ttl-a');
  await handle.attach({ sessionId: 's2', agentId: 's2', source: 'test', role: 'worker' });
  const id = await makeTask(handle, 'Leased');
  const other = await makeTask(handle, 'Next');
  await handle.command(cmd('task.claim', { taskId: id, expected: { entityRev: handle.state.tasks[id].rev } }));
  assert.equal(handle.leases.get(id).expiresAt, new Date(now() + TTL_MS).toISOString());

  tick(TTL_MS - 1);
  const stillHeld = await handle.command(cmd('task.claim', {
    taskId: id,
    expected: { entityRev: handle.state.tasks[id].rev },
  })).then(() => null, (error) => error);
  assert.equal(stillHeld?.code, 'lease-held', 'one millisecond before the TTL the lease is live');

  tick(GRACE_MS + 1);
  const res = await handle.command(cmd('task.claim', {
    taskId: other,
    expected: { entityRev: handle.state.tasks[other].rev },
    actor: { kind: 'agent', sessionId: 's2' },
  }));
  assert.equal(handle.state.tasks[id].state, 'ready', 'past grace the expired task was released');
  assert.deepEqual(
    res.events.map((event) => event.type),
    ['lease/expired', 'task/readied', 'lease/granted', 'task/claimed'],
    'expiry and the claim travel in one commit',
  );
  await svc.close();
});

// 责任：推进到 TTL 加宽限之后再用旧 token begin，必须报 lease-expired。
test('an expired lease rejects the old fencing token', async () => {
  const { svc, handle, tick } = await harness('pb-ttl-b');
  const id = await makeTask(handle, 'Fenced');
  await handle.command(cmd('task.claim', { taskId: id, expected: { entityRev: handle.state.tasks[id].rev } }));
  const token = handle.leases.get(id).token;
  tick(TTL_MS + GRACE_MS + 1);
  const error = await handle.command(cmd('task.begin', {
    taskId: id,
    expected: { entityRev: handle.state.tasks[id].rev },
    fencingToken: token,
    summary: 'late',
  })).then(() => null, (err) => err);
  assert.equal(error?.code, 'lease-expired');
  await svc.close();
});

// 责任：推进时钟再 touch 会话后，expiresAt 必须等于新时刻加完整 TTL。
test('renewing a lease pushes the TTL from the injected clock', async () => {
  const { svc, handle, tick, now } = await harness('pb-ttl-c');
  const id = await makeTask(handle, 'Renew');
  await handle.command(cmd('task.claim', { taskId: id, expected: { entityRev: handle.state.tasks[id].rev } }));
  tick(600_000);
  handle.touch('s1');
  assert.equal(handle.leases.get(id).expiresAt, new Date(now() + TTL_MS).toISOString());
  await svc.close();
});
