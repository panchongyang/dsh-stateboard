import { KNOWLEDGE_LIMITS as LIMITS } from '../../shared/knowledge.js';
import { BoardError } from '../errors.js';

const normalize = text => String(text).normalize('NFKC').toLowerCase();
const tokens = text => normalize(text).match(/[\p{L}\p{N}_./:@-]+/gu) ?? [];

// 用途：统一词法输入；保留接口完整标识，中文使用单字/双字组合覆盖短词，无模型推断。
export function terms(text) {
  const out = new Set();
  for (const token of tokens(text)) {
    for (const [word] of token.matchAll(/[\p{Script=Han}]+|[^\p{Script=Han}]+/gu)) {
      if (/[\p{Script=Han}]/u.test(word)) {
        let previous = '';
        for (const char of word) {
          out.add(char);
          if (previous) out.add(previous + char);
          previous = char;
        }
      } else {
        out.add(word);
        for (const part of word.split(/[_.\/:@-]+/).filter(Boolean)) out.add(part);
      }
    }
  }
  return [...out];
}

export function queryTerms(query) {
  const selected = terms(query);
  if (!selected.length || selected.length > LIMITS.queryTerms) {
    throw new BoardError('invalid-command', 'Knowledge query has no searchable terms or exceeds the term budget', { status: 400 });
  }
  return selected;
}

// 编码为原子 ASCII 词项，避免 SQLite 再拆开 restore_context/error-code 而扩大命中。
const ftsTerm = word => 't' + Buffer.from(word).toString('hex');
export function ftsText(text) { return terms(text).map(ftsTerm).join(' '); }
export function ftsQuery(query) { return queryTerms(query).map(word => '"' + ftsTerm(word) + '"').join(' AND '); }

// 从查询取显式词组；连续短中文可放宽跨词双字。
export function relaxedQuery(query) {
  let groups = [...new Set(tokens(query).filter(word => /[\p{L}\p{N}]/u.test(word)))];
  if (groups.length === 1 && /^\p{Script=Han}{4,7}$/u.test(groups[0])) {
    const chars = [...groups[0]];
    groups = [...new Set(chars.slice(1).map((char, i) => chars[i] + char))];
  }
  if (groups.length < 3 || groups.length > LIMITS.queryGroups) return null;
  return { groups, minimum: Math.floor(groups.length / 2) + 1 };
}

// 预编译查询词组，返回供有界扫描复用的计分和词组掩码计算函数。
export function scanMatcher(query, relaxed) {
  const required = queryTerms(query);
  const groups = relaxed?.groups.map(queryTerms);
  return source => {
    const body = new Set(terms(source.text || '')), title = new Set(terms(source.title));
    const has = word => body.has(word) || title.has(word);
    const matching = groups?.map(words => words.every(has));
    const groupMatches = matching?.filter(Boolean).length ?? 0;
    if (relaxed ? groupMatches < relaxed.minimum : !required.every(has)) return null;
    const score = required.reduce((total, word) => total + (title.has(word) ? 3 : body.has(word) ? 1 : 0), 0);
    const groupMask = matching?.reduce((mask, yes, i) => yes ? mask | (1 << i) : mask, 0);
    return { score, groupMask, groupMatches };
  };
}

// 用途：返回原文窗口，仍可沿引用读取完整记录；不生成自然语言摘要。
export function snippet(text, needles = [], length = LIMITS.snippetChars) {
  if (typeof text !== 'string') return null;
  if (!needles.length) return Array.from(text.slice(0, length * 2)).slice(0, length).join('');
  const lower = text.toLowerCase();
  const position = needles.map(word => lower.indexOf(word)).find(index => index >= 0);
  let start = Math.max(0, (position ?? 0) - 40);
  if (/^[\uDC00-\uDFFF]/u.test(text.slice(start, start + 1))) start--;
  return Array.from(text.slice(start, start + length * 2)).slice(0, length).join('');
}
