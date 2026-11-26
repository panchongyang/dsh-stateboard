// Historical record semantics live on the model side, not in the medium.
import { applyEvent, assertEventSupported, emptyState, normalizePlanHeads } from '../model.js';
import { canonicalJSON } from '../domain/value-hash.js';
import { assertCurrentSchema } from '../schema.js';
import { assertDocEventsInLog, assertExternalDocsInState } from '../documents/external-model.js';
import { assertWorkspaceVersionsInState, assertWorkspaceVersionsMatch, retainedVersionsInLog } from '../domain/workspace-record.js';
import { assertWorkspaceAttachmentCommit, assertWorkspaceAttachmentLog } from '../domain/workspace-attachments.js';
import { assertFixedCommit, assertFixedLog } from '../documents/fixed-reference.js';
import { eventActor } from '../domain/commit-envelope.js';
import { BoardError } from '../errors.js';
import { assertRelationReferences, assertRelationLog } from '../domain/document-relations.js';

/** A reserved identity or unconfirmed first line is not a published project. */
export function assertCommittedProject(seq, projectId) {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new BoardError('board-data-missing', 'project has no verified first commit', {
    status: 409, details: { projectId },
  });
}

export function assertRecord(meta, commit) {
  for (const event of commit.events) assertEventSupported(meta, event, commit);
}
export function assertRecordBatch(state, commit, history) {
  assertFixedCommit(state, commit);
  assertWorkspaceAttachmentCommit(state, commit);
  assertRelationReferences(state, commit, history);
  if (commit.events.some((event) => event.type === 'doc/external-migrated')) assertDocEventsInLog([...history, commit]);
}
export function restoreRecords(meta, lines, snapshot = null) {
  const at = snapshot && Number.isInteger(snapshot.seq) && snapshot.seq >= 0 && snapshot.seq <= lines.length
    ? (snapshot.seq === 0 ? { hash: 'genesis' } : lines[snapshot.seq - 1]) : null;
  const usable = Boolean(at && snapshot.state && at.hash === snapshot.hash);
  const expectedDocs = assertDocEventsInLog(lines, { snapshotSeq: usable ? snapshot.seq : null });
  assertFixedLog(lines, meta.project, usable ? snapshot : null);
  assertWorkspaceAttachmentLog(lines, meta.projectId ?? meta.project.id, usable ? snapshot : null);
  assertRelationLog(lines, meta.project, usable ? snapshot : null);
  if (usable) {
    assertExternalDocsInState(snapshot.state, { expectedDocs, seq: snapshot.seq });
    assertWorkspaceVersionsInState(snapshot.state, { seq: snapshot.seq });
    assertWorkspaceVersionsMatch(snapshot.state, retainedVersionsInLog(lines, snapshot.seq, meta.projectId), { seq: snapshot.seq });
  }
  let state = usable ? normalizePlanHeads(structuredClone(snapshot.state))
    : emptyState({ ...meta.project, schemaVersion: meta.schemaVersion ?? meta.project.schemaVersion ?? 2 });
  const start = usable ? snapshot.seq : 0;
  const timeline = [];
  for (const commit of lines.slice(start)) {
    assertFixedCommit(state, commit);
    for (const event of commit.events) applyEvent(state, structuredClone(event), commit);
    state.lastSeq = commit.seq; state.lastHash = commit.hash; state.project.rev = commit.seq;
    timeline.push(...commit.events.map((event) => ({ seq: commit.seq, at: commit.at, type: event.type,
      taskId: event.taskId || null, actor: eventActor(event, commit), cmdId: commit.cmdId })));
  }
  state.project.rev = state.lastSeq;
  assertCurrentSchema(state);
  return { state, timeline };
}

// Compatibility replay entry for repair/offline consumers.
export function replayRecords(meta, commits) {
  const state = emptyState({ ...meta.project, schemaVersion: meta.schemaVersion ?? meta.project.schemaVersion ?? 2 });
  const timeline = [];
  for (const commit of commits) {
    assertFixedCommit(state, commit);
    assertWorkspaceAttachmentCommit(state, commit);
    assertRelationReferences(state, commit, commits);
    for (const event of commit.events) {
      applyEvent(state, structuredClone(event), commit);
      timeline.push({
        seq: commit.seq,
        at: commit.at,
        type: event.type,
        taskId: event.taskId || null,
        actor: eventActor(event, commit),
        cmdId: commit.cmdId,
      });
    }
    state.lastSeq = commit.seq;
    state.lastHash = commit.hash;
    state.project.rev = commit.seq;
  }
  assertCurrentSchema(state);
  return { state, timeline };
}
