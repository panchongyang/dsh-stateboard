// Plain read port for the cold worker: values only, no ProjectHandle or
// ProjectService. Workspace/Git observation reaches the same functions through a
// narrow binding facade; blob reads stay an injected side-effect port.
import path from 'node:path';
import { readMigrationBlob } from './documents/migration-blob.js';
import { BindingIndex } from './identity/bindings.js';
import { readRegistry } from './identity/registry.js';
import { fullHealth } from './health.js';
import { buildDigest } from './digest.js';
import { inlineDocProjection } from './projection/doc.js';
import { viewSource } from './projection/source.js';
import { briefView, boardView, docsView, eventsView, planView, plansView, taskView } from './views.js';

function bindingIndex(rootDir, projectId, meta) {
  let persisted = [];
  try { persisted = readRegistry(rootDir).registry.bindings; } catch { /* implicit main only */ }
  return new BindingIndex(persisted, new Map([[projectId, meta]]));
}

// 用途：为已捕获/验证的投影创建只读领域适配；不 init/open service，不持 writer 锁。
export function createReadHandle({ projectId, rootDir, dir, now, live, fileEvidenceRoot }, snapshot) {
  const meta = snapshot.meta;
  const state = snapshot.state;
  const rev = snapshot.lastSeq ?? snapshot.rev ?? state.lastSeq;
  const timeline = snapshot.timeline || [];
  const commits = snapshot.commits || [];
  const memoryBlobs = snapshot.blobs ? new Map(snapshot.blobs) : null;
  const blobsDir = path.join(dir, 'blobs');
  const readBlob = (hash) => {
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return null;
    if (memoryBlobs) return memoryBlobs.get(hash) ?? null;
    return readMigrationBlob(blobsDir, hash);
  };
  const source = viewSource({
    projectId, state, rev, timeline, leases: [], now, readOnly: !live,
    workspacePath: snapshot.spaceHome?.root ?? state.project.workspacePath, meta,
    store: { commits, readBlob, readMigrationBlob: readBlob },
  });
  let index = null;
  const localBindings = () => {
    if (!snapshot.spaceHome) return bindingIndex(rootDir, projectId, meta);
    snapshot.spaceHome.check();
    return new BindingIndex([], new Map([[projectId, meta]]), { spaceRoot: snapshot.spaceHome.root });
  };
  const service = {
    reloadBindings() { index = localBindings(); },
    bindings() { index ??= localBindings(); return index; },
  };
  const handle = Object.assign(Object.create(null), source, {
    meta, fileEvidenceRoot: snapshot.spaceHome?.root ?? fileEvidenceRoot,
    service,
    store: source.store,
    health() { return fullHealth(handle, { includeEvidenceWarnings: true }); },
    digest(sessionId, options = {}) { return buildDigest(briefView(handle, sessionId), sessionId, options); },
    query(view, params = {}) {
      switch (view) {
        case 'brief': return briefView(handle, params.sessionId);
        case 'board': return boardView(handle);
        case 'task': return taskView(handle, params.taskId, params.sessionId);
        case 'plan': return planView(handle, params.planId);
        case 'plans': return plansView(handle, params);
        case 'docs': return docsView(handle);
        case 'doc': {
          const doc = state.docs[params.docId];
          return inlineDocProjection(snapshot, params.docId, doc && doc.source !== 'external' ? readBlob(doc.hash) : null, params.maxBytes);
        }
        case 'events': return eventsView(handle, params.after, params.limit);
        default: throw new Error('unknown read handle view: ' + view);
      }
    },
  });
  return handle;
}
