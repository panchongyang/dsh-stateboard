import { KNOWLEDGE_KINDS, KNOWLEDGE_LIMITS as LIMITS } from '../../shared/knowledge.js';
import { PROJECT_READ_ID_PATTERNS } from '../../shared/contract.js';
import { BoardError } from '../errors.js';
import { decodeReference, parseCursor } from './reference.js';
import { queryTerms } from './terms.js';

function invalid() { throw new BoardError('invalid-command', 'Invalid knowledge read arguments', { status: 400 }); }
function integer(value, low, high) { if (!Number.isSafeInteger(value) || value < low || value > high) invalid(); return value; }
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid();
}
function refs(value, project) {
  if (!Array.isArray(value) || value.length < 1 || value.length > LIMITS.refs) invalid();
  for (const reference of value) {
    const ref = decodeReference(reference, project);
    if (['inline', 'external', 'file', 'fixed'].includes(ref.part) && !ref.contentHash) invalid();
  }
  return [...new Set(value)];
}

// 用途：领域入口统一限制单次成本，不约束 Agent 的联想轮数、方向或累计跳数。
export function knowledgeRequest(mode, args) {
  const common = ['projectId', 'cursor', 'relatedLimit'];
  object(args, [...common, ...(mode === 'search' ? ['query', 'kinds', 'limit', 'discovery', 'historyRef'] : ['refs', 'mode', 'maxBytes'])]);
  if (typeof args.projectId !== 'string' || !new RegExp(PROJECT_READ_ID_PATTERNS.project).test(args.projectId)) invalid();
  const request = { ...args, relatedLimit: integer(args.relatedLimit ?? LIMITS.defaultRelated, 0, LIMITS.related) };
  if (args.cursor !== undefined) parseCursor(args.cursor);
  if (mode === 'search') return searchRequest(request);
  request.refs = refs(args.refs, args.projectId);
  request.mode = args.mode ?? 'source';
  if (!['source', 'context'].includes(request.mode) || (args.cursor && request.refs.length !== 1)) invalid();
  request.maxBytes = integer(args.maxBytes ?? LIMITS.bodyBytes, 4, LIMITS.bodyBytes);
  return request;
}

function searchRequest(request) {
  if (typeof request.query !== 'string' || !request.query.trim() || request.query.length > LIMITS.queryChars) invalid();
  queryTerms(request.query);
  if (request.historyRef !== undefined) refs([request.historyRef], request.projectId);
  request.limit = integer(request.limit ?? LIMITS.defaultResults, 1, LIMITS.results);
  request.kinds ??= [];
  if (!Array.isArray(request.kinds) || request.kinds.length > KNOWLEDGE_KINDS.length || request.kinds.some(kind => !KNOWLEDGE_KINDS.includes(kind))) invalid();
  request.kinds = [...new Set(request.kinds)].sort();
  if (request.discovery !== undefined) {
    object(request.discovery, ['parents', 'reason']);
    request.discovery = { parents: refs(request.discovery.parents, request.projectId), reason: request.discovery.reason };
    if (typeof request.discovery.reason !== 'string' || !request.discovery.reason.trim() || request.discovery.reason.length > 500) invalid();
  }
  return request;
}
