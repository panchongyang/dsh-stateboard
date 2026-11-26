// Stable addresses and replay of explicit document version relations. No I/O.
import { isDeepStrictEqual as equal } from 'node:util';
import { BoardError } from '../errors.js';
import { assertFixedReference, fixedKey } from '../documents/fixed-reference.js';

export const RELATION_ADDED = 'doc/relation-added';
export const RELATION_CLOSED = 'doc/relation-closed';
export const RELATION_EVENTS = new Set([RELATION_ADDED, RELATION_CLOSED]);

const SOURCE_IDS = { task: /^tsk_/, plan: /^pln_/, evidence: /^ev_/, audit: /^aud_/ };
const TASK_RECORDS = new Set([
  'task/created', 'task/updated', 'task/readied', 'task/claimed', 'task/released', 'task/submitted',
  'task/verified', 'task/rejected', 'task/blocked', 'task/unblocked', 'task/interrupted', 'task/reconciled',
  'task/canceled', 'task/reopened', 'task/orphaned',
]);
const PLAN_RECORDS = new Set(['plan/published', 'plan/revised']);
const text = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value;
const positive = value => Number.isSafeInteger(value) && value > 0;
const maps = value => value && typeof value === 'object' && !Array.isArray(value);
const fields = (value, names) => maps(value) && Object.keys(value).sort().join(',') === names;
const invalid = message => new BoardError('invalid-command', message, { status: 400 });
const badRecord = () => new BoardError('invalid-document-relation', 'Relation does not match the committed source or target', { status: 409 });
export const missingRelation = () => new BoardError('not-found', 'No authorized document relation or version', { status: 404 });
export const relationIdIsValid = id => text(id, 128) && /^rel_[0-9a-z_-]+$/.test(id);
const canWriteRelation = actor => ['human', 'agent', 'system'].includes(actor?.kind);
export function assertRelationWriter(request) {
  if (!canWriteRelation(request?.actor)) throw new BoardError('forbidden-role', 'Relation writes require a trusted actor', { status: 403 });
}

export function normalizeRelationSource(raw) {
  if (!fields(raw, 'event,id,kind,seq') || typeof raw.kind !== 'string' || !Object.hasOwn(SOURCE_IDS, raw.kind) || !text(raw.id, 128)
    || !SOURCE_IDS[raw.kind].test(raw.id) || !positive(raw.seq) || !Number.isSafeInteger(raw.event) || raw.event < 0) {
    throw invalid('from must identify a task, plan, evidence or audit at an exact commit and zero-based event');
  }
  return { kind: raw.kind, id: raw.id, seq: raw.seq, event: raw.event };
}

export function normalizeRelationTarget(raw, { allowCurrent = false } = {}) {
  if (!maps(raw) || !text(raw.docId, 128) || !/^doc_[A-Za-z0-9_-]+$/.test(raw.docId)) throw invalid('to must identify a document');
  if (raw.kind === 'workspace-current' && allowCurrent && fields(raw, 'docId,kind')) return { kind: raw.kind, docId: raw.docId };
  if (raw.kind === 'workspace-body' && fields(raw, 'docId,kind,versionId') && text(raw.versionId)) {
    return { kind: raw.kind, docId: raw.docId, versionId: raw.versionId };
  }
  if (raw.kind === 'inline' && fields(raw, 'docId,kind,rev') && positive(raw.rev)) return { kind: raw.kind, docId: raw.docId, rev: raw.rev };
  if (raw.kind === 'git-fixed' && fields(raw, 'docId,fixed,kind')) {
    return { kind: raw.kind, docId: raw.docId, fixed: structuredClone(assertFixedReference(raw.fixed)) };
  }
  throw invalid('to must select one supported document version');
}

export function owningStoredWorkspaceVersion(state, target) {
  if (target.kind !== 'workspace-body' || !Object.hasOwn(state.workspaceVersions || {}, target.versionId)) return null;
  const row = state.workspaceVersions[target.versionId];
  return row?.versionRef?.docId === target.docId && row.versionRef.projectId === state.project.id && row.versionRef.versionId === target.versionId ? row : null;
}

export function recordedFixedVersion(state, target) {
  if (target.kind !== 'git-fixed' || target.fixed.projectId !== state.project.id || !state.project.gitContentRepository) return null;
  const key = fixedKey(target.docId, target.fixed);
  return Object.hasOwn(state.fixedContents || {}, key) ? state.fixedContents[key] : null;
}

