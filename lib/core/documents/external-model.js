// External document records: structure, management transitions and replay
// projection. Contract: docs/WORKSPACE-DOCUMENTS-CONTRACT.md §1, §2.1, §2.3, §5.
//
// An external record lives in state.docs next to inline ones and is told apart
// only by `source: 'external'`. Every external event carries the full record;
// replay validates it and refuses (invalid-external-doc) instead of skipping.

import { isDeepStrictEqual } from 'node:util';
import { BoardError } from '../errors.js';
import { validateRelPath } from './locate.js';
import { MIGRATED_EVENT, migrationProblem, migrationTransitionProblem, historicalMigrationProblem } from './migration-record.js';

export const DOC_KINDS = Object.freeze(['spec', 'design', 'decision', 'note', 'runbook']);
export const MANAGEMENT_STATES = Object.freeze(['draft', 'in_review', 'adopted', 'archived']);
export const READER_VERSION = 'workspace-reader/1';
export const BASELINE_DOMAIN = 'workspace-bytes';

export const EXTERNAL_EVENTS = Object.freeze([
  'doc/external-registered',
  'doc/external-updated',
  'doc/external-relocated',
  'doc/external-unregistered',
  'doc/external-confirmed',
  MIGRATED_EVENT,
]);

const TRANSITIONS = Object.freeze({
  draft: ['in_review', 'archived'],
  in_review: ['adopted', 'draft', 'archived'],
  adopted: ['in_review', 'archived'],
  archived: ['draft'],
});

const HEX64 = /^[0-9a-f]{64}$/;
const GIT_OID = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

export function invalidExternal(message, details = null) {
  return new BoardError('invalid-external-doc', message, { status: 400, details });
}

export function isExternal(doc) {
  return Boolean(doc) && doc.source === 'external';
}

export function externalOperationRequired(docId, op) {
  return new BoardError('external-doc-operation-required', 'doc ' + docId + ' is an external document; ' + op + ' cannot read or change it, use the doc.external.* operations', {
    status: 409,
    details: { docId, source: 'external', use: 'doc.external' },
  });
}

