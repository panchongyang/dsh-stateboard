/**
 * 测试职责：验证推进视图的归属、前沿、分层和聚焦规则。
 * 典型流程：构造合成只读看板 → 计算前沿、归属和线路 → 核对节点、边和窗口。
 * 覆盖边界：覆盖布局、长链、宽扇出和异常依赖；不覆盖 DOM 或宿主渲染。
 * 外部前置：无；只调用纯模型。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFlowModel, flowChain, flowIsException, flowNowGroups, flowPlanColor,
  flowUnlockCount, flowWaitState, flowWindow, layoutFlowLane,
} from '../../../src/client/model/flow-layout.ts';

function task(id, state, extra = {}) {
  return { id, state, acceptance: { total: 1 }, ...extra };
}

function plan(id, taskIds, extra = {}) {
  return { id, status: 'active', title: id, steps: [{ id: 'step', taskIds }], ...extra };
}

function board(tasks, extra = {}) {
  return { columns: { fixture: tasks }, ...extra };
}

function ids(tasks) {
  return tasks.map((item) => item.id);
}

// 责任：按当前步骤成员区分活动计划、计划外和归属失效。
test('active plan membership comes from current step lists, with separate unplanned and orphan lanes', () => {
  const ready = task('ready', 'ready', { planRef: { planId: 'p', version: 1 } });
  const done = task('done', 'done', { verifiedBy: 'agent', verifiedAt: '2026-11-01' });
  const orphan = task('orphan', 'backlog', { planRef: { planId: 'p', version: 1 } });
  const unplanned = task('out', 'ready');
  const canceled = task('canceled', 'canceled');
  const tasks = [ready, done, orphan, unplanned, canceled];
  const model = buildFlowModel(board(tasks, {
    plans: [plan('p', ['ready', 'done', 'canceled'], { currentVersion: 2, focus: true }), plan('archived', ['orphan'], { status: 'archived' })],
    readyOrder: ['unknown', 'out', 'out', 'ready'],
  }));
  assert.deepEqual(ids(model.queue), ['out', 'ready']);
  assert.equal(model.queueRank.get('ready'), 2);
  assert.deepEqual(model.lanes.map((lane) => lane.key), ['plan:p', 'out', 'legacy']);
  const [active] = model.lanes;
  assert.deepEqual(ids(active.tasks), ['ready']);
  assert.deepEqual(ids(active.finished), ['done']);
  assert.deepEqual([active.done, active.total, active.steps[0].total], [1, 2, 2]);
  assert.equal(active.focus, true);
  assert.equal(active.color, flowPlanColor('p'));
  assert.equal(model.laneByTask.get('orphan')?.kind, 'legacy');
  assert.equal(model.laneByTask.has('canceled'), false);
  assert.equal(model.recent[0].verifiedBy, 'agent');
});

// 责任：旧响应缺成员时，仅按当前版本和已知步骤匹配。
test('older steps without taskIds use only exact active-version references', () => {
  const tasks = [
    task('known', 'ready', { planRef: { planId: 'p', version: 2, stepId: 'unlisted' } }),
    task('stale', 'backlog', { planRef: { planId: 'p', version: 1, stepId: 'unlisted' } }),
    task('removed', 'backlog', { planRef: { planId: 'p', version: 2, stepId: 'listed' } }),
  ];
  const model = buildFlowModel(board(tasks, {
    plans: [plan('p', [], { currentVersion: 2, steps: [{ id: 'unlisted' }, { id: 'listed', taskIds: [] }] })],
  }));
  assert.deepEqual(ids(model.lanes[0].tasks), ['known']);
  assert.deepEqual(ids(model.lanes[1].tasks), ['stale', 'removed']);
});

// 责任：并行上限只影响文案，异常单列，进行中预览优先覆盖三个不同会话。
test('parallel summary separates attention and represents different running sessions', () => {
  const running = Array.from({ length: 10 }, (_, index) => task('running-' + index, 'in_progress', {
    updatedAt: index === 3 ? '2026-10-30' : '2026-11-' + String(index + 1).padStart(2, '0'),
    leaseExpired: index === 8,
    owner: index === 3 ? undefined : { sessionId: 'session-' + (index % 3) },
  }));
  const blocked = task('blocked', 'blocked', { updatedAt: '2026-11-05' });
  const review = task('review', 'review', { updatedAt: '2026-11-11' });
  const audit = task('audit', 'review', { labels: ['gate:audit'], updatedAt: '2026-11-01' });
  const interrupted = task('interrupted', 'interrupted', { updatedAt: '2026-11-06' });
  const inputs = { attention: { blocked: [blocked], interrupted: [interrupted] } };
  const low = buildFlowModel(board([...running, review, audit], { ...inputs, project: { policy: { maxInProgress: 2 } } }));
  const high = buildFlowModel(board([...running, review, audit], { ...inputs, project: { policy: { maxInProgress: 10 } } }));
  assert.deepEqual([low.inProgress, low.maxInProgress, high.inProgress, high.maxInProgress], [10, 2, 10, 10]);
  const groups = flowNowGroups(low.nowCards);
  assert.deepEqual(groups, flowNowGroups(high.nowCards));
  assert.equal(groups.running.length, 10);
  assert.equal(groups.sessionCount, 3);
  assert.deepEqual(ids(groups.runningPreview), ['running-0', 'running-1', 'running-2']);
  assert.deepEqual(ids(groups.review), ['review']);
  assert.deepEqual(ids(groups.audit), ['audit']);
  assert.deepEqual(ids(groups.exceptions), ['blocked', 'interrupted', 'running-8']);
  assert.deepEqual(ids(groups.attention), ['blocked', 'interrupted', 'running-8', 'audit', 'review']);
  assert.equal(flowIsException(task('unknown-lease', 'in_progress', { leaseExpired: null })), false);
  assert.deepEqual(ids(flowWindow(low.nowCards, 2, new Set(['running-9'])).visible), ['audit', 'running-9']);
});

// 责任：后继在可用行与前置对齐，边跨越依赖层。
test('draws dependency layers and aligns successive tasks to available parent rows', () => {
  const tasks = [
    task('a', 'ready'), task('b', 'ready'), task('b1', 'backlog', { deps: ['b'] }),
    task('a1', 'backlog', { deps: ['a'] }), task('a2', 'backlog', { deps: ['a1'] }),
    task('merged', 'backlog', { deps: ['a1', 'b1', 'a1'] }),
  ];
  const make = (items) => buildFlowModel(board(items, { plans: [plan('p', ids(tasks))], readyOrder: ['a', 'b'] }));
  const model = make(tasks);
  const layout = layoutFlowLane(model.lanes[0], model);
  assert.deepEqual(layout.nodes.map(({ task: item, column, row }) => [item.id, column, row]), [
    ['a', 0, 0], ['b', 0, 1], ['a1', 1, 0], ['b1', 1, 1], ['a2', 2, 0], ['merged', 2, 1],
  ]);
  assert.equal(layout.edges.filter(({ from, to }) => from === 'a1' && to === 'merged').length, 1);
  const reversed = make([...tasks].reverse());
  assert.deepEqual(layoutFlowLane(reversed.lanes[0], reversed), layout);
  assert.deepEqual([...flowChain(model, 'a1')], ['a1', 'a', 'a2', 'merged']);
  assert.deepEqual([...flowChain(model, 'a1', model.lanes[0])], ['a1', 'a', 'a2', 'merged']);
  assert.deepEqual([...flowChain(model, 'missing')], []);
});

// 责任：区分缺失前置，并只计入满足全部前置后可就绪的任务。
test('classifies unsatisfied prerequisites and counts only tasks whose last prerequisite would finish', () => {
  const tasks = [
    task('a', 'ready'),
    task('b', 'done'),
    task('c', 'ready'),
    task('local', 'backlog', { deps: ['a', 'b'] }),
    task('cross', 'backlog', { deps: ['c'] }),
    task('both', 'backlog', { deps: ['a', 'c'] }),
    task('missing', 'backlog', { deps: ['missing-target'] }),
    task('no-wait', 'backlog', { deps: ['b'] }),
    task('no-acceptance', 'backlog', { deps: ['a'], acceptance: { total: 0 } }),
  ];
  const model = buildFlowModel(board(tasks, { plans: [plan('p', ids(tasks).filter((id) => id !== 'c'))] }));
  assert.equal(flowUnlockCount(model, 'a'), 1);
  assert.equal(flowUnlockCount(model, 'c'), 1);
  assert.equal(flowWaitState(model, tasks[3]).kind, 'waiting');
  assert.equal(flowWaitState(model, tasks[4]).lane?.kind, 'out');
  assert.equal(flowWaitState(model, tasks[6]).kind, 'missing');
  assert.equal(flowWaitState(model, tasks[7]).kind, 'not-ready');
  assert.deepEqual([...flowChain(model, 'b', model.lanes[0])], ['b', 'local', 'no-wait']);
});

// 责任：限制两千项长链的默认窗口，同时保留显式匹配。
test('truncates the front and a 2,000-task chain without losing explicit matches', () => {
  const tasks = Array.from({ length: 2000 }, (_, index) => {
    const id = 'task-' + String(index).padStart(4, '0');
    const deps = index < 10 ? [] : ['task-' + String(index - 1).padStart(4, '0')];
    return task(id, index < 10 ? 'ready' : 'backlog', { deps });
  });
  const model = buildFlowModel(board(tasks, { plans: [plan('p', ids(tasks))], readyOrder: ids(tasks.slice(0, 10)) }));
  const lane = model.lanes[0];
  const base = layoutFlowLane(lane, model);
  assert.deepEqual([base.hiddenFront, base.hiddenTail, base.nodes.length], [6, 1985, 9]);
  const keep = new Set(['task-0009', 'task-1999']);
  const matched = layoutFlowLane(lane, model, { keep });
  assert.deepEqual([matched.hiddenFront, matched.hiddenTail, matched.columns], [5, 1984, 7]);
  assert.ok(matched.nodes.some(({ task: item }) => item.id === 'task-1999'));
  const expanded = layoutFlowLane(lane, model, { expanded: true });
  assert.deepEqual([expanded.hiddenFront, expanded.hiddenTail, expanded.nodes.length], [0, 0, 2000]);
  assert.equal(flowChain(model, 'task-1999', lane).size, 1991);
});

// 责任：单层宽扇出即使没有长链也必须截断。
test('bounds a 2,000-task shallow layer independently of chain depth', () => {
  const front = task('root', 'in_progress');
  const waiting = Array.from({ length: 1999 }, (_, index) =>
    task('wait-' + String(index).padStart(4, '0'), 'backlog', { deps: [front.id] }));
  const tasks = [front, ...waiting];
  const model = buildFlowModel(board(tasks, { plans: [plan('p', ids(tasks))] }));
  const lane = model.lanes[0];
  const base = layoutFlowLane(lane, model);
  assert.deepEqual([base.columns, base.rows, base.hiddenTail, base.edges.length], [2, 12, 1987, 12]);
  const match = layoutFlowLane(lane, model, { keep: new Set(['wait-1998']) });
  assert.equal(match.hiddenTail, 1986);
  assert.ok(match.nodes.some(({ task: item }) => item.id === 'wait-1998'));
  assert.equal(layoutFlowLane(lane, model, { expanded: true }).nodes.length, 2000);
});

// 责任：含环依赖终止布局，重复计算的节点和行稳定。
test('cycles terminate with stable node and row identities', () => {
  const tasks = [
    task('a', 'backlog', { deps: ['b'] }),
    task('b', 'backlog', { deps: ['a', 'c'] }),
    task('c', 'backlog', { deps: ['c'] }),
  ];
  const model = buildFlowModel(board(tasks, { plans: [plan('p', ids(tasks))] }));
  const layout = layoutFlowLane(model.lanes[0], model);
  assert.deepEqual(layout.nodes.map(({ task: item, column, row }) => [item.id, column, row]), [
    ['a', 1, 0], ['b', 1, 1], ['c', 1, 2],
  ]);
  assert.equal(layout.edges.length, 4);
  assert.deepEqual([...flowChain(model, 'a')], ['a', 'b', 'c']);
});
