import { isGate } from './filters.ts';
import type { BoardView, Card, Plan } from './view-types.ts';

export type FlowTask = Card & { id: string };

interface FlowStep {
  id: string;
  title: string;
  tasks: FlowTask[];
  done: number;
  total: number;
}

export interface FlowLane {
  key: string;
  kind: 'plan' | 'out' | 'legacy';
  title: string;
  plan?: Plan;
  color: number;
  focus: boolean;
  tasks: FlowTask[];
  finished: FlowTask[];
  done: number;
  total: number;
  steps: FlowStep[];
  hasEdges: boolean;
  counts: { active: number; ready: number; waiting: number };
}

export interface FlowModel {
  tasks: FlowTask[];
  byId: Map<string, FlowTask>;
  lanes: FlowLane[];
  laneByTask: Map<string, FlowLane>;
  queue: FlowTask[];
  queueRank: Map<string, number>;
  recent: FlowTask[];
  nowCards: FlowTask[];
  inProgress: number;
  maxInProgress?: number;
  dependents: Map<string, string[]>;
  unlocks: Map<string, number>;
}

interface LaneNode { task: FlowTask; column: number; row: number }
interface LaneEdge { from: string; to: string }
interface LaneLayout {
  nodes: LaneNode[];
  edges: LaneEdge[];
  columns: number;
  rows: number;
  hiddenFront: number;
  hiddenTail: number;
}

export function flowIsException(task: Card): boolean {
  return task.state === 'blocked' || task.state === 'interrupted'
    || (task.state === 'review' && isGate(task))
    || (task.state === 'in_progress' && task.leaseExpired === true);
}

function isNow(task: FlowTask): boolean {
  return task.state === 'in_progress' || task.state === 'review'
    || task.state === 'blocked' || task.state === 'interrupted';
}

function byPriority(a: FlowTask, b: FlowTask): number {
  return (a.priority ?? 100) - (b.priority ?? 100) || a.id.localeCompare(b.id);
}

function urgency(task: FlowTask): number {
  if (flowIsException(task)) return 0;
  if (isNow(task)) return 1;
  return task.state === 'ready' ? 2 : 3;
}

function byUrgency(a: FlowTask, b: FlowTask, rank: ReadonlyMap<string, number>): number {
  const aAt = a.updatedAt || a.intent?.startedAt || '\uffff';
  const bAt = b.updatedAt || b.intent?.startedAt || '\uffff';
  return urgency(a) - urgency(b)
    || (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER)
    || aAt.localeCompare(bAt)
    || byPriority(a, b);
}

export function flowPlanColor(planId: string): number {
  let hash = 0;
  for (let index = 0; index < planId.length; index += 1) {
    hash = Math.imul(hash, 31) + planId.charCodeAt(index);
  }
  return (hash >>> 0) % 8;
}

function createLane(key: string, kind: FlowLane['kind'], title: string, plan?: Plan): FlowLane {
  return {
    key, kind, title, plan, color: flowPlanColor(plan?.id ?? key), focus: plan?.focus === true,
    tasks: [], finished: [], done: 0, total: 0, steps: [], hasEdges: false,
    counts: { active: 0, ready: 0, waiting: 0 },
  };
}

