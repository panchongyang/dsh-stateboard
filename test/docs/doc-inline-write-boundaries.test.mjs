/**
 * 测试职责：防止被拒绝的内嵌写请求先创建项目或冷开恢复已有工作。
 * 典型流程：合成宿主及无项目/冷项目目录 → 工具 put/link → 比较目录、日志哈希和只读重放状态。
 * 覆盖边界：覆盖 工具和 HTTP 拒绝零写、旧快照及允许打开时的恢复对照；不覆盖 真实 DSH 实例。
 * 外部前置：需要 DSH peer 可导入；只使用合成 store。
 */
// Host entry-point boundaries for the inline-write policy. A rejected inline
// write must be refused BEFORE the project is created or opened: opening a cold
// project runs recovery commits, and the old tool path minted a project for a
// write that was then rejected. These cases use synthetic roots only.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { apply } from '../../lib/index.js';
import { ProjectService } from '../../lib/core/service.js';
import { replay } from '../../lib/core/store/format.js';

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));

function boot(stateDir) {
  const tools = new Map();
  const disposers = [];
  let route;
  let inject;
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { register(tool) { tools.set(tool.name, tool); } },
    systemPrompt: { section() { return () => {}; }, getSectionOrder() { return 9000; } },
    agents: { list() { return []; } },
    on(name, handler) { if (name === 'webserver/index-inject') inject = handler; return () => {}; },
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return () => {}; },
    get(name) {
      if (name === 'webServer') return { register(spec) { route = spec.handler; return () => {}; } };
      return undefined;
    },
  };
  apply(ctx, { rootDir: stateDir });
  return { tools, disposers, postCommand };

  function postCommand(projectId, command) {
    const injected = [];
    inject(injected);
    const token = injected.find((item) => item.name === '__PROJECT_BOARD__').value.token;
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(command))]), {
      url: '/project-board/api/projects/' + projectId + '/commands',
      method: 'POST',
      headers: { 'x-project-board-token': token },
    });
    return new Promise((resolve) => {
      let status;
      route(req, { writeHead(code) { status = code; }, end(body) { resolve({ status, body: JSON.parse(body) }); } });
    });
  }
}

function execAt(cwd) {
  return { agent: { id: 'session-inline-boundary', session: { header: { cwd } } }, callId: 'call-inline-boundary' };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every project log under the store, hashed: a rejected write must not append. */
function logBytes(root, out = []) {
  if (!fs.existsSync(root)) return '';
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) logBytes(full, out);
    else if (entry.name === 'commits.jsonl') out.push(path.relative(root, full) + ' ' + crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'));
  }
  return out.sort().join('|');
}

function taskStateFromLog(root, taskId) {
  let logFile = null;
  (function find(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) find(full);
      else if (entry.name === 'commits.jsonl' && !logFile) logFile = full;
    }
  })(path.join(root, 'projects'));
  assert.ok(logFile, 'project log exists');
  const commits = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  return replay({ project: {} }, commits).state.tasks[taskId]?.state ?? null;
}

// 责任：无项目工作区执行被拒 doc.put 须报 not-found，不得创建项目目录或 genesis 日志。
test('a brand-new workspace is not turned into a project by a rejected doc.put', async () => {
  const stateDir = tmp('pb-inline-boundary-new-state');
  const ws = tmp('pb-inline-boundary-new-ws');
  const tools = boot(stateDir).tools;
  await sleep(30);
  const err = await tools.get('project_doc').execute({ op: 'put', title: 'Denied', body: 'no' }, execAt(ws)).then(() => null, (error) => error);
  assert.equal(err.code, 'not-found', 'there is no project yet; tell the caller to publish a plan first');
  const projectsDir = path.join(stateDir, 'projects');
  const created = fs.existsSync(projectsDir) ? fs.readdirSync(projectsDir) : [];
  assert.deepEqual(created, [], 'a rejected inline write creates no project directory');
  assert.equal(logBytes(stateDir), '', 'a rejected inline write appends no genesis/recovery commit');
});

