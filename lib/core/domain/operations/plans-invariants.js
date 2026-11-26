// Final model guards run once for a complete new transaction, never on replay.
// They check only new plan/member relationships, leaving unrelated legacy facts
// readable and editable without silently repairing their history.
import { BoardError } from '../../errors.js';

function reject(message, details = {}) {
  throw new BoardError('invalid-command', 'incomplete plan operation batch: ' + message, { status: 400, details });
}
const membersOf = (plan) => new Map((plan?.steps || []).flatMap((step) => step.taskIds.map((taskId) => [taskId, step.id])));
const currentPlan = (state, planId) => state.plans[planId + '@' + state.currentPlans[planId]];
const sameRef = (a, b) => a?.planId === b?.planId && a?.version === b?.version && a?.stepId === b?.stepId;
function membershipIndex(state) {
  const index = new Map();
  for (const planId of Object.keys(state.currentPlans)) for (const taskId of membersOf(currentPlan(state, planId)).keys()) {
    const plans = index.get(taskId) || new Set();
    plans.add(planId);
    index.set(taskId, plans);
  }
  return index;
}
// Label the strongly connected components reachable from changed tasks, not
// the whole project. Cycles already present in that subgraph are not themselves
// grounds to reject: only a newly authored edge within a component is illegal.
function dependencyComponents(roots, depsOf) {
  const seen = new Set();
  const finished = [];
  const reverse = new Map();
  for (const root of roots) {
    const pending = [{ taskId: root, exit: false }];
    while (pending.length) {
      const { taskId, exit } = pending.pop();
      if (exit) { finished.push(taskId); continue; }
      if (seen.has(taskId)) continue;
      seen.add(taskId);
      pending.push({ taskId, exit: true });
      for (const dep of depsOf(taskId)) {
        const predecessors = reverse.get(dep) ?? [];
        predecessors.push(taskId);
        reverse.set(dep, predecessors);
        if (!seen.has(dep)) pending.push({ taskId: dep, exit: false });
      }
    }
  }
  const components = new Map();
  for (const root of finished.reverse()) {
    const pending = [root];
    while (pending.length) {
      const taskId = pending.pop();
      if (components.has(taskId)) continue;
      components.set(taskId, root);
      for (const predecessor of reverse.get(taskId) ?? []) pending.push(predecessor);
    }
  }
  return components;
}

function assertNewPlanDependencies(before, after, changedTaskIds) {
  const exists = (id) => Object.hasOwn(after, id);
  const depsOf = (id) => exists(id) ? after[id].deps ?? [] : [];
  const added = new Map();
  for (const taskId of changedTaskIds) {
    const previous = new Set(before[taskId]?.deps ?? []);
    const deps = depsOf(taskId).filter((dep) => !previous.has(dep));
    for (const dep of deps) {
      if (!exists(dep)) throw new BoardError('invalid-command', 'unknown dependency ' + dep, { status: 400 });
    }
    if (deps.length) added.set(taskId, deps);
  }
  if (!added.size) return;
  const components = dependencyComponents(added.keys(), depsOf);
  for (const [taskId, deps] of added) {
    if (deps.some((dep) => components.get(dep) === components.get(taskId))) {
      throw new BoardError('invalid-command', 'dependency cycle at ' + taskId, { status: 400 });
    }
  }
}

