import { KNOWLEDGE_LIMITS as LIMITS } from '../../shared/knowledge.js';
import { BoardError } from '../errors.js';
import { readRecord, metadataOf } from './records.js';
import { readContent } from './content.js';
import { decodeReference, makeCursor, parseCursor, staleCursor } from './reference.js';
import { relatedRecords } from './relations.js';

export function resolveSource(snapshot, reference) {
  const ref = decodeReference(reference, snapshot.projectId);
  return ['record', 'evidence', 'audit'].includes(ref.part) ? readRecord(snapshot, reference) : readContent(snapshot, reference);
}

export function coverage(snapshot, indexed = null, bodies = null) {
  return { scope: 'retained-project-materials', log: { verifiedThrough: snapshot.seq, verifiedHash: snapshot.hash,
    indexedThrough: indexed?.seq ?? null, indexedHash: indexed?.hash ?? null,
    lag: indexed ? snapshot.seq - indexed.seq : null, ...snapshot.logBoundary }, bodies,
    completeness: 'relative-to-listed-sources', absenceMeansNoConstraint: false };
}

// 用途：按 UTF-8 边界分块，游标绑定完整正文 hash；不会把新文件接在旧分页后面。
function chunk(source, maxBytes, cursor) {
  const bytes = typeof source.text === 'string' ? Buffer.from(source.text) : null;
  let offset = 0;
  if (cursor) {
    const value = parseCursor(cursor);
    if (value.type !== 'body' || value.ref !== source.ref || value.hash !== source.contentHash
      || !Number.isSafeInteger(value.offset) || value.offset < 0 || !bytes || value.offset >= bytes.length
      || (bytes[value.offset] & 0xc0) === 0x80) throw staleCursor();
    offset = value.offset;
  }
  let end = bytes ? Math.min(bytes.length, offset + maxBytes) : 0;
  while (bytes && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  const truncated = !!bytes && end < bytes.length;
  return { ...metadataOf(source), observedAt: source.observedAt ?? null,
    content: bytes ? bytes.subarray(offset, end).toString('utf8') : null,
    format: source.kind === 'content' ? 'text' : 'public-record-json',
    range: { offset, end, totalBytes: bytes?.length ?? null, truncated, internalFieldsOmitted: source.kind !== 'content' },
    nextCursor: truncated ? makeCursor({ type: 'body', ref: source.ref, hash: source.contentHash, offset: end }) : null };
}

export function boundedResponse(value) {
  if (Buffer.byteLength(JSON.stringify(value)) > LIMITS.responseBytes) {
    throw new BoardError('knowledge-response-limit', 'Knowledge response exceeds the budget; request fewer sources or a smaller body chunk', { status: 413 });
  }
  return value;
}

// 用途：精确原文读取独立于索引；权限、身份、内容变化均在当前来源重新核对。
export function readKnowledge(snapshot, args) {
  const sources = [], records = [];
  for (const reference of args.refs) {
    const source = resolveSource(snapshot, reference);
    records.push(chunk(source, args.maxBytes, args.cursor));
    sources.push(metadataOf(source));
  }
  const expansion = relatedRecords(snapshot, sources, args.mode === 'context' ? args.relatedLimit : 0, new Set(args.refs));
  const related = expansion.related.map(({ source, via }) => ({ ...metadataOf(source), via, observedAt: source.observedAt ?? null }));
  return boundedResponse({ projectId: snapshot.projectId, records, related, relatedUnavailable: expansion.unavailable, relatedTruncated: expansion.truncated,
    coverage: { ...coverage(snapshot), relatedBodies: expansion.bodyReads }, interpretation: 'source-records; authority-and-applicability-not-inferred' });
}
