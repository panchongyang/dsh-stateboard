/**
 * 测试职责：在新构造模型中保留租约并制造绑定临界事实，不修改活模型。
 * 边界：内存介质不得写盘；历史归档须先关闭真实 writer 再经合法链冷开。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MemoryStore } from '../../lib/core/store.js';
import { ProjectHandle } from '../../lib/core/handle.js';
import { TransactionModel } from '../../lib/core/transaction/model.js';
import { makeCommit } from '../../lib/core/domain/commit-envelope.js';
import { appendCommitAndReopen } from './jsonl-history.mjs';

export function isolatedTouchHandle(source, { binding, leases = source.leases, readOnly = false, closed = false } = {}) {
  const data = source.committedSnapshot();
  const state = structuredClone(data.state);
  if (binding) state.bindings.s1 = { ...state.bindings.s1, ...binding };
  const medium = new MemoryStore(source.meta);
  medium.model = new TransactionModel({ ...data, state }, { leases });
  const h = new ProjectHandle(source.service, source.meta, medium, { ...data, readOnly });
  h.closed = closed;
  assert.deepEqual(h.leases, leases, 'fixture must retain the actual lease, never delete it to make touch inert');
  return h;
}

export function touchSnapshot(h, commitsFile = h.store.commitsFile) {
  return { rev: h.rev, hash: h.lastHash, leases: h.leases, bindings: structuredClone(h.state.bindings),
    bytes: fs.readFileSync(commitsFile), records: structuredClone([...h.store.commits]) };
}

export async function archivedHistory(source, rootDir, serviceOptions = {}) {
  const commitsFile = source.store.commitsFile, prefix = fs.readFileSync(commitsFile);
  const data = { ...structuredClone(source.state.project), phase: 'archived' };
  const commit = makeCommit(source.rev + 1, source.lastHash, { kind: 'human', via: 'synthetic-legacy-history' },
    'cmd_fixture_archive_' + source.rev, source.rev, [{ type: 'project/updated', data }], source.clock().toISOString());
  const reopened = await appendCommitAndReopen(source.service, { rootDir, projectId: source.id, commitsFile, commit, serviceOptions });
  assert.equal(source.closed, true);
  assert.deepEqual(fs.readFileSync(commitsFile).subarray(0, prefix.length), prefix);
  assert.equal(reopened.h.rev, commit.seq, 'cold archived open must not add recovery records');
  assert.equal(reopened.h.lastHash, commit.hash);
  assert.equal(reopened.h.state.project.phase, 'archived');
  return reopened;
}
