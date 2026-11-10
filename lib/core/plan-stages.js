import { BoardError } from './errors.js';
import { nextPriority, planKey, TERMINAL_STATES } from './model.js';

const STAGE_TASK_LIMIT = 5;

function* reachableFrom(starts, neighborsOf) {
  const pending = starts.map((id) => ({ id, origin: id }));
  const visited = new Set(starts);
  while (pending.length > 0) {
    const { id, origin } = pending.pop();
    yield { id, origin };
    for (const neighbor of neighborsOf(id)) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      pending.push({ id: neighbor, origin });
    }
  }
}

function rejectDependency(plan, step, taskId, dependencyId, taskOf) {
  const taskTitle = JSON.stringify(taskOf(taskId)?.title?.slice(0, 120) ?? taskId);
  const dependencyTitle = JSON.stringify(taskOf(dependencyId)?.title?.slice(0, 120) ?? dependencyId);
  throw new BoardError('plan-stage-dependency',
    'Move ' + taskTitle + ' and ' + dependencyTitle + ' to different stages or remove the dependency between them.',
    { status: 409, details: { planId: plan.id, stepId: step.id, taskId, dependencyId } });
}

function indexStageMemberships(plans) {
  const memberships = new Map();
  let ordinal = 0;
  for (const plan of plans) {
    for (const step of plan.steps ?? []) {
      const stage = { plan, step, ordinal: ordinal++ };
      for (const id of step.taskIds) {
        const stages = memberships.get(id) ?? new Set();
        stages.add(stage);
        memberships.set(id, stages);
      }
    }
  }
  return memberships;
}

function assertStageGrouping(plan, step, previousGroupOf, { dependentsOf, taskOf }) {
  const members = new Set(step.taskIds);
  const pending = step.taskIds.map((id) => ({ id, dependencyId: id }));
  const groupsByTask = new Map();
  while (pending.length > 0) {
    const { id, dependencyId } = pending.pop();
    const group = previousGroupOf(dependencyId);
    const groups = groupsByTask.get(id) ?? [];
    // Two distinct prior groups suffice: any upstream member belongs to at
    // most one of them, so one representative can witness a new pairing.
    if (groups.length === 2 || groups.includes(group)) continue;
    groups.push(group);
    groupsByTask.set(id, groups);
    if (members.has(id) && previousGroupOf(id) !== group) {
      rejectDependency(plan, step, id, dependencyId, taskOf);
    }
    for (const dependent of dependentsOf(id)) pending.push({ id: dependent, dependencyId });
  }
}

function outsidePriorGroups(members, previousMemberships) {
  const counts = new Map();
  let largest;
  let largestCount = 0;
  for (const id of members) {
    for (const stage of previousMemberships.get(id) ?? []) {
      const count = (counts.get(stage) ?? 0) + 1;
      counts.set(stage, count);
      if (count > largestCount) {
        largest = stage;
        largestCount = count;
      }
    }
  }
  const groups = new Map();
  for (const id of members) {
    const previous = previousMemberships.get(id);
    if (previous?.has(largest)) continue;
    const key = previous ? 'prior:' + [...previous].map((stage) => stage.ordinal).join(',') : 'new:' + id;
    const group = groups.get(key) ?? [];
    group.push(id);
    groups.set(key, group);
  }
  return groups.values();
}

function assertOverlappingStageGrouping(plan, step, previousMemberships, { depsOf, dependentsOf, taskOf }) {
  const members = new Set(step.taskIds);
  // Every pair inside the largest prior stage is already allowed. Only
  // members outside it can witness a new pairing, in either direction.
  for (const group of outsidePriorGroups(members, previousMemberships)) {
    const previousStages = [...(previousMemberships.get(group[0]) ?? [])];
    for (const [neighborsOf, reverse] of [[depsOf, false], [dependentsOf, true]]) {
      for (const { id, origin } of reachableFrom(group, neighborsOf)) {
        if (id === origin || !members.has(id)) continue;
        const otherStages = previousMemberships.get(id);
        if (!previousStages.some((stage) => otherStages?.has(stage))) {
          const [taskId, dependencyId] = reverse ? [id, origin] : [origin, id];
          rejectDependency(plan, step, taskId, dependencyId, taskOf);
        }
      }
    }
  }
}

function assertNewStageGroupings(plan, previousPlan, graph) {
  const previousMemberships = indexStageMemberships(previousPlan ? [previousPlan] : []);
  // A new member has no prior group in this plan, so use its own ID.
  const previousGroupOf = (id) => previousMemberships.get(id)?.values().next().value ?? id;
  for (const step of plan.steps ?? []) {
    if (step.taskIds.length < 2) continue;
    const firstMemberships = [...(previousMemberships.get(step.taskIds[0]) ?? [])];
    const sharedStage = firstMemberships.some((stage) =>
      step.taskIds.every((id) => previousMemberships.get(id)?.has(stage)));
    if (sharedStage) continue;
    // Older revisions can leave overlapping stages. Preserve a pair if it
    // shared any prior stage, even when the stage partitions overlap.
    if (step.taskIds.some((id) => previousMemberships.get(id)?.size > 1)) {
      assertOverlappingStageGrouping(plan, step, previousMemberships, graph);
    } else {
      assertStageGrouping(plan, step, previousGroupOf, graph);
    }
  }
}

