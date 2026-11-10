/**
 * 测试职责：冻结事件分类与未知事件 fail-closed 的重放/修复边界。
 * 典型流程：合成内存/磁盘日志与新旧注册表 → apply/replay/严格校验 → 检查状态及拒绝诊断。
 * 覆盖边界：覆盖 applied/additive/migration 分类与快照覆盖事件；不覆盖真实生产升级。
 * 外部前置：无；磁盘用例只用临时 store。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { EVENT_CLASSES, EVENT_REGISTRY, eventClass } from '../../lib/shared/events.js';
import { applyEvent, assertEventSupported, emptyState } from '../../lib/core/model.js';
import { makeCommit, MemoryStore, JsonlStore } from '../../lib/core/store.js';
import { replay, validateCommit } from '../../lib/core/store/format.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const meta = { schemaVersion: 3, project: { id: 'prj_test', name: 'compat', phase: 'active', workspacePath: 'x', rev: 0 } };
const actor = { kind: 'agent', sessionId: 's1' };

// 责任：注册表中的事件必须属于已知分类，审计事件显式 additive、领域更新显式 applied。
test('every registered type has a known class and additive entries are explicit', () => {
  for (const [type, cls] of Object.entries(EVENT_REGISTRY)) {
    assert.equal(EVENT_CLASSES.includes(cls), true, type + ' has class ' + cls);
    assert.notEqual(cls, 'refuse', type + ' must not be registered as refuse');
  }
  assert.equal(EVENT_REGISTRY['task/meta-edited'], 'additive');
  assert.equal(EVENT_REGISTRY['task/assignment'], 'additive');
  assert.equal(EVENT_REGISTRY['task/updated'], 'applied');
});

// 责任：未知、空或非字符串事件类型须默认 refuse，不能作为可忽略事件。
test('unknown and malformed types default to refuse', () => {
  assert.equal(eventClass('task/from-the-future'), 'refuse');
  assert.equal(eventClass(''), 'refuse');
  assert.equal(eventClass(null), 'refuse');
  assert.equal(eventClass('task/updated'), 'applied');
});

// 责任：应用 additive 事件不得创建任务，applied 创建事件才可投影领域状态。
test('additive is a no-op; applied projects into state', () => {
  const state = emptyState(meta.project);
  applyEvent(state, { type: 'task/meta-edited', taskId: 't1', data: { taskId: 't1', fields: ['title'], at: 'x' } });
  assert.deepEqual(state.tasks, {}, 'audit-only event must not create or change a task');
  applyEvent(state, { type: 'task/created', taskId: 't1', data: { id: 't1', requiresAudit: false, state: 'ready' } });
  assert.deepEqual(Object.keys(state.tasks), ['t1']);
});

// 责任：拒绝未知事件时须携带 projectId、seq、type、compatibility 与恢复提示。
test('refusal carries project, seq, type and compatibility', () => {
  const state = emptyState(meta.project);
  assert.throws(
    () => applyEvent(state, { type: 'task/ownership-swap', data: {} }, { seq: 7 }),
    (error) => {
      assert.equal(error.code, 'incompatible-event');
      assert.equal(error.status, 409);
      assert.equal(error.details.projectId, 'prj_test');
      assert.equal(error.details.seq, 7);
      assert.equal(error.details.type, 'task/ownership-swap');
      assert.equal(error.details.compatibility, 'refuse');
      assert.match(error.details.hint, /snapshot|upgrade/);
      return true;
    },
  );
});

// 责任：migration 分类必须明确报需迁移，不能像 additive 一样静默跳过。
test('migration is a distinct class, not a silent no-op', () => {
  const state = emptyState(meta.project);
  assert.throws(
    () => assertEventSupported(state, { type: 'x/schema-shift' }, { seq: 2 }, { 'x/schema-shift': 'migration' }),
    (error) => {
      assert.equal(error.code, 'incompatible-event');
      assert.equal(error.details.compatibility, 'migration');
      assert.match(error.details.hint, /migration/);
      return true;
    },
  );
});

// 责任：仅含 additive 的日志须可打开，追加未知事件后必须在该 seq 拒绝。
test('a log containing an unknown event refuses to open; additive-only logs still open', () => {
  const first = makeCommit(1, 'genesis', actor, 'cmd_1', 0, [
    { type: 'task/created', taskId: 't1', data: { id: 't1', requiresAudit: false, state: 'ready' } },
  ]);
  // Replay stamps createdBy into event data; open a fresh clone each time so the
  // hash chain of the fixture stays intact.
  const open = (commits) => new MemoryStore(meta, structuredClone(commits)).open();
  const opened = open([first]);
  assert.deepEqual(Object.keys(opened.state.tasks), ['t1']);

  const auditOnly = makeCommit(2, first.hash, actor, 'cmd_2', 1, [
    { type: 'task/meta-edited', taskId: 't1', data: { taskId: 't1', fields: ['title'], at: 'x' } },
  ]);
  const additive = open([first, auditOnly]);
  assert.deepEqual(Object.keys(additive.state.tasks), ['t1'], 'additive event stays a no-op');

  const foreign = makeCommit(3, auditOnly.hash, actor, 'cmd_3', 2, [
    { type: 'task/ownership-swap', taskId: 't1', data: { id: 't1' } },
  ]);
  assert.throws(
    () => open([first, auditOnly, foreign]),
    (error) => error.code === 'incompatible-event' && error.details.seq === 3,
  );
  assert.throws(() => replay(meta, structuredClone([first, auditOnly, foreign])), { code: 'incompatible-event' });
});

// 责任：严格前缀校验须接受全部已登记事件，包括可靠性审计记录。
test('strict prefix validation accepts every registered event including reliability records', () => {
  for (const type of Object.keys(EVENT_REGISTRY)) {
    const commit = makeCommit(1, 'genesis', actor, 'cmd_registry', 0, [{ type, data: {} }]);
    assert.doesNotThrow(() => validateCommit(commit, { line: 1, validSeq: 0, validHash: 'genesis' }, { strictEvents: true }), type);
  }
});

// 责任：意图结清和租约审计记录须可重放，但未知事件仍须被拒绝。
test('intent settlement and lease audit records replay without weakening unknown refusal', () => {
  const events = [
    { type: 'work/intent', data: { id: 'i1', taskId: 't1', status: 'open' } },
    { type: 'lease/granted', data: { taskId: 't1', token: 17 } },
    { type: 'work/abandoned', data: { id: 'i1', taskId: 't1', status: 'abandoned', outcome: 'stopped', sideEffects: [] } },
    { type: 'lease/revoked', data: { taskId: 't1', token: 17 } },
    { type: 'task/released', data: { id: 't1', requiresAudit: false, state: 'ready', owner: null } },
  ];
  const commit = makeCommit(1, 'genesis', actor, 'cmd_settle', 0, events);
  const state = new MemoryStore(meta, [commit]).open().state;
  assert.equal(state.intents.i1.status, 'abandoned');
  assert.equal(state.intents.i1.outcome, 'stopped');
  assert.deepEqual(state.intents.i1.sideEffects, []);
  assert.equal(state.counters.leaseToken, 17);
  assert.equal(state.tasks.t1.state, 'ready');
});

// 责任：磁盘日志含未知事件时必须先拒绝，不能因缺 LF 或快照存在而先修写源日志。
test('normal disk open rejects unknown events before any missing-LF repair, also with a snapshot', () => {
  for (const snapshot of [false, true]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-compat-'));
    try {
      const commit = makeCommit(1, 'genesis', actor, 'cmd_unknown', 0, [{ type: 'task/future-owner', data: {} }]);
      const bytes = JSON.stringify(commit);
      const file = path.join(dir, 'commits.jsonl');
      fs.writeFileSync(file, bytes);
      if (snapshot) fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify({ seq: 1, hash: commit.hash, state: emptyState(meta.project) }));
      assert.throws(() => new JsonlStore(dir, meta).open(), (error) => error.code === 'incompatible-event' && error.details.projectId === 'prj_test');
      assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'refused open must not normalize the log');
      assert.equal(fs.existsSync(path.join(dir, 'lock.json')), false);
      assert.equal(fs.readdirSync(dir).some((name) => name.includes('.tmp')), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