function flowLanes(tasks: FlowTask[], plans: Plan[]): Pick<FlowModel, 'lanes' | 'laneByTask'> {
  const active = new Map<string, FlowLane>();
  const members = new Map<string, { lane: FlowLane; step: FlowStep }>();
  const oldSteps = new Map<FlowLane, Map<string, FlowStep>>();
  for (const plan of plans) {
    if (!plan.id || plan.status !== 'active') continue;
    const lane = createLane('plan:' + plan.id, 'plan', plan.title || '未命名计划', plan);
    active.set(plan.id, lane);
    const old = new Map<string, FlowStep>();
    oldSteps.set(lane, old);
    for (const step of plan.steps ?? []) {
      if (!step.id) continue;
      const entry = { id: step.id, title: step.title || '未命名步骤', tasks: [], done: 0, total: 0 };
      lane.steps.push(entry);
      if (step.taskIds === undefined) old.set(step.id, entry);
      else for (const id of step.taskIds) members.set(id, { lane, step: entry });
    }
  }
  const out = createLane('out', 'out', '计划外');
  const legacy = createLane('legacy', 'legacy', '归属失效');
  const laneByTask = new Map<string, FlowLane>();
  for (const task of tasks) {
    if (task.state === 'canceled') continue;
    let member = members.get(task.id);
    const ref = task.planRef;
    const oldLane = !member && ref?.planId ? active.get(ref.planId) : undefined;
    // Older board responses omit member IDs. Trust an exact active-version reference
    // only when that step omitted the array; an explicit empty array is authoritative.
    if (oldLane && ref?.stepId && ref.version !== undefined && oldLane.plan?.currentVersion === ref.version) {
      const step = oldSteps.get(oldLane)?.get(ref.stepId);
      if (step) member = { lane: oldLane, step };
    }
    const lane = member?.lane ?? (task.planRef ? legacy : out);
    laneByTask.set(task.id, lane);
    lane.total += 1;
    if (member) member.step.total += 1;
    if (task.state === 'done') {
      lane.done += 1;
      lane.finished.push(task);
      if (member) member.step.done += 1;
      continue;
    }
    lane.tasks.push(task);
    member?.step.tasks.push(task);
    if (task.state === 'ready') lane.counts.ready += 1;
    else if (task.state === 'backlog') lane.counts.waiting += 1;
    else if (isNow(task)) lane.counts.active += 1;
  }
  const lanes = [...active.values(), ...[out, legacy].filter((lane) => lane.total > 0)];
  for (const lane of lanes) {
    const live = new Set(lane.tasks.map((task) => task.id));
    lane.hasEdges = lane.tasks.some((task) => task.deps?.some((id) => live.has(id)));
  }
  return { lanes, laneByTask };
}

export function buildFlowModel(board: BoardView): FlowModel {
  const byId = new Map<string, FlowTask>();
  const columns = Object.values(board.columns ?? {});
  const attention = [board.attention?.blocked ?? [], board.attention?.interrupted ?? []];
  for (const card of [...columns, ...attention].flat()) {
    if (card.id) byId.set(card.id, card as FlowTask);
  }
  const tasks = [...byId.values()];
  const ready = new Map(tasks.filter((task) => task.state === 'ready').map((task) => [task.id, task]));
  const queue: FlowTask[] = [];
  for (const id of board.readyOrder ?? []) {
    const task = ready.get(id);
    if (!task) continue;
    queue.push(task);
    ready.delete(id);
  }
  queue.push(...ready.values());
  const queueRank = new Map(queue.map((task, index) => [task.id, index + 1]));
  const nowCards = tasks.filter(isNow).sort((a, b) => byUrgency(a, b, queueRank));
  const recent = tasks.filter((task) => task.state === 'done').sort((a, b) => {
    const aAt = a.verifiedAt || a.updatedAt || '';
    const bAt = b.verifiedAt || b.updatedAt || '';
    return bAt.localeCompare(aAt) || a.id.localeCompare(b.id);
  });
  const dependents = new Map<string, string[]>();
  const unlocks = new Map<string, number>();
  for (const task of tasks) {
    const deps = [...new Set(task.deps ?? [])];
    for (const id of deps) {
      const known = dependents.get(id);
      if (known) known.push(task.id);
      else dependents.set(id, [task.id]);
    }
    if (task.state !== 'backlog' || !(task.acceptance?.total > 0)) continue;
    const unmet = deps.filter((id) => byId.get(id)?.state !== 'done');
    if (unmet.length === 1) {
      const id = unmet[0];
      unlocks.set(id, (unlocks.get(id) ?? 0) + 1);
    }
  }
  return {
    tasks, byId, queue, queueRank, nowCards, recent, dependents, unlocks,
    inProgress: nowCards.filter((task) => task.state === 'in_progress').length,
    maxInProgress: board.project?.policy?.maxInProgress,
    ...flowLanes(tasks, board.plans ?? []),
  };
}

