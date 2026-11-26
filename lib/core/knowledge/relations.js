import { baseReference, eventEntity, hiddenEvent, locateReference, metadataOf, readRecord, sourceExcerpt } from './records.js';
import { decodeReference, encodeReference } from './reference.js';
import { assertKnowledgeFixedAuthority, contentCandidates, observeCandidate, workspaceBodyCandidate } from './content.js';
import { locateRelationOwner } from '../domain/document-relations.js';
import { BoardError } from '../errors.js';
import { canonicalJSON } from '../util.js';
import { KNOWLEDGE_LIMITS as LIMITS } from '../../shared/knowledge.js';
import { MAX_DOC_BYTES } from '../documents/read.js';

function relationTargets(value) {
  const targets = [];
  for (const id of value.deps || []) targets.push({ entity: 'task:' + id, reason: 'task.deps' });
  if (value.planRef) targets.push({ entity: 'plan:' + value.planRef.planId, version: value.planRef.version, reason: 'task.planRef' });
  for (const step of value.steps || []) for (const id of step.taskIds || []) targets.push({ entity: 'task:' + id, reason: 'plan.steps.taskIds' });
  for (const id of value.links?.taskIds || []) targets.push({ entity: 'task:' + id, reason: 'document.links.taskIds' });
  for (const ref of value.links?.planRefs || []) targets.push({ entity: 'plan:' + ref.planId, version: ref.version, reason: 'document.links.planRefs' });
  if (value.kind === 'doc' && value.ref && !value.fixed && !value.workspaceVersion) {
    const [id, rev] = value.ref.split('@');
    targets.push({ entity: 'doc:' + id, ...(rev ? { revision: Number(rev) } : {}),
      reason: rev ? 'evidence.document' : 'evidence.document.current-metadata' });
  }
  return targets;
}

// 用途：关系只由来源中的字段产生；仅 ID 的目标明确为本次水位，非历史 as-of。
function findTarget(snapshot, target) {
  for (let ci = snapshot.commits.length - 1; ci >= 0; ci--) {
    const commit = snapshot.commits[ci];
    for (let ei = commit.events.length - 1; ei >= 0; ei--) {
      const event = commit.events[ei];
      if (eventEntity(event) !== target.entity || event.data?.id !== target.entity.slice(target.entity.indexOf(':') + 1)) continue;
      if (target.version !== undefined && event.data?.version !== target.version) continue;
      if (target.revision !== undefined && event.data?.rev !== target.revision) continue;
      return encodeReference(baseReference(snapshot, commit, ei));
    }
  }
  return null;
}

function localEdges(snapshot, located) {
  const { ref, event, value, commit } = located;
  const edges = [];
  const add = (reference, reason, scope = 'source-version') => edges.push({ ref: reference, reason, scope });
  const at = (part, item) => encodeReference(baseReference(snapshot, commit, ref.event, part, item));
  if (ref.part !== 'record') add(at('record'), 'source.parent');
  if (ref.part === 'record' && event.type.startsWith('task/')) {
    for (const row of value.evidence || []) add(at('evidence', row.id), 'task.evidence');
    if (value.lastAudit?.id) add(at('audit', value.lastAudit.id), 'task.lastAudit');
  }
  if (value.supersededBy && event.data.evidence?.some(row => row.id === value.supersededBy)) add(at('evidence', value.supersededBy), 'evidence.supersededBy');
  if (value.acceptanceId) add(at('record'), 'evidence.acceptance:' + value.acceptanceId);
  return edges;
}

function historyEdges(snapshot, located) {
  if (located.ref.part !== 'record') return [];
  const entity = eventEntity(located.event);
  if (!entity) return [];
  let previous = null, next = null;
  for (const commit of snapshot.commits) {
    for (let ei = 0; ei < commit.events.length; ei++) {
      const event = commit.events[ei];
      if (eventEntity(event) !== entity || hiddenEvent(snapshot, event)) continue;
      const ref = encodeReference(baseReference(snapshot, commit, ei));
      if (commit.seq < located.ref.seq || (commit.seq === located.ref.seq && ei < located.ref.event)) previous = ref;
      if (!next && (commit.seq > located.ref.seq || (commit.seq === located.ref.seq && ei > located.ref.event))) next = ref;
    }
  }
  return [previous && { ref: previous, reason: 'source.previous', scope: 'retained-history' },
    next && { ref: next, reason: 'source.next', scope: 'retained-history' }].filter(Boolean);
}

