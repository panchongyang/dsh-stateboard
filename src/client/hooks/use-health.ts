// Health React reads keep independent fixed 5s polling, hidden skips and interval-only cleanup.
// Requests may overlap; transport owns its default timeout. Never join the board reader.
import React from 'react';
import type { Health } from '../model/view-types.ts';
import { getHealth } from '../api/transport.ts';
import { errorText } from '../model/labels.ts';
const useState = React.useState;
const useEffect = React.useEffect;
const useCallback = React.useCallback;

export function useHealth(projectId: string | undefined, initial: { health?: Health }) {
  const [health, setHealth] = useState<Health | null | undefined>(initial.health || null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const load = useCallback(function () {
    if (!projectId) return;
    getHealth(projectId)
      .then(function (result) {
        setHealth(result.health);
        setError(null);
        setUpdatedAt(new Date());
      })
      .catch(function (reason: unknown) { setError(errorText(reason)); });
  }, [projectId]);

  useEffect(function () {
    load();
    const timer = setInterval(function () {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      load();
    }, 5000);
    return function () { clearInterval(timer); };
  }, [load]);

  return { health, error, updatedAt, load };
}
