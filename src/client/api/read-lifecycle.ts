// One read controller per page resource owns cancellation, polling and late-response fencing; never owns writes.
import { POLL_INTERVAL_MS, REQUEST_TIMEOUT_MS, backoffDelay } from '../model/races.ts';

export interface ReadRequest { signal: AbortSignal; timeoutMs: number }
export interface ReadOptions { poll?: boolean; document?: EventTarget & { visibilityState?: string }; window?: EventTarget; setTimeout?: (fn: () => void, ms: number) => number; clearTimeout?: (id: number) => void }
export interface ReadState<T> { data: T; ready: boolean; loading: boolean; error: unknown; refreshedAt: Date | null }
export interface PageRead<T> { snapshot(): ReadState<T>; subscribe(listener: (state: ReadState<T>) => void): () => void; reload(invalidate?: boolean): Promise<void>; start(): void; stop(): void }
interface ReadLoop<T> { begin(): void; load(): Promise<T>; current(): boolean; dirty(): boolean; accept(data: T): void; reject(error: unknown): void }
interface ReadStore<T> { snapshot(): ReadState<T>; subscribe(listener: (state: ReadState<T>) => void): () => void; update(patch: Partial<ReadState<T>>): void }

export function createPageRead<T>(load: (request: ReadRequest) => Promise<T>, empty: T, options?: ReadOptions): PageRead<T> {
  options = options || {};
  const environment = readEnvironment(options);
  const doc = environment.doc, win = environment.win;
  const later = environment.later, cancel = environment.cancel;
  const store = readStore(empty);
  const update = store.update;
  let active = false;
  let generation = 0;
  let pending: Promise<void> | null = null;
  let controller: AbortController | null = null;
  let dirty = false;
  let timer: number | null = null;
  let failures = 0;
  function hidden() { return doc && doc.visibilityState === 'hidden'; }
  function clearTimer() { if (timer !== null) cancel(timer); timer = null; }
  function schedule() {
    clearTimer();
    if (!active || !options!.poll || hidden()) return;
    timer = later(function () { timer = null; reload(false); }, failures ? backoffDelay(failures - 1) : POLL_INTERVAL_MS);
  }
  function reload(invalidate?: boolean): Promise<void> {
    if (!active) return Promise.resolve();
    if (pending) {
      // An explicit refresh (especially after a write) needs a read begun AFTER
      // that invalidation. Ordinary resume/poll reads can join the current one.
      if (invalidate !== false) dirty = true;
      return pending;
    }
    clearTimer();
    const epoch = generation;
    update({ loading: true });
    const work = readUntilClean({
      begin: function () { dirty = false; controller = new AbortController(); },
      load: function () { return load({ signal: controller!.signal, timeoutMs: REQUEST_TIMEOUT_MS }); },
      current: function () { return active && epoch === generation; },
      dirty: function () { return dirty; },
      accept: function (data) { failures = 0; update({ data, ready: true, error: null, refreshedAt: new Date() }); },
      reject: function (error) { failures += 1; update({ error }); },
    });
    pending = work.finally(function () {
      if (!active || epoch !== generation) return;
      pending = null;
      controller = null;
      // A write may invalidate in the microtask between the loop finishing and
      // this finalizer. Its caller must still await a fresh read, not lose it.
      if (dirty) return reload(true);
      update({ loading: false });
      schedule();
    });
    return pending;
  }
  function resume() {
    if (!active) return;
    if (hidden()) { clearTimer(); return; }
    reload(false);
  }
  return {
    snapshot: store.snapshot,
    subscribe: store.subscribe,
    reload,
    start: function () {
      if (active) return;
      active = true;
      generation += 1;
      readEvents(doc, win, resume, true);
      resume();
    },
    stop: function () {
      active = false;
      generation += 1;
      clearTimer();
      if (controller) controller.abort();
      controller = null;
      pending = null;
      dirty = false;
      readEvents(doc, win, resume, false);
    },
  };
}

// A write invalidation repeats the read before callers resolve; stale epochs
// publish neither data nor errors. The finalizer separately covers its microtask gap.
async function readUntilClean<T>(read: ReadLoop<T>): Promise<void> {
  do {
    read.begin();
    try {
      const data = await read.load();
      if (!read.current()) return;
      if (!read.dirty()) read.accept(data);
    } catch (error) {
      if (!read.current()) return;
      if (!read.dirty()) read.reject(error);
    }
  } while (read.current() && read.dirty());
}

// Environment injection keeps synthetic clocks and visibility targets isolated.
function readEnvironment(options: ReadOptions): { doc: ReadOptions['document'] | null; win: EventTarget | null; later: (fn: () => void, ms: number) => number; cancel: (id: number) => void } {
  return {
    doc: options.document || (typeof document !== 'undefined' ? document : null),
    win: options.window || (typeof window !== 'undefined' ? window : null),
    later: options.setTimeout || setTimeout,
    cancel: options.clearTimeout || clearTimeout,
  };
}

// Snapshot publication stays synchronous so subscribers observe invalidation order.
function readStore<T>(empty: T): ReadStore<T> {
  let state: ReadState<T> = { data: empty, ready: false, loading: true, error: null, refreshedAt: null };
  const listeners = new Set<(state: ReadState<T>) => void>();
  return {
    snapshot: function () { return state; },
    subscribe: function (listener) { listeners.add(listener); return function () { listeners.delete(listener); }; },
    update: function (patch) {
      state = Object.assign({}, state, patch);
      listeners.forEach(function (listener) { listener(state); });
    },
  };
}

function readEvents(doc: EventTarget | null | undefined, win: EventTarget | null, resume: () => void, adding: boolean): void {
  const method: 'addEventListener' | 'removeEventListener' = adding ? 'addEventListener' : 'removeEventListener';
  if (doc) doc[method]('visibilitychange', resume);
  if (win) { win[method]('focus', resume); win[method]('pageshow', resume); }
}