function linkedDocuments(snapshot, source) {
  if (!source.entity?.startsWith('task:')) return [];
  const taskId = source.entity.slice(5);
  return [...Object.values(snapshot.state.docs).filter(doc => !doc.unregistered && doc.links?.taskIds?.includes(taskId))
    .map(doc => ({ entity: 'doc:' + doc.id, reason: 'document.links.taskIds.reverse' })),
  ...Object.values(snapshot.state.tasks).filter(task => task.deps?.includes(taskId))
    .map(task => ({ entity: 'task:' + task.id, reason: 'task.deps.reverse' }))];
}

function bodyEdges(snapshot, candidates, located) {
  const hold = located.ref.part === 'evidence' ? located.value.workspaceVersion
    : located.ref.part === 'record' && located.event.type === 'doc/external-confirmed' ? located.value.baseline?.workspaceVersion : null;
  if (hold) {
    const candidate = workspaceBodyCandidate(snapshot, hold);
    if (!candidate || candidate.ref.contentHash !== hold.contentHash) return [];
    const reason = located.ref.part === 'evidence' ? 'evidence.workspace-version' : 'document.confirmed-version';
    return [{ candidate, reason, scope: 'explicit-version' }];
  }
  if (located.ref.part === 'evidence' && ((located.value.kind === 'file' && located.value.hash) || located.value.fixed)) {
    return [{ candidate: { origin: 'evidence:' + located.ref.item,
      ref: { ...located.ref, part: located.value.fixed ? 'fixed' : 'file' } }, reason: 'evidence.content', scope: 'source-version' }];
  }
  return candidates.filter(candidate => candidate.ref.seq === located.ref.seq && candidate.ref.event === located.ref.event
    && (located.ref.part === 'record' ? !candidate.ref.item : candidate.ref.item === located.ref.item))
    .map(candidate => ({ candidate, reason: 'source.content', scope: candidate.ref.part === 'external' ? 'current-observation' : 'source-version' }));
}

const exactReason = 'document.version-relation';
const bodyTarget = ({ docId, versionId }) => ({ kind: 'workspace-body', docId, versionId });

function workVersion(snapshot, located) {
  const { ref, event, value } = located;
  const kind = ref.part === 'record' ? event.type.split('/')[0] : ref.part;
  if (!['task', 'plan', 'evidence', 'audit'].includes(kind)) return null;
  const from = { kind, id: value.id, seq: ref.seq, event: ref.event };
  return locateRelationOwner(snapshot.commits, from) ? from : null;
}

function documentVersion(located, workspaceRef) {
  if (workspaceRef?.part === 'workspace-body') return bodyTarget(workspaceRef);
  if (!located?.ref.contentHash) return null;
  const { ref, value } = located;
  if (ref.part === 'inline' && value.hash === ref.contentHash && value.source !== 'external') {
    return { kind: 'inline', docId: value.id, rev: value.rev };
  }
  if (ref.part === 'fixed' && value.fixed?.blobContentHash === ref.contentHash) {
    return { kind: 'git-fixed', docId: value.ref, fixed: value.fixed };
  }
  return null;
}

function sameWorkVersion(left, right) {
  return left.kind === right.kind && left.id === right.id && left.seq === right.seq && left.event === right.event;
}

function sameDocumentVersion(left, right) {
  if (left.kind !== right.kind || left.docId !== right.docId) return false;
  switch (left.kind) {
    case 'workspace-body': return left.versionId === right.versionId;
    case 'inline': return left.rev === right.rev;
    case 'git-fixed': return canonicalJSON(left.fixed) === canonicalJSON(right.fixed);
    default: return false;
  }
}

