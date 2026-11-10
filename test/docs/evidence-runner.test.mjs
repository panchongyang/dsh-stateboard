/**
 * 测试职责：证明 command/test/note/url 都是材料，不会因 ref 或 execution 自报而被执行或判真。
 * 典型流程：临时任务指定 requiredKinds → submit 或 completed 对账 → 检查执行标记、证据与状态。
 * 覆盖边界：覆盖 多材料类型、覆盖不匹配的原子拒绝及旧 auto 请求拒绝；不覆盖真实命令 runner。
 * 外部前置：无；恶意 ref 仅是未执行字符串。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectService } from '../../lib/core/service.js';
import { auditEvidence, evidenceVerified } from '../../lib/core/evidence.js';

function cmd(op, extra = {}) {
  return { op, cmdId: crypto.randomUUID(), actor: { kind: 'agent', sessionId: 's1' }, ...extra };
}
async function setup(requiredKinds) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-material-'));
  const svc = new ProjectService({ rootDir: path.join(root, 'board') });
  await svc.init();
  const h = await svc.createProject({ workspacePath: root });
  await h.attach({ sessionId: 's1', agentId: 's1', source: 'test', role: 'worker' });
  const created = await h.command(cmd('task.create', { title: 'material', acceptance: [{ text: 'record', requiredKinds }] }));
  const id = created.events[0].taskId;
  await h.command(cmd('task.claim', { taskId: id, expected: { entityRev: h.state.tasks[id].rev } }));
  await h.command(cmd('task.begin', { taskId: id, expected: { entityRev: h.state.tasks[id].rev }, fencingToken: h.leases.get(id).token, summary: 'work' }));
  return { root, svc, h, id };
}
for (const entry of ['submit', 'reconcile']) {
  for (const kind of ['command', 'test', 'note', 'url']) {
    // 责任：提交含写文件命令的 ref 须不产生标记，execution 被清空且任务只到 review。
    test(`${entry}: ${kind} is recorded without executing or judging its ref`, async () => {
      const { root, svc, h, id } = await setup([kind]);
      try {
        const marker = path.join(root, 'EXECUTED');
        const ref = `node -e "require('fs').writeFileSync('${marker.replaceAll('\\', '/')}', 'bad')"`;
        if (entry === 'reconcile') await h.command(cmd('task.interrupt', { note: 'interrupted for reconciliation', taskId: id, expected: { entityRev: h.state.tasks[id].rev }, fencingToken: h.leases.get(id).token }));
        const evidence = [{ kind, ref, summary: 'failed or unavailable is still material', acceptanceId: h.state.tasks[id].acceptance[0].id, execution: { executor: 'host', status: 'failed', exitCode: 9, proofVersion: 2, proof: 'f'.repeat(64) } }];
        const result = await h.command(cmd('task.' + entry, { taskId: id, expected: { entityRev: h.state.tasks[id].rev }, fencingToken: h.leases.get(id)?.token, choice: 'completed', note: 'observed material', evidence }));
        assert.equal(fs.existsSync(marker), false);
        assert.equal(h.state.tasks[id].state, 'review');
        assert.equal(h.state.tasks[id].evidence[0].execution, null);
        assert.equal(evidenceVerified(h, h.state.tasks[id], h.state.tasks[id].evidence[0]), false);
        assert.deepEqual(auditEvidence(h, h.state.tasks[id]), []);
        assert.deepEqual(result.warnings || [], []);
      } finally { await svc.close(); }
    });
  }
  // 责任：验收点要求 file 却只交 note 时须 missing-evidence，版本与证据数量均不变。
  test(`${entry}: requiredKinds mismatch is atomic`, async () => {
    const { svc, h, id } = await setup(['file']);
    try {
      if (entry === 'reconcile') await h.command(cmd('task.interrupt', { note: 'interrupted for reconciliation', taskId: id, expected: { entityRev: h.state.tasks[id].rev }, fencingToken: h.leases.get(id).token }));
      const before = h.rev;
      await assert.rejects(h.command(cmd('task.' + entry, { taskId: id, expected: { entityRev: h.state.tasks[id].rev }, fencingToken: h.leases.get(id)?.token, choice: 'completed', note: 'done', evidence: [{ kind: 'note', ref: 'reported', acceptanceId: h.state.tasks[id].acceptance[0].id }] })), { code: 'missing-evidence' });
      assert.equal(h.rev, before);
      assert.equal(h.state.tasks[id].evidence.length, 0);
    } finally { await svc.close(); }
  });
}

// 责任：请求 verification:auto 必须报 retired，项目策略保持 manual。
test('auto verification requests are explicitly retired', async () => {
  const { svc, h } = await setup();
  try {
    await assert.rejects(h.command(cmd('project.update', { actor: { kind: 'human' }, policy: { verification: 'auto' } })), { code: 'invalid-command', message: /retired/ });
    assert.equal(h.state.project.policy.verification, 'manual');
  } finally { await svc.close(); }
});
