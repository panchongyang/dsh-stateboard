// Authorization and materialization for the versioned workspace sources. The cache is never an input here.
import { KNOWLEDGE_WORKSPACE_REFERENCE_VERSION as VERSION, KNOWLEDGE_WORKSPACE_READER_VERSION as READER,
  KNOWLEDGE_CHUNK_VERSION as CHUNKER, KNOWLEDGE_CHUNK_BYTES as CHUNK_BYTES } from '../../shared/knowledge.js';
import { sha256 } from '../util.js';
import { owningStoredWorkspaceVersion } from '../domain/document-relations.js';
import { checkProjectionLexical } from '../reader/discovery/path-policy.js';
import { resolveExactWorkspaceVersion } from '../reader/workspace-retained.js';
import { MAX_DOC_BYTES } from '../documents/read.js';
import { encodeReference, invalidReference, referenceId } from './reference.js';

export function workspaceBodyCandidate(snapshot, target) {
  if (!snapshot.workspace || !snapshot.spaceHome) return null;
  const row = owningStoredWorkspaceVersion(snapshot.state, target);
  if (!row) return null;
  try {
    checkProjectionLexical(row.locator.relPath, snapshot.workspace.denyPrefixes);
    const authorized = resolveExactWorkspaceVersion(snapshot.spaceHome, snapshot.state, target);
    if (!authorized) return null;
  } catch { return null; } // A denied locator must not appear even as hit metadata.
  const { docId, versionId, contentHash } = row.versionRef;
  return { origin: 'workspace-body:' + versionId, ref: { v: VERSION, projectId: snapshot.projectId,
    part: 'workspace-body', docId, versionId, contentHash }, size: row.size };
}

export function workspaceCurrentCandidate(snapshot, entry) {
  if (!snapshot.workspaceReader || typeof entry?.relPath !== 'string' || entry.relPath.length > 1024) return null;
  return { origin: 'workspace-current:' + entry.relPath, size: entry.size,
    ref: { v: VERSION, projectId: snapshot.projectId, part: 'workspace-current', relPath: entry.relPath,
      workspaceContext: snapshot.workspace.workspaceContext, readerVersion: READER } };
}

function unchunk({ start, end, chunkerVersion, ...ref }) { return ref; }

function material(ref, text, details = {}) {
  const refString = ref.contentHash ? encodeReference(ref) : null;
  const wholeRef = ref.contentHash ? encodeReference(unchunk(ref)) : null;
  const retained = ref.part === 'workspace-body';
  const readable = details.availability === 'available';
  const sourceVersion = retained ? { docId: ref.docId, versionId: ref.versionId, contentHash: ref.contentHash }
    : { workspaceContext: ref.workspaceContext, ...(readable ? { relPath: ref.relPath } : {}), readerVersion: READER, contentHash: ref.contentHash };
  return { id: refString && referenceId(refString), ref: refString, kind: 'content', sourcePart: ref.part,
    title: readable ? details.title : 'Workspace content unavailable',
    entity: retained ? 'doc:' + ref.docId : (details.docId ? 'doc:' + details.docId : null),
    seq: null, event: null, eventType: null, version: retained ? ref.versionId : null, revision: details.revision ?? null,
    state: details.state ?? null, observedAt: details.observedAt ?? null,
    contentHash: ref.contentHash ?? null, hashDomain: 'workspace-bytes', size: details.size ?? 0,
    availability: details.availability, text, sourceVersion, ...(wholeRef ? { sourceRef: wholeRef } : {}),
    ...(ref.chunkerVersion !== undefined ? { sourceRange: { start: ref.start, end: ref.end, chunkerVersion: CHUNKER } } : {}) };
}

function unavailable(ref, code) { return material(ref, null, { availability: code }); }

function endAt(bytes, start) {
  let end = Math.min(bytes.length, start + CHUNK_BYTES);
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return end;
}

function exactChunk(bytes, ref) {
  for (let start = 0; start < bytes.length && start <= ref.start;) {
    const end = endAt(bytes, start);
    if (start === ref.start && end === ref.end) return bytes.subarray(start, end).toString('utf8');
    start = end;
  }
  throw invalidReference('Knowledge chunk no longer matches its source');
}

function currentSource(snapshot, ref) {
  if (!snapshot.workspaceReader || ref.workspaceContext !== snapshot.workspace.workspaceContext) throw invalidReference();
  let body;
  try { body = snapshot.workspaceReader.readBody(ref.relPath); }
  catch (error) { return unavailable(ref, error.code || 'source-unavailable'); }
  if (ref.contentHash !== undefined && body.hash !== ref.contentHash) return unavailable(ref, 'source-changed');
  const exact = { ...ref, contentHash: body.hash };
  const doc = snapshot.workspaceDocs?.get(ref.relPath);
  const text = ref.chunkerVersion ? exactChunk(Buffer.from(body.text), ref) : body.text;
  return material(exact, text, { title: doc?.title || ref.relPath, docId: doc?.id, state: doc?.status,
    revision: doc?.rev, size: body.size, availability: 'available', observedAt: new Date().toISOString() });
}

function retainedSource(snapshot, ref) {
  const target = { kind: 'workspace-body', docId: ref.docId, versionId: ref.versionId };
  const candidate = workspaceBodyCandidate(snapshot, target);
  if (!candidate || candidate.ref.contentHash !== ref.contentHash) throw invalidReference();
  const row = snapshot.state.workspaceVersions[ref.versionId];
  const doc = snapshot.state.docs[ref.docId];
  let body;
  try { body = resolveExactWorkspaceVersion(snapshot.spaceHome, snapshot.state, target).read(MAX_DOC_BYTES); }
  catch (error) { return unavailable(ref, error.code || 'source-unavailable'); }
  const text = ref.chunkerVersion ? exactChunk(Buffer.from(body.body), ref) : body.body;
  return material(ref, text, { title: doc?.title || row.locator.relPath, size: body.size, availability: 'available',
    observedAt: row.observedAt });
}

export function readWorkspaceSource(snapshot, ref) {
  return ref.part === 'workspace-current' ? currentSource(snapshot, ref) : retainedSource(snapshot, ref);
}

export function* workspaceChunks(source) {
  if (source.availability !== 'available') return;
  const bytes = Buffer.from(source.text);
  if (bytes.length === 0) { yield source; return; }
  const ref = unpackSourceRef(source);
  for (let start = 0; start < bytes.length;) {
    const end = endAt(bytes, start);
    const refString = encodeReference({ ...ref, chunkerVersion: CHUNKER, start, end });
    yield { ...source, id: referenceId(refString), ref: refString, text: bytes.subarray(start, end).toString('utf8'),
      sourceRange: { start, end, chunkerVersion: CHUNKER } };
    start = end;
  }
}

function unpackSourceRef(source) {
  // This string was encoded just above from the current authoritative observation.
  return JSON.parse(Buffer.from(source.sourceRef.slice(4), 'base64url').toString('utf8'));
}