function exactCandidateReader(snapshot, candidates, onProofLimit) {
  const { workspace, spaceHome } = snapshot;
  const byOrigin = new Map(candidates.map(candidate => [candidate.origin, candidate]));
  return (row) => {
    const target = row.toVersionRef;
    if (target.kind === 'inline') {
      const candidate = byOrigin.get('inline:' + target.docId + '@' + target.rev);
      if (!candidate || locateReference(snapshot, encodeReference(candidate.ref)).value.hash !== row.inlineHash) return null;
      return { ...candidate, ref: { ...candidate.ref, contentHash: row.inlineHash } };
    }
    // The legacy read handle and a stored ref are not workspace capabilities.
    if (!workspace?.workspaceContext || !workspace.scopeKey || !spaceHome || !Array.isArray(workspace.denyPrefixes)
      || workspace.root !== spaceHome.root) return null;
    if (target.kind === 'workspace-body') return workspaceBodyCandidate(snapshot, target);
    if (target.kind !== 'git-fixed') return null;
    const candidate = byOrigin.get('fixed:' + target.docId + ':' + canonicalJSON(target.fixed));
    if (!candidate) return null;
    try { assertKnowledgeFixedAuthority(snapshot, target); }
    catch (error) {
      if (error.code === 'knowledge-resource-limit') { onProofLimit(); return null; }
      if (error instanceof BoardError || ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return null;
      throw error;
    }
    return { ...candidate, ref: { ...candidate.ref, contentHash: target.fixed.blobContentHash } };
  };
}

function* exactEdges(snapshot, anchors, candidateFor) {
  for (const { source, located, workspaceRef } of anchors) {
    const from = located && workVersion(snapshot, located);
    const to = documentVersion(located, workspaceRef);
    if (!from && !to) continue;
    for (const row of Object.values(snapshot.state.documentRelations ?? {})) {
      if (from ? !sameWorkVersion(from, row.fromVersion) : !sameDocumentVersion(to, row.toVersionRef)) continue;
      const candidate = candidateFor(row);
      if (!candidate || (workspaceRef && candidate.ref.contentHash !== workspaceRef.contentHash)) continue;
      const work = row.fromVersion;
      const commit = snapshot.commits[work.seq - 1];
      if (!locateRelationOwner(snapshot.commits, work)) continue;
      const part = ['evidence', 'audit'].includes(work.kind) ? work.kind : 'record';
      const documentRef = encodeReference(candidate.ref);
      const targetRef = from ? documentRef
        : encodeReference(baseReference(snapshot, commit, work.event, part, part === 'record' ? undefined : work.id));
      // Only the selected authorized edge is projected. In particular, do not
      // disclose a successor's ID or the underlying event/commit containing it.
      const { relationId, relationKind, fromVersion, toVersionRef, createdAt, closedAt } = row;
      yield { source, targetRef, candidate: from ? candidate : null, via: {
        from: source.ref, reason: exactReason, direction: from ? 'out' : 'in', basis: 'recorded',
        scope: 'explicit-version', targetWatermark: snapshot.seq, documentRef,
        relation: { relationId, relationKind, fromVersion, toVersionRef, createdAt, ...(closedAt ? { closedAt } : {}) },
      } };
    }
  }
}

// 用途：单次一跳并去重；模型可以用任意新查询继续联想，不设置累计轮数门禁。
export function relatedRecords(snapshot, sources, limit, visited = new Set(), { history = true, exactDocumentRelations = history, onAdmitted } = {}) {
  const bodyReads = { attempted: 0, available: 0, unavailable: 0 };
  if (!limit) return { related: [], unavailable: [], bodyReads, truncated: false };
  const related = [];
  const unavailable = [];
  const candidates = contentCandidates(snapshot);
  const anchors = sources.map(source => source.ref.startsWith('kb2.')
    ? { source, workspaceRef: decodeReference(source.ref, snapshot.projectId) }
    : { source, located: locateReference(snapshot, source.ref) });
  const full = () => related.length + unavailable.length >= limit;
  const bodyBudgetSpent = () => bodyReads.attempted >= LIMITS.bodyCount || bytes > LIMITS.bodyBatchBytes - MAX_DOC_BYTES;
  let truncated = false;
  let bytes = 0;
  if (exactDocumentRelations && snapshot.state.documentRelations) {
    const candidateFor = exactCandidateReader(snapshot, candidates, () => { truncated = true; });
    const seen = new Set();
    const observed = new Map();
    for (const { source, targetRef, candidate, via } of exactEdges(snapshot, anchors, candidateFor)) {
      // Different explicit edges to the same endpoint remain independently
      // verifiable, even if that endpoint is already one of the inputs.
      const identity = JSON.stringify([source.ref, via.relation.relationId]);
      if (seen.has(identity)) continue;
      if (full()) { truncated = true; break; }
      seen.add(identity);
      let target = observed.get(targetRef);
      if (!target) {
        if (candidate && bodyBudgetSpent()) { truncated = true; continue; }
        target = candidate ? observeCandidate(snapshot, candidate) : readRecord(snapshot, targetRef);
        observed.set(targetRef, target);
        if (candidate) {
          bodyReads.attempted++;
          if (target.availability === 'available') { bodyReads.available++; bytes += target.size; }
          else { bodyReads.unavailable++; bytes += MAX_DOC_BYTES; }
        }
      }
      if (!['available', 'legacy-git-record-only'].includes(target.availability)) {
        unavailable.push({ sourceRef: source.ref, targetRef, reason: via.reason, availability: target.availability, via });
        continue;
      }
      visited.add(target.ref);
      related.push({ source: { ...metadataOf(target), observedAt: target.observedAt, fragment: sourceExcerpt(target) }, via });
      onAdmitted?.(target);
    }
  }
  for (const { source, located } of anchors) {
    if (!located) continue; // kb2 content has no legacy log position.
    const edges = localEdges(snapshot, located);
    if (['record', 'evidence'].includes(located.ref.part)) edges.push(...bodyEdges(snapshot, candidates, located));
    for (const target of [...relationTargets(located.value), ...linkedDocuments(snapshot, source)]) {
      const ref = findTarget(snapshot, target);
      if (ref) edges.push({ ref, reason: target.reason, scope: target.version === undefined && target.revision === undefined ? 'target-at-read-watermark' : 'explicit-version' });
      else edges.push({ missing: target.entity, reason: target.reason });
    }
    if (history) edges.push(...historyEdges(snapshot, located));
    for (const edge of edges) {
      if (visited.has(edge.ref)) continue;
      if (full()) { truncated = true; continue; }
      if (edge.missing) { unavailable.push({ sourceRef: source.ref, targetEntity: edge.missing, reason: edge.reason, availability: 'target-unavailable' }); continue; }
      if (edge.candidate && bodyBudgetSpent()) { truncated = true; continue; }
      const target = edge.candidate ? observeCandidate(snapshot, edge.candidate) : readRecord(snapshot, edge.ref);
      if (edge.candidate) {
        bodyReads.attempted++;
        if (target.availability === 'available') { bodyReads.available++; bytes += target.size || 0; }
        else { bodyReads.unavailable++; bytes += MAX_DOC_BYTES; }
      }
      if (visited.has(target.ref)) continue;
      visited.add(target.ref);
      // 未取得完整 hash 的正文不产生可读引用；记录本身仍明确保留。
      if (target.kind === 'content' && !['available', 'legacy-git-record-only'].includes(target.availability)) {
        unavailable.push({ sourceRef: source.ref, reason: edge.reason, availability: target.availability });
        continue;
      }
      const sourceView = { ...metadataOf(target), observedAt: target.observedAt, fragment: sourceExcerpt(target) };
      related.push({ source: sourceView, via: { from: source.ref, reason: edge.reason,
        basis: 'recorded', scope: edge.scope, targetWatermark: snapshot.seq } });
      onAdmitted?.(target);
    }
  }
  return { related, unavailable, bodyReads, truncated };
}