/** True when `from → to` is an allowed management transition (contract §2.1). */
export function transitionAllowed(from, to) {
  return Object.hasOwn(TRANSITIONS, from) && TRANSITIONS[from].includes(to);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function locatorProblem(locator) {
  if (!locator || typeof locator !== 'object' || Array.isArray(locator)) return 'locator missing';
  const keys = Object.keys(locator).sort().join(',');
  if (keys !== 'bindingId,relPath') return 'locator must be exactly {bindingId, relPath}';
  if (!nonEmpty(locator.bindingId)) return 'locator.bindingId missing';
  const lexical = validateRelPath(locator.relPath);
  if (!lexical.ok) return 'locator.relPath rejected: ' + lexical.detail;
  return null;
}

function baselineProblem(baseline) {
  if (baseline === null) return null;
  if (!baseline || typeof baseline !== 'object') return 'baseline must be an object or null';
  if (baseline.domain !== BASELINE_DOMAIN) return 'baseline.domain must be ' + BASELINE_DOMAIN;
  if (typeof baseline.contentHash !== 'string' || !HEX64.test(baseline.contentHash)) return 'baseline.contentHash must be lowercase hex64';
  if (!nonEmpty(baseline.bindingId)) return 'baseline.bindingId missing';
  if (!validateRelPath(baseline.relPath).ok) return 'baseline.relPath invalid';
  if (baseline.gitHeadOid !== null && !GIT_OID.test(String(baseline.gitHeadOid))) return 'baseline.gitHeadOid invalid';
  if (!nonEmpty(baseline.confirmedAt) || !baseline.confirmedBy || typeof baseline.confirmedBy !== 'object') return 'baseline confirmedAt/confirmedBy missing';
  if (!nonEmpty(baseline.readerVersion)) return 'baseline.readerVersion missing';
  return null;
}

function linksProblem(links) {
  if (!links || typeof links !== 'object') return 'links missing';
  if (!Array.isArray(links.taskIds) || !Array.isArray(links.planRefs)) return 'links must carry taskIds and planRefs arrays';
  return null;
}

// Legacy inline rows predate the planRefs field: validate whatever is present
// instead of demanding today's shape, or real history stops opening.
function inlineLinksProblem(links) {
  if (!links || typeof links !== 'object' || Array.isArray(links)) return 'links must be an object';
  if (links.taskIds !== undefined && !Array.isArray(links.taskIds)) return 'links.taskIds must be an array';
  if (Array.isArray(links.taskIds) && links.taskIds.some((id) => typeof id !== 'string')) return 'links.taskIds must hold strings';
  if (links.planRefs !== undefined && !Array.isArray(links.planRefs)) return 'links.planRefs must be an array';
  for (const ref of Array.isArray(links.planRefs) ? links.planRefs : []) {
    if (!ref || typeof ref !== 'object' || typeof ref.planId !== 'string' || !Number.isInteger(ref.version)) return 'links.planRefs entries need planId and version';
  }
  return null;
}

/** First structural problem of an external record, or null. */
export function externalRecordProblem(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return 'record missing';
  if (doc.source !== 'external') return 'source must be external';
  if (typeof doc.id !== 'string' || !doc.id.startsWith('doc_')) return 'id must start with doc_';
  if (!Number.isInteger(doc.rev) || doc.rev < 1) return 'rev must be a positive integer';
  if (!nonEmpty(doc.title)) return 'title missing';
  if (!DOC_KINDS.includes(doc.kind)) return 'kind invalid';
  if (!MANAGEMENT_STATES.includes(doc.status)) return 'status invalid';
  if (Object.hasOwn(doc, 'bindingId') || Object.hasOwn(doc, 'relPath')) return 'bindingId/relPath live only in locator';
  if (Object.hasOwn(doc, 'hash') || Object.hasOwn(doc, 'body')) return 'external records carry no body hash';
  if (typeof doc.baselineInContext !== 'boolean') return 'baselineInContext must be a boolean';
  if (doc.baselineInContext && !doc.baseline) return 'baselineInContext requires a baseline';
  return locatorProblem(doc.locator)
    || migrationProblem(doc)
    || linksProblem(doc.links)
    || baselineProblem(doc.baseline ?? null)
    || (doc.unregistered != null && (typeof doc.unregistered !== 'object' || !nonEmpty(doc.unregistered.at)) ? 'unregistered must be null or {at,...}' : null);
}

export function assertExternalRecord(doc, details = null) {
  const problem = externalRecordProblem(doc);
  if (problem) throw invalidExternal('invalid external doc: ' + problem, { ...(details || {}), docId: doc && doc.id, reason: problem });
}

function replayDetails(event, commit) {
  return { seq: commit && Number.isInteger(commit.seq) ? commit.seq : null, type: event.type };
}

// Missing source is compatible only with a valid legacy inline record, not an
// external row whose discriminator was lost. Keep optional provenance/timestamps
// compatible while requiring the inline body's persisted identity.
function assertInlineRecord(doc, details = null) {
  let problem = null;
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) problem = 'record missing';
  else if (doc.source !== undefined && doc.source !== 'inline') problem = 'source must be inline or absent';
  else if (typeof doc.id !== 'string' || !doc.id.startsWith('doc_')) problem = 'id must start with doc_';
  else if (!Number.isInteger(doc.rev) || doc.rev < 1) problem = 'rev must be a positive integer';
  else if (!nonEmpty(doc.title)) problem = 'title missing';
  else if (!DOC_KINDS.includes(doc.kind)) problem = 'kind invalid';
  else if (typeof doc.hash !== 'string' || !HEX64.test(doc.hash)) problem = 'inline hash must be lowercase hex64';
  else if (!Number.isSafeInteger(doc.size) || doc.size < 0) problem = 'inline size must be a non-negative safe integer';
  else {
    const externalField = ['locator', 'bindingId', 'relPath', 'baseline', 'baselineInContext', 'status', 'unregistered', 'migration']
      .find((field) => Object.hasOwn(doc, field));
    problem = externalField ? 'inline record cannot carry ' + externalField : inlineLinksProblem(doc.links);
  }
  if (problem) throw invalidExternal('invalid inline doc: ' + problem, { ...(details || {}), docId: doc && doc.id, reason: problem });
}