// 责任：冷项目 put/link/畸形请求被拒后日志和进行中状态不变，有效 board 请求仍须触发恢复。
test('rejected HTTP and tool put/link on a cold project do not trigger recovery commits', async (t) => {
  const stateDir = tmp('pb-inline-boundary-cold-state');
  const ws = tmp('pb-inline-boundary-cold-ws');
  const seed = new ProjectService({ rootDir: stateDir });
  await seed.init();
  const h = await seed.createProject({ workspacePath: ws, name: 'cold' });
  const created = await h.command({
    cmdId: 'cmd_boundary_task', actor: { kind: 'human', via: 'test' }, op: 'task.create', title: 'T', acceptance: [{ text: 'x' }],
  });
  const taskId = created.events[0].data.id;
  await h.command({ cmdId: 'cmd_boundary_claim', actor: { kind: 'human', via: 'test' }, op: 'task.claim', taskId, expected: { entityRev: 1 } });
  await seed.close();

  const before = logBytes(stateDir);
  assert.equal(taskStateFromLog(stateDir, taskId), 'in_progress');
  const { tools, disposers, postCommand } = boot(stateDir);
  t.after(async () => { for (const dispose of disposers.reverse()) await dispose(); });
  await sleep(30);

  const put = await tools.get('project_doc').execute({ op: 'put', title: 'Denied', body: 'no' }, execAt(ws)).then(() => null, (error) => error);
  assert.equal(put.code, 'inline-write-disabled');
  const link = await tools.get('project_doc').execute({ op: 'link', docId: 'doc_missing', links: { taskIds: [] } }, execAt(ws)).then(() => null, (error) => error);
  assert.equal(link.code, 'not-found');

  const shape = await tools.get('project_doc').execute({ op: 'put', title: 'No body' }, execAt(ws)).then(() => null, (error) => error);
  assert.equal(shape.code, 'invalid-command');
  const badLinks = { taskIds: ['tsk_unknown'] };
  await assert.rejects(tools.get('project_doc').execute({ op: 'put', title: 'Bad links', body: 'x', links: badLinks }, execAt(ws)), (error) => {
    assert.equal(error.code, 'invalid-command');
    assert.deepEqual(JSON.parse(error.message).details, { unknownTaskIds: ['tsk_unknown'] });
    return true;
  });

  for (const [command, status, code] of [
    [{ op: 'doc.put', title: 'No body' }, 400, 'invalid-command'],
    [{ op: 'doc.put', title: 'Bad links', body: 'x', links: badLinks }, 400, 'invalid-command'],
    [{ op: 'doc.put', title: 123, body: 'x' }, 409, 'inline-write-disabled'],
    [{ op: 'doc.link', docId: 'doc_missing', links: badLinks }, 404, 'not-found'],
  ]) {
    const response = await postCommand(h.id, command);
    assert.equal(response.status, status);
    assert.equal(response.body.error.code, code);
  }

  assert.equal(logBytes(stateDir), before, 'the policy rejection appends no lease/recovery commit');
  assert.equal(taskStateFromLog(stateDir, taskId), 'in_progress', 'the un-recovered task is untouched');
  assert.equal(fs.existsSync(h.store.lockFile), false, 'the rejected requests do not acquire a writer lock');

  // A valid write path still opens and recovers the same cold project.
  const board = tools.get('project_board');
  const view = await board.execute({ view: 'board' }, execAt(ws));
  assert.ok(view.ok);
  assert.notEqual(logBytes(stateDir), before, 'a valid open still runs recovery');
});