const isInlineRevision = (event, target) => (event.type === 'doc/created' || event.type === 'doc/updated')
  && event.data?.id === target.docId && event.data.rev === target.rev && event.data.source !== 'external';
const envelopeMatches = (event, idKey, revKey) => (event[idKey] === undefined || event[idKey] === event.data.id)
  && (event[revKey] === undefined || event[revKey] === event.data[revKey]);
const conflictsWithInlinePin = (event, target, hash) => isInlineRevision(event, target)
  && (!envelopeMatches(event, 'docId', 'rev') || event.data.hash !== hash);
export function inlineVersionAt(commits, target, beforeSeq = Infinity) {
  let exact = null;
  for (let i = Math.min(commits.length, beforeSeq - 1) - 1; i >= 0; i--) {
    for (const event of commits[i].events) {
      if (!isInlineRevision(event, target)) continue;
      if (!envelopeMatches(event, 'docId', 'rev') || (exact && exact.hash !== event.data.hash)) return null;
      exact = event.data;
    }
  }
  return exact;
}

export function locateRelationOwner(commits, from, beforeSeq = Infinity) {
  if (from.seq >= beforeSeq) return null;
  const commit = commits[from.seq - 1];
  if (commit?.seq !== from.seq) return null;
  const event = commit.events[from.event];
  if (from.kind === 'plan') return PLAN_RECORDS.has(event?.type) && event.data?.id === from.id
    && positive(event.data.version) && envelopeMatches(event, 'planId', 'version') ? from.id : null;
  if (!TASK_RECORDS.has(event?.type) || typeof event.data?.id !== 'string' || !event.data.id.startsWith('tsk_')
    || !positive(event.data.rev) || !envelopeMatches(event, 'taskId', 'rev')) return null;
  const task = event.data;
  if (from.kind === 'task') return task.id === from.id ? task.id : null;
  if (from.kind === 'audit') return task.lastAudit?.id === from.id ? task.id : null;
  return task.evidence?.some(row => row.id === from.id) ? task.id : null;
}

export function assertRelationSourceRevision(state, from, ownerId, expectedRev) {
  if (!positive(expectedRev)) throw invalid('expectedRev must be a positive task or plan-head revision');
  const entity = from.kind === 'plan' ? state.planHeads?.[ownerId] : state.tasks?.[ownerId];
  if (!entity) throw missingRelation();
  if (entity.rev !== expectedRev) throw new BoardError('stale-revision', 'Relation source revision has changed', { status: 409, details: { currentRev: entity.rev } });
}

export function activeRelation(state, relationId) {
  if (!relationIdIsValid(relationId)) throw invalid('Invalid relationId');
  const row = state.documentRelations?.[relationId];
  if (!row || row.closedAt) throw missingRelation();
  return row;
}

/** A duplicate open reference is a no-op; closed references remain history. */
export function existingRelation(state, from, to) {
  return Object.values(state.documentRelations || {}).find(row => !row.closedAt && equal(from, row.fromVersion) && equal(to, row.toVersionRef));
}

export function applyDocumentRelationEvent(state, event, commit) {
  const data = event.data;
  if (!fields(event, 'data,docId,type') || !maps(data) || !relationIdIsValid(data.relationId)
    || !canWriteRelation(commit?.actor) || !text(commit.at)) throw badRecord();
  const rows = state.documentRelations ||= {};
  const actor = { kind: commit.actor.kind, sessionId: commit.actor.sessionId ?? null, agentId: commit.actor.agentId ?? null };
  if (event.type === RELATION_CLOSED) {
    const row = rows[data.relationId];
    if (!fields(data, 'relationId,replacedBy') || !row || row.closedAt || event.docId !== row.toVersionRef.docId
      || (data.replacedBy !== null && (!relationIdIsValid(data.replacedBy) || data.replacedBy === row.relationId || rows[data.replacedBy]))) throw badRecord();
    rows[row.relationId] = { ...row, closedAt: commit.at, closedBy: actor, replacedBy: data.replacedBy };
    return;
  }
  let from, to;
  try { from = normalizeRelationSource(data.fromVersion); to = normalizeRelationTarget(data.toVersionRef); }
  catch { throw badRecord(); }
  const inline = to.kind === 'inline';
  if (!fields(data, inline ? 'fromVersion,inlineHash,relationId,relationKind,sourceOwnerId,toVersionRef'
    : 'fromVersion,relationId,relationKind,sourceOwnerId,toVersionRef') || rows[data.relationId]
    || data.relationKind !== 'reference' || !text(data.sourceOwnerId, 128)
    || (inline && (typeof data.inlineHash !== 'string' || !/^[0-9a-f]{64}$/.test(data.inlineHash)))
    || event.docId !== to.docId || from.seq >= commit.seq || existingRelation(state, from, to)) throw badRecord();
  rows[data.relationId] = { ...data, fromVersion: from, toVersionRef: to, createdAt: commit.at, actor };
}

