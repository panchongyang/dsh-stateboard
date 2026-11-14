import path from 'node:path';
import { canonicalJSON, isInside, sha256 } from '../util.js';
import { readLocator, mainBinding } from '../documents/external-observe.js';
import { readDocument, interpretDocumentBytes } from '../documents/read.js';
import { resolveFixedContent } from '../documents/fixed-content.js';
import { baseReference, locateReference, material } from './records.js';
import { encodeReference, invalidReference } from './reference.js';

// 用途：只列登记与证据引用的正文；普通工作区目录和任意 Git 历史不参与枚举。
export function contentCandidates(snapshot) {
  const selected = new Map();
  for (const commit of snapshot.commits) {
    for (let index = 0; index < commit.events.length; index++) {
      const event = commit.events[index], data = event.data || {};
      const add = (key, part, item) => {
        if (!selected.has(key)) selected.set(key, { origin: key, ref: baseReference(snapshot, commit, index, part, item) });
      };
      if (event.type.startsWith('doc/') && data.id) {
        if (data.source === 'external') {
          const key = 'external:' + data.id;
          selected.delete(key);
          if (!data.unregistered) add(key, 'external');
        } else if (data.hash && data.rev) add('inline:' + data.id + '@' + data.rev, 'inline');
      }
      if (event.type === 'doc/content-fixed') add('fixed:' + data.ref + ':' + canonicalJSON(data.fixed), 'fixed');
      if (!event.type.startsWith('task/')) continue;
      for (const row of data.evidence || []) {
        if (row.kind === 'file' && row.hash) add('file:' + row.id + ':' + row.hash, 'file', row.id);
        if (row.kind === 'doc' && row.fixed) add('fixed:' + row.ref + ':' + canonicalJSON(row.fixed), 'fixed', row.id);
      }
    }
  }
  return [...selected.values()];
}

function unavailable(code) { return { ok: false, code, availability: code }; }

function inlineContent(snapshot, value) {
  if (!value.id?.startsWith('doc_') || value.source === 'external' || !/^[a-f0-9]{64}$/.test(value.hash || '')) throw invalidReference();
  const text = snapshot.handle.store.readBlob(value.hash);
  if (text === null) return unavailable('source-missing');
  if (sha256(text) !== value.hash) return unavailable('content-hash-mismatch');
  return { ok: true, text, hash: value.hash, size: Buffer.byteLength(text), domain: 'inline-utf8', previewable: true };
}

function externalContent(snapshot, value) {
  if (value.source !== 'external' || !value.locator) throw invalidReference();
  const current = snapshot.state.docs[value.id];
  if (!current || current.unregistered) return unavailable('source-unregistered');
  if (canonicalJSON(current.locator) !== canonicalJSON(value.locator)) return unavailable('source-changed');
  return { ...readLocator(snapshot.handle, value.locator).read, domain: 'workspace-bytes' };
}

function fileContent(snapshot, value) {
  if (value.kind !== 'file' || !/^[a-f0-9]{64}$/.test(value.hash || '') || typeof value.ref !== 'string') throw invalidReference();
  const binding = mainBinding(snapshot.handle);
  if (!binding) return unavailable('missing-binding');
  const absolute = path.resolve(binding.root, value.ref);
  if (!isInside(binding.root, absolute)) return unavailable('outside-root');
  const relPath = path.relative(binding.root, absolute).split(path.sep).join('/');
  const read = readDocument(binding.root, relPath);
  if (read.ok && read.hash !== value.hash) return unavailable('source-changed');
  return { ...read, domain: 'workspace-bytes' };
}

function fixedContent(snapshot, value) {
  if (value.kind !== 'doc' || !value.fixed || typeof value.ref !== 'string') throw invalidReference();
  const { content, fixed } = resolveFixedContent(snapshot.handle, { docId: value.ref, fixed: value.fixed }, { withinBinding: true });
  const interpreted = interpretDocumentBytes(content.bytes, fixed.pathAtCommit);
  return { ...interpreted, hash: fixed.blobContentHash, domain: 'git-blob-bytes' };
}

// 用途：回到精确来源验证正文；失效、缺失与不支持都保持为显式结果，不使用缓存正文。
export function readContent(snapshot, reference) {
  const located = locateReference(snapshot, reference);
  const { ref, event, value } = located;
  const methods = { inline: inlineContent, external: externalContent, file: fileContent, fixed: fixedContent };
  if (!methods[ref.part]) throw invalidReference();
  let read;
  try { read = methods[ref.part](snapshot, value); }
  catch (error) {
    if (error.code === 'knowledge-reference-invalid') throw error;
    read = unavailable(error.code || 'source-unavailable');
  }
  const title = value.title || (value.kind === 'file' ? 'File evidence: ' + value.id : value.ref) || event.type;
  const base = material(snapshot, ref, event, '', 'content', title);
  const expected = ref.contentHash;
  if (read.ok && expected && read.hash !== expected) read = { ...unavailable('source-changed'), domain: read.domain, size: read.size, observedHash: read.hash };
  if (!read.ok || !read.previewable || typeof read.text !== 'string') {
    return { ...base, text: null, data: null, contentHash: expected || value.hash || null,
      hashDomain: read.domain || null, size: read.size || 0, observedHash: read.observedHash ?? null,
      availability: read.code || 'unsupported-format', observedAt: new Date().toISOString() };
  }
  const next = { ...ref, contentHash: read.hash };
  const result = material(snapshot, next, event, read.text, 'content', base.title);
  return { ...result, contentHash: read.hash, hashDomain: read.domain || 'workspace-bytes',
    textHash: sha256(read.text), size: read.size, observedAt: new Date().toISOString() };
}

export function observeCandidate(snapshot, candidate) {
  return { ...readContent(snapshot, encodeReference(candidate.ref)), origin: candidate.origin };
}