export function flowNowGroups(tasks: readonly FlowTask[]) {
  const running = tasks.filter((task) => task.state === 'in_progress');
  const review = tasks.filter((task) => task.state === 'review' && !isGate(task));
  const audit = tasks.filter((task) => task.state === 'review' && isGate(task));
  const exceptions = tasks.filter((task) => task.state !== 'review' && flowIsException(task));
  const attention = [...exceptions, ...audit, ...review];
  // 优先用仍在执行的任务代表不同会话，同一会话的其他任务留在分组清单。
  const ordered = [...running.filter((task) => task.leaseExpired !== true), ...running.filter((task) => task.leaseExpired === true)];
  const representatives = new Map<string, FlowTask>();
  for (const task of ordered) {
    const session = task.owner?.sessionId;
    if (session && !representatives.has(session)) representatives.set(session, task);
  }
  const preview = new Set([...representatives.values(), ...ordered]);
  return { running, review, audit, exceptions, attention, sessionCount: representatives.size, runningPreview: [...preview].slice(0, 3) };
}

export function flowOrderTasks(model: FlowModel, tasks: readonly FlowTask[]): FlowTask[] {
  return [...tasks].sort((a, b) => byUrgency(a, b, model.queueRank));
}

// 最后一格为溢出入口。泳道可额外保留已聚焦或命中的任务。
export function flowWindow<T extends { id: string }>(items: readonly T[], slots: number, keep?: ReadonlySet<string>) {
  if (items.length <= slots) return { visible: [...items], overflow: [] };
  const visible: T[] = [];
  const overflow: T[] = [];
  items.forEach((item, index) => {
    (index < slots - 1 || keep?.has(item.id) ? visible : overflow).push(item);
  });
  return { visible, overflow };
}

export function flowUnlockCount(model: FlowModel, taskId: string): number {
  return model.unlocks.get(taskId) ?? 0;
}

export function flowWaitState(model: FlowModel, task: FlowTask): {
  kind: 'missing' | 'external' | 'waiting' | 'not-ready';
  lane?: FlowLane;
} {
  const lane = model.laneByTask.get(task.id);
  const unmet = (task.deps ?? []).filter((id) => model.byId.get(id)?.state !== 'done');
  if (!unmet.length) return { kind: 'not-ready' };
  if (unmet.some((id) => !model.byId.has(id) || model.byId.get(id)?.state === 'canceled')) return { kind: 'missing' };
  const external = unmet.find((id) => model.laneByTask.get(id) !== lane);
  return external ? { kind: 'external', lane: model.laneByTask.get(external) } : { kind: 'waiting' };
}

// 分别追溯前置与后续，避免把共用前置的旁支误判为链的一部分。
export function flowChain(model: FlowModel, id: string, lane?: FlowLane): Set<string> {
  const contains = (key: string) => lane ? model.laneByTask.get(key) === lane : model.byId.has(key);
  if (!contains(id)) return new Set();
  function walk(neighbors: (key: string) => readonly string[]): Set<string> {
    const seen = new Set([id]);
    const pending = [id];
    for (let index = 0; index < pending.length; index += 1) {
      for (const key of neighbors(pending[index])) {
        if (!contains(key) || seen.has(key)) continue;
        seen.add(key);
        pending.push(key);
      }
    }
    return seen;
  }
  return new Set([
    ...walk((key) => model.byId.get(key)?.deps ?? []),
    ...walk((key) => model.dependents.get(key) ?? []),
  ]);
}

