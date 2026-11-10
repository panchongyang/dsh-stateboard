/**
 * 测试职责：穷举任务命令状态、身份、租约、token、版本与意图结清的笛卡尔契约。
 * 典型流程：先校验隔离 → 为每条组合重置 fixture → 公共命令对比独立 oracle → 检查成功细节/失败零写。
 * 覆盖边界：覆盖 每操作 576 组合与结清 192 组合；不覆盖真实宿主、磁盘故障或无限 fuzz。
 * 外部前置：必须由隔离 launcher 设置最小 HOME/DSH/TEMP；禁止直接使用真实会话环境。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { TASK, TOKEN, actor, assertIsolation, fixture } from '../helpers/core-matrix-fixture.mjs';
import { OPS, SETTLERS, STATES, oracle, settlementPayload } from '../helpers/core-matrix-oracle.mjs';

assertIsolation();

function* rows(op) {
  for (const state of STATES) for (const kind of ['human', 'agent']) {
    for (const lease of ['none', 'live']) for (const token of ['correct', 'stale', 'missing']) {
      for (const open of [false, true]) for (const revision of ['current', 'stale', 'missing']) {
        yield { op, state, kind, lease, token, open, revision };
      }
    }
  }
}

export function inputFor(f, row) {
  const command = f.command(row.op, { actor: actor(row.kind) });
  if (row.token === 'stale') command.fencingToken = TOKEN - 1;
  if (row.token === 'missing') delete command.fencingToken;
  if (row.revision === 'stale') command.expected.entityRev = 6;
  if (row.revision === 'missing') delete command.expected.entityRev;
  if (row.open && SETTLERS.includes(row.op)) command.intent = settlementPayload('stopped');
  return command;
}

function assertSuccessDetails(f, row, result) {
  const task = f.h.state.tasks[TASK];
  if (row.op === 'interrupt') {
    assert.equal(Boolean(f.h.state.intents.int_matrix?.status === 'open'), row.open);
    assert.equal(task.interrupt.previousState, row.state);
    assert.equal(f.h.leases.has(TASK), false);
  }
  if (SETTLERS.includes(row.op) && row.open) {
    const intent = f.h.state.intents.int_matrix;
    assert.equal(intent.status, 'abandoned');
    assert.equal(intent.outcome, 'stopped');
    assert.deepEqual(intent.sideEffects, []);
    assert.equal(intent.closedBy.kind, row.kind);
    assert.ok(intent.closedAt);
    assert.equal(intent.closeReason, { block: 'blocked', release: 'released', cancel: 'canceled', reject: 'rejected', override: 'override' }[row.op]);
  }
  if (['block', 'release', 'cancel', 'override', 'submit'].includes(row.op)) assert.equal(f.h.leases.has(TASK), false);
  if (['claim', 'begin'].includes(row.op)) assert.ok(f.h.leases.has(TASK));
  if (row.op === 'submit') assert.equal(f.h.state.intents.int_matrix.status, 'closed');
  assert.equal(result.committed, true);
}

for (const op of OPS) {
  // 责任：每个 op 的状态/身份/租约/token/版本/意图组合须与 oracle 一致，成功后的租约和意图细节也须正确。
  test('Cartesian matrix: ' + op + ' (576 combinations)', async (t) => {
    const f = fixture();
    const counts = { allow: 0, reject: 0 };
    try {
      for (const row of rows(op)) {
        f.reset(row);
        const expected = oracle(row);
        const result = await f.check(inputFor(f, row), expected, JSON.stringify(row));
        counts[expected.error ? 'reject' : 'allow']++;
        if (!expected.error) assertSuccessDetails(f, row, result);
      }
      assert.equal(counts.allow + counts.reject, 576);
      t.diagnostic(JSON.stringify({ op, combinations: 576, ...counts }));
    } finally { f.close(); }
  });
}

const settlements = ['absent', 'stopped', 'unknown', 'invalid-outcome', 'missing-effects', 'effects', 'limit50', 'limit51', 'bad-kind', 'bad-ref', 'bad-hash', 'over-bytes'];
for (const op of SETTLERS) {
  // 责任：逐个结清输入含缺失/unknown/超限/坏字段时须按 oracle 拒绝，合法 stopped 副作用须原样记录。
  test('RFC-3 settlement matrix: ' + op + ' (192 combinations)', async (t) => {
    const f = fixture();
    let allowed = 0;
    try {
      for (const kind of ['human', 'agent']) for (const lease of ['none', 'live']) {
        for (const open of [false, true]) for (const token of ['correct', 'missing']) for (const settlement of settlements) {
          const row = { op, kind, lease, open, token, settlement, state: op === 'reject' ? 'review' : 'in_progress' };
          f.reset(row);
          const cmd = inputFor(f, row);
          const intent = settlementPayload(settlement);
          if (intent === undefined) delete cmd.intent;
          else cmd.intent = intent;
          const expected = oracle(row);
          await f.check(cmd, expected, JSON.stringify(row));
          if (!expected.error) {
            allowed++;
            if (open) assert.deepEqual(f.h.state.intents.int_matrix.sideEffects, intent.sideEffects);
          }
        }
      }
      t.diagnostic(JSON.stringify({ op, combinations: 192, allow: allowed, reject: 192 - allowed }));
    } finally { f.close(); }
  });
}
