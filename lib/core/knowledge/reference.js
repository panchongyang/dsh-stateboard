import { KNOWLEDGE_LIMITS as LIMITS, KNOWLEDGE_VERSION } from '../../shared/knowledge.js';
import { BoardError } from '../errors.js';
import { canonicalJSON, sha256 } from '../util.js';

// 用途：产生与索引代无关的来源身份；引用不授予任何路径或项目权限。
export function encodeReference(value) {
  return 'kb1.' + Buffer.from(canonicalJSON({ v: KNOWLEDGE_VERSION, ...value })).toString('base64url');
}

export function invalidReference(message = 'Knowledge reference is invalid') {
  return new BoardError('knowledge-reference-invalid', message, { status: 400 });
}

// 用途：严格解析来源定位；所有实际数据仍须由日志重新解析核对。
export function decodeReference(text, projectId) {
  if (typeof text !== 'string' || text.length > LIMITS.refChars || !/^kb1\.[A-Za-z0-9_-]+$/.test(text)) throw invalidReference();
  let ref;
  try { ref = JSON.parse(Buffer.from(text.slice(4), 'base64url').toString('utf8')); } catch { throw invalidReference(); }
  const fields = ['v', 'projectId', 'seq', 'commitHash', 'event', 'part', 'item', 'contentHash'];
  if (!ref || typeof ref !== 'object' || Array.isArray(ref) || Object.keys(ref).some(key => !fields.includes(key))
    || ref.v !== KNOWLEDGE_VERSION || ref.projectId !== projectId || !Number.isSafeInteger(ref.seq) || ref.seq < 1
    || !Number.isSafeInteger(ref.event) || ref.event < 0 || !/^sha256:[a-f0-9]{64}$/.test(ref.commitHash)
    || !['record', 'evidence', 'audit', 'inline', 'external', 'fixed', 'file'].includes(ref.part)
    || (ref.item !== undefined && (typeof ref.item !== 'string' || !ref.item.length || ref.item.length > 256))
    || (ref.contentHash !== undefined && !/^[a-f0-9]{64}$/.test(ref.contentHash))) throw invalidReference();
  if (encodeReference(ref) !== text) throw invalidReference();
  return ref;
}

export function referenceId(ref) { return sha256(typeof ref === 'string' ? ref : encodeReference(ref)); }

// 用途：分页游标绑定请求与索引身份；它不是可执行查询或持久来源引用。
export function makeCursor(value) { return Buffer.from(canonicalJSON(value)).toString('base64url'); }

export function parseCursor(text) {
  if (typeof text !== 'string' || text.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(text)) throw invalidReference('Invalid knowledge cursor');
  try {
    const value = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value) || makeCursor(value) !== text) throw invalidReference();
    return value;
  }
  catch { throw invalidReference('Invalid knowledge cursor'); }
}

export function staleCursor() { return new BoardError('knowledge-cursor-stale', 'Knowledge changed; restart this query', { status: 409 }); }