function laneDepths(tasks: FlowTask[], model: FlowModel): Map<string, number> {
  const local = new Map(tasks.map((task) => [task.id, task]));
  const depth = new Map<string, number>();
  const backlogDeps = new Map<string, number>();
  const pending: string[] = [];
  for (const task of tasks) {
    const backlog = task.state === 'backlog';
    depth.set(task.id, backlog ? 1 : 0);
    const count = backlog ? new Set(task.deps?.filter((id) => local.get(id)?.state === 'backlog')).size : 0;
    backlogDeps.set(task.id, count);
    if (count === 0) pending.push(task.id);
  }
  // 没有完成拓扑排序的节点保留已知前置给出的深度；异常环不会阻断渲染。
  for (let index = 0; index < pending.length; index += 1) {
    const id = pending[index];
    for (const next of model.dependents.get(id) ?? []) {
      if (local.get(next)?.state !== 'backlog') continue;
      depth.set(next, Math.max(depth.get(next)!, depth.get(id)! + 1));
      if (local.get(id)?.state !== 'backlog') continue;
      const remaining = backlogDeps.get(next)! - 1;
      backlogDeps.set(next, remaining);
      if (remaining === 0) pending.push(next);
    }
  }
  return depth;
}

const FRONT_SLOTS = 5;
const WAITING_SLOTS = 13;
const LAST_VISIBLE_LAYER = 5;

export function layoutFlowLane(
  lane: FlowLane, model: FlowModel, options: { keep?: ReadonlySet<string>; expanded?: boolean } = {},
): LaneLayout {
  const depth = laneDepths(lane.tasks, model);
  const front = flowOrderTasks(model, lane.tasks.filter((task) => depth.get(task.id) === 0));
  const frontWindow = flowWindow(front, options.expanded ? front.length : FRONT_SLOTS, options.keep);
  const levels = new Map<number, FlowTask[]>([[0, frontWindow.visible]]);
  let hiddenTail = 0;
  for (const task of lane.tasks) {
    const level = depth.get(task.id)!;
    if (level === 0) continue;
    if (!options.expanded && level > LAST_VISIBLE_LAYER && !options.keep?.has(task.id)) {
      hiddenTail += 1;
      continue;
    }
    const existing = levels.get(level);
    if (existing) existing.push(task);
    else levels.set(level, [task]);
  }

  const nodes: LaneNode[] = [];
  const positions = new Map<string, LaneNode>();
  let columns = 0;
  let rows = 0;
  for (const level of [...levels.keys()].sort((a, b) => a - b)) {
    const tasks = levels.get(level)!;
    const ordered = tasks.map((task, index) => {
      const known = (task.deps ?? []).map((id) => positions.get(id)).filter((node) => node !== undefined);
      const desired = known.length ? known.reduce((sum, node) => sum + node.row, 0) / known.length : level === 0 ? index : 0;
      return { id: task.id, task, desired };
    });
    if (level > 0) ordered.sort((a, b) => a.desired - b.desired || byPriority(a.task, b.task));
    const window = flowWindow(ordered, options.expanded || level === 0 ? ordered.length : WAITING_SLOTS, options.keep);
    const visible = window.visible;
    hiddenTail += window.overflow.length;
    const capacity = Math.max(rows, visible.length);
    let previousRow = -1;
    visible.forEach(({ task, desired }, index) => {
      const row = Math.max(previousRow + 1, Math.min(Math.round(desired), capacity - visible.length + index));
      const node = { task, column: columns, row };
      nodes.push(node);
      positions.set(task.id, node);
      previousRow = row;
    });
    columns += 1;
    rows = capacity;
  }
  const edges = nodes.flatMap(({ task }) => [...new Set(task.deps ?? [])]
    .filter((id) => positions.has(id)).map((id) => ({ from: id, to: task.id })));
  return { nodes, edges, columns, rows, hiddenFront: frontWindow.overflow.length, hiddenTail };
}
