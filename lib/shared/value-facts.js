// Pure model facts shared by policy, projection and replay.
export function taskDepsSatisfied(state, task) {
  return (task.deps || []).every((dep) => state.tasks[dep] && state.tasks[dep].state === 'done');
}

export function openIntentFor(state, taskId) {
  for (const intent of Object.values(state.intents)) {
    if (intent.taskId === taskId && intent.status === 'open') return intent;
  }
  return null;
}
