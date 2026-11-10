// Request-local tickets and cancellation fence late completions; no React or navigation policy.
/**
 * A poll that resolves after a newer one must not overwrite the newer state.
 * Every request takes a ticket; only the newest ticket may commit.
 */
export interface RequestTicket { id: number; signal: AbortSignal | undefined; abort(): void }
export interface RequestGate { begin(): RequestTicket; isCurrent(id: number): boolean; abortAll(): void }

export function createRequestGate(): RequestGate {
  let current = 0;
  let controllers: AbortController[] = [];
  return {
    begin: function () {
      current += 1;
      const id = current;
      let controller: AbortController | null = null;
      try {
        controller = new AbortController();
        controllers.push(controller);
      } catch (error) {
        controller = null;
      }
      return { id, signal: controller ? controller.signal : undefined, abort: function () { if (controller) controller.abort(); } };
    },
    isCurrent: function (id) { return id === current; },
    abortAll: function () {
      for (let i = 0; i < controllers.length; i += 1) {
        try { controllers[i].abort(); } catch (error) { /* already ended */ }
      }
      controllers = [];
      current += 1;
    },
  };
}

// Default name keeps request ownership explicit at hook call sites.
export default createRequestGate;