/** Validate cross-record references on the forced pre-append and replay paths. */
export function assertRelationReferences(state, commit, history) {
  const { workspaceVersions, fixedContents, project, documentRelations } = state;
  for (const [ordinal, event] of commit.events.entries()) {
    if (!RELATION_EVENTS.has(event.type)) {
      if ((event.type === 'doc/created' || event.type === 'doc/updated') && Object.values(documentRelations || {}).some(row =>
        row.toVersionRef.kind === 'inline' && conflictsWithInlinePin(event, row.toVersionRef, row.inlineHash))) throw badRecord();
      continue;
    }
    const data = event.data;
    if (event.type === RELATION_CLOSED) {
      if (data?.replacedBy && !commit.events.slice(ordinal + 1).some(next => next.type === RELATION_ADDED && next.data?.relationId === data.replacedBy
        && equal(next.data.fromVersion, documentRelations?.[data.relationId]?.fromVersion))) throw badRecord();
      continue;
    }
    let from, to;
    try { from = normalizeRelationSource(data?.fromVersion); to = normalizeRelationTarget(data?.toVersionRef); }
    catch { throw badRecord(); }
    if (locateRelationOwner(history, from, commit.seq) !== data.sourceOwnerId) throw badRecord();
    if (to.kind === 'inline') {
      const version = inlineVersionAt(history, to, commit.seq);
      if (!version || version.hash !== data.inlineHash || commit.events.some(candidate => conflictsWithInlinePin(candidate, to, version.hash))) throw badRecord();
    }
    if (to.kind === 'git-fixed' && !recordedFixedVersion({ fixedContents, project }, to)) throw badRecord();
    if (to.kind === 'workspace-body' && !owningStoredWorkspaceVersion({ workspaceVersions, project }, to)
      && !commit.events.slice(0, ordinal).some(earlier => earlier.type === 'doc/workspace-retained'
        && owningStoredWorkspaceVersion({ workspaceVersions: { [to.versionId]: earlier.data?.version }, project }, to)
        && earlier.data.version.versionRef.versionId === to.versionId)) throw badRecord();
  }
}

/** The snapshot cannot add or hide a relation; verify the log even underneath it. */
export function assertRelationLog(commits, initialProject, snapshot) {
  const shadow = { project: initialProject, workspaceVersions: {}, fixedContents: {}, documentRelations: {} };
  let atSnapshot = {};
  let sourceAtSnapshot = initialProject;
  for (const commit of commits) {
    assertRelationReferences(shadow, commit, commits);
    for (const event of commit.events) {
      if (event.type === 'project/created' || event.type === 'project/updated') shadow.project = event.data;
      else if (event.type === 'doc/workspace-retained') {
        const row = event.data?.version;
        if (row?.versionRef) shadow.workspaceVersions[row.versionRef.versionId] = row;
      } else if (event.type === 'doc/content-fixed') {
        const row = event.data;
        shadow.fixedContents[fixedKey(row.ref, row.fixed)] = row;
      } else if (RELATION_EVENTS.has(event.type)) applyDocumentRelationEvent(shadow, event, commit);
    }
    if (snapshot?.seq === commit.seq) {
      atSnapshot = { ...shadow.documentRelations };
      sourceAtSnapshot = shadow.project;
    }
  }
  // Physical copies retain the logged source identity; the snapshot cannot
  // nominate a different former root and thereby authorize a retained locator.
  if (snapshot && (snapshot.state.project?.id !== sourceAtSnapshot?.id
    || snapshot.state.project?.workspacePath !== sourceAtSnapshot?.workspacePath
    || !equal(snapshot.state.documentRelations ?? {}, atSnapshot))) throw badRecord();
}