function dependencyGraph(taskIds, taskOf) {
  const depsOf = (id) => taskOf(id)?.deps ?? [];
  const dependents = new Map();
  for (const id of taskIds) {
    for (const dep of depsOf(id)) {
      const parents = dependents.get(dep) ?? [];
      parents.push(id);
      dependents.set(dep, parents);
    }
  }
  return { taskOf, depsOf, dependentsOf: (id) => dependents.get(id) ?? [] };
}

export function assertPublishStageDependencies(steps) {
  const tasks = new Map(steps.flatMap((step) => step.tasks.map((task) => [task.key, task])));
  const plan = {
    id: null,
    steps: steps.map((step) => ({ id: step.id, taskIds: step.tasks.map((task) => task.key) })),
  };
  assertNewStageGroupings(plan, null, dependencyGraph(tasks.keys(), (key) => tasks.get(key)));
}

function assertNewDependencyPaths(plans, addedDependencies, { depsOf, dependentsOf, taskOf }) {
  const stageMemberships = indexStageMemberships(plans);
  for (const [id, added] of addedDependencies) {
    // A new path must reach the added edge from one stage member and
    // continue from it to another member of the same stage.
    const sources = new Map();
    for (const { id: source } of reachableFrom([id], dependentsOf)) {
      for (const stage of stageMemberships.get(source) ?? []) {
        if (stage.step.taskIds.length < 2) continue;
        const members = sources.get(stage) ?? [];
        if (members.length < 2) members.push(source);
        sources.set(stage, members);
      }
    }
    if (sources.size === 0) continue;
    for (const { id: dependencyId } of reachableFrom(added, depsOf)) {
      for (const stage of stageMemberships.get(dependencyId) ?? []) {
        const source = sources.get(stage)?.find((member) => member !== dependencyId);
        if (source !== undefined) {
          rejectDependency(stage.plan, stage.step, source, dependencyId, taskOf);
        }
      }
    }
  }
}

// Inspect prospective membership and dependencies together, before the
// command commits. Existing relationships are allowed to survive replay and edits.
export function assertNoNewStageDependencies(state, events) {
  const plans = new Map();
  const tasks = new Map();
  for (const { type, data } of events ?? []) {
    if (type === 'plan/revised') plans.set(data.id, data);
    if (type === 'task/created' || type === 'task/updated') tasks.set(data.id, data);
  }
  const addedDependencies = new Map();
  for (const [taskId, task] of tasks) {
    const previous = state.tasks[taskId];
    // New tasks enter a stage through a membership change. A path through
    // one from an existing task must also include a new edge from that task.
    if (!previous) continue;
    const previousDeps = new Set(previous.deps);
    const added = (task.deps ?? []).filter((id) => !previousDeps.has(id));
    if (added.length > 0) addedDependencies.set(taskId, added);
  }
  const previousPlan = (id) => state.plans[planKey(id, state.currentPlans[id])];
  if (plans.size === 0 && addedDependencies.size === 0) return;
  const taskOf = (id) => tasks.get(id) ?? state.tasks[id];
  const graph = dependencyGraph(new Set([...Object.keys(state.tasks), ...tasks.keys()]), taskOf);
  for (const plan of plans.values()) {
    assertNewStageGroupings(plan, previousPlan(plan.id), graph);
  }
  if (addedDependencies.size > 0) {
    for (const id of Object.keys(state.currentPlans)) {
      const plan = previousPlan(id);
      if (plan && !plans.has(id)) plans.set(id, plan);
    }
    assertNewDependencyPaths(plans.values(), addedDependencies, graph);
  }
}

// Membership comes from the current version. planRef can point to an older
// version after adopt/release, and orphaned tasks are outside the current steps.
export function stageWorkOf(state, task = null) {
  const planId = task ? task.planRef?.planId : state.project.focusPlanId;
  if (!planId || state.planHeads[planId]?.status !== 'active') return null;
  const plan = state.plans[planKey(planId, state.currentPlans[planId])];
  if (!plan) return null;
  if (task && !plan.steps.some((step) => step.taskIds.includes(task.id))) return null;
  for (const step of plan.steps) {
    const open = step.taskIds.map((id) => state.tasks[id])
      .filter((member) => member && !TERMINAL_STATES.includes(member.state));
    if (open.length === 0) continue;
    const review = open.filter((member) => member.state === 'review');
    const readyCount = open.filter((member) => member.state === 'ready').length;
    const remainingCount = open.length - review.length;
    const canImplement = readyCount > 0 || open.some((member) => member.state === 'in_progress');
    return {
      planId: plan.id, stepId: step.id, title: step.title.slice(0, 300),
      mode: remainingCount === 0 ? 'audit' : canImplement ? 'implement' : 'waiting',
      remainingCount, readyCount, reviewCount: review.length,
      readyTaskIds: nextPriority(open, STAGE_TASK_LIMIT).map((member) => member.id),
      reviewTaskIds: review.slice(0, STAGE_TASK_LIMIT).map((member) => member.id),
    };
  }
  return null;
}
