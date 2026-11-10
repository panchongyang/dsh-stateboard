// Toast React state owns timed dismissal and reduced-motion exit; no resource reads or writes.
import React from 'react';
import type { Toast } from '../model/view-types.ts';
import { motionDurationMs, prefersReducedMotion } from '../utils/format.ts';
const useState = React.useState;
const useCallback = React.useCallback;
const useRef = React.useRef;
const TOAST_MS = 3200;

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const leaving = useRef<Record<string, boolean>>({});
  const dismiss = useCallback(function (id: string) {
    if (leaving.current[id]) return;
    leaving.current[id] = true;
    const delay = motionDurationMs('base', prefersReducedMotion());
    setToasts(function (previous) {
      return previous.map(function (item) { return item.id === id ? Object.assign({}, item, { leaving: true }) : item; });
    });
    setTimeout(function () {
      delete leaving.current[id];
      setToasts(function (previous) {
        return previous.filter(function (item) { return item.id !== id; });
      });
    }, delay);
  }, []);
  const push = useCallback(function (tone: string, text: string) {
    seq.current += 1;
    const id = 'toast-' + seq.current;
    setToasts(function (previous) { return previous.concat([{ id, tone, text }]); });
    setTimeout(function () { dismiss(id); }, TOAST_MS);
  }, [dismiss]);
  return { toasts, push, dismiss };
}
