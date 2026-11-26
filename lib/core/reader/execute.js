// One execution plan shared by the main thread (live published values) and the
// query worker (cold replay). Projections are pure; blob/Git/health effects go
// through the explicit ports below.
import { inspectExternalDoc, listExternalDocs } from '../documents/external-observe.js';
import { getFixedContent } from '../documents/fixed-content.js';
import { readImageAsset } from '../documents/assets.js';
import { fullHealth } from '../health.js';
import { inlineDocProjection } from '../projection/doc.js';
import { projectValue } from '../projection/views.js';

/**
 * A plain read port for workspace/Git observation and evidence audit. It exposes
 * only values and read-only functions; it is not a ProjectHandle and has no
 * command, append, lease or service-open capability.
 */
export function readPort({ projectId, state, rev, now, leases = [], meta = null, bindings = null, readBlob = () => null, readOnly = true }) {
  const active = Array.isArray(bindings?.active) ? bindings.active : [];
  const main = bindings?.main || null;
  const index = {
    activeFor: (id) => id === projectId ? active : [],
    mainOf: (id) => id === projectId ? main : null,
  };
  return {
    id: projectId,
    projectId,
    state,
    rev,
    readOnly,
    closed: false,
    workspacePath: state.project.workspacePath, fileEvidenceRoot: bindings?.fileEvidenceRoot,
    meta: meta || { project: state.project },
    leases: new Map((Array.isArray(leases) ? leases : []).map((lease) => [lease.taskId, lease])),
    store: { readBlob, readMigrationBlob: readBlob },
    service: { reloadBindings() {}, bindings: () => index },
    clock: () => new Date(now),
    _ensureOpen() {},
    _nowMs() { return now; },
  };
}

function healthValue(port) {
  const health = fullHealth(port, { includeEvidenceWarnings: true });
  return { health: { ...health, evidenceAudit: { status: 'complete' } } };
}

/** Execute a view against captured values. Returns a plain, still-detached value. */
/**
 * Stable identity for the 30 s external-observation cache: a project keeps one
 * port object and refreshes its values per call. `fresh` still bypasses the
 * cache inside external-observe; the port never changes that decision.
 */
export function createStableReadPort(initial = {}) {
  const box = { projectId: initial.projectId, state: initial.state, rev: initial.rev, now: initial.now,
    leases: initial.leases || [], meta: initial.meta || null, bindings: initial.bindings || null, readBlob: initial.readBlob || (() => null), readOnly: initial.readOnly !== false };
  const index = () => ({
    activeFor: (id) => id === box.projectId ? (box.bindings?.active || []) : [],
    mainOf: (id) => id === box.projectId ? (box.bindings?.main || null) : null,
  });
  const port = {
    get id() { return box.projectId; }, get projectId() { return box.projectId; },
    get state() { return box.state; }, get rev() { return box.rev; },
    get readOnly() { return box.readOnly; }, closed: false,
    get workspacePath() { return box.state.project.workspacePath; },
    get meta() { return box.meta || { project: box.state.project }; },
    get leases() { return new Map((box.leases || []).map((lease) => [lease.taskId, lease])); },
    store: { readBlob: (hash) => box.readBlob(hash), readMigrationBlob: (hash) => box.readBlob(hash) },
    service: { reloadBindings() {}, bindings: index },
    clock: () => new Date(box.now),
    _ensureOpen() {}, _nowMs() { return box.now; },
  };
  return {
    port,
    update(next) {
      Object.assign(box, next);
      if (next.bindings !== undefined) box.bindings = next.bindings;
      return port;
    },
  };
}

/**
 * taskView redacts lease/owner for an actor that cannot see the credential,
 * but the open intent still carries its fencing token. A value with no visible
 * lease must not smuggle that token through the intent projection.
 */
function withoutForeignIntentToken(value) {
  if (!value || value.lease !== null || !value.intent || !Object.hasOwn(value.intent, 'token')) return value;
  const { token: _token, ...intent } = value.intent;
  return { ...value, intent };
}

export function executeRead({ snapshot, view, params = {}, actor = {}, readBlob = () => null, bindings = null, meta = null, port: stablePort = null, hints = null }) {
  const port = () => stablePort || readPort({ ...snapshot, bindings, readBlob, meta });
  switch (view) {
    case 'doc': {
      // The reader fetches the bounded body; projection only shapes the value.
      const doc = snapshot.state.docs[params.docId];
      const body = doc && doc.source !== 'external' ? readBlob(doc.hash) : null;
      return inlineDocProjection(snapshot, params.docId, body, params.maxBytes);
    }
    case 'inspect':
      return inspectExternalDoc(port(), params.docId, { fresh: params.fresh === true, preview: params.preview === true });
    case 'doc_asset':
      return readImageAsset(port(), params.docId, params.rawPath);
    case 'get_fixed':
      return getFixedContent(port(), {
        docId: params.docId,
        ...(params.fixed !== undefined ? { fixed: params.fixed } : {}),
        ...(params.commitOid !== undefined ? { commitOid: params.commitOid } : {}),
        ...(params.pathAtCommit !== undefined ? { pathAtCommit: params.pathAtCommit } : {}),
        ...(params.bindingId !== undefined ? { bindingId: params.bindingId } : {}),
      }, { withinBinding: true });
    case 'list_external':
      return listExternalDocs(port(), { includeUnregistered: params.includeUnregistered === true });
    case 'health':
      return healthValue(port());
    default: {
      const value = projectValue(view, snapshot, params, actor, hints);
      return view === 'task' ? withoutForeignIntentToken(value) : value;
    }
  }
}

export const EXECUTED_VIEWS = Object.freeze(['doc', 'inspect', 'get_fixed', 'doc_asset', 'list_external', 'health']);
