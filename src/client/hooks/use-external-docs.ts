// External-document React adapters adapt API-owned observation gates and guarded writes; payload rules remain in model and HTTP stays in api.
// Data hooks for the external document panel: observation and write runner.
import React from 'react';
import type { DocView, ExternalBody, ExternalErrorView } from '../model/types.ts';
import requestGate from '../api/request-gate.ts';
import { externalDocAction as sendAction, inspectExternalDoc, updateExternalDoc as sendUpdate } from '../api/transport.ts';
import { usePageWrite } from './page-navigation.ts';
import { externalErrorView } from '../model/external-payloads.ts';

interface InspectState { view: DocView | null; loading: boolean; error: unknown }
interface WriteOptions { projectId: string; docId: string; notify?: (tone: string, text: string) => void; onChanged?: () => void; reload: (fresh: boolean) => unknown }
type Classify = (error: unknown) => ExternalErrorView;

const useState = React.useState;
const useEffect = React.useEffect;
const useRef = React.useRef;

/** Inspect one external doc (with preview). `reload(true)` is the explicit fresh re-observation. */
export function useExternalInspect(projectId: string, docId: string, remember?: (id: string, view: DocView) => void) {
  const [state, setState] = useState<InspectState>({ view: null, loading: true, error: null });
  // Render initializes the gate; cleanup aborts it without clearing the ref.
  const gate = useRef<ReturnType<typeof requestGate> | null>(null);
  if (!gate.current) gate.current = requestGate();
  function load(fresh?: boolean) {
    const ticket = gate.current!.begin();
    setState(function (prev) {
      const keep = prev.view && prev.view.doc && prev.view.doc.id === docId ? prev.view : null;
      return { view: keep, loading: true, error: null };
    });
    return inspectExternalDoc(projectId, docId, { preview: true, fresh: Boolean(fresh), signal: ticket.signal }).then(function (view) {
      if (!gate.current!.isCurrent(ticket.id)) return null;
      setState({ view, loading: false, error: null });
      if (remember) remember(docId, view);
      return view;
    }, function (error: unknown) {
      if (!gate.current!.isCurrent(ticket.id)) return null;
      setState(function (prev) { return { view: prev.view, loading: false, error }; });
      return null;
    });
  }
  useEffect(function () {
    load(false);
    return function () { gate.current!.abortAll(); };
  }, [projectId, docId]);
  return { view: state.view, loading: state.loading, error: state.error, reload: load };
}

/**
 * Runs one write at a time. Success reloads the list and re-observes; failure
 * keeps the form open and exposes the classified error. Nothing is replayed
 * automatically after a stale-revision.
 */
export function useExternalWrite(options: WriteOptions) {
  const updateExternalDoc = usePageWrite(sendUpdate);
  const externalDocAction = usePageWrite(sendAction);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ExternalErrorView | null>(null);
  function run(request: () => Promise<unknown>, okText: string, done?: () => void, classify?: Classify) {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    request().then(function () {
      setBusy(false);
      if (options.notify) options.notify('success', okText);
      if (options.onChanged) options.onChanged();
      if (done) done();
      return options.reload(false);
    }, function (error: unknown) {
      setBusy(false);
      setFailure((classify || externalErrorView)(error));
    });
  }
  return {
    busy,
    failure,
    clear: function () { setFailure(null); },
    patch: function (body: ExternalBody, done?: () => void) { run(function () { return updateExternalDoc(options.projectId, options.docId, body); }, '登记信息已更新', done); },
    act: function (action: string, body: ExternalBody, okText: string, done?: () => void, classify?: Classify) { run(function () { return externalDocAction(options.projectId, options.docId, action, body); }, okText, done, classify); },
  };
}
