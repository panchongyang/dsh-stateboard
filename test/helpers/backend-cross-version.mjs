// 开发者兼容演练：仅生成独立的临时项目；不接入真实数据目录，不下载或安装任何东西。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const thisRepo = path.resolve(import.meta.dirname, '../..');
async function modules(root) {
  const load = p => import(pathToFileURL(path.resolve(root, 'lib/core', p)).href);
  const [{ ProjectService }, { JsonlStore }] = await Promise.all([load('service.js'), load('store.js')]);
  return { ProjectService, JsonlStore };
}

// 新建计划、任务、内容对象、工作意图与提交记录，覆盖一次多实体写和可去重命令。
export async function seedSynthetic(root, dir) {
  const { ProjectService } = await modules(root);
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-six-ws-'));
  const service = new ProjectService({ rootDir: dir, privilegedInlineWrites: true });
  try {
    await service.init();
    const actor = { kind: 'agent', agentId: 'synthetic-worker', sessionId: 'synthetic-worker', via: 'tool' };
    const handle = await service.createProject({ workspacePath, name: 'Synthetic compatibility', actor });
    await handle.attach({ sessionId: actor.sessionId, agentId: actor.agentId, role: 'worker' });
    const execute = (op, payload = {}) => handle.command({ op, actor, cmdId: 'compat:' + op, ...payload });
    const plan = await execute('plan.publish', { title: 'Synthetic plan', steps: [{ id: 'step', title: 'Work', tasks: [
      { key: 't', title: 'Synthetic task', acceptance: [{ text: 'Evidence retained' }] },
    ] }] });
    const taskId = plan.events.find(e => e.type === 'task/created').taskId;
    const put = await execute('doc.put', { title: 'Archive', kind: 'note', body: 'immutable archive\n', links: { taskIds: [taskId], planRefs: [] } });
    const doc = put.events.find(e => e.type === 'doc/created').data;
    const revision = () => ({ entityRev: handle.state.tasks[taskId].rev });
    await execute('task.claim', { taskId, expected: revision() });
    const fencingToken = handle.state.tasks[taskId].owner.fencingToken;
    await execute('task.begin', { taskId, expected: revision(), fencingToken, summary: 'synthetic work' });
    const acceptanceId = handle.state.tasks[taskId].acceptance[0].id;
    await execute('task.submit', { taskId, expected: revision(), fencingToken, evidence: [{ kind: 'doc', ref: doc.id + '@1', acceptanceId }] });
    assert.equal(handle.state.tasks[taskId].state, 'review');
    const verify=await execute('task.verify', { actor: { kind: 'human', via: 'web' }, taskId, expected: revision() });
    assert.ok(verify.committed);
    return { id: handle.id, docId: doc.id, taskId, dir: handle.meta.dir };
  } finally { await service.close(); }
}

function inspect({ JsonlStore }, dir, expected) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const store = new JsonlStore(dir, meta, { lock: false });
  try {
    const { state, timeline, cmdIds, lastSeq, lastHash, commits } = store.open();
    assert.equal(state.tasks[expected.taskId].state, 'done');
    const doc = state.docs[expected.docId];
    assert.equal(store.readBlob(doc.hash), 'immutable archive\n');
    assert.ok(cmdIds.has('compat:task.submit'));
    assert.ok(commits.some(c => c.events.some(e => e.type === 'task/submitted') && c.events.some(e => e.type === 'work/result')));
    return { state, timeline, ids: [...cmdIds], lastSeq, lastHash, events: commits.map(c => [c.seq, c.hash, c.actor, c.events.map(e => e.type)]) };
  } finally { store.close(); }
}

// 验证新版本的一行式业务首写也被旧读者完整还原；读者不得修整文件或忽略初始任务。
async function compareInitialTransaction(candidate, reference) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-six-first-log-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-six-first-ws-'));
  const svc = new candidate.ProjectService({ rootDir });
  const sessionId = 'first-local', cmdId = 'compat:first-task';
  let projectId;
  try {
    await svc.init();
    const first = await svc.commandInWorkspace(workspace, { op: 'task.create', cmdId,
      actor: { kind: 'agent', sessionId, agentId: sessionId, via: 'tool' }, expected: { projectRev: 1 },
      title: 'Single commit', acceptance: [{ text: 'Recorded' }] }, { agentSessionSource: 'tool' });
    projectId = first.projectId;
    assert.equal(first.result.projectRev, 1);
  } finally { await svc.close(); }
  const dir = path.join(rootDir, 'projects', projectId), log = path.join(dir, 'commits.jsonl');
  const bytes = fs.readFileSync(log), meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const read = ({ JsonlStore }) => {
    const store = new JsonlStore(dir, meta, { lock: false });
    try {
      const { state, timeline, cmdIds, lastSeq, lastHash, commits } = store.open();
      assert.equal(lastSeq, 1); assert.deepEqual([...cmdIds], [cmdId]);
      assert.equal(state.bindings[sessionId].epoch, 1);
      assert.equal(Object.values(state.tasks).length, 1); assert.equal(Object.values(state.tasks)[0].title, 'Single commit');
      assert.deepEqual(commits[0].events.slice(0, 3).map(e => e.type), ['project/created', 'session/bound', 'task/created']);
      return { state, timeline, lastHash };
    } finally { store.close(); }
  };
  assert.deepEqual(read(candidate), read(reference)); assert.deepEqual(fs.readFileSync(log), bytes);
  return { writer: 'candidate-first-business-write', commits: 1, tasks: 1, docBodies: 0 };
}

// 两个实现分别产生记录，两个只读实例打开完全相同的字节，并对照完整状态、水位和事件顺序。
export async function compareVersion(reference) {
  const current = await modules(thisRepo), other = await modules(reference);
  const cases = [];
  for (const [writer, name] of [[reference, 'reference'], [thisRepo, 'candidate']]) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-six-history-'));
    const expected = await seedSynthetic(writer, scratch);
    const log = path.join(expected.dir, 'commits.jsonl');
    const original = fs.readFileSync(log);
    const one = inspect(current, expected.dir, expected), two = inspect(other, expected.dir, expected);
    assert.deepEqual(one, two);
    assert.deepEqual(original, fs.readFileSync(log));
    cases.push({ writer: name, commits: one.lastSeq, tasks: Object.keys(one.state.tasks).length, docBodies: 1 });
  }
  cases.push(await compareInitialTransaction(current, other));
  return cases;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv.length !== 3 || !path.isAbsolute(process.argv[2])) throw new Error('Supply the absolute path of the trusted reference checkout; never a data root');
  console.log(JSON.stringify(await compareVersion(process.argv[2])));
}
