/**
 * 测试职责：守住日志重放、完整性、单写者与项目搬迁的集成契约。
 * 典型流程：构造合成临时项目或状态 → 执行领域操作 → 比较原始断言与副作用。
 * 覆盖边界：覆盖 冷恢复、提交链和只读 follower；不覆盖 任务轻编辑、计划成员或性能预算。
 * 外部前置：需要可写临时目录；日志篡改只作用于合成项目。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ProjectService } from '../../lib/core/service.js';

import test from 'node:test';
import { JsonlStore, commitHash } from '../../lib/core/store.js';
import { tmp, cmd, humanCmd, setup, publish, taskByTitle, tokenOf, openSubmittable } from '../helpers/core-lifecycle-fixture.mjs';

function logFile(stateDir, projectId) {
  return path.join(stateDir, 'projects', projectId, 'commits.jsonl');
}

function readLog(stateDir, projectId) {
  return fs.readFileSync(logFile(stateDir, projectId), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

function writeLog(stateDir, projectId, commits) {
  fs.writeFileSync(logFile(stateDir, projectId), commits.map((commit) => JSON.stringify(commit)).join('\n') + '\n');
  const snapshot = path.join(stateDir, 'projects', projectId, 'snapshot.json');
  if (fs.existsSync(snapshot)) fs.rmSync(snapshot);
}

function relink(commits) {
  let prev = 'genesis';
  return commits.map((commit) => {
    const next = { ...commit, prev };
    next.hash = commitHash(next);
    prev = next.hash;
    return next;
  });
}

async function openTampered(stateDir, projectId, mutate) {
  writeLog(stateDir, projectId, mutate(readLog(stateDir, projectId)));
  const svc2 = new ProjectService({ rootDir: stateDir, privilegedInlineWrites: true });
  await svc2.init();
  try {
    const handle = await svc2.open(projectId);
    return { handle, error: null, svc: svc2 };
  } catch (error) {
    return { handle: null, error, svc: svc2 };
  }
}

// 责任：搬迁项目后旧路径不再找到看板，新路径须复用同 id、任务及更新后的 meta。
test('project.relocate moves the project to a new workspace and keeps its data', async () => {
  const { h, svc, wsDir, stateDir } = await setup();
  await publish(h);
  const oldId = h.id;
  const ws2 = tmp('pb-ws2');
  const result = await h.command({ cmdId: 'reloc-1', actor: { kind: 'system', via: 'system' }, op: 'project.relocate', workspacePath: ws2 });
  assert.equal(result.ok, true);
  assert.equal((await svc.openByWorkspace(wsDir)), null);
  const moved = await svc.openByWorkspace(ws2);
  assert.equal(moved.id, oldId);
  assert.equal(Object.keys(moved.state.tasks).length, 2);
  const meta = JSON.parse(fs.readFileSync(path.join(stateDir, 'projects', oldId, 'meta.json'), 'utf8'));
  assert.equal(meta.project.workspacePath, moved.workspacePath);
  assert.ok(meta.project.workspacePath.includes('pb-ws2'));
  await svc.close();
});

// 责任：带开放意图重启后任务须 interrupted，completed 对账加证据才转 review 供人工验收。
test('crash recovery marks interrupted and reconcile(completed) moves to review', async () => {
  const { h, wsDir, stateDir, svc } = await setup();
  fs.writeFileSync(path.join(wsDir, 'artifact.txt'), 'hello');
  await publish(h);
  const t1 = taskByTitle(h, 'T1');
  await h.command(cmd('task.claim', { taskId: t1.id, expected: { entityRev: t1.rev } }));
  const claim = h.state.tasks[t1.id];
  await h.command({ ...cmd('task.begin', { taskId: t1.id, expected: { entityRev: claim.rev }, fencingToken: tokenOf(h, t1.id), summary: 'x' }) });
  const taskId = t1.id;
  const acceptanceId = h.state.tasks[taskId].acceptance[0].id;
  h.close();
  await svc.close();

  const svc2 = new ProjectService({ rootDir: stateDir, privilegedInlineWrites: true });
  await svc2.init();
  const h2 = await svc2.open(h.id);
  const recovered = h2.state.tasks[taskId];
  assert.equal(recovered.state, 'interrupted');
  const result = await h2.command({ ...cmd('task.reconcile', {
    taskId,
    expected: { entityRev: recovered.rev },
    choice: 'completed',
    note: 'verified the file exists',
    evidence: [{ kind: 'file', ref: 'artifact.txt', summary: 'artifact', acceptanceId }],
  }) });
  assert.equal(result.ok, true);
  assert.equal(h2.state.tasks[taskId].state, 'review');
  const verified = await h2.command(humanCmd('task.verify', { taskId, expected: { entityRev: h2.state.tasks[taskId].rev } }));
  assert.equal(verified.ok, true);
  assert.equal(h2.state.tasks[taskId].state, 'done');
  h2.close();
  await svc2.close();
});

// 责任：关闭并重新打开同一项目后，完整领域状态须与提交前克隆完全相同。
test('replay from commits is deterministic', async () => {
  const { h, stateDir, svc } = await setup();
  await publish(h);
  const before = structuredClone(h.state);
  h.close();
  await svc.close();
  const svc2 = new ProjectService({ rootDir: stateDir, privilegedInlineWrites: true });
  await svc2.init();
  const h2 = await svc2.open(h.id);
  assert.deepEqual(h2.state, before);
  h2.close();
  await svc2.close();
});

// 责任：日志末尾截断残片须被忽略并在打开时修复，已提交前缀不可丢失。
test('truncated tail is ignored and repaired on open', async () => {
  const { h, stateDir, svc } = await setup();
  await publish(h);
  const before = structuredClone(h.state);
  const commitsFile = path.join(stateDir, 'projects', h.id, 'commits.jsonl');
  h.close();
  await svc.close();
  fs.appendFileSync(commitsFile, '{"v":1,"seq":');
  const svc2 = new ProjectService({ rootDir: stateDir, privilegedInlineWrites: true });
  await svc2.init();
  const h2 = await svc2.open(h.id);
  assert.deepEqual(h2.state, before);
  const text = fs.readFileSync(commitsFile, 'utf8');
  assert.ok(text.endsWith('\n'));
  h2.close();
  await svc2.close();
});

// 责任：同进程第二个 service 打开同项目须共享 handle，不能分叉写日志。
test('a second service over the same project shares one handle instead of forking the log', async () => {
  const { h, stateDir, svc } = await setup();
  await publish(h);
  const before = h.rev;
  const svc2 = new ProjectService({ rootDir: stateDir, privilegedInlineWrites: true });
  await svc2.init();
  const h2 = await svc2.open(h.id);
  assert.equal(h2, h, 'one handle per project per process');
  assert.equal(h2.rev, before);
  await h2.command(cmd('task.create', { title: 'From svc2', acceptance: [{ text: 'x' }] }));
  assert.equal(h.rev, before + 1, 'the first service sees the commit');
  const seqs = fs.readFileSync(path.join(stateDir, 'projects', h.id, 'commits.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line).seq);
  assert.deepEqual(seqs, seqs.map((_, index) => index + 1), 'seq stays contiguous');
  await svc2.close();
  await svc.close();
});

// 责任：绕过 service 在同进程重复打开同一日志必须拒绝，防止双 writer。
test('opening one project log twice in the same process is refused', async () => {
  const { h, stateDir, svc } = await setup();
  await publish(h);
  const dir = path.join(stateDir, 'projects', h.id);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const second = new JsonlStore(dir, meta);
  assert.throws(() => second.open(), (error) => error && error.code === 'log-busy');
  await svc.close();
});

// 责任：另一 writer 延长日志后旧 writer append 须拒绝，不能覆盖已有尾部。
test('a writer refuses to append when another writer extended the log', async () => {
  const { h, stateDir, svc } = await setup();
  await publish(h);
  const file = path.join(stateDir, 'projects', h.id, 'commits.jsonl');
  const external = { v: 1, seq: 999, prev: 'deadbeef', hash: 'x', at: new Date().toISOString(), actor: { kind: 'system' }, cmdId: 'cmd_external', baseRev: 0, events: [] };
  fs.appendFileSync(file, JSON.stringify(external) + '\n');
  const error = await h.command(cmd('task.create', { title: 'Nope', acceptance: [{ text: 'x' }] })).then(() => null, (e) => e);
  assert.ok(error, 'append must be refused');
  assert.equal(error.code, 'log-forked');
  await svc.close();
});

// 责任：同 handle recover 只能执行一次，重复调用不得重写已存在日志。
test('recover runs once per handle and never rewrites the log', async () => {
  const { h, svc } = await setup();
  await publish(h);
  const t1 = taskByTitle(h, 'T1');
  await h.command(cmd('task.claim', { taskId: t1.id, expected: { entityRev: t1.rev } }));
  const before = h.rev;
  h.recover();
  assert.equal(h.rev, before, 'a second recover is a no-op');
  assert.equal(h.state.tasks[t1.id].state, 'in_progress');
  await svc.close();
});

// 责任：修改提交 payload 却不更新哈希时，冷重放必须识别哈希篡改。
test('a tampered payload is caught by the commit hash', async () => {
  const { h, svc, stateDir } = await openSubmittable();
  await svc.close();
  const { error, svc: reopened } = await openTampered(stateDir, h.id, (commits) => {
    const next = commits.map((commit) => ({ ...commit }));
    next[1] = { ...next[1], at: '2000-01-01T00:00:00.000Z' };
    return next;
  });
  assert.equal(error?.code, 'hash-chain-broken');
  assert.match(error.message, /hash/);
  await reopened.close();
});

// 责任：即使重算全部哈希，重复 seq 仍须被连续序号校验拒绝。
test('a duplicated seq is caught even when every hash is rebuilt', async () => {
  const { h, svc, stateDir } = await openSubmittable();
  await svc.close();
  const { error, svc: reopened } = await openTampered(stateDir, h.id, (commits) => {
    const copy = { ...commits[1], cmdId: 'cmd_duplicate_seq' };
    return relink([commits[0], commits[1], copy, ...commits.slice(2)]);
  });
  assert.equal(error?.code, 'hash-chain-broken');
  assert.match(error.message, /seq/);
  await reopened.close();
});

// 责任：即使重算哈希，prev 跳过中间提交也必须被链校验识别。
test('a prev hash that skips a commit is caught even when every hash is rebuilt', async () => {
  const { h, svc, stateDir } = await openSubmittable();
  await svc.close();
  const { error, svc: reopened } = await openTampered(stateDir, h.id, (commits) => {
    const next = commits.map((commit) => ({ ...commit }));
    next[2] = { ...next[2], prev: next[0].hash };
    next[2].hash = commitHash(next[2]);
    for (let i = 3; i < next.length; i += 1) {
      next[i] = { ...next[i], prev: next[i - 1].hash };
      next[i].hash = commitHash(next[i]);
    }
    return next;
  });
  assert.equal(error?.code, 'hash-chain-broken');
  assert.match(error.message, /prev/);
  await reopened.close();
});

// 责任：日志格式来自更新版本时须报不兼容，不能错当损坏尝试修复。
test('a log written by a newer format is refused, not treated as corruption', async () => {
  const { h, svc, stateDir } = await openSubmittable();
  await svc.close();
  const file = logFile(stateDir, h.id);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  lines[0] = { ...lines[0], v: 2 };
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  const snapshot = path.join(stateDir, 'projects', h.id, 'snapshot.json');
  if (fs.existsSync(snapshot)) fs.rmSync(snapshot);
  const svc2 = new ProjectService({ rootDir: stateDir, privilegedInlineWrites: true });
  await svc2.init();
  const error = await svc2.open(h.id).then(() => null, (err) => err);
  assert.equal(error?.code, 'unsupported-version');
  assert.match(error.message, /version 2/);
  await svc2.close();
});

// 责任：只读 follower 已打开后须看见后续追加的提交，不得永久停在旧投影。
test('a read-only follower sees commits appended after it opened', async () => {
  const { h, svc, stateDir } = await openSubmittable();
  const projectId = h.id;
  h.close();
  await svc.close();
  const meta = JSON.parse(fs.readFileSync(path.join(stateDir, 'projects', projectId, 'meta.json'), 'utf8'));
  const peek = new JsonlStore(path.join(stateDir, 'projects', projectId), meta.project ? meta : { project: meta }, { lock: false });
  const first = peek.open();
  const rev0 = first.lastSeq;
  assert.equal(peek.readOnly, true);

  const writer = new ProjectService({ rootDir: stateDir, privilegedInlineWrites: true });
  await writer.init();
  const w = await writer.open(projectId);
  await w.command(cmd('task.create', { title: 'After the peek', acceptance: [{ text: 'x' }] }));

  const seen = peek.refresh();
  assert.ok(seen, 'the follower noticed the append');
  assert.equal(peek.lastSeq, rev0 + 1);
  assert.equal(peek.lastSeq, w.rev);
  assert.ok(Object.values(peek.state.tasks).some((task) => task.title === 'After the peek'));
  assert.equal(peek.refresh(), null, 'a second refresh with no new commits is a no-op');
  peek.close();
  await writer.close();
});