export function assertPlanOperationBatch(before, after, events) {
  const versions = new Map();
  const taskEvents = new Map();
  let changedFocus = false;
  for (const event of events) {
    if (event.type === 'plan/published' || event.type === 'plan/revised') versions.set(event.data.id, event.data);
    if (['task/created', 'task/updated', 'task/orphaned'].includes(event.type)) taskEvents.set(event.taskId, event);
    if (event.type === 'plan/focused' || event.type === 'plan/archived') changedFocus = true;
  }
  const priorMemberships = versions.size ? membershipIndex(before) : null;
  const nextMemberships = versions.size ? membershipIndex(after) : null;
  for (const [planId, plan] of versions) {
    const previous = currentPlan(before, planId);
    const previousMembers = membersOf(previous);
    const members = membersOf(plan);
    const head = after.planHeads[planId];
    if (head?.currentVersion !== plan.version || after.currentPlans[planId] !== plan.version || !after.plans[planId + '@' + plan.version]) reject('version pointer does not identify the materialized plan', { planId });
    if (!plan.steps.length) reject('published version has no stages', { planId });
    const seenSteps = new Set();
    const priorCounts = new Map();
    for (const step of previous?.steps || []) for (const taskId of step.taskIds) priorCounts.set(taskId, (priorCounts.get(taskId) || 0) + 1);
    const currentStages = new Map();
    for (const step of plan.steps) for (const taskId of step.taskIds) {
      const stages = currentStages.get(taskId) || new Set();
      stages.add(step.id);
      currentStages.set(taskId, stages);
    }
    const seenTasks = new Map();
    for (const step of plan.steps) {
      if (seenSteps.has(step.id)) reject('duplicate stage identifier', { planId, stepId: step.id });
      seenSteps.add(step.id);
      for (const taskId of step.taskIds) {
        const count = (seenTasks.get(taskId) || 0) + 1;
        if (count > Math.max(1, priorCounts.get(taskId) || 0)) reject('task gains overlapping stage membership', { planId, taskId });
        seenTasks.set(taskId, count);
        const task = after.tasks[taskId];
        if (!task) reject('member task was not materialized', { planId, taskId });
        const unchangedMembership = previousMembers.get(taskId) === step.id;
        // Retained members may keep an older pointer after adopt/release. Their
        // unchanged historical pointers are not reinterpreted by today's guards.
        const foreignLegacy = previousMembers.has(taskId) && task.planRef?.planId !== planId && sameRef(before.tasks[taskId]?.planRef, task.planRef);
        if (!foreignLegacy && (!unchangedMembership || !sameRef(before.tasks[taskId]?.planRef, task.planRef))) {
          const ref = task.planRef;
          const target = ref && after.plans[ref.planId + '@' + ref.version];
          if (ref?.planId !== planId || !currentStages.get(taskId).has(ref.stepId) || !target?.steps.some((entry) => entry.id === ref.stepId && entry.taskIds.includes(taskId))) reject('member ownership was not settled', { planId, taskId });
          if (!unchangedMembership && ref.version !== plan.version) reject('new member was not assigned to the new version', { planId, taskId });
        }
        if (!unchangedMembership && !taskEvents.has(taskId)) reject('new membership has no task transition record', { planId, taskId });
        for (const otherId of nextMemberships.get(taskId) || []) {
          if (otherId !== planId && !(priorMemberships.get(taskId)?.has(planId) && priorMemberships.get(taskId)?.has(otherId))) {
            throw new BoardError('plan-task-in-use', 'task is a member of another plan: ' + otherId, { status: 409, details: { taskId, planId: otherId } });
          }
        }
      }
    }
    for (const taskId of previousMembers.keys()) {
      if (members.has(taskId) || !before.tasks[taskId]) continue;
      const task = after.tasks[taskId];
      const record = taskEvents.get(taskId);
      if (before.tasks[taskId]?.planRef?.planId !== planId && sameRef(before.tasks[taskId]?.planRef, task?.planRef)) continue;
      if (!task || !(record?.type === 'task/orphaned' && task.orphaned === true || record?.type === 'task/updated' && task.planRef === null)) reject('removed member has neither orphan nor release record', { planId, taskId });
    }
  }
  if (versions.size) assertNewPlanDependencies(before.tasks, after.tasks, taskEvents.keys());
  if (changedFocus && after.project.focusPlanId && after.planHeads[after.project.focusPlanId]?.status !== 'active') reject('focus does not reference an active plan');
}

export function assertPlanOperationCompletion(work) {
  const owned = [...work.scratch].filter(([key]) => typeof key === 'string' && key.startsWith('plans.transition:'));
  for (const [, transition] of owned) if (transition.pending.size) reject('version has unexecuted task actions', { planId: transition.planId, taskIds: [...transition.pending.keys()] });
  // Clear only our successful model-owned scopes; the engine checks other domains.
  for (const [key] of owned) work.scratch.delete(key);
}
