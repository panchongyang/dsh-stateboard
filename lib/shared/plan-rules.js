// Shared read-only facts: no I/O, mutation capability or core-layer dependency.
export function planTitleConflict(heads, title, excludeId = null) {
  const key = String(title || '').trim().toLowerCase();
  if (!key) return null;
  for (const head of Object.values(heads)) {
    if (head.id !== excludeId && String(head.title || '').trim().toLowerCase() === key) return { planId: head.id, title: head.title };
  }
  return null;
}

export function planLiveWorkFact(state, head, leasedTaskIds) {
  if (head.status !== 'active') return null;
  const plan = state.plans[head.id + '@' + head.currentVersion];
  for (const taskId of (plan?.steps || []).flatMap((step) => step.taskIds || [])) {
    if (state.tasks[taskId]?.state === 'in_progress') return { taskId, reason: 'in_progress' };
    if (leasedTaskIds.has(taskId)) return { taskId, reason: 'lease' };
  }
  return null;
}
