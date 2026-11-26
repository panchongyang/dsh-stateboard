// A captured project snapshot is a plain value: no handle, service, writer or
// live object may escape this module. View/lease algorithms take this source
// instead of a ProjectHandle, so logical projection cannot trigger I/O.
import { healthSummaryOf } from '../health.js';

const EMPTY_STORE = Object.freeze({ commits: [], readBlob: () => null, readMigrationBlob: () => null });

/**
 * Build the read-only view source consumed by views.js / lease.js.
 * `snapshot` is { projectId?, state, rev|lastSeq, timeline?, commits?, leases?, now, store? }.
 * Every field is an already-captured value; `store.readBlob` is a side-effect
 * port supplied by the caller, never a handle.
 */
export function viewSource(snapshot) {
  const state = snapshot.state;
  const leases = snapshot.leases instanceof Map
    ? new Map(snapshot.leases)
    : new Map((snapshot.leases || []).map((lease) => [lease.taskId, lease]));
  const now = snapshot.now;
  const store = snapshot.store || EMPTY_STORE;
  const rev = snapshot.rev ?? snapshot.lastSeq ?? state.lastSeq;
  return {
    id: snapshot.projectId ?? state.project.id,
    projectId: snapshot.projectId ?? state.project.id,
    state,
    rev,
    timeline: snapshot.timeline || [],
    commits: snapshot.commits || store.commits || [],
    leases,
    readOnly: snapshot.readOnly === true,
    closed: false,
    workspacePath: snapshot.workspacePath ?? state.project.workspacePath,
    meta: snapshot.meta ?? { project: state.project },
    store: { ...store, commits: snapshot.commits || store.commits || [] },
    clock: () => new Date(now),
    _ensureOpen() {},
    _nowMs() { return now; },
    healthSummary() { return healthSummaryOf({ state, leases: leases.values(), now }); },
  };
}

/** Detach a projected DTO from every captured/live object before publication. */
export function detachValue(value) {
  return value === undefined ? value : structuredClone(value);
}
