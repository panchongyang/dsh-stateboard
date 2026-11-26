// 审计治理测试共用的合成任务、历史回放与拒绝原子性 fixture。
// 仅构造临时目录；公开测试用例与契约断言留在 contract 入口。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectService } from '../../lib/core/service.js';
import { reopenSyntheticHistory } from './core-matrix-fixture.mjs';

export const worker = { kind: 'agent', sessionId: 'worker-session', agentId: 'worker-agent' };
export const auditor = { kind: 'agent', sessionId: 'auditor-session', agentId: 'auditor-agent' };
export const human = { kind: 'human', sessionId: 'human:test', via: 'test' };
export const report = 'I inspected the recorded material and checked acceptance independently.';
let serial = 0;
export async function fixture(t, { gated = true, file = false, alive = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-audit-v3-'));
  const ws = path.join(root, 'workspace');
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, 'artifact.txt'), 'original');
  const svc = await new ProjectService({ rootDir: path.join(root, 'data') }).init();
  t.after(() => svc.close());
  let h = await svc.createProject({ workspacePath: ws, actor: auditor });
  t.after(() => { if (!h.closed) h.close(); });
  if (alive) await h.attach({ sessionId: worker.sessionId, agentId: worker.agentId });
  const send = (op, extra = {}, actor = worker) => h.command({ cmdId: 'audit-test-' + ++serial, op, actor, ...extra });
  const made = await send('task.create', { title: 'Audited work', requiresAudit: gated, acceptance: [{ text: 'artifact accepted' }] }, auditor);
  const id = made.events.find((e) => e.type === 'task/created').taskId;
  const task = () => h.state.tasks[id];
  const act = (op, extra = {}, actor = worker) => send('task.' + op, { taskId: id, expected: { entityRev: task().rev }, ...extra }, actor);
  const submit = () => act('submit', { fencingToken: h.leases.get(id).token, evidence: [{ kind: file ? 'file' : 'command', ref: file ? 'artifact.txt' : 'nonexistent-command --not-executed', acceptanceId: task().acceptance[0].id, execution: { exitCode: 17, status: 'failed' } }] });
  const review = async () => { await act('claim'); await act('begin', { summary: 'implement artifact', fencingToken: h.leases.get(id).token }); await submit(); };
  const snapshot = () => ({ state: structuredClone(h.state), leases: structuredClone([...h.leases]), rev: h.rev, commits: fs.readFileSync(h.store.commitsFile), blobs: fs.readdirSync(h.store.blobsDir) });
  const denied = async (op, extra, actor, code, reason) => {
    const before = snapshot();
    await assert.rejects(act(op, extra, actor), (error) => {
      assert.equal(error.code, code);
      if (reason) assert.equal(error.details?.reason, reason);
      return true;
    });
    assert.deepEqual(snapshot(), before, 'failure leaves events, revisions, blobs and leases unchanged');
  };
  const ops = (sessionId) => Object.fromEntries(h.query('task', { taskId: id, sessionId }).allowedOps.map((row) => [row.op, row]));
  const seed = (mutate, runtimeLeases = h.leases) => {
    const state = structuredClone(h.state);
    mutate(state);
    const events = [ { type: 'project/updated', data: state.project },
      ...Object.values(state.tasks).map((row) => ({ type: 'task/updated', taskId: row.id, rev: row.rev, data: row })),
      ...Object.values(state.planHeads).map((head) => ({ type: 'plan/updated', data: head })) ];
    h = reopenSyntheticHistory(h, events, runtimeLeases);
  };
  const legacyLease = () => {
    const at = h.clock().toISOString();
    const lease = { taskId: id, ...worker, token: h.state.counters.leaseToken + 1,
      epoch: h.state.bindings[worker.sessionId]?.epoch || 0, acquiredAt: at, grantedAt: at,
      expiresAt: new Date(Date.parse(at) + 900_000).toISOString(), progressAt: at, renewCount: 0, lastRenewedAt: null };
    // Install an old grant in the fixture source log; only the volatile row is
    // supplied independently, exactly as matrix live/grace/expired inputs are.
    h = reopenSyntheticHistory(h, [{ type: 'lease/granted', data: lease }], [[id, lease]]);
    return lease;
  };
  return { get h() { return h; }, svc, root, ws, id, task, act, send, submit, review, snapshot, denied, ops, seed, legacyLease };
}
