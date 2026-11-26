/**
 * 测试职责：旧 Git 固定事实的结构校验与冷重放保留，读取不访问对象、不推断缺失来源。
 * 典型流程：合成旧屏障/日志 → 校验缺屏障拒绝 → 无 Git 冷开与读取 → 缺对象/改定位后对照元数据。
 * 覆盖边界：覆盖 同提交屏障、无 Git 重放、缺对象与原始身份不变；不覆盖远程对象修复或下载。
 * 外部前置：Git 只用于构造合成旧日志；运行期用例把 Git 执行面替换为直接失败。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { ProjectService } from '../../lib/core/service.js';
import { applyEvent } from '../../lib/core/model.js';
import { MemoryStore } from '../../lib/core/store.js';
import { assertFixedCommit } from '../../lib/core/documents/fixed-reference.js';
import { getFixedContent } from '../../lib/core/documents/fixed-content.js';
import { auditEvidence } from '../../lib/core/evidence.js';
import { bootstrapPin, command, repository, temp } from '../helpers/fixed-fixture.mjs';

async function setup() {
  const { root, oid } = repository();
  const board = temp();
  const svc = new ProjectService({ rootDir: board, privilegedInlineWrites: true });
  await svc.init();
  const h = await svc.createProject({ workspacePath: root });
  await h.attach({ sessionId: 'edge', agentId: 'edge', source: 'test', role: 'worker' });
  const out = await h.command(command('doc.external.register', { title: '边界', relPath: 'docs/spec.md' }));
  const pin = await bootstrapPin(h, out.docId);
  const row = { id: 'ev_legacy', taskId: 'tsk_edge', kind: 'doc', ref: out.docId, hash: pin.fixed.blobContentHash, fixed: structuredClone(pin.fixed), verifiedAt: '2025-01-01T00:00:00.000Z' };
  return { root, oid, board, svc, h, docId: out.docId, row, pin };
}

function noGit(t, body) {
  for (const name of ['execFileSync', 'execFile', 'spawnSync', 'spawn', 'exec', 'execSync']) {
    t.mock.method(childProcess, name, () => { throw new Error('product runtime must not run Git'); });
  }
  syncBuiltinESMExports();
  try { return body(); } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
}

// 责任：旧固定证据必须与同提交 content-fixed 屏障成对；缺屏障或身份不符仍拒绝重放。
test('legacy fixed evidence still requires a matching atomic barrier and rejects mismatches', async () => {
  const s = await setup();
  const { ref, hash, fixed } = s.row;
  const event = { type: 'doc/content-fixed', docId: ref, data: { kind: 'doc', ref, hash, fixed: structuredClone(fixed) } };
  const state = structuredClone(s.h.state);
  const taskEvent = { type: 'task/updated', data: { id: 'tsk_new', evidence: [s.row] } };
  assert.throws(() => assertFixedCommit(state, { events: [taskEvent] }), { code: 'invalid-fixed-reference' });
  assert.throws(() => applyEvent(structuredClone(s.h.state), taskEvent), { code: 'invalid-fixed-reference' });
  assert.doesNotThrow(() => assertFixedCommit(state, { events: [event, taskEvent] }));
  const wrong = structuredClone(event);
  wrong.data.fixed.pathAtCommit = 'docs/other.md';
  assert.throws(() => assertFixedCommit(state, { events: [wrong, taskEvent] }), { code: 'invalid-fixed-reference' });
  const malformed = structuredClone(event);
  malformed.data.fixed.projectId = 'prj_foreign';
  assert.throws(() => assertFixedCommit(state, { events: [malformed, taskEvent] }), { code: 'invalid-fixed-reference' });
  await s.svc.close();
});

// 责任：旧日志冷开、审计与元数据读取全程不得启动 Git。
test('cold replay of legacy fixed facts audits and reads metadata without Git', async (t) => {
  const s = await setup();
  const projectId = s.h.id;
  const docId = s.docId;
  const fixed = structuredClone(s.pin.fixed);
  assert.ok(s.h.state.project.gitContentRepository);
  await s.svc.close();
  await noGit(t, async () => {
    const svc = new ProjectService({ rootDir: s.board, privilegedInlineWrites: true });
    await svc.init();
    const h = await svc.open(projectId);
    assert.ok(h.state.project.gitContentRepository);
    const view = getFixedContent(h, { docId, commitOid: fixed.commitOid, pathAtCommit: 'docs/spec.md' });
    assert.equal(view.availability, 'legacy-git-record-only');
    assert.equal(view.body, null);
    assert.equal(view.hash, fixed.blobContentHash);
    const warnings = auditEvidence(h, { evidence: [s.row] });
    assert.equal(warnings[0].severity, 'warning');
    assert.equal(warnings[0].code, 'legacy-git-not-reverified');
    await svc.close();
  });
});

// 责任：对象缺失或工作区变化不得让读取推断出新来源；已记录身份原样返回。
test('absent objects and edited files never become a new source; recorded identity stays verbatim', async () => {
  const s = await setup();
  const before = structuredClone(s.h.state.fixedContents);
  fs.rmSync(s.root + '/docs/spec.md');
  const view = getFixedContent(s.h, { docId: s.docId, fixed: s.pin.fixed });
  assert.deepEqual(view.fixed, s.pin.fixed);
  assert.equal(view.hash, s.pin.fixed.blobContentHash);
  assert.equal(view.body, null);
  assert.deepEqual(s.h.state.fixedContents, before);
  assert.throws(() => getFixedContent(s.h, { docId: s.docId, commitOid: 'b'.repeat(40), pathAtCommit: 'docs/spec.md' }), { code: 'not-found', status: 404 });
  assert.throws(() => getFixedContent(s.h, { docId: s.docId, commitOid: s.oid, pathAtCommit: 'docs/missing.md' }), { code: 'not-found', status: 404 });
  await s.svc.close();
});

// 责任：不认识 doc/content-fixed 的旧读端仍须拒绝包含该事件的 commit，不部分应用。
test('a registry without doc/content-fixed rejects the legacy fixed commit', async () => {
  const s = await setup();
  const registry = { ...(await import('../../lib/shared/events.js')).EVENT_REGISTRY };
  delete registry['doc/content-fixed'];
  const commits = fs.readFileSync(s.h.store.commitsFile, 'utf8').trim().split('\n').map(JSON.parse);
  const fixedCommit = commits.find((commit) => commit.events.some((event) => event.type === 'doc/content-fixed'));
  assert.ok(fixedCommit, 'the synthetic legacy log carries a fixed event');
  const event = fixedCommit.events.find((item) => item.type === 'doc/content-fixed');
  const { assertEventSupported } = await import('../../lib/core/model.js');
  assert.throws(() => assertEventSupported(s.h.state, event, fixedCommit, registry), { code: 'incompatible-event', status: 409 });
  await s.svc.close();
});
