/**
 * 测试职责：用真实日志回放构造 legacy/重复证据，替代直接改已发布 state。
 * 典型流程：真实 Git 观察得到 fixed 身份 → 组装 project/updated + content-fixed + task/updated 提交 →
 *           关闭 writer、追加 JSONL（内存 store 走重建）→ 真实 restore 后继续查询。
 * 边界：只用于合成 fixture；不调用生产测试口，也不直接改写冻结对象。
 */
import fs from 'node:fs';
import { JsonlStore, MemoryStore, makeCommit } from '../../lib/core/store.js';
import { newId } from '../../lib/core/util.js';
import { legacyGitMaterial } from './fixed-fixture.mjs';

/** Install one durable commit by closing the writer and replaying the log, never by publishing in place. */
function appendHistory(handle, events) {
  const commit = makeCommit(handle.rev + 1, handle.lastHash, { kind: 'system', via: 'prompt-fixture' },
    'cmd_fixture_' + newId('x'), handle.rev, events);
  if (typeof handle.store.commitsFile === 'string') {
    const file = handle.store.commitsFile;
    const dir = handle.store.dir;
    const meta = handle.meta;
    handle.store.close();
    fs.appendFileSync(file, JSON.stringify(commit) + '\n');
    const store = new JsonlStore(dir, meta);
    store.open();
    handle.store = store;
    handle.model = store.model;
  } else {
    const store = new MemoryStore(handle.meta, [...handle.store.commits, commit]);
    store.blobs = handle.store.blobs;
    store.open();
    handle.store = store;
    handle.model = store.model;
  }
  handle._lapsed = null;
  return handle;
}

function taskEvent(handle, taskId, patch) {
  const task = handle.state.tasks[taskId];
  if (!task) throw new Error('fixture task not found: ' + taskId);
  const data = { ...structuredClone(task), ...structuredClone(patch), rev: task.rev + 1, updatedAt: handle.clock().toISOString() };
  return { type: 'task/updated', taskId, rev: data.rev, data };
}

function contentFixedEvents(rows) {
  const events = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || !Object.hasOwn(row, 'fixed')) continue;
    const key = row.ref + ':' + JSON.stringify(row.fixed);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({ type: 'doc/content-fixed', docId: row.ref, data: { kind: 'doc', ref: row.ref, fixed: row.fixed, hash: row.hash } });
  }
  return events;
}

export function commitTaskEvidence(handle, taskId, evidence) {
  return appendHistory(handle, [...contentFixedEvents(evidence), taskEvent(handle, taskId, { evidence })]);
}

/** Build a synthetic historical source and evidence row, not a new pin. */
export function pinDocEvidence(handle, docId) {
  const { data, source } = legacyGitMaterial(handle, docId);
  return {
    repository: source,
    reason: 'historical-prompt-fixture',
    row: { id: 'ev_fixed_' + newId('x'), ...data, fixedState: 'pinned', fixedReason: null, verifiedAt: handle.clock().toISOString() },
  };
}

export function commitPinnedEvidence(handle, taskId, rows, repository, reason = 'auto-approve-git-content-repository') {
  const events = [
    { type: 'project/updated', data: { ...structuredClone(handle.state.project), gitContentRepository: structuredClone(repository) }, actor: { kind: 'system', reason } },
    ...contentFixedEvents(rows),
    taskEvent(handle, taskId, { evidence: rows }),
  ];
  return appendHistory(handle, events);
}
