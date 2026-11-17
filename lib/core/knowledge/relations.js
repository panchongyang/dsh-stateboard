import { baseReference, eventEntity, locateReference, metadataOf, readRecord, sourceExcerpt } from './records.js';
import { encodeReference } from './reference.js';
import { contentCandidates, observeCandidate } from './content.js';
import { KNOWLEDGE_LIMITS as LIMITS } from '../../shared/knowledge.js';
import { MAX_DOC_BYTES } from '../documents/read.js';

function relationTargets(value) {
  const targets = [];
  for (const id of value.deps || []) targets.push({ entity: 'task:' + id, reason: 'task.deps' });
  if (value.planRef) targets.push({ entity: 'plan:' + value.planRef.planId, version: value.planRef.version, reason: 'task.planRef' });
  for (const step of value.steps || []) for (const id of step.taskIds || []) targets.push({ entity: 'task:' + id, reason: 'plan.steps.taskIds' });
  for (const id of value.links?.taskIds || []) targets.push({ entity: 'task:' + id, reason: 'document.links.taskIds' });
  for (const ref of value.links?.planRefs || []) targets.push({ entity: 'plan:' + ref.planId, version: ref.version, reason: 'document.links.planRefs' });
  if (value.kind === 'doc' && value.ref && !value.fixed) {
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
      if (eventEntity(commit.events[ei]) !== entity) continue;
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

function bodyEdges(candidates, located) {
  if (located.ref.part === 'evidence' && ((located.value.kind === 'file' && located.value.hash) || located.value.fixed)) {
    return [{ candidate: { origin: 'evidence:' + located.ref.item,
      ref: { ...located.ref, part: located.value.fixed ? 'fixed' : 'file' } }, reason: 'evidence.content', scope: 'source-version' }];
  }
  return candidates.filter(candidate => candidate.ref.seq === located.ref.seq && candidate.ref.event === located.ref.event
    && (located.ref.part === 'record' ? !candidate.ref.item : candidate.ref.item === located.ref.item))
    .map(candidate => ({ candidate, reason: 'source.content', scope: candidate.ref.part === 'external' ? 'current-observation' : 'source-version' }));
}

// 用途：单次一跳并去重；模型可以用任意新查询继续联想，不设置累计轮数门禁。
export function relatedRecords(snapshot, sources, limit, visited = new Set(), { history = true } = {}) {
  const bodyReads = { attempted: 0, available: 0, unavailable: 0 };
  if (!limit) return { related: [], unavailable: [], bodyReads, truncated: false };
  const related = [];
  const unavailable = [];
  const candidates = contentCandidates(snapshot);
  let truncated = false;
  let bytes = 0;
  for (const source of sources) {
    const located = locateReference(snapshot, source.ref);
    const edges = localEdges(snapshot, located);
    if (['record', 'evidence'].includes(located.ref.part)) edges.push(...bodyEdges(candidates, located));
    for (const target of [...relationTargets(located.value), ...linkedDocuments(snapshot, source)]) {
      const ref = findTarget(snapshot, target);
      if (ref) edges.push({ ref, reason: target.reason, scope: target.version === undefined && target.revision === undefined ? 'target-at-read-watermark' : 'explicit-version' });
      else edges.push({ missing: target.entity, reason: target.reason });
    }
    if (history) edges.push(...historyEdges(snapshot, located));
    for (const edge of edges) {
      if (visited.has(edge.ref)) continue;
      if (related.length + unavailable.length >= limit) { truncated = true; continue; }
      if (edge.missing) { unavailable.push({ sourceRef: source.ref, targetEntity: edge.missing, reason: edge.reason, availability: 'target-unavailable' }); continue; }
      if (edge.candidate && bytes > LIMITS.bodyBatchBytes - MAX_DOC_BYTES) { truncated = true; continue; }
      const target = edge.candidate ? observeCandidate(snapshot, edge.candidate) : readRecord(snapshot, edge.ref);
      if (visited.has(target.ref)) continue;
      visited.add(target.ref);
      bytes += edge.candidate ? target.size || 0 : 0;
      if (edge.candidate) bodyReads.attempted++;
      // 未取得完整 hash 的正文不产生可读引用；记录本身仍明确保留。
      if (target.kind === 'content' && target.availability !== 'available') {
        bodyReads.unavailable++;
        unavailable.push({ sourceRef: source.ref, reason: edge.reason, availability: target.availability });
        continue;
      }
      if (edge.candidate) bodyReads.available++;
      const sourceView = { ...metadataOf(target), observedAt: target.observedAt, fragment: sourceExcerpt(target) };
      related.push({ source: sourceView, via: { from: source.ref, reason: edge.reason,
        basis: 'recorded', scope: edge.scope, targetWatermark: snapshot.seq } });
    }
  }
  return { related, unavailable, bodyReads, truncated };
}
