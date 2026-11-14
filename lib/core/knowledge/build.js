import { KNOWLEDGE_LIMITS as LIMITS } from '../../shared/knowledge.js';
import { BoardError } from '../errors.js';
import { canonicalJSON, sha256 } from '../util.js';
import { commitMaterials } from './records.js';
import { contentCandidates, observeCandidate } from './content.js';
import { MAX_DOC_BYTES } from '../documents/read.js';
import { encodeReference } from './reference.js';

// 核对缓存头是否属于本次已验证的日志前缀。
function validHead(head, snapshot) {
  return Number.isSafeInteger(head?.seq) && head.seq >= 0
    && (head.seq === 0 ? head.hash === null : snapshot.commits[head.seq - 1]?.hash === head.hash);
}

// 在调用者的索引读事务中取一致的覆盖状态；refreshed 是本请求尝试观测的数量。
export function currentIndexState(index, snapshot, refreshed = 0) {
  const indexed = index.get('head');
  if (!index.compatible() || !validHead(indexed, snapshot)) return null;
  const generation = index.get('generation');
  const sweep = index.get('bodySweep');
  if (typeof generation !== 'string' || !sweep?.states) throw new Error('Incomplete knowledge index state');
  return { indexed, generation, bodies: bodyCoverage(sweep.known ?? contentCandidates(snapshot).length, sweep.states, refreshed) };
}

// 用途：整批 commit 前进，不能在同一提交的证据/事件之间发布不完整水位。
export function recordBatch(snapshot, after, budget = LIMITS.recordCount) {
  const records = [];
  let through = after;
  for (const commit of snapshot.commits.slice(after)) {
    const batch = [...commitMaterials(snapshot, commit)];
    if (batch.length > budget) throw new BoardError('knowledge-resource-limit', 'One commit exceeds the knowledge record budget', { status: 503 });
    if (records.length + batch.length > budget) break;
    records.push(...batch);
    through = commit.seq;
  }
  return { records, through };
}

function observeBodies(snapshot, candidates, offset, options) {
  const observations = [];
  let bytes = 0;
  for (const candidate of candidates.slice(offset)) {
    if (observations.length >= (options.bodyCount ?? LIMITS.bodyCount) || bytes > LIMITS.bodyBatchBytes - MAX_DOC_BYTES) break;
    const source = observeCandidate(snapshot, candidate);
    observations.push(source);
    bytes += source.size || 0;
  }
  return observations;
}

// 用途：派生事务同时发布来源、轮询位置和水位；正文只有词项，没有归档副本。
export function updateIndex(index, snapshot, options = {}) {
  index.begin();
  try {
    const head = index.get('head');
    if (!index.compatible() || !validHead(head, snapshot)) index.reset();
    const previous = index.get('head') || { seq: 0, hash: null };
    const batch = recordBatch(snapshot, previous.seq, options.recordCount);
    let changed = batch.through !== previous.seq;
    for (const record of batch.records) changed = index.put(record) || changed;
    const bodies = updateBodies(index, snapshot, options);
    changed = bodies.changed || changed;
    const next = { seq: batch.through, hash: snapshot.commits[batch.through - 1]?.hash || null };
    index.set('head', next);
    if (changed) index.publish();
    const state = { indexed: next, bodies: bodies.coverage, generation: index.get('generation') };
    index.commit();
    return state;
  } catch (error) { index.rollback(); throw error; }
}

function updateBodies(index, snapshot, options) {
  const candidates = contentCandidates(snapshot);
  const origins = new Set(candidates.map(row => row.origin));
  let changed = false;
  for (const origin of index.origins()) if (!origins.has(origin)) changed = index.remove(origin) || changed;
  const signature = sha256(canonicalJSON(candidates));
  const sweep = index.get('bodySweep');
  const offset = sweep?.signature === signature && sweep.offset < candidates.length ? sweep.offset : 0;
  const observed = observeBodies(snapshot, candidates, offset, options);
  const states = sweep?.signature === signature ? sweep.states : {};
  for (const source of observed) {
    const old = index.byOrigin(source.origin);
    if (old.some(row => row.id !== source.id) || source.availability !== 'available') changed = index.remove(source.origin) || changed;
    if (source.availability === 'available') changed = index.put(source) || changed;
    const ref = candidates.find(candidate => candidate.origin === source.origin).ref;
    states[source.origin] = { availability: source.availability, contentHash: source.contentHash, observedAt: source.observedAt,
      sourceRef: encodeReference({ projectId: ref.projectId, seq: ref.seq, commitHash: ref.commitHash, event: ref.event, part: 'record' }) };
  }
  index.set('bodySweep', { signature, offset: offset + observed.length, states, known: candidates.length });
  return { changed, coverage: bodyCoverage(candidates.length, states, observed.length) };
}

function bodyCoverage(known, states, refreshed) {
  const rows = Object.values(states);
  const unavailable = rows.filter(row => row.availability !== 'available');
  const reasons = {};
  for (const row of unavailable) reasons[row.availability] = (reasons[row.availability] || 0) + 1;
  return { known, observed: rows.length, deferred: known - rows.length, refreshed,
    availableAtObservation: rows.filter(row => row.availability === 'available').length,
    unavailable: unavailable.length, unavailableReasons: reasons,
    unavailableExamples: unavailable.slice(0, LIMITS.refs).map(row => ({ ref: row.sourceRef ?? null, availability: row.availability })),
    oldestObservation: rows.map(row => row.observedAt).sort()[0] || null,
    atomicWithLog: false, archived: false };
}

// 用途：无 SQLite 时按可续读的日志/正文窗口扫描，零命中不隐藏尚未遍历的窗口。
export function scanBatch(snapshot, position = {}, options = {}) {
  const candidates = contentCandidates(snapshot);
  if (!Number.isSafeInteger(position.seq ?? 0) || (position.seq ?? 0) < 0 || (position.seq ?? 0) > snapshot.seq
    || !Number.isSafeInteger(position.body ?? 0) || (position.body ?? 0) < 0 || (position.body ?? 0) > candidates.length) {
    throw new BoardError('knowledge-cursor-stale', 'Knowledge scan position is invalid; restart this query', { status: 409 });
  }
  const batch = recordBatch(snapshot, position.seq || 0, options.recordCount);
  const offset = position.body || 0;
  const observed = observeBodies(snapshot, candidates, offset, options);
  const records = [...batch.records, ...observed.filter(row => row.availability === 'available')];
  const states = Object.fromEntries(observed.map(row => [row.origin, row]));
  return { records, indexed: { seq: batch.through, hash: snapshot.commits[batch.through - 1]?.hash || null },
    bodies: bodyCoverage(candidates.length, states, observed.length),
    start: { seq: position.seq || 0, body: offset },
    next: batch.through < snapshot.seq || offset + observed.length < candidates.length
      ? { seq: batch.through, body: offset + observed.length } : null };
}
