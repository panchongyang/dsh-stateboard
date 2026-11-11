/**
 * 测试职责：验证独立的只读项目视图不触发 writer、恢复、续租或修尾。
 * 典型流程：合成日志和项目 → 调用只读端口 → 比较分页、视图、磁盘树及错误。
 * 覆盖边界：覆盖 core 读边界、分页和 worker 关闭；不覆盖 MCP HTTP 或真实用户数据。
 * 外部前置：使用临时项目和进程内 worker。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createProjectReader } from '../../lib/core/project-reader.js';
import { JsonlStore } from '../../lib/core/store.js';
import { faultFs, ioError } from '../helpers/fault-fs.mjs';
import { command, makeService, withProject } from '../helpers/service-fixture.mjs';

async function addTask(handle, title, extra = {}) {
  const result = await handle.command(command('task.create', { title, acceptance: [{ text: 'Check result' }], ...extra }));
  return result.events[0].taskId;
}

function snapshotFiles(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
    .map(({ parentPath, name }) => path.join(parentPath, name)).sort().map((file) => [file, fs.readFileSync(file, 'base64')]);
}

// 责任：真实冷日志中保留进行中任务和坏尾；读取仍不触碰字节或打开 writer。
test('reader reports durable in-progress state without creating, recovering, or repairing', async (t) => {
  const { svc, h, stateDir } = await withProject(t, { name: 'Read project' });
  const taskId = await addTask(h, 'Inspect this');
  await h.attach({ sessionId: 'read-fixture', agentId: 'read-fixture', role: 'worker' });
  const result = await h.command(command('task.claim', {
    actor: { kind: 'agent', sessionId: 'read-fixture', agentId: 'read-fixture' }, taskId,
    expected: { entityRev: h.state.tasks[taskId].rev },
  }));
  const projectId = h.state.project.id;
  const projectRev = result.projectRev;
  const log = path.join(svc.projectsDir, projectId, 'commits.jsonl');
  await svc.close();
  fs.appendFileSync(log, '{"incomplete":');
  const { svc: cold } = await makeService(t, { rootDir: stateDir });
  const reader = createProjectReader(cold);
  try {
    const before = snapshotFiles(stateDir);
    const projects = await reader.listProjects();
    assert.deepEqual(projects, {
      projects: [{ id: projectId, name: 'Read project', phase: 'active', rev: projectRev, available: true }], nextCursor: null,
    });
    const list = await reader.listTasks({ projectId, state: 'in_progress' });
    assert.deepEqual(list.tasks.map(({ id, state }) => [id, state]), [[taskId, 'in_progress']]);
    assert.equal(list.projectRev, projectRev);
    const detail = await reader.getTask({ projectId, taskId });
    assert.equal(detail.task.state, 'in_progress');
    assert.equal(detail.projectRev, projectRev);
    assert.deepEqual(Object.keys(detail.task).sort(), [
      'acceptance', 'acceptanceTotal', 'description', 'evidenceCount', 'id', 'priority', 'rev', 'state', 'title', 'truncated',
    ]);
    detail.task.acceptance[0].text = 'Changed local result';
    assert.equal((await reader.getTask({ projectId, taskId })).task.acceptance[0].text, 'Check result');
    const context = await reader.getWorkContext({ projectId, taskId });
    assert.equal(context.projectRev, projectRev);
    assert.equal(context.task.id, taskId);
    assert.equal(context.task.acceptance[0].text, 'Check result');
    assert.equal(Object.hasOwn(context.task, 'owner'), false);
    assert.equal(context.nextAction, 'check_work_session');
    assert.equal(cold.handles.size, 0);
    assert.equal(fs.existsSync(path.join(cold.projectsDir, projectId, 'lock.json')), false);
    assert.deepEqual(snapshotFiles(stateDir), before);
  } finally { await reader.close(); }
});

// 责任：项目上下文给出有界的续做候选；读者确认任务后才返回详情。
test('work context prioritizes continuity and never selects a candidate', async (t) => {
  const { svc, h } = await withProject(t, { name: 'Context fixture' });
  const projectId = h.id;
  const reader = createProjectReader(svc);
  t.after(() => reader.close());
  const empty = await reader.getWorkContext({ projectId });
  assert.deepEqual(empty, {
    projectId, projectRev: h.rev, project: { name: 'Context fixture', phase: 'active' },
    task: null, candidates: [], candidateCount: 0, nextAction: 'no_open_task', stageWork: null,
  });
  const blockedId = await addTask(h, 'Blocked task', { requiresAudit: true });
  const human = { kind: 'human', via: 'test' };
  await h.command(command('task.claim', { actor: human, taskId: blockedId, expected: { entityRev: 1 } }));
  await h.command(command('task.block', {
    actor: human, taskId: blockedId, expected: { entityRev: 2 }, code: 'waiting', note: 'x'.repeat(450),
  }));
  const single = await reader.getWorkContext({ projectId });
  assert.equal(single.task, null);
  assert.equal(single.candidateCount, 1);
  assert.equal(single.nextAction, 'select_task');
  for (let i = 0; i < 5; i += 1) await addTask(h, 'Ready ' + i);
  const before = h.rev;
  const many = await reader.getWorkContext({ projectId });
  assert.equal(many.candidateCount, 6);
  assert.equal(many.candidates.length, 5);
  assert.equal(many.candidates[0].id, blockedId);
  assert.equal(many.task, null);
  const blocked = await reader.getWorkContext({ projectId, taskId: blockedId });
  assert.equal(blocked.task.requiresAudit, true);
  assert.deepEqual(blocked.task.blocker, { code: 'waiting', note: 'x'.repeat(400), truncated: true });
  assert.equal(blocked.nextAction, 'inspect_blocker');
  await assert.rejects(reader.getWorkContext({ projectId, taskId: 'tsk_missing' }), { code: 'not-found' });
  await assert.rejects(reader.getWorkContext({ projectId, taskId: '' }), { code: 'invalid-command' });
  assert.equal(h.rev, before);
});

// 责任：fsync 失败前日志上已可见的完整行，不能进入同进程 writer 的已提交任务视图。
test('reader uses published writer state while a tentative append rolls back', async (t) => {
  let faults;
  const { h, stateDir } = await withProject(t, {
    storeFactory(dir, meta) {
      faults = faultFs(dir);
      return new JsonlStore(dir, meta, { fs: faults.io });
    },
  });
  const projectId = h.state.project.id;
  const taskId = await addTask(h, 'Published');
  const { svc: observer } = await makeService(t, { rootDir: stateDir });
  const reader = createProjectReader(observer);
  const { commitsFile } = h.store;
  const before = fs.readFileSync(commitsFile);
  const projectRev = h.rev;
  let results;
  try {
    faults.arm('fsyncSync', (file) => file === commitsFile, () => {
      const line = fs.readFileSync(commitsFile, 'utf8').trimEnd().split('\n').at(-1);
      const tentative = JSON.parse(line).events.find((event) => event.type === 'task/created');
      assert.ok(tentative && tentative.taskId !== taskId);
      // Hold both cold worker slots to prove hot reads can complete without replay.
      results = Promise.allSettled([
        reader.listTasks({ projectId: 'prj_cold1' }),
        reader.listTasks({ projectId: 'prj_cold2' }),
        reader.listTasks({ projectId }),
        reader.getTask({ projectId, taskId: tentative.taskId }),
      ]);
      throw ioError();
    });
    await assert.rejects(addTask(h, 'Rollback'), { code: 'EIO' });
    faults.consumed();
    const [coldFirst, coldSecond, list, detail] = await results;
    assert.equal(coldFirst.reason?.code, 'not-found');
    assert.equal(coldSecond.reason?.code, 'not-found');
    assert.equal(list.status, 'fulfilled');
    assert.equal(list.value.projectRev, projectRev);
    assert.deepEqual(list.value.tasks.map(({ id }) => id), [taskId]);
    assert.equal(detail.reason?.code, 'not-found');
    assert.equal(h.rev, projectRev);
    assert.deepEqual(fs.readFileSync(commitsFile), before);
    assert.equal(observer.handles.size, 0);
  } finally { await reader.close(); }
});

// 责任：等待冷读取期间出现本进程 writer 时，使用已发布视图，即使冷读取失败。
test('reader prefers a newly visible writer after cold replay fails', async (t) => {
  const { svc, h, base } = await withProject(t);
  const projectId = h.state.project.id;
  const taskId = await addTask(h, 'Published');
  let lookups = 0;
  const reader = createProjectReader({
    projectsDir: path.join(base, 'absent-projects'),
    lookupLiveWriter(id) { return ++lookups === 1 ? null : svc.lookupLiveWriter(id); },
  });
  try {
    const detail = await reader.getTask({ projectId, taskId });
    assert.equal(detail.projectRev, h.rev);
    assert.equal(detail.task.id, taskId);
    assert.equal(lookups, 2);
  } finally { await reader.close(); }
});

// 责任：列表按 ID 稳定分页，详情文本和验收项裁剪后保持身份和总数。
test('project and task lists page by ID and task detail is bounded', async (t) => {
  const { svc, h, base } = await withProject(t, { name: 'First' });
  const otherWorkspace = path.join(base, 'other-workspace');
  fs.mkdirSync(otherWorkspace);
  const other = await svc.createProject({ workspacePath: otherWorkspace, name: 'Second' });
  const projectId = h.state.project.id;
  const ids = [
    await addTask(h, 'x'.repeat(301), {
      description: 'y'.repeat(4_001),
      acceptance: Array.from({ length: 42 }, (_, i) => ({ text: String(i) + 'z'.repeat(400), requiredKinds: ['note'] })),
    }),
    await addTask(h, 'second'),
    await addTask(h, 'third'),
  ];
  const reader = createProjectReader(svc);
  try {
    const firstProject = await reader.listProjects({ limit: 1 });
    const nextProject = await reader.listProjects({ limit: 1, after: firstProject.nextCursor });
    assert.deepEqual([firstProject.projects[0].id, nextProject.projects[0].id], [projectId, other.state.project.id].sort());
    assert.equal(nextProject.nextCursor, null);

    const firstTask = await reader.listTasks({ projectId, state: 'ready', limit: 2 });
    const nextTask = await reader.listTasks({ projectId, state: 'ready', limit: 2, after: firstTask.nextCursor });
    assert.deepEqual([...firstTask.tasks, ...nextTask.tasks].map(({ id }) => id), ids.toSorted());
    assert.equal(nextTask.nextCursor, null);
    const detail = (await reader.getTask({ projectId, taskId: ids[0] })).task;
    assert.equal(detail.title.length, 300);
    assert.equal(detail.description.length, 4_000);
    assert.equal(detail.acceptance.length, 40);
    assert.equal(detail.acceptanceTotal, 42);
    assert.equal(detail.acceptance[0].text.length, 400);
    assert.deepEqual(detail.acceptance[0].requiredKinds, ['note']);
    assert.equal(detail.truncated, true);
    await assert.rejects(reader.listTasks({ projectId, limit: 101 }), { code: 'invalid-command' });
    await assert.rejects(reader.listTasks({ projectId, state: 'unknown' }), { code: 'invalid-command' });
    await assert.rejects(reader.listProjects({ after: 'tsk_bad' }), { code: 'invalid-command' });
    await assert.rejects(reader.getTask({ projectId: '../outside', taskId: ids[0] }), { code: 'invalid-command' });
  } finally { await reader.close(); }
});

// 责任：不存在、不可读或版本不支持保持不同错误，列表不可读项不暴露内部路径。
test('reader separates missing projects and tasks from malformed and unsupported stores', async (t) => {
  const { svc, h, stateDir } = await withProject(t);
  const taskId = await addTask(h, 'Stored');
  const projectId = h.state.project.id;
  const dir = path.join(svc.projectsDir, projectId);
  const log = path.join(dir, 'commits.jsonl');
  const meta = path.join(dir, 'meta.json');
  await svc.close();
  const { svc: cold } = await makeService(t, { rootDir: stateDir });
  const reader = createProjectReader(cold);
  try {
    await assert.rejects(reader.listTasks({ projectId: 'prj_absent' }), { code: 'not-found', status: 404 });
    await assert.rejects(reader.getTask({ projectId, taskId: 'tsk_absent' }), { code: 'not-found', status: 404 });

    const original = fs.readFileSync(log, 'utf8');
    const first = original.indexOf('\n');
    fs.writeFileSync(log, JSON.stringify({ ...JSON.parse(original.slice(0, first)), v: 99 }) + original.slice(first));
    await assert.rejects(reader.getTask({ projectId, taskId }), { code: 'unsupported-version', status: 409 });
    fs.writeFileSync(log, original + 'bad-commit\n');
    await assert.rejects(reader.listTasks({ projectId }), { code: 'hash-chain-broken', status: 503 });
    fs.writeFileSync(meta, '{bad-meta\n');
    await assert.rejects(reader.listTasks({ projectId }), { code: 'project-unreadable', status: 503 });
    const { projects } = await reader.listProjects();
    assert.deepEqual(projects, [{
      id: projectId, available: false, error: { code: 'project-unreadable', message: 'Project data is unavailable' },
    }]);
    assert.equal(cold.handles.size, 0);
  } finally { await reader.close(); }
});

// 责任：工作线程占满后拒绝额外请求；关闭终止自己拥有的读线程并拒绝发布结果。
test('reader bounds replay concurrency and closes pending reads', async (t) => {
  const { svc, h, stateDir } = await withProject(t);
  const projectId = h.state.project.id;
  await svc.close();
  const { svc: cold } = await makeService(t, { rootDir: stateDir });
  const reader = createProjectReader(cold);
  const reads = Promise.allSettled(Array.from({ length: 3 }, () => reader.listTasks({ projectId })));
  await reader.close();
  const errors = (await reads).map(({ reason }) => reason.code);
  assert.deepEqual(errors, ['closed', 'closed', 'read-busy']);
  await assert.rejects(reader.listProjects(), { code: 'closed' });
});
// 责任：项目目录或存储文件的链接不能被当成已验证的项目数据。
test('reader rejects linked project directories without touching the target', async (t) => {
  const { svc, h, stateDir } = await withProject(t);
  const target = path.join(svc.projectsDir, h.state.project.id);
  const alias = path.join(svc.projectsDir, 'prj_linked');
  fs.symlinkSync(target, alias, 'junction');
  const reader = createProjectReader(svc);
  try {
    const before = snapshotFiles(target);
    await assert.rejects(reader.listTasks({ projectId: 'prj_linked' }), { code: 'project-unreadable', status: 503 });
    assert.deepEqual(snapshotFiles(target), before);
    assert.equal(svc.handles.size, 1);
  } finally {
    await reader.close();
    fs.unlinkSync(alias);
  }
});