/** Inline doc/created|updated must never carry or overwrite an external record. */
export function assertInlineDocEvent(state, event, data, commit) {
  const details = replayDetails(event, commit);
  assertInlineRecord(data, details);
  if (isExternal(state.docs[data.id])) {
    throw invalidExternal(event.type + ' cannot overwrite external doc ' + data.id, { ...details, docId: data.id });
  }
}

/** Replay projection for doc/external-* events. */
export function applyExternalDocEvent(state, event, data, commit) {
  const details = replayDetails(event, commit);
  assertExternalRecord(data, details);
  if (event.docId !== undefined && event.docId !== data.id) throw invalidExternal('event docId does not match record id', { ...details, docId: data.id });
  const existing = state.docs[data.id];
  if (event.type === MIGRATED_EVENT) {
    const problem = migrationTransitionProblem(existing, data, event);
    if (problem) throw invalidExternal(problem, { ...details, docId: data.id });
    if (isExternal(existing)) return; // exact duplicate mapping: retain later metadata
  } else if (event.type === 'doc/external-registered') {
    if (data.migration !== undefined) throw invalidExternal('registration cannot invent migration provenance', { ...details, docId: data.id });
    if (existing) throw invalidExternal('doc ' + data.id + ' is already registered', { ...details, docId: data.id });
    if (data.rev !== 1) throw invalidExternal('a registration starts at rev 1', { ...details, docId: data.id });
  } else {
    if (!isExternal(existing)) throw invalidExternal(event.type + ' targets a doc that is not an external record', { ...details, docId: data.id });
    if (data.rev !== existing.rev + 1) throw invalidExternal('metaRev must advance by exactly one', { ...details, docId: data.id, rev: data.rev, previous: existing.rev });
    if (!isDeepStrictEqual(existing.migration, data.migration)) throw invalidExternal('migration provenance is immutable', { ...details, docId: data.id });
  }
  state.docs[data.id] = data;
}

/** Snapshot rows obey the same source rules and must match their log anchor. */
export function assertExternalDocsInState(state, { expectedDocs, seq = null } = {}) {
  const docs = state && state.docs;
  const details = { origin: 'snapshot', seq };
  if (docs != null && (typeof docs !== 'object' || Array.isArray(docs))) {
    throw invalidExternal('snapshot docs must be a record map', details);
  }
  for (const [id, doc] of Object.entries(docs || {})) {
    if (isExternal(doc)) assertExternalRecord(doc, details);
    else assertInlineRecord(doc, details);
    if (doc.id !== id) throw invalidExternal('snapshot doc key does not match record id', { ...details, docId: id, reason: 'doc-id-mismatch' });
  }
  if (expectedDocs !== undefined && !isDeepStrictEqual(docs || {}, expectedDocs)) {
    const docId = [...new Set([...Object.keys(docs || {}), ...Object.keys(expectedDocs)])]
      .find((id) => !isDeepStrictEqual((docs || {})[id], expectedDocs[id]));
    throw invalidExternal('snapshot documents differ from the log at seq ' + seq, { ...details, docId, reason: 'snapshot-doc-mismatch' });
  }
  return state;
}

/**
 * Validate every doc event, including the snapshot-covered prefix. Capture a
 * separate projection at the snapshot's own seq, never compare it to the tail.
 */
export function assertDocEventsInLog(commits, { snapshotSeq = null } = {}) {
  const shadow = { docs: {} };
  const revisions = new Map();
  let atSnapshot = snapshotSeq === 0 ? {} : undefined;
  for (const commit of commits) {
    for (const event of commit.events || []) {
      const type = event && event.type;
      if (EXTERNAL_EVENTS.includes(type)) {
        applyExternalDocEvent(shadow, event, event.data, commit);
        if (type === MIGRATED_EVENT) {
          const problem = historicalMigrationProblem(event.data, revisions);
          if (problem) throw invalidExternal(problem, { seq: commit.seq, type, docId: event.data.id });
        }
      } else if (type === 'doc/created' || type === 'doc/updated') {
        assertInlineDocEvent(shadow, event, event.data, commit);
        shadow.docs[event.data.id] = event.data;
        revisions.set(event.data.id + '@' + event.data.rev, event.data);
      }
    }
    if (commit.seq === snapshotSeq) atSnapshot = structuredClone(shadow.docs);
  }
  return atSnapshot;
}
