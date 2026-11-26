import { KNOWLEDGE_LIMITS as LIMITS } from '../../shared/knowledge.js';
import { BoardError } from '../errors.js';
import { canonicalJSON, sha256 } from '../util.js';
import { commitMaterials } from './records.js';
import { contentCandidates, observeCandidate } from './content.js';
import { MAX_DOC_BYTES } from '../documents/read.js';
import { encodeReference } from './reference.js';
import { isWorkspaceOrigin, prepareWorkspaceBatch, prepareWorkspaceScan } from './workspace-index.js';

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
  return { indexed, generation, bodies: bodyCoverage(sweep.known ?? contentCandidates(snapshot).length, sweep.states, refreshed),
    workspace: index.get('workspaceSweep')?.coverage ?? null };
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

function bodyQuota(options) {
  let count = 0, bytes = 0;
  const countCap = Math.min(LIMITS.bodyCount, Math.max(1, options.bodyCount ?? LIMITS.bodyCount));
  return {
    ready: () => count < countCap && bytes <= LIMITS.bodyBatchBytes - MAX_DOC_BYTES,
    read(observe) {
      count++;
      let source;
      try { return source = observe(); }
      finally {
        // A failed or corrupt read may already have consumed one full object.
        const size = source?.size;
        bytes += source?.availability === 'available' && Number.isSafeInteger(size) && size >= 0 && size <= MAX_DOC_BYTES
          ? size : MAX_DOC_BYTES;
      }
    },
  };
}

function drainBodies(start, options, lanes) {
  const quota = bodyQuota(options);
  let next = Number.isInteger(start) && start >= 0 && start < lanes.length ? start : 0;
  while (quota.ready()) {
    let attempted = false;
    for (let i = 0; i < lanes.length; i++) {
      const lane = (next + i) % lanes.length;
      if (lanes[lane]?.(quota)) { next = (lane + 1) % lanes.length; attempted = true; break; }
    }
    if (!attempted) break;
  }
  return next;
}

function prepareBodies(snapshot, candidates, offset) {
  const observed = [];
  return { observed, tryNext(quota) {
    const candidate = candidates[offset + observed.length];
    if (!candidate) return false;
    observed.push(quota.read(() => observeCandidate(snapshot, candidate)));
    return true;
  } };
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
    const legacy = prepareIndexedBodies(index, snapshot);
    const projected = prepareWorkspaceBatch(index, snapshot);
    const nextLane = drainBodies(index.get('bodyLane'), options, [legacy.tryNext, projected?.tryRetained, projected?.tryCurrent]);
    index.set('bodyLane', nextLane);
    const bodies = legacy.finish();
    const workspace = projected?.finish() ?? { changed: false, workspace: null };
    changed = bodies.changed || workspace.changed || changed;
    const next = { seq: batch.through, hash: snapshot.commits[batch.through - 1]?.hash || null };
    index.set('head', next);
    if (changed) index.publish();
    const state = { indexed: next, bodies: bodies.coverage, workspace: workspace.workspace, generation: index.get('generation') };
    index.commit();
    return state;
  } catch (error) { index.rollback(); throw error; }
}

function prepareIndexedBodies(index, snapshot) {
  const candidates = contentCandidates(snapshot);
  const origins = new Set(candidates.map(row => row.origin));
  let changed = false;
  for (const origin of index.origins()) if (!isWorkspaceOrigin(origin) && !origins.has(origin)) changed = index.remove(origin) || changed;
  const signature = sha256(canonicalJSON(candidates));
  const sweep = index.get('bodySweep');
  const offset = sweep?.signature === signature && sweep.offset < candidates.length ? sweep.offset : 0;
  const { observed, tryNext } = prepareBodies(snapshot, candidates, offset);
  return { tryNext, finish() {
    const states = sweep?.signature === signature ? sweep.states : {};
    for (const [i, source] of observed.entries()) {
      const old = index.byOrigin(source.origin);
      if (old.some(row => row.id !== source.id) || source.availability !== 'available') changed = index.remove(source.origin) || changed;
      if (source.availability === 'available') changed = index.put(source) || changed;
      const ref = candidates[offset + i].ref;
      states[source.origin] = { availability: source.availability, contentHash: source.contentHash, observedAt: source.observedAt,
        sourceRef: encodeReference({ projectId: ref.projectId, seq: ref.seq, commitHash: ref.commitHash, event: ref.event, part: 'record' }) };
    }
    index.set('bodySweep', { signature, offset: offset + observed.length, states, known: candidates.length });
    return { changed, coverage: bodyCoverage(candidates.length, states, observed.length) };
  } };
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
  const workspaceBody = position.workspaceBody ?? 0;
  if (!Number.isSafeInteger(workspaceBody) || workspaceBody < 0 || (snapshot.workspace && workspaceBody > (snapshot.state.counters.workspaceVersionSeq ?? 0))
    || !Number.isSafeInteger(position.workspaceCurrent ?? 0) || (position.workspaceCurrent ?? 0) < 0
    || (position.workspacePage !== undefined && (typeof position.workspacePage !== 'string' || !/^[a-f0-9]{64}$/.test(position.workspacePage)))
    || !Number.isSafeInteger(position.seq ?? 0) || (position.seq ?? 0) < 0 || (position.seq ?? 0) > snapshot.seq
    || !Number.isSafeInteger(position.body ?? 0) || (position.body ?? 0) < 0 || (position.body ?? 0) > candidates.length) {
    throw new BoardError('knowledge-cursor-stale', 'Knowledge scan position is invalid; restart this query', { status: 409 });
  }
  const batch = recordBatch(snapshot, position.seq || 0, options.recordCount);
  const offset = position.body || 0;
  const legacy = prepareBodies(snapshot, candidates, offset);
  const projected = prepareWorkspaceScan(snapshot, position);
  const nextLane = drainBodies(position.bodyLane, options, [legacy.tryNext, projected?.tryRetained, projected?.tryCurrent]);
  const { observed } = legacy;
  const workspace = projected?.finish();
  const records = [...batch.records, ...observed.filter(row => row.availability === 'available'), ...(workspace?.rows ?? [])];
  const states = Object.fromEntries(observed.map(row => [row.origin, row]));
  return { records, indexed: { seq: batch.through, hash: snapshot.commits[batch.through - 1]?.hash || null },
    bodies: bodyCoverage(candidates.length, states, observed.length),
    workspace: workspace?.coverage ?? null,
    start: { seq: position.seq || 0, body: offset, ...(workspace ? { ...workspace.start, bodyLane: position.bodyLane ?? 0 } : {}) },
    next: batch.through < snapshot.seq || offset + observed.length < candidates.length || workspace?.pending
      ? { seq: batch.through, body: offset + observed.length, ...(workspace ? { ...workspace.next, bodyLane: nextLane } : {}) } : null };
}
