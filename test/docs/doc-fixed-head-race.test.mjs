/**
 * 测试职责：确认、提交和完成对账均以自身留存对象为准，任何进程调用都不能偷偷使用 Git。
 * 典型流程：隔离工作区留存 A 并确认 → 外部编辑为 B → 任务提交或对账 → 回读确切版本。
 * 覆盖边界：覆盖 已提交版本引用与拒绝路径；不覆盖 实际宿主或真实数据。
 * 外部前置：无 Git；拦截本测试进程的子进程入口，试验只操作专用临时目录。
 */
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ProjectService } from '../../lib/core/service.js';
import { resolveExactWorkspaceVersion } from '../../lib/core/reader/workspace-retained.js';
import { makeService, command } from '../helpers/service-fixture.mjs';
import { sha } from '../helpers/fixed-fixture.mjs';

function prohibitChildProcess(t) {
  const names = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync'];
  const before = Object.fromEntries(names.map(name => [name, cp[name]]));
  const invoked = [];
  for (const name of names) cp[name] = (...args) => {
    invoked.push({ name, executable: args[0] });
    throw new Error('Unexpected product child process');
  };
  syncBuiltinESMExports();
  t.after(() => { Object.assign(cp, before); syncBuiltinESMExports(); });
  return invoked;
}

async function setup(t) {
  const { wsDir } = await makeService(t);
  const root = fs.realpathSync.native(wsDir);
  fs.mkdirSync(path.join(root, '.git'));
  const service = await new ProjectService({ spaceRoot: root }).init();
  t.after(() => service.close());
  const h = await service.createProject({ workspacePath: root, actor: { kind: 'human', via: 'test' } });
  await h.attach({ sessionId: 'gitless-test', agentId: 'gitless-test', source: 'test', role: 'worker' });
  const file = path.join(root, 'necessary.md');
  fs.writeFileSync(file, 'A: confirmed version\r\n');
  const { docId } = await h.command(command('doc.external.register', { title: 'Independent evidence', relPath: 'necessary.md' }));
  return { h, service, file, docId };
}

async function conclude({ h, docId }, route) {
  const created = await h.command(command('task.create', { title: 'Independent evidence', acceptance: [{ text: 'read back B' }] }));
  const taskId = created.events[0].data.id;
  const expected = () => ({ entityRev: h.state.tasks[taskId].rev });
  await h.command(command('task.claim', { taskId, expected: expected() }));
  const fencingToken = h.leases.get(taskId).token;
  await h.command(command('task.begin', { taskId, fencingToken, expected: expected(), summary: 'test retained evidence' }));
  if (route === 'reconcile') await h.command(command('task.interrupt', {
    taskId, fencingToken, expected: expected(), note: 'interrupted', sideEffects: [],
  }));
  const result = await h.command(command(route === 'submit' ? 'task.submit' : 'task.reconcile', {
    taskId, fencingToken, expected: expected(), ...(route === 'reconcile' ? { choice: 'completed', note: 'complete' } : {}),
    evidence: [{ kind: 'doc', ref: docId, acceptanceId: h.state.tasks[taskId].acceptance[0].id }],
  }));
  return { result, row: h.state.tasks[taskId].evidence.at(-1), taskId };
}

for (const route of ['submit', 'reconcile']) {
  // 责任：修改后提交或对账必须留存实际 B，且不能改写已确认 A 或调用 Git。
  test(`${route}: confirmation and evidence reference their own exact bytes without Git`, async t => {
    const s = await setup(t);
    const invoked = prohibitChildProcess(t);
    const { h, service, file, docId } = s;
    const confirmation = await h.command(command('doc.external.confirm', {
      docId, expectedMetaRev: h.state.docs[docId].rev, expectedContentHash: sha('A: confirmed version\r\n'),
    }));
    const original = h.state.docs[docId].baseline.workspaceVersion;
    assert.equal(original.contentHash, sha('A: confirmed version\r\n'));
    assert.ok(confirmation.events.some(event => event.type === 'doc/workspace-retained'));
    fs.writeFileSync(file, '\uFEFFB: submitted version🙂\r\n');
    const { row, result } = await conclude(s, route);
    assert.equal(row.hash, sha('\uFEFFB: submitted version🙂\r\n'));
    assert.equal(row.workspaceVersion.contentHash, row.hash);
    assert.equal(Object.hasOwn(row, 'fixed'), false);
    assert.equal(Object.hasOwn(h.state.project, 'gitContentRepository'), false);
    assert.ok(result.events.some(event => event.type === 'doc/workspace-retained'));
    assert.ok(result.events.every(event => event.type !== 'doc/content-fixed'));
    fs.writeFileSync(file, 'C: current file must not replace A or B');
    const read = ref => resolveExactWorkspaceVersion(service.spaceHome, h.state, ref).read().body;
    assert.equal(read(original), 'A: confirmed version\r\n');
    assert.equal(read(row.workspaceVersion), '\uFEFFB: submitted version🙂\r\n');
    assert.deepEqual(h.state.docs[docId].baseline.workspaceVersion, original);
    assert.deepEqual(invoked, []);
  });
}

// 责任：越权确认停在授权门，不追加确认日志、不安装正文对象。
test('a forbidden confirmation leaves both the object tree and log unchanged', async t => {
  const { h, service, docId } = await setup(t);
  const root = path.join(service.spaceHome.root, '.projectboard', 'objects');
  const list = () => fs.existsSync(root) ? fs.readdirSync(root, { recursive: true }).sort() : [];
  const before = list();
  const log = fs.readFileSync(h.store.commitsFile);
  await assert.rejects(h.command(command('doc.external.confirm', {
    actor: { kind: 'metadata', sessionId: 'synthetic-rejected' }, docId,
    expectedMetaRev: h.state.docs[docId].rev, expectedContentHash: sha('A: confirmed version\r\n'),
  })), { code: 'forbidden-role' });
  assert.deepEqual(list(), before);
  assert.deepEqual(fs.readFileSync(h.store.commitsFile), log);
});
