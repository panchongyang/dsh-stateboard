// 在单一索引代内检索、折叠和交付有界片段；源引用仍由权威日志验证。
import { KNOWLEDGE_LIMITS as LIMITS } from '../../shared/knowledge.js';
import { canonicalJSON, sha256 } from '../util.js';
import { sourceExcerpt, locateReference, searchGroup } from './records.js';
import { makeCursor, parseCursor, staleCursor } from './reference.js';
import { queryTerms, relaxedQuery, scanMatcher } from './terms.js';
import { currentIndexState, updateIndex, scanBatch } from './build.js';
import { relatedRecords } from './relations.js';
import { boundedResponse, coverage, resolveSource } from './read.js';

// 查询、类型与历史来源共同决定游标归属；页大小只控制本次交付。
function queryKey({ projectId, query, kinds, historyRef }) {
  return sha256(canonicalJSON({ projectId, query, kinds, historyRef: historyRef ?? null }));
}

// 解析该查询的页游标，并核对已验证日志水位。
function cursorFor(args, snapshot) {
  if (!args.cursor) return null;
  const cursor = parseCursor(args.cursor);
  if (cursor.type !== 'search' || cursor.key !== queryKey(args) || cursor.hash !== snapshot.hash
    || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw staleCursor();
  return cursor;
}

// 扫描当前窗口，按最佳相关性排列实体组，保留每组最新匹配记录。
function rankedScan(records, args, historyGroup, relaxed) {
  const match = scanMatcher(args.query, relaxed);
  const candidates = [];
  for (const source of records) {
    if (args.kinds.length && !args.kinds.includes(source.kind)) continue;
    const group = searchGroup(source, args.projectId);
    if (historyGroup && historyGroup !== group) continue;
    const matched = match(source);
    if (matched) candidates.push({ ...source, ...matched, group, historyCount: 1 });
  }
  candidates.sort((a, b) => b.groupMatches - a.groupMatches || b.score - a.score
    || b.seq - a.seq || b.event - a.event || a.id.localeCompare(b.id));
  if (historyGroup) return candidates;
  const groups = new Map();
  for (const row of candidates) {
    const first = groups.get(row.group);
    if (!first) { groups.set(row.group, row); continue; }
    const newer = row.seq > first.seq || (row.seq === first.seq && row.event > first.event);
    groups.set(row.group, { ...(newer ? row : first), historyCount: first.historyCount + 1 });
  }
  return [...groups.values()];
}

// SQLite 降级时依据续页位置读有界窗口，校验窗口结果代后再取页。
function scanQuery(snapshot, args, cursor, options, historyGroup) {
  if (cursor && cursor.engine !== 'scan') throw staleCursor();
  const batch = scanBatch(snapshot, cursor?.start, options);
  let rows = rankedScan(batch.records, args, historyGroup, null);
  const relaxed = rows.length ? null : relaxedQuery(args.query);
  if (relaxed) rows = rankedScan(batch.records, args, historyGroup, relaxed);
  const generation = sha256(canonicalJSON(rows.map(row => [row.id, row.contentHash, row.historyCount, row.groupMask ?? null])));
  if (cursor?.generation && cursor.generation !== generation) throw staleCursor();
  const offset = cursor?.offset ?? 0;
  return { ...batch, generation, rows: rows.slice(offset, offset + args.limit + 1), relaxed, engine: 'scan', offset };
}

// 首次搜索推进派生索引；续页只读游标所指的索引代。
function ftsQuery(index, snapshot, args, cursor, options, historyGroup) {
  if (cursor && cursor.engine !== 'fts5') throw staleCursor();
  const updated = cursor ? null : updateIndex(index, snapshot, options);
  // 水位、正文观测和查询结果使用同一 SQLite 读事务。
  index.beginRead();
  try {
    const state = currentIndexState(index, snapshot, updated?.bodies.refreshed);
    if (!state || (cursor && cursor.generation !== state.generation)) throw staleCursor();
    const offset = cursor?.offset ?? 0;
    const execute = relaxed => index.search(args.query, args.kinds, args.limit + 1, offset, { historyGroup, relaxed });
    let relaxed = cursor?.queryMatch === 'relaxed' ? relaxedQuery(args.query) : null;
    if (cursor?.queryMatch === 'relaxed' && !relaxed) throw staleCursor();
    let rows = execute(relaxed);
    if (!cursor && !rows.length) {
      relaxed = relaxedQuery(args.query);
      if (relaxed) rows = execute(relaxed);
    }
    index.commit();
    return { ...state, rows, relaxed, engine: 'fts5', offset, start: null, next: null };
  } catch (error) { index.rollback(); throw error; }
}

// 从权威来源回读索引命中；派生索引身份不符时由 worker 降级。
function indexedSource(snapshot, ref) {
  try { return resolveSource(snapshot, ref); }
  catch (error) {
    if (error.code === 'knowledge-reference-invalid') throw new Error('Derived index source identity mismatch');
    throw error;
  }
}

// 按已消耗的行数生成下一页游标；降级扫描还可推进到后继窗口。
function nextCursor(args, snapshot, state, consumed) {
  const base = { type: 'search', key: queryKey(args), hash: snapshot.hash, engine: state.engine };
  if (consumed < state.rows.length) return makeCursor({ ...base, generation: state.generation,
    offset: state.offset + consumed, start: state.start, queryMatch: state.relaxed ? 'relaxed' : 'exact' });
  if (state.next) return makeCursor({ ...base, offset: 0, start: state.next });
  return null;
}

// 保留 Agent 选取来源所需的原文及版本身份，完整校验字段由 read 提供。
function searchSource(source, needles) {
  const { ref, kind, title, entity, seq, eventType, version, revision, state, availability } = source;
  const fragment = source.fragment ?? sourceExcerpt(source, needles);
  return { ref, kind, title, entity, seq, eventType, version, revision, state, availability, fragment,
    ...(source.observedAt ? { observedAt: source.observedAt } : {}) };
}

// 根据本行的词组掩码列出放宽命中的词组及缺项。
function keywordHit(row, source, needles, relaxed) {
  const matchedGroups = relaxed?.groups.filter((_, i) => row.groupMask & (1 << i));
  return { ...searchSource(source, matchedGroups ?? needles), score: row.score, historyCount: row.historyCount,
    match: relaxed ? 'keyword-relaxed' : 'keyword',
    ...(relaxed ? { matchedGroups, missingGroups: relaxed.groups.filter(group => !matchedGroups.includes(group)) } : {}) };
}

// 先从保证交付的命中展开关联，再用剩余名额补充直接命中。
function selectPage(snapshot, args, state) {
  const guaranteed = args.limit - Math.min(args.relatedLimit, Math.floor(args.limit / 2));
  const sourceFor = row => state.engine === 'fts5' ? indexedSource(snapshot, row.ref) : row;
  const anchors = state.rows.slice(0, guaranteed).map(sourceFor);
  const expansion = relatedRecords(snapshot, anchors, Math.min(args.relatedLimit, args.limit - anchors.length),
    new Set(anchors.map(source => source.ref)), { history: false });
  const relatedRefs = new Set(expansion.related.map(({ source }) => source.ref));
  const maximum = args.limit - expansion.related.length - expansion.unavailable.length;
  const needles = queryTerms(args.query).sort((a, b) => b.length - a.length);
  const hits = [];
  let consumed = 0;
  for (const row of state.rows) {
    if (hits.length >= maximum) break;
    const index = consumed++;
    if (relatedRefs.has(row.ref)) continue;
    hits.push(keywordHit(row, anchors[index] ?? sourceFor(row), needles, state.relaxed));
  }
  const related = expansion.related.map(({ source, via }) => ({ ...searchSource(source, []), match: 'relation',
    via: { reason: via.reason, scope: via.scope, basis: via.basis, targetWatermark: via.targetWatermark,
      fromHit: anchors.findIndex(anchor => anchor.ref === via.from) } }));
  return { hits, related, expansion, consumed };
}

// 使用已验证的快照和传入预算完成一次搜索，结果不改变项目权威数据。
export function searchKnowledge(index, snapshot, args, options = {}) {
  for (const parent of args.discovery?.parents || []) locateReference(snapshot, parent);
  const cursor = cursorFor(args, snapshot);
  const historyGroup = args.historyRef ? searchGroup(resolveSource(snapshot, args.historyRef), snapshot.projectId) : undefined;
  const state = index.engine === 'fts5' ? ftsQuery(index, snapshot, args, cursor, options, historyGroup)
    : scanQuery(snapshot, args, cursor, options, historyGroup);
  const { hits, related, expansion, consumed } = selectPage(snapshot, args, state);
  const ranking = state.relaxed ? 'keyword-group-coverage' : state.engine === 'fts5' ? 'bm25' : 'keyword-overlap';
  return boundedResponse({ projectId: snapshot.projectId, query: args.query, engine: state.engine, ranking,
    queryMatch: state.relaxed ? 'relaxed' : 'exact', degradedReason: index.reason || null,
    hits, related, relatedUnavailable: expansion.unavailable, relatedTruncated: expansion.truncated,
    nextCursor: nextCursor(args, snapshot, state, consumed),
    coverage: { ...coverage(snapshot, state.indexed, state.bodies), relatedBodies: expansion.bodyReads,
      scanWindow: state.engine === 'scan' ? { start: state.start, next: state.next } : null },
    discovery: args.discovery ? { ...args.discovery, basis: 'caller-suggested', persisted: false } : null,
    interpretation: 'relevance-is-not-authority-or-validity' });
}
