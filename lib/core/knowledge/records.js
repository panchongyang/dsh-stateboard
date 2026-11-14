import { sha256 } from '../util.js';
import { KNOWLEDGE_LIMITS as LIMITS } from '../../shared/knowledge.js';
import { snippet } from './terms.js';
import { encodeReference, decodeReference, referenceId, invalidReference } from './reference.js';

const HIDDEN = new Set(['fencingToken', 'token', 'sessionToken', 'mcpRenewals', 'workspacePath', 'root', 'gitContentRepository', 'owner', 'lease']);
const FAMILIES = new Set(['task', 'plan', 'doc', 'session', 'project', 'work', 'override', 'lease']);

// 用途：返回已有读取边界内的原始字段，不泄露内部凭据、绑定根或绝对文件引用。
export function publicRecord(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (HIDDEN.has(key)) return undefined;
    if (key === 'ref' && typeof item === 'string' && /^(?:[A-Za-z]:[\\/]|[\\/])/.test(item)) return null;
    return item;
  }));
}

export function baseReference(snapshot, commit, event, part = 'record', item) {
  return { projectId: snapshot.projectId, seq: commit.seq, commitHash: commit.hash, event, part, ...(item ? { item } : {}) };
}

export function eventEntity(event) {
  if (event.taskId) return 'task:' + event.taskId;
  if (event.docId) return 'doc:' + event.docId;
  const family = event.type.split('/')[0];
  if (!FAMILIES.has(family)) return null;
  const id = family === 'session' ? event.data?.sessionId : event.data?.id;
  if (typeof id === 'string') return family + ':' + id;
  return null;
}

function kindOf(event) {
  const family = event.type.split('/')[0];
  return { task: 'task', plan: 'plan', doc: 'document', session: 'session' }[family] || 'event';
}

// 用途：源记录的检索展示与原文来自同一公开投影；hash 明确属于该投影。
export function material(snapshot, ref, event, value, kind, title) {
  const data = publicRecord(value);
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const reference = encodeReference(ref);
  return { id: referenceId(reference), ref: reference, kind, title: String(title || event.type).slice(0, 300),
    entity: eventEntity(event), seq: ref.seq, commitHash: ref.commitHash, event: ref.event, eventType: event.type, sourcePart: ref.part,
    at: snapshot.commits[ref.seq - 1].at, actor: publicRecord(event.actor || snapshot.commits[ref.seq - 1].actor),
    version: event.data?.version ?? null, revision: event.data?.rev ?? null,
    state: event.data?.state ?? event.data?.status ?? null,
    contentHash: sha256(text), hashDomain: 'public-record-utf8', text, data, availability: 'available' };
}

// 用途：逐事件提取任务、文档与嵌套证据/审查，包含快照前与 additive 历史。
export function* commitMaterials(snapshot, commit) {
    for (let index = 0; index < commit.events.length; index++) {
      const event = commit.events[index];
      const data = event.data ?? {};
      yield material(snapshot, baseReference(snapshot, commit, index), event, event, kindOf(event), data.title || data.name || event.type);
      if (event.type.startsWith('task/')) {
        for (const evidence of data.evidence || []) {
          yield material(snapshot, baseReference(snapshot, commit, index, 'evidence', evidence.id), event, evidence, 'evidence', evidence.summary || evidence.kind);
        }
        if (data.lastAudit?.id) yield material(snapshot, baseReference(snapshot, commit, index, 'audit', data.lastAudit.id), event, data.lastAudit, 'audit', 'Audit: ' + (data.title || data.id));
      }
    }
}

