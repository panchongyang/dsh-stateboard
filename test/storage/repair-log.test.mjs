/**
 * 测试职责：保证分叉日志修复规划只选可验证链，对非分叉损坏拒绝猜测修复。
 * 典型流程：构造连续链及两条同基分支 → planRepair/checkChain → 对照保留/丢弃范围。
 * 覆盖边界：覆盖 默认保尾、显式保头和安全拒绝；不覆盖磁盘写修复或真实数据备份。
 * 外部前置：无；纯内存提交链。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeCommit } from '../../lib/core/store.js';
import { checkChain, planRepair } from '../../lib/core/repair.js';

function chain(n, branch = 'a') {
  const out = [];
  let prev = 'genesis';
  for (let i = 1; i <= n; i += 1) {
    const commit = makeCommit(i, prev, { kind: 'agent', sessionId: 's' }, branch + '-' + i, i - 1, [
      { type: 'session/checkpoint', data: { note: branch + i } },
    ]);
    prev = commit.hash;
    out.push(commit);
  }
  return out;
}

/** [1,2] then two branches that both continue from commit 2. */
function forkedLog() {
  const base = chain(2);
  const a3 = makeCommit(3, base[1].hash, { kind: 'agent', sessionId: 'a' }, 'a-3', 2, [{ type: 'session/checkpoint', data: { note: 'a3' } }]);
  const a4 = makeCommit(4, a3.hash, { kind: 'agent', sessionId: 'a' }, 'a-4', 3, [{ type: 'session/checkpoint', data: { note: 'a4' } }]);
  const b3 = makeCommit(3, base[1].hash, { kind: 'agent', sessionId: 'b' }, 'b-3', 2, [{ type: 'session/checkpoint', data: { note: 'b3' } }]);
  return [...base, a3, a4, b3];
}

// 责任：连续有效日志须 action=none，不能凭空提出丢弃提交。
test('a contiguous log needs no repair', () => {
  const plan = planRepair(chain(5));
  assert.equal(plan.action, 'none');
  assert.equal(checkChain(chain(5)).ok, true);
});

// 责任：分叉重复 seq 时默认保留后分支，裁掉前分支并得到有效连续链。
test('a forked seq is cut at the second branch, keeping the tail by default', () => {
  const plan = planRepair(forkedLog());
  assert.equal(plan.action, 'repair');
  assert.equal(plan.start, 2);
  assert.equal(plan.end, 3);
  assert.equal(plan.dropped.length, 2, 'the earlier branch (a3, a4) is dropped');
  assert.equal(plan.kept.length, 3, '1, 2 then the later branch');
  assert.equal(plan.kept.at(-1).cmdId, 'b-3');
  assert.equal(checkChain(plan.kept).ok, true, 'the proposed log must verify');
});

// 责任：keep=head 须在分歧前截断，所有分支尾部均列入 dropped。
test('--keep head truncates at the divergence instead', () => {
  const plan = planRepair(forkedLog(), { keep: 'head' });
  assert.equal(plan.action, 'repair');
  assert.equal(plan.kept.length, 2);
  assert.equal(plan.dropped.length, 3, 'everything from the divergence on');
  assert.equal(checkChain(plan.kept).ok, true);
});

// 责任：连续 seq 但 payload 哈希损坏须 refuse，不得崩溃或当分叉修。
test('a hash mismatch with contiguous seqs is refused, not crashed on', () => {
  const commits = chain(4);
  commits[2].events[0].data.note = 'tampered';
  const plan = planRepair(commits);
  assert.equal(plan.action, 'refuse');
  assert.match(plan.reason, /hash mismatch at line 3/);
  assert.match(plan.reason, /not forked|contiguous/);
});

// 责任：首提交非 seq=1 须拒绝，不能从中段日志猜 genesis。
test('a log that does not start at seq 1 is refused', () => {
  const plan = planRepair(chain(3).slice(1));
  assert.equal(plan.action, 'refuse');
  assert.match(plan.reason, /first commit has seq 2/);
});

// 责任：空日志须拒绝，不能提出写成空文件的修复计划。
test('an empty log is refused instead of being written empty', () => {
  const plan = planRepair([]);
  assert.equal(plan.action, 'refuse');
  assert.match(plan.reason, /empty/);
});
