/**
 * 测试职责：通过本机 MCP 监听验证独立写凭据、工作会话和任务流转。
 * 典型流程：创建合成项目 → 按凭据发现工具 → 领取、提交或释放 → 核对日志与租约。
 * 覆盖边界：覆盖授权拒绝、并发重试、恢复和回滚；不覆盖日常 DSH profile 或真实数据。
 * 外部前置：需要本机回环端口及可写的合成临时目录。
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer, request } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { JsonlStore } from '../../lib/core/store.js';
import { mountProjectMcp } from '../../lib/host/mcp.js';
import { faultFs, ioError } from '../helpers/fault-fs.mjs';
import { makeService, withProject, command } from '../helpers/service-fixture.mjs';

const READ = 'ac'.repeat(32);
const WRITE = 'bc'.repeat(32);
const HOST = '127.0.0.1';
const HUMAN = { kind: 'human', via: 'test' };
const ENV = { PROJECT_BOARD_MCP_TOKEN: READ, PROJECT_BOARD_MCP_WRITE_TOKEN: WRITE };

async function listener(t, service, write, env = ENV) {
  const reserve = createServer().listen(0, HOST);
  await once(reserve, 'listening');
  const { port } = reserve.address();
  await new Promise((resolve) => reserve.close(resolve));
  const started = Promise.withResolvers();
  const logger = { info: started.resolve };
  const close = mountProjectMcp({ service, ready: Promise.resolve(), ctx: { logger } }, { enabled: true, port, write }, env);
  t.after(close);
  await started.promise;
  const post = (token, method, params) => new Promise((resolve, reject) => {
    const req = request({
      hostname: HOST, port, path: '/mcp',
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-11-25',
      },
      signal: AbortSignal.timeout(5000),
    }, async (res) => {
      try {
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        if (res.statusCode === 200 || res.statusCode === 500) {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } else {
          resolve({ status: res.statusCode });
        }
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
  });
  const call = (name, args, token = WRITE) => post(token, 'tools/call', { name, arguments: args });
  return { post, call, close };
}

async function success(mcp, name, args, token) {
  const body = await mcp.call(name, args, token);
  assert.equal(body.result?.isError, undefined, JSON.stringify(body));
  assert.ok(body.result?.structuredContent, JSON.stringify(body));
  return body.result.structuredContent;
}

function denied(body, code) {
  assert.equal(body.result?.isError, true, JSON.stringify(body));
  assert.deepEqual(Object.keys(body.result.structuredContent).sort(), ['code', 'message']);
  assert.equal(body.result.structuredContent.code, code);
}

async function readyTask(h) {
  const created = await h.command(command('task.create', {
    actor: HUMAN, title: 'Synthetic work', acceptance: [{ text: 'Check evidence', requiredKinds: ['note'] }],
  }));
  return created.events[0].data;
}

async function startWork(mcp, projectId, task) {
  const { sessionToken } = await success(mcp, 'open_work_session', { projectId });
  return { projectId, taskId: task.id, sessionToken, expectedRev: task.rev, requestId: 'claim-1' };
}

const writes = (projectIds) => ({ enabled: true, projectIds });

// 责任：写开关、项目清单或独立凭据不满足时保留原有只读目录。
test('MCP writes require explicit opt-in, an allowlist and a distinct write bearer', { timeout: 15000 }, async (t) => {
  const { svc, h } = await withProject(t);
  const variants = [
    [undefined, ENV],
    [Object.create(writes([h.id])), ENV],
    [{ enabled: 'true', projectIds: [h.id] }, ENV],
    [writes([]), ENV],
    [writes(['../outside']), ENV],
    [writes([h.id]), { ...ENV, PROJECT_BOARD_MCP_WRITE_TOKEN: READ }],
    [writes([h.id]), { ...ENV, PROJECT_BOARD_MCP_WRITE_TOKEN: '' }],
  ];
  for (const [settings, env] of variants) {
    const mcp = await listener(t, svc, settings, env);
    try {
      const read = await mcp.post(READ, 'tools/list', {});
      assert.deepEqual(read.result.tools.map(({ name }) => name), ['list_projects', 'list_tasks', 'get_task']);
      assert.deepEqual(await mcp.post(WRITE, 'tools/list', {}), { status: 401 });
    } finally {
      await mcp.close();
    }
  }
});

// 责任：项目越权、凭据隔离、会话伪造和未知参数都在冷开 writer 前拒绝。
test('MCP authorization, session and shape denials leave cold project logs and locks untouched', { timeout: 12000 }, async (t) => {
  const { svc, h, stateDir, wsDir } = await withProject(t);
  const otherDir = path.join(wsDir, 'other');
  fs.mkdirSync(otherDir);
  const other = await svc.createProject({ workspacePath: otherDir });
  const task = await readyTask(h);
  const otherTask = await readyTask(other);
  await other.command(command('task.claim', { actor: HUMAN, taskId: otherTask.id, expected: { entityRev: otherTask.rev } }));
  const targets = [h, other].map(({ store }) => [store.commitsFile, store.lockFile, fs.readFileSync(store.commitsFile)]);
  await svc.close();
  const { svc: cold } = await makeService(t, { rootDir: stateDir });
  const mcp = await listener(t, cold, writes([h.id]));
  const claim = await startWork(mcp, h.id, task);
  const create = { projectId: h.id, sessionToken: claim.sessionToken, requestId: 'new', title: 'Follow-up', acceptance: [{ text: 'Prove it' }] };
  assert.equal((await mcp.call('claim_task', claim, READ)).error.code, -32602);
  assert.equal((await mcp.call('create_task', create, READ)).error.code, -32602);
  assert.deepEqual(await mcp.call('claim_task', claim, 'ab'.repeat(24)), { status: 401 });
  assert.equal((await mcp.call('get_task', { projectId: h.id, taskId: task.id })).error.code, -32602);
  assert.equal((await mcp.call('verify_task', claim)).error.code, -32602);
  denied(await mcp.call('open_work_session', { projectId: other.id }), 'project-forbidden');
  denied(await mcp.call('claim_task', { ...claim, projectId: other.id, taskId: otherTask.id }), 'project-forbidden');
  denied(await mcp.call('create_task', { ...create, projectId: other.id }), 'project-forbidden');
  denied(await mcp.call('create_task', { ...create, actor: { kind: 'human' } }), 'invalid-command');
  denied(await mcp.call('claim_task', { ...claim, actor: { kind: 'human' } }), 'invalid-command');
  denied(await mcp.call('claim_task', { ...claim, sessionId: 'forged' }), 'invalid-command');
  denied(await mcp.call('claim_task', { ...claim, expectedRev: String(task.rev) }), 'invalid-command');
  denied(await mcp.call('claim_task', { ...claim, sessionToken: claim.sessionToken.replace(/.$/, (c) => c === 'a' ? 'b' : 'a') }), 'work-session-invalid');
  await mcp.close();

  const broader = await listener(t, cold, writes([h.id, other.id]));
  const newClaim = await startWork(broader, h.id, task);
  denied(await broader.call('claim_task', { ...newClaim, projectId: other.id, taskId: otherTask.id }), 'work-session-invalid');
  denied(await broader.call('claim_task', claim), 'work-session-invalid');
  for (const [log, lock, before] of targets) {
    assert.deepEqual(fs.readFileSync(log), before);
    assert.equal(fs.existsSync(lock), false);
  }
});

// 责任：验证领取、执行意图和证据提交的既有规则，以及持久去重与审查状态。
test('MCP claim, intent and evidence submission use the existing task workflow and durable dedupe', { timeout: 12000 }, async (t) => {
  const { svc, h, stateDir } = await withProject(t);
  const task = await readyTask(h);
  const mcp = await listener(t, svc, writes([h.id]));
  const { result } = await mcp.post(WRITE, 'tools/list', {});
  assert.deepEqual(result.tools.map(({ name }) => name),
    ['open_work_session', 'create_task', 'update_task', 'ready_task', 'claim_task', 'begin_task', 'submit_task', 'release_task', 'interrupt_task']);
  const claim = await startWork(mcp, h.id, task);
  const before = h.rev;
  denied(await mcp.call('claim_task', { ...claim, projectRev: h.rev + 1 }), 'stale-revision');
  assert.equal(h.rev, before);
  const got = await success(mcp, 'claim_task', claim);
  assert.equal(got.state, 'in_progress');
  assert.equal(got.taskRev, task.rev + 1);
  assert.ok(got.lease.fencingToken > 0);
  const commit = h.store.commits.at(-1);
  assert.deepEqual(commit.events.map(({ type }) => type), ['session/bound', 'lease/granted', 'task/claimed']);
  assert.equal(commit.actor.kind, 'agent');
  assert.equal(commit.actor.agentId, 'codex:mcp');
  assert.equal(commit.actor.via, 'mcp');
  assert.equal(commit.events[0].data.sessionId, commit.actor.sessionId);
  assert.equal(commit.events[0].data.autoResume, false);
  assert.equal(commit.events[1].data.epoch, commit.events[0].data.epoch);
  assert.ok(!fs.readFileSync(h.store.commitsFile, 'utf8').includes(claim.sessionToken));
  const retry = await success(mcp, 'claim_task', Object.fromEntries(Object.entries(claim).reverse()));
  assert.deepEqual(retry, { ...got, deduped: true });
  assert.equal(h.rev, before + 1);

  const begin = { ...claim, expectedRev: got.taskRev, requestId: 'begin-1', fencingToken: got.lease.fencingToken, summary: 'Prepare proof' };
  const other = await startWork(mcp, h.id, task);
  denied(await mcp.call('begin_task', { ...begin, sessionToken: other.sessionToken }), 'lease-held');
  denied(await mcp.call('begin_task', { ...begin, fencingToken: begin.fencingToken + 1 }), 'fencing-stale');
  const begun = await success(mcp, 'begin_task', begin);
  const submit = { ...claim, expectedRev: begun.taskRev, requestId: 'submit-1', fencingToken: begin.fencingToken };
  const priorSubmit = h.rev;
  denied(await mcp.call('submit_task', { ...submit, evidence: [] }), 'missing-evidence');
  denied(await mcp.call('submit_task', { ...submit, evidence: [{ kind: 'file', ref: '../outside' }] }), 'invalid-command');
  denied(await mcp.call('submit_task', { ...submit, evidence: [{ kind: 'note', ref: 'result', fixed: {} }] }), 'invalid-command');
  assert.equal(h.rev, priorSubmit);
  const args = { ...submit, evidence: [{ kind: 'note', ref: 'Checked', acceptanceId: task.acceptance[0].id }] };
  const submitted = await success(mcp, 'submit_task', args);
  assert.equal(submitted.state, 'review');
  assert.deepEqual(await success(mcp, 'submit_task', args), { ...submitted, deduped: true });
  assert.equal((await success(mcp, 'claim_task', claim)).lease, null);

  await mcp.close();
  await svc.close();
  const { svc: reopened } = await makeService(t, { rootDir: stateDir });
  const live = await reopened.open(h.id);
  assert.equal(live.state.tasks[task.id].state, 'review');
  assert.equal(live.state.tasks[task.id].acceptance[0].met, true);
});

// 责任：通过同一工作会话从建卡走到人审，复用依赖、版本、审计门与租约校验。
test('MCP task intake and work close the loop using existing agent permissions', { timeout: 12000 }, async (t) => {
  const { svc, h } = await withProject(t);
  const dependency = await readyTask(h);
  const mcp = await listener(t, svc, writes([h.id]));
  const { sessionToken } = await success(mcp, 'open_work_session', { projectId: h.id });
  const session = { projectId: h.id, sessionToken };
  const create = {
    ...session, requestId: 'create', title: 'Develop ProjectBoard',
    acceptance: [{ text: 'Provide the result', requiredKinds: ['note'] }],
    priority: -5, weight: 1.5, labels: ['self-host'], requiresAudit: true, deps: [dependency.id],
  };
  const beforeCreate = h.rev;
  denied(await mcp.call('create_task', { ...create, projectRev: beforeCreate + 1 }), 'stale-revision');
  denied(await mcp.call('create_task', { ...create, acceptance: [{ text: 'Proof', met: true }] }), 'invalid-command');
  const pair = await Promise.all([success(mcp, 'create_task', create), success(mcp, 'create_task', create)]);
  assert.equal(pair[0].taskId, pair[1].taskId);
  assert.deepEqual(pair.map(({ deduped }) => deduped).sort(), [false, true]);
  const task = pair[0];
  assert.equal(task.state, 'backlog');
  assert.equal(task.taskRev, 1);
  assert.equal(h.rev, beforeCreate + 1);
  assert.deepEqual(Object.keys(h.state.bindings), []);
  assert.equal(h.state.tasks[task.taskId].createdBy.agentId, 'codex:mcp');
  assert.equal(h.state.tasks[task.taskId].priority, -5);
  assert.equal(h.state.tasks[task.taskId].weight, 1.5);
  const work = { ...session, taskId: task.taskId };
  const edit = { ...work, expectedRev: task.taskRev, requestId: 'edit', description: 'Deliver', deps: [], reason: 'Scope clarified' };
  denied(await mcp.call('ready_task', { ...work, expectedRev: task.taskRev, requestId: 'ready' }), 'dependency-unmet');
  denied(await mcp.call('update_task', { ...edit, requiresAudit: false }), 'forbidden-role');
  assert.equal(h.rev, beforeCreate + 1);
  const updated = await success(mcp, 'update_task', edit);
  assert.equal(updated.state, 'backlog');
  assert.deepEqual(await success(mcp, 'update_task', edit), { ...updated, deduped: true });
  assert.equal(h.store.commits.at(-1).events.find(({ type }) => type === 'task/meta-edited').data.reason, 'Scope clarified');
  const ready = { ...work, expectedRev: updated.taskRev, requestId: 'ready' };
  denied(await mcp.call('ready_task', { ...ready, expectedRev: task.taskRev }), 'stale-revision');
  const promoted = await success(mcp, 'ready_task', ready);
  assert.equal(promoted.state, 'ready');
  assert.deepEqual(await success(mcp, 'ready_task', ready), { ...promoted, deduped: true });
  const claim = await success(mcp, 'claim_task', { ...work, expectedRev: promoted.taskRev, requestId: 'claim' });
  const other = await success(mcp, 'open_work_session', { projectId: h.id });
  const leasedEdit = { ...work, expectedRev: claim.taskRev, requestId: 'leased-edit', description: 'Delivery underway' };
  denied(await mcp.call('update_task', { ...leasedEdit, sessionToken: other.sessionToken }), 'lease-held');
  const amended = await success(mcp, 'update_task', leasedEdit);
  const fenced = { ...work, fencingToken: claim.lease.fencingToken };
  const begun = await success(mcp, 'begin_task', { ...fenced, expectedRev: amended.taskRev, requestId: 'begin', summary: 'Work' });
  const acceptanceId = h.state.tasks[task.taskId].acceptance[0].id;
  const submitted = await success(mcp, 'submit_task', {
    ...fenced, expectedRev: begun.taskRev, requestId: 'submit',
    evidence: [{ kind: 'note', ref: 'Checked', acceptanceId }],
  });
  assert.equal(submitted.state, 'review');
  await h.command(command('task.verify', {
    actor: HUMAN, taskId: task.taskId, expected: { entityRev: submitted.taskRev },
  }));
  const done = await success(mcp, 'get_task', { projectId: h.id, taskId: task.taskId }, READ);
  assert.equal(done.task.state, 'done');
  const replay = await success(mcp, 'create_task', create);
  assert.equal(replay.deduped, true);
  assert.equal(replay.taskId, task.taskId);
  assert.equal(replay.taskRev, done.task.rev);
  assert.equal(Object.keys(h.state.tasks).length, 2);
});

// 责任：并发领取只产生一枚有效租约，重试不能返回后续授予的 token。
test('concurrent claims fence sessions and replay cannot recover a newer grant', { timeout: 12000 }, async (t) => {
  const { svc, h } = await withProject(t);
  const task = await readyTask(h);
  const mcp = await listener(t, svc, writes([h.id]));
  const attempts = await Promise.all([startWork(mcp, h.id, task), startWork(mcp, h.id, task)]);
  const replies = await Promise.all(attempts.map((claim) => mcp.call('claim_task', claim)));
  const winner = replies.findIndex((reply) => !reply.result.isError);
  assert.notEqual(winner, -1);
  denied(replies[1 - winner], 'lease-held');
  const claimed = replies[winner].result.structuredContent;
  const claim = attempts[winner];
  const leaseArgs = { ...claim, fencingToken: claimed.lease.fencingToken };
  const begun = await success(mcp, 'begin_task', { ...leaseArgs, expectedRev: claimed.taskRev, requestId: 'begin', summary: 'Record work' });
  const release = { ...leaseArgs, expectedRev: begun.taskRev, requestId: 'release' };
  denied(await mcp.call('release_task', release), 'intent-unresolved');
  const ready = await success(mcp, 'release_task', { ...release, intent: { outcome: 'stopped', sideEffects: [] } });
  assert.equal(ready.state, 'ready');
  const newer = { ...claim, expectedRev: ready.taskRev, requestId: 'claim-2' };
  const same = await Promise.all([success(mcp, 'claim_task', newer), success(mcp, 'claim_task', newer)]);
  assert.deepEqual(same.map(({ deduped }) => deduped).sort(), [false, true]);
  assert.deepEqual(same[0].lease, same[1].lease);
  assert.ok(same[0].lease.fencingToken > claimed.lease.fencingToken);
  const old = await success(mcp, 'claim_task', claim);
  assert.equal(old.deduped, true);
  assert.equal(old.lease, null);
});

// 责任：人工驳回后任务可重新领取，宿主重启也不向旧会话隐式授予租约。
test('rejecting MCP work leaves a claimable task both live and after restart', { timeout: 12000 }, async (t) => {
  for (const restart of [false, true]) {
    const { svc, h, stateDir } = await withProject(t);
    const task = await readyTask(h);
    const mcp = await listener(t, svc, writes([h.id]));
    const claim = await startWork(mcp, h.id, task);
    const got = await success(mcp, 'claim_task', claim);
    const submit = {
      ...claim, fencingToken: got.lease.fencingToken, expectedRev: got.taskRev, requestId: 'submit',
      evidence: [{ kind: 'note', ref: 'Checked', acceptanceId: task.acceptance[0].id }],
    };
    const submitted = await success(mcp, 'submit_task', submit);
    let handle = h;
    let active = mcp;
    if (restart) {
      await mcp.close();
      await svc.close();
      const { svc: cold } = await makeService(t, { rootDir: stateDir });
      handle = await cold.open(h.id);
      active = await listener(t, cold, writes([h.id]));
    }
    const rejected = await handle.command(command('task.reject', {
      actor: HUMAN, taskId: task.id, expected: { entityRev: submitted.taskRev }, reason: 'Redo with better evidence',
    }));
    assert.equal(rejected.events.find(({ type }) => type === 'task/rejected').data.state, 'ready');
    assert.equal(rejected.events.find(({ type }) => type === 'task/assignment').data.cause, 'explicit-claim');
    assert.equal(rejected.events.some(({ type }) => type === 'lease/granted'), false);
    const next = await startWork(active, h.id, handle.state.tasks[task.id]);
    const reclaimed = await success(active, 'claim_task', next);
    assert.ok(reclaimed.lease.fencingToken > got.lease.fencingToken);
  }
});

// 责任：同一会话再次领取时保留完整宽限期和历史提交内容。
test('a later grant refreshes the same MCP session and gets its full grace period', { timeout: 12000 }, async (t) => {
  let now = Date.parse('2026-01-01T00:00:00Z');
  const { svc, h } = await withProject(t, { clock: () => new Date(now) });
  const task = await readyTask(h);
  const mcp = await listener(t, svc, writes([h.id]));
  const claim = await startWork(mcp, h.id, task);
  const first = await success(mcp, 'claim_task', claim);
  const firstCommit = h.store.commits.at(-1);
  const frozenCommit = structuredClone(firstCommit);
  const release = { ...claim, requestId: 'release-1', expectedRev: first.taskRev, fencingToken: first.lease.fencingToken };
  const ready = await success(mcp, 'release_task', release);
  now += 31 * 60 * 1000;
  const later = { ...claim, expectedRev: ready.taskRev, requestId: 'claim-2' };
  const second = await success(mcp, 'claim_task', later);
  assert.deepEqual(firstCommit, frozenCommit);
  now = Date.parse(second.lease.expiresAt) + 1;
  const freed = await success(mcp, 'release_task', {
    ...later, requestId: 'release-2', expectedRev: second.taskRev, fencingToken: second.lease.fencingToken,
  });
  assert.equal(freed.state, 'ready');
});

// 责任：同步失败时原子回滚会话绑定和租约，原样重试只提交一次。
test('a failed claim append rolls back both session binding and lease before an exact retry', { timeout: 12000 }, async (t) => {
  let faults;
  const { svc, h } = await withProject(t, {
    storeFactory(dir, meta) {
      faults = faultFs(dir);
      return new JsonlStore(dir, meta, { fs: faults.io });
    },
  });
  const task = await readyTask(h);
  const mcp = await listener(t, svc, writes([h.id]));
  const args = await startWork(mcp, h.id, task);
  const { commitsFile } = h.store;
  const before = fs.readFileSync(commitsFile);
  const bindingCount = Object.keys(h.state.bindings).length;
  const rev = h.rev;
  faults.arm('fsyncSync', (file) => file === commitsFile, () => { throw ioError(); });
  const failed = await mcp.call('claim_task', args);
  assert.deepEqual(failed.error, { code: -32603, message: 'Internal error' });
  faults.consumed();
  assert.deepEqual(fs.readFileSync(commitsFile), before);
  assert.equal(Object.keys(h.state.bindings).length, bindingCount);
  assert.equal(h.leases.size, 0);
  assert.equal(h.rev, rev);
  const retried = await success(mcp, 'claim_task', args);
  assert.equal(retried.deduped, false);
  assert.equal(retried.state, 'in_progress');
  assert.equal(h.rev, rev + 1);
});

// 责任：过期与重启后保留执行意图，旧会话或旧租约不能重新取得写权限。
test('lease expiry, unknown work and restart preserve intent semantics', { timeout: 12000 }, async (t) => {
  let now = Date.parse('2026-01-01T00:00:00Z');
  const clock = () => new Date(now);
  const { svc, h, stateDir } = await withProject(t, { clock });
  const task = await readyTask(h);
  const mcp = await listener(t, svc, writes([h.id]));
  const claim = await startWork(mcp, h.id, task);
  const granted = await success(mcp, 'claim_task', claim);
  const fence = { ...claim, fencingToken: granted.lease.fencingToken };
  const begun = await success(mcp, 'begin_task', { ...fence, expectedRev: granted.taskRev, requestId: 'begin', summary: 'Start' });
  now += 31 * 60 * 1000;
  assert.equal((await success(mcp, 'claim_task', claim)).lease, null);
  denied(await mcp.call('release_task', { ...fence, expectedRev: begun.taskRev, requestId: 'release' }), 'lease-expired');
  const interrupted = await success(mcp, 'interrupt_task', { ...fence, expectedRev: begun.taskRev, requestId: 'interrupt', note: 'Outcome unknown' });
  assert.equal(interrupted.state, 'interrupted');
  assert.equal(Object.values(h.state.intents)[0].status, 'open');
  const other = await readyTask(h);
  const held = await startWork(mcp, h.id, other);
  const second = await success(mcp, 'claim_task', held);
  await mcp.close();
  await svc.close();

  const { svc: cold } = await makeService(t, { rootDir: stateDir, clock });
  const restarted = await listener(t, cold, writes([h.id]));
  denied(await restarted.call('claim_task', held), 'work-session-invalid');
  assert.equal(cold.lookupLiveWriter(h.id), null);
  const live = await cold.open(h.id);
  assert.equal(live.state.tasks[other.id].state, 'ready');
  assert.equal(live.state.tasks[task.id].state, 'interrupted');
  assert.ok(live.store.commits.at(-1).events.some(({ type, data }) => type === 'lease/expired'
    && data.reason === 'restart' && data.token === second.lease.fencingToken));
  const expiring = await startWork(restarted, h.id, live.state.tasks[other.id]);
  now += 24 * 60 * 60 * 1000;
  const rev = live.rev;
  denied(await restarted.call('claim_task', expiring), 'work-session-invalid');
  assert.equal(live.rev, rev);
});
