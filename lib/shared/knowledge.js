// 知识读取的公开边界；没有运行时依赖，不包含领域判断。
export const KNOWLEDGE_VERSION = 1;
export const KNOWLEDGE_TOOLS = Object.freeze({ search: 'search_project_knowledge', read: 'read_project_knowledge' });
export const KNOWLEDGE_KINDS = Object.freeze(['event', 'task', 'plan', 'document', 'evidence', 'audit', 'session', 'content']);
export const KNOWLEDGE_LIMITS = Object.freeze({
  queryChars: 500, queryTerms: 64, results: 50, defaultResults: 20,
  refs: 8, related: 20, defaultRelated: 10, refChars: 4096,
  bodyBytes: 24 * 1024, responseBytes: 256 * 1024, snippetChars: 360, queryGroups: 6,
  timeoutMs: 30_000, logBytes: 64 * 1024 * 1024,
  bodyCount: 32, bodyBatchBytes: 32 * 1024 * 1024, recordCount: 4000,
});

const object = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const reference = { type: 'string', minLength: 5, maxLength: KNOWLEDGE_LIMITS.refChars };
const refs = { type: 'array', items: reference, minItems: 1, maxItems: KNOWLEDGE_LIMITS.refs };
const common = { cursor: { type: 'string', maxLength: 8192 }, relatedLimit: integer(0, KNOWLEDGE_LIMITS.related) };

// 两个宿主入口共用业务描述与 JSON Schema；身份凭据只由适配器追加。
export const KNOWLEDGE_INPUTS = Object.freeze({
  search: object({ ...common, query: { type: 'string', minLength: 1, maxLength: KNOWLEDGE_LIMITS.queryChars },
    kinds: { type: 'array', items: { type: 'string', enum: KNOWLEDGE_KINDS } }, limit: integer(1, KNOWLEDGE_LIMITS.results), historyRef: reference,
    discovery: object({ parents: refs, reason: { type: 'string', minLength: 1, maxLength: 500 } }, ['parents', 'reason']),
  }, ['query']),
  read: object({ ...common, refs, mode: { type: 'string', enum: ['source', 'context'] }, maxBytes: integer(4, KNOWLEDGE_LIMITS.bodyBytes) }, ['refs']),
});
export const KNOWLEDGE_DESCRIPTIONS = Object.freeze({
  search: 'Search retained project knowledge. Results show original excerpts and references. Open a result with read, or pass its ref as historyRef with the same query to see matching versions. Exact matches take priority; a zero-hit range can return labeled partial keyword matches. Inspect coverage and use keywords separated by spaces. No task lease is required.',
  read: 'Read original retained records or observed content by stable knowledge reference. Optional context adds one hop of recorded relations; choose references or search again to explore further. Changed or unavailable content is explicit. References grant no additional access. No task lease is required.',
});