// 责任：人工启用后，工具 put/link 保持原命令结果和文档投影。
test('permitted tool put/link preserve the command result and document projection', async (t) => {
  const stateDir = tmp('pb-inline-boundary-permitted-state');
  const ws = tmp('pb-inline-boundary-permitted-ws');
  const seed = new ProjectService({ rootDir: stateDir });
  await seed.init();
  const h = await seed.createProject({ workspacePath: ws, name: 'allowed' });
  await h.command({ op: 'doc.inline_policy', cmdId: 'cmd_inline_permitted', actor: { kind: 'human' },
    authorized: true, disabled: false, expected: { projectRev: h.rev } });
  await seed.close();

  const { tools, disposers } = boot(stateDir);
  t.after(async () => { for (const dispose of disposers.reverse()) await dispose(); });
  const tool = tools.get('project_doc');
  const exec = execAt(ws);
  const created = await tool.execute({ op: 'put', title: 'Allowed', body: 'hello' }, exec);
  assert.equal(created.projectId, h.id);
  assert.equal(created.result.events.at(-1).type, 'doc/created');
  assert.equal(created.doc.title, 'Allowed');
  const linked = await tool.execute({ op: 'link', docId: created.doc.id, links: { taskIds: [] } }, exec);
  assert.equal(linked.projectId, h.id);
  assert.equal(linked.result.events.at(-1).type, 'doc/updated');
  assert.equal(linked.doc.id, created.doc.id);
  assert.equal(linked.doc.rev, created.doc.rev + 1);
});

// 责任：不可读取的提交日志须以损坏错误拒绝，不能当成缺项目或继续打开写句柄。
test('inline command admission surfaces a corrupt log without opening a writer', async (t) => {
  const stateDir = tmp('pb-inline-boundary-corrupt-state');
  const ws = tmp('pb-inline-boundary-corrupt-ws');
  const seed = new ProjectService({ rootDir: stateDir });
  await seed.init();
  const h = await seed.createProject({ workspacePath: ws, name: 'corrupt' });
  await seed.close();
  fs.appendFileSync(h.store.commitsFile, 'synthetic bad complete line\n');
  const before = logBytes(stateDir);
  const { tools, disposers, postCommand } = boot(stateDir);
  t.after(async () => { for (const dispose of disposers.reverse()) await dispose(); });
  await assert.rejects(tools.get('project_doc').execute({ op: 'put', title: 'Denied', body: 'x' }, execAt(ws)), { code: 'hash-chain-broken' });
  const response = await postCommand(h.id, { op: 'doc.put', title: 'Denied', body: 'x' });
  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, 'hash-chain-broken');
  assert.equal(fs.existsSync(h.store.lockFile), false);
  assert.equal(logBytes(stateDir), before);
});


// 责任：旧快照省略空 docs 时，拒绝仍使用原有错误并且不打开 writer。
test('inline admission treats missing docs in an accepted snapshot as empty', async (t) => {
  const stateDir = tmp('pb-inline-boundary-empty-docs-state');
  const ws = tmp('pb-inline-boundary-empty-docs-ws');
  const seed = await new ProjectService({ rootDir: stateDir }).init();
  const h = await seed.createProject({ workspacePath: ws, name: 'empty docs' });
  const state = structuredClone(h.state);
  delete state.docs;
  await seed.close();
  fs.writeFileSync(h.store.snapshotFile, JSON.stringify({ v: 1, seq: h.rev, hash: h.lastHash, state }));

  const before = logBytes(stateDir);
  const { tools, disposers, postCommand } = boot(stateDir);
  t.after(async () => { for (const dispose of disposers.reverse()) await dispose(); });
  const tool = tools.get('project_doc');
  for (const [args, status, code] of [
    [{ op: 'link', docId: 'doc_missing', links: { taskIds: [] } }, 404, 'not-found'],
    [{ op: 'put', docId: 'doc_missing', title: 'Denied', body: 'x' }, 409, 'inline-write-disabled'],
  ]) {
    await assert.rejects(tool.execute(args, execAt(ws)), { code });
    const response = await postCommand(h.id, { ...args, op: 'doc.' + args.op });
    assert.equal(response.status, status);
    assert.equal(response.body.error.code, code);
  }
  assert.equal(fs.existsSync(h.store.lockFile), false);
  assert.equal(logBytes(stateDir), before);
});