// 用途：从权威日志核对引用，不信任缓存中保存的正文、ID 或调用者选择器。
export function locateReference(snapshot, text) {
  const ref = decodeReference(text, snapshot.projectId);
  const commit = snapshot.commits[ref.seq - 1];
  if (!commit || commit.hash !== ref.commitHash || !commit.events[ref.event]) throw invalidReference('Knowledge source identity no longer matches');
  const event = commit.events[ref.event];
  const data = event.data ?? {};
  if (ref.item && !['evidence', 'audit', 'fixed', 'file'].includes(ref.part)) throw invalidReference();
  if (['inline', 'external'].includes(ref.part) && !event.type.startsWith('doc/')) throw invalidReference();
  if (ref.part === 'file' && !ref.item) throw invalidReference();
  if (ref.part === 'fixed' && !ref.item && event.type !== 'doc/content-fixed') throw invalidReference();
  let value = data;
  if (ref.item) {
    value = ref.part === 'audit' ? data.lastAudit : data.evidence?.find(row => row.id === ref.item);
    if (!value || value.id !== ref.item || !event.type.startsWith('task/')) throw invalidReference();
  }
  if (ref.part === 'audit' && !ref.item) throw invalidReference();
  if (ref.part === 'evidence' && !ref.item) throw invalidReference();
  return { ref, commit, event, value };
}

export function readRecord(snapshot, reference) {
  const { ref, event, value } = locateReference(snapshot, reference);
  if (!['record', 'evidence', 'audit'].includes(ref.part) || ref.contentHash) throw invalidReference();
  const kind = ref.part === 'record' ? kindOf(event) : ref.part;
  const payload = ref.part === 'record' ? event : value;
  return material(snapshot, ref, event, payload, kind, value.title || value.name || value.summary || event.type);
}

// 用途：索引只保存来源身份与可公开元数据，不保存原文字段或生成摘要。
export function metadataOf(source) {
  const { text, data, observedAt, ...metadata } = source;
  return metadata;
}

// 任务、计划和文档按实体归组；证据和审查以所属实体及各自记录身份归组。
export function searchGroup(source, projectId) {
  if (['evidence', 'audit'].includes(source.kind)) return [source.kind, source.entity, decodeReference(source.ref, projectId).item].join(':');
  if (['task', 'plan', 'document'].includes(source.kind) && source.entity
    && (source.revision != null || source.version != null)) return source.kind + ':' + source.entity;
  return source.id;
}

// 从来源的公开业务字段截取原文；优先呈现命中字段及留存的限制说明。
export function sourceExcerpt(source, needles) {
  if (source.availability !== 'available') return null;
  if (source.kind === 'content') return snippet(source.text, needles);
  const value = ['evidence', 'audit'].includes(source.kind) ? source.data : source.data?.data;
  if (!value) return snippet(source.title, needles);
  const doc = value.draft || value;
  const list = input => Array.isArray(input) ? input : [];
  const fields = [
    value.description, doc.goal, value.summary, value.report, value.note, value.resolutionNote, value.reason,
    source.kind === 'evidence' && (value.kind === 'note' || !value.summary) ? value.ref : null,
    ...list(doc.assumptions), ...list(doc.risks),
    ...list(value.acceptance).map(item => item?.text),
    ...list(value.checklist).flatMap(item => [item?.item, item?.note]),
    ...list(doc.steps).flatMap(step => [step?.title, step?.detail, step?.description]),
    ...list(value.evidence).map(item => item?.summary),
    ...list(value.nextActions),
  ];
  const passages = fields.filter(field => typeof field === 'string' && field.trim())
    .flatMap(field => field.split(/\r?\n/u).filter(line => line.trim()));
  if (passages.length < 2) return snippet(passages[0] ?? source.title, needles);
  const primary = passages[0];
  const candidates = passages.slice(1);
  const cuePattern = /未主动|未确认|未宣称|仍待|不得|禁止|必须|\bmust\b/iu;
  const primaryText = (source.title + '\n' + primary).toLowerCase();
  const matched = needles?.find(word => word.length > 1
    && !primaryText.includes(word)
    && candidates.some(line => line.toLowerCase().includes(word)));
  const matching = matched && candidates.find(line => line.toLowerCase().includes(matched));
  const secondary = matching || candidates.find(line => cuePattern.test(line)) || candidates[0];
  const first = snippet(primary, needles, 180);
  const remaining = LIMITS.snippetChars - [...first].length - 1;
  const cue = matching ? matched : secondary.match(cuePattern)?.[0];
  return first + '\n' + snippet(secondary, cue ? [cue.toLowerCase()] : needles, remaining);
}
