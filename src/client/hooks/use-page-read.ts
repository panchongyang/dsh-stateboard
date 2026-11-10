// React resource adapters subscribe to API-owned read lifecycles; they never issue HTTP directly.
import React from 'react';
import type { PageRead, ReadState, ReadRequest } from '../api/read-lifecycle.ts';
import type { Project, Plan, TaskView } from '../model/types.ts';
import { getProjects, getBoard, getTask, getPlans } from '../api/transport.ts';
import requestGate from '../api/request-gate.ts';
import { createPageRead } from '../api/read-lifecycle.ts';
import { REQUEST_TIMEOUT_MS } from '../model/races.ts';
import { errorText } from '../model/labels.ts';
import { accessSnapshot, subscribeAccess } from '../model/page-access.ts';
import { mainViewCwd } from '../model/project-location.ts';
import { pluginCtx } from '../model/state.ts';

const useState = React.useState;
const useEffect = React.useEffect;
const useCallback = React.useCallback;
const useRef = React.useRef;

function usePageRead<T>(load: (options: ReadRequest) => Promise<T>, empty: T, scope: string | undefined, poll: boolean) {
  const reader = React.useMemo(function () { return createPageRead(load, empty, { poll }); }, [scope]);
  const [observed, setObserved] = useState<{ reader: PageRead<T>; value: ReadState<T> } | null>(null);
  useEffect(function () {
    const off = reader.subscribe(function (value) { setObserved({ reader, value }); });
    reader.start();
    return function () { off(); reader.stop(); };
  }, [reader]);
  // Never expose the previous project's snapshot during the render before effects.
  const state = observed && observed.reader === reader ? observed.value : reader.snapshot();
  return Object.assign({}, state, { error: state.error ? errorText(state.error) : null, reload: reader.reload });
}

export function usePageAccess() {
  const [notice, setNotice] = useState(accessSnapshot);
  useEffect(function () {
    const off = subscribeAccess(setNotice);
    setNotice(accessSnapshot());
    return off;
  }, []);
  return notice;
}

export function useMainViewCwd() {
  const [cwd, setCwd] = useState('');
  useEffect(function () {
    let sessions;
    try { sessions = pluginCtx && pluginCtx.get && pluginCtx.get('sessions'); } catch (error) { return undefined; }
    const list = sessions && sessions.list;
    if (!list || typeof list.getSnapshot !== 'function') return undefined;
    // Subscription callbacks use the capability checked above; no host fallback is invented.
    function update() { setCwd(mainViewCwd(list!.getSnapshot!())); }
    const off = typeof list.subscribe === 'function' ? list.subscribe(update) : null;
    update();
    return typeof off === 'function' ? off : undefined;
  }, []);
  return cwd;
}

export function useProjects() {
  const state = usePageRead<Project[]>(async function (options) { return (await getProjects(options)).projects || []; }, [], 'projects', false);
  return Object.assign({}, state, { projects: state.data });
}

export function useBoard(projectId: string | undefined) {
  const state = usePageRead(function (options) { return projectId ? getBoard(projectId, options) : Promise.resolve(null); }, null, projectId, Boolean(projectId));
  return Object.assign({}, state, { board: state.data });
}

export function usePlans(projectId: string | undefined) {
  const state = usePageRead<Plan[]>(async function (options) { return projectId ? (await getPlans(projectId, options)).plans || [] : []; }, [], projectId, false);
  return Object.assign({}, state, { plans: state.data });
}

export function useTask(projectId: string | undefined, taskId: string | undefined, refreshKey: unknown, initial?: { view?: TaskView }) {
  const [view, setView] = useState(initial && initial.view ? initial.view : null);
  const [error, setError] = useState<string | null>(null);
  // Initialized during render and replaced, never cleared, by the effect/cleanup pair.
  const gate = useRef<ReturnType<typeof requestGate> | null>(null);
  if (!gate.current) gate.current = requestGate();
  const reload = useCallback(async function () {
    if (!projectId || !taskId) { setView(null); return; }
    const ticket = gate.current!.begin();
    try {
      const value = await getTask(projectId, taskId, { signal: ticket.signal, timeoutMs: REQUEST_TIMEOUT_MS });
      if (!gate.current!.isCurrent(ticket.id)) return;
      setView(value);
      setError(null);
    } catch (reason) {
      if (!gate.current!.isCurrent(ticket.id)) return;
      setError(errorText(reason));
    }
  }, [projectId, taskId]);
  useEffect(function () {
    gate.current = requestGate();
    reload();
    return function () { gate.current!.abortAll(); };
  }, [reload, refreshKey]);
  return { view, error, reload };
}
