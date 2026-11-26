// An attachment names an existing exact ledger entry, never a current file.
// The same invariant applies before append and throughout cold/snapshot replay.
import { isDeepStrictEqual } from 'node:util';
import { eventClass } from '../../shared/events.js';
import { invalidVersion, latestVersionFor, versionRefProblem, WORKSPACE_RETAINED_EVENT } from './workspace-record.js';
import { workspaceEvidenceRefProblem } from './workspace-version-ref.js';

const hasBaselineRef = doc => Boolean(doc?.baseline && Object.hasOwn(doc.baseline, 'workspaceVersion'));
const hasVersionRef = row => Boolean(row && Object.hasOwn(row, 'workspaceVersion'));
const retainedRows = task => (Array.isArray(task?.evidence) ? task.evidence.filter(hasVersionRef) : []);

function assertEvidenceIds(task, fail) {
  const ids = new Set();
  if (!Array.isArray(task?.evidence)) fail('Workspace evidence history is missing');
  for (const row of task.evidence) {
    if (typeof row?.id !== 'string' || !row.id.trim() || ids.has(row.id)) fail('Workspace evidence requires nonempty unique evidence IDs');
    ids.add(row.id);
  }
}

function advance(state, commit) {
  let projectId = state.projectId;
  for (const event of commit.events) {
    const data = event.data;
    const fail = message => { throw invalidVersion(message, { seq: commit.seq, type: event.type }); };
    const exact = (ref, docId, contentHash) => {
      const problem = versionRefProblem(ref, { projectId, docId, contentHash });
      if (problem) fail('Invalid workspace version attachment: ' + problem);
      const version = state.version(ref.versionId);
      if (!version || !isDeepStrictEqual(version.versionRef, ref)) fail('Workspace version attachment has no matching retained record');
      return version;
    };
    const requireLatest = (version, doc) => {
      const ref = version.versionRef;
      if (doc?.source !== 'external' || doc.unregistered || !isDeepStrictEqual(doc.locator, version.locator)
        || state.latest(ref.docId)?.versionRef.versionId !== ref.versionId) {
        fail('A new workspace version attachment must describe the latest retained version at the current locator');
      }
    };
    if (event.type === 'project/created' || event.type === 'project/updated') projectId = data.id;
    if (event.type === WORKSPACE_RETAINED_EVENT) state.putVersion(data?.version);
    if (typeof event.type !== 'string') continue;
    if (event.type.startsWith('doc/external-')) {
      const priorDoc = state.doc(data?.id);
      const previous = hasBaselineRef(priorDoc) ? priorDoc.baseline : null;
      const current = hasBaselineRef(data) ? data.baseline : null;
      if (event.type === 'doc/external-confirmed' && (previous || Object.hasOwn(event.change?.previousBaseline ?? {}, 'workspaceVersion'))
        && !isDeepStrictEqual(event.change?.previousBaseline, priorDoc?.baseline)) fail('Confirmation previousBaseline differs from its historical record');
      if (event.type === 'doc/external-confirmed' && current) {
        const version = exact(current.workspaceVersion, data.id, current.contentHash);
        requireLatest(version, priorDoc);
        const locator = { bindingId: current.bindingId, relPath: current.relPath };
        if (!data.baselineInContext || !isDeepStrictEqual(locator, data.locator)
            || !isDeepStrictEqual(locator, version.locator) || event.change?.size !== version.size) {
          fail('Workspace confirmation does not describe the retained locator and size');
        }
      } else if (event.type !== 'doc/external-confirmed' && !isDeepStrictEqual(current, previous)) {
        fail('Only confirmation may change a workspace version baseline');
      }
      state.putDoc(data?.id, data);
    }
    if (event.type.startsWith('task/') && eventClass(event.type) === 'applied' && data?.id) {
      const previous = state.evidence(data.id);
      const current = retainedRows(data);
      if (!previous.length && !current.length) continue; // Old records have their original validation rules.
      assertEvidenceIds(data, fail);
      const oldById = new Map(previous.map(row => [row.id, row]));
      const newIds = new Set();
      for (const row of current) {
        if (workspaceEvidenceRefProblem(row, projectId)
          || ['fixed', 'fixedState', 'fixedReason'].some(key => Object.hasOwn(row, key))) fail('Invalid workspace version evidence fields');
        const version = exact(row.workspaceVersion, row.ref, row.hash);
        const before = oldById.get(row.id);
        if (before) {
          if (!isDeepStrictEqual(before.workspaceVersion, row.workspaceVersion)) fail('A retained evidence reference is immutable');
        } else {
          if (!['task/submitted', 'task/reconciled'].includes(event.type)) fail('Workspace evidence must be introduced by submit or reconcile');
          requireLatest(version, state.doc(row.ref));
        }
        newIds.add(row.id);
      }
      for (const id of oldById.keys()) if (!newIds.has(id)) fail('A retained evidence reference cannot be removed from history');
      state.putEvidence(data.id, current);
    }
  }
  state.projectId = projectId;
}

function validator(projectId, base = {}) {
  const versions = new Map(), latest = new Map(), docs = new Map(), evidence = new Map();
  return { projectId,
    version: id => versions.get(id) ?? base.workspaceVersions?.[id],
    latest: docId => latest.get(docId) ?? latestVersionFor(base, docId),
    putVersion(row) {
      if (!row?.versionRef) return;
      versions.set(row.versionRef.versionId, row);
      latest.set(row.versionRef.docId, row);
    },
    doc: id => docs.get(id) ?? base.docs?.[id],
    putDoc: (id, row) => docs.set(id, row),
    evidence: id => evidence.get(id) ?? retainedRows(base.tasks?.[id]),
    putEvidence: (id, rows) => evidence.set(id, rows),
    evidenceKeys: () => evidence.keys(),
  };
}

function assertSnapshot(state, snapshot) {
  const tasks = snapshot.state.tasks ?? {};
  for (const id of new Set([...state.evidenceKeys(), ...Object.keys(tasks)])) {
    const fromSnapshot = retainedRows(tasks[id]);
    const fromLog = state.evidence(id);
    if (!fromSnapshot.length && !fromLog.length) continue;
    const fail = message => { throw invalidVersion(message, { seq: snapshot.seq, taskId: id, origin: 'snapshot' }); };
    assertEvidenceIds(tasks[id], fail);
    if (!isDeepStrictEqual(fromLog, fromSnapshot)) fail('Snapshot workspace evidence differs from the log');
  }
}

export function assertWorkspaceAttachmentCommit(state, commit) {
  advance(validator(state.project?.id, state), commit);
}

export function assertWorkspaceAttachmentLog(commits, projectId, snapshot) {
  const state = validator(projectId);
  if (snapshot?.seq === 0) assertSnapshot(state, snapshot);
  for (const commit of commits) {
    advance(state, commit);
    if (commit.seq === snapshot?.seq) assertSnapshot(state, snapshot);
  }
}
