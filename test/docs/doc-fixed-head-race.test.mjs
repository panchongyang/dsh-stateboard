/**
 * 测试职责：防止洁净校验期间 HEAD 前移造成旧提交与当前字节混配。
 * 典型流程：临时仓库包含 A/B 提交 → 拦截 HEAD 返回值 → 调用自动固定、提交或对账 → 检查降级。
 * 覆盖边界：覆盖 三条入口的 HEAD 复核和 filemode 后最终检查；不覆盖真实高压并发或远程更新。
 * 外部前置：需要 Git；仅拦截本进程 spawnSync 并在结束后恢复。
 */
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { withProject, command } from '../helpers/service-fixture.mjs';
import { autoExternalEvidence } from '../../lib/core/documents/fixed-auto.js';
import { assertCleanPath } from '../../lib/core/documents/fixed-worktree.js';
import { repositoryAt } from '../../lib/core/documents/fixed-git.js';
import { git, put, repository, sha } from '../helpers/fixed-fixture.mjs';

function intercept(t, transform) {
  const original = cp.spawnSync;
  cp.spawnSync = function (exe, args, options) {
    const result = original(exe, args, options);
    transform(args, result);
    return result;
  };
  syncBuiltinESMExports();
  t.after(() => { cp.spawnSync = original; syncBuiltinESMExports(); });
}

async function setup(t) {
  const { root, oid } = repository('sha1', t);
  put(root, 'docs/spec.md', 'version two\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'second version');
  const current = git(root, 'rev-parse', 'HEAD');
  const { h } = await withProject(t, { workspacePath: root });
  await h.attach({ sessionId: 'fixed-test', agentId: 'fixed-test', source: 'test', role: 'worker' });
  const { docId } = await h.command(command('doc.external.register', { title: 'Race', relPath: 'docs/spec.md' }));
  return { root, oid, current, h, docId };
}

const isHead = (args) => args.slice(-3).join(' ') === 'rev-parse --verify HEAD^{commit}';

for (const route of ['auto', 'submit', 'reconcile']) {
  // 责任：首次返回旧 HEAD 后再返回新 HEAD，各入口须降级 head-changed、保留 B 字节且不写固定事件。
  test(`${route}: HEAD A then clean B silently degrades, never pins A bytes`, async (t) => {
    const s = await setup(t);
    let reads = 0;
    intercept(t, (args, result) => {
      if (!isHead(args)) return;
      if (reads++ === 0) {
        result.stdout = Buffer.from(s.oid + '\n');
        result.output[1] = result.stdout;
      }
    });
    let row, events = [];
    if (route === 'auto') row = autoExternalEvidence(s.h, s.h.state.docs[s.docId]);
    else {
      const created = await s.h.command(command('task.create', { title: 'Race task', acceptance: [{ text: 'safe evidence' }] }));
      const taskId = created.events[0].data.id;
      const expected = () => ({ entityRev: s.h.state.tasks[taskId].rev });
      await s.h.command(command('task.claim', { taskId, expected: expected() }));
      const fencingToken = s.h.leases.get(taskId).token;
      await s.h.command(command('task.begin', { taskId, fencingToken, expected: expected(), summary: 'race' }));
      if (route === 'reconcile') await s.h.command(command('task.interrupt', {
        taskId, fencingToken, expected: expected(), note: 'interrupted', sideEffects: [],
      }));
      const result = await s.h.command(command(route === 'submit' ? 'task.submit' : 'task.reconcile', {
        taskId, fencingToken, expected: expected(), choice: 'completed', note: 'complete',
        evidence: [{ kind: 'doc', ref: s.docId, acceptanceId: s.h.state.tasks[taskId].acceptance[0].id }],
      }));
      events = result.events;
      row = s.h.state.tasks[taskId].evidence.at(-1);
    }
    assert.ok(reads >= 2, 'seam must cross distinct HEAD reads');
    assert.equal(row.fixedState, 'current-only');
    assert.equal(row.fixedReason, 'head-changed');
    assert.equal(row.fixed ?? null, null);
    assert.equal(row.hash, sha('version two\n'));
    assert.equal(s.h.state.project.gitContentRepository, undefined);
    assert.equal(events.some((e) => ['project/updated', 'doc/content-fixed'].includes(e.type)), false);
  });
}

// 责任：在 filemode 校验后改变 HEAD 返回值，clean 检查必须最后复核并报 head-changed。
test('HEAD is rechecked after all cleanliness checks, including filemode config', async (t) => {
  const s = await setup(t);
  let checkedMode = false, finalRead = false;
  intercept(t, (args, result) => {
    if (args.slice(-3).join(' ') === 'config --get core.filemode') checkedMode = true;
    if (isHead(args) && checkedMode) {
      finalRead = true;
      result.stdout = Buffer.from(s.oid + '\n');
      result.output[1] = result.stdout;
    }
  });
  assert.throws(() => assertCleanPath(repositoryAt(s.root), 'docs/spec.md', s.current), { code: 'head-changed' });
  assert.equal(checkedMode, true);
  assert.equal(finalRead, true);
});
