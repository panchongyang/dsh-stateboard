// Pure read-only D6 inventory. No store open, lock, blob write or filesystem write.
import path from 'node:path';
import { sha256 } from '../util.js';
import { validateRelPath } from './locate.js';

const INLINE = new Set(['doc/created', 'doc/updated']);
const copy = (value) => structuredClone(value);
export const revisionKey = (docId, rev) => docId + '@' + rev;

function addRevision(index, doc, origin) {
  if (!doc || doc.source === 'external' || !doc.id || !Number.isInteger(doc.rev)) return;
  const key = revisionKey(doc.id, doc.rev);
  const previous = index.get(key);
  if (previous) {
    if (previous.hash !== doc.hash) previous.conflictingHashes.push(doc.hash);
    previous.origins.push(origin);
    return;
  }
  index.set(key, { ref: key, docId: doc.id, rev: doc.rev, hash: doc.hash, size: doc.size,
    links: copy(doc.links || {}), origins: [origin], conflictingHashes: [], references: [] });
}

function evidenceRows(data, origin, rows) {
  for (const [index, evidence] of (data?.evidence || []).entries()) {
    if (evidence.kind !== 'doc') continue;
    rows.push({ ...copy(evidence), ownerId: data.id, index, origin });
  }
}

function collectHistory(state, commits) {
  const index = new Map();
  const evidence = [];
  const associations = [];
  const fixedContents = [];
  const latest = new Map();
  for (const commit of commits) {
    for (const [eventIndex, event] of (commit.events || []).entries()) {
      const origin = { seq: commit.seq, eventIndex, type: event.type };
      if (event.type === 'doc/content-fixed') fixedContents.push({ ...copy(event.data), origin, domain: 'git-blob-bytes' });
      if (INLINE.has(event.type)) {
        addRevision(index, event.data, origin);
        latest.set(event.data.id, revisionKey(event.data.id, event.data.rev));
        associations.push({ docId: event.data.id, rev: event.data.rev, links: copy(event.data.links || {}), origin });
      }
      const rows = [];
      evidenceRows(event.data, origin, rows);
      for (const row of rows) {
        // Bare legacy references resolve at the event's position, never at today's head.
        row.resolvedRef = row.fixed || row.fixedState ? null : (row.ref.includes('@') ? row.ref : latest.get(row.ref) || null);
        evidence.push(row);
      }
    }
  }
  for (const doc of Object.values(state.docs || {})) addRevision(index, doc, { view: 'state' });
  const historicalEvidence = evidence.slice();
  for (const task of Object.values(state.tasks || {})) {
    const rows = [];
    evidenceRows(task, { view: 'state' }, rows);
    for (const row of rows) {
      const original = historicalEvidence.find((old) => old.ownerId === row.ownerId && old.ref === row.ref && old.hash === row.hash
        && (row.id ? old.id === row.id : old.index === row.index));
      row.resolvedRef = original?.resolvedRef ?? (row.ref.includes('@') ? row.ref : null);
      evidence.push(row);
    }
  }
  for (const row of evidence) {
    if (row.fixed || row.fixedState) continue;
    row.resolvedRef ??= row.ref.includes('@') ? row.ref : null;
    const version = index.get(row.resolvedRef);
    if (version) version.references.push({ ownerId: row.ownerId, index: row.index, hash: row.hash ?? null, origin: row.origin });
  }
  for (const row of Object.values(state.fixedContents || {})) fixedContents.push({ ...copy(row), origin: { view: 'state' }, domain: 'git-blob-bytes' });
  return { index, evidence, associations, fixedContents };
}

/** Restore precisely the persisted UTF-8 string hash, never a current file. */
export function exportInlineContent(readBlob, hash) {
  if (!/^[0-9a-f]{64}$/.test(hash || '')) return { status: 'invalid-hash', hash };
  try {
    const body = readBlob(hash);
    if (body === null || body === undefined) return { status: 'missing-blob', hash };
    if (typeof body !== 'string' || sha256(body) !== hash) return { status: 'hash-mismatch', hash };
    return { status: 'available', hash, size: Buffer.byteLength(body, 'utf8'), body, domain: 'inline-utf8' };
  } catch (error) {
    return { status: 'blob-unreadable', hash, detail: error.code || error.message };
  }
}

function destinationConflicts(state, destinations, bindingRoots) {
  const conflicts = [];
  const used = new Map();
  const rows = [...Object.values(state.docs || {}).filter((doc) => doc.source === 'external')
    .map((doc) => ({ docId: doc.id, locator: doc.locator })), ...destinations];
  for (const row of rows) {
    const locator = row.locator;
    if (!locator?.bindingId || !validateRelPath(locator.relPath).ok) {
      conflicts.push({ code: 'invalid-destination', ...copy(row) });
      continue;
    }
    // Case folding is collision detection, not identity equivalence or rebinding.
    const root = bindingRoots[locator.bindingId];
    const key = root ? path.resolve(root, ...locator.relPath.split('/')).toLowerCase()
      : locator.bindingId + ':' + locator.relPath.toLowerCase();
    const previous = used.get(key);
    if (previous && previous.docId !== row.docId) conflicts.push({ code: 'destination-conflict', first: previous, second: copy(row) });
    else used.set(key, copy(row));
  }
  return conflicts;
}

/** JSON-safe, deterministic and exhaustive: all revisions, not just evidence counts. */
export function inventoryInlineDocuments({ state, commits = [], readBlob, destinations = [], includeBodies = false, bindingRoots = {} }) {
  const { index, evidence, associations, fixedContents } = collectHistory(state, commits);
  const missing = [];
  for (const association of associations) {
    for (const taskId of association.links.taskIds || []) {
      if (!state.tasks?.[taskId]) missing.push({ code: 'missing-linked-task', ref: revisionKey(association.docId, association.rev), taskId });
    }
    for (const plan of association.links.planRefs || []) {
      if (!state.plans?.[revisionKey(plan.planId, plan.version)]) missing.push({ code: 'missing-linked-plan', ref: revisionKey(association.docId, association.rev), plan });
    }
  }
  const revisions = [...index.values()].sort((a, b) => a.ref.localeCompare(b.ref));
  for (const row of revisions) {
    row.source = state.docs?.[row.docId]?.migration ? 'inline-archive' : 'inline';
    row.readOnly = true;
    row.gitManaged = false;
    const exported = exportInlineContent(readBlob, row.hash);
    row.blob = includeBodies ? exported : { ...exported, body: undefined };
    if (row.blob.body === undefined) delete row.blob.body;
    if (exported.status !== 'available') missing.push({ ref: row.ref, hash: row.hash, code: exported.status });
    else if (exported.size !== row.size) missing.push({ ref: row.ref, hash: row.hash, code: 'size-mismatch', recorded: row.size, actual: exported.size });
    if (row.conflictingHashes.length) missing.push({ ref: row.ref, code: 'revision-hash-conflict', hashes: [row.hash, ...row.conflictingHashes] });
    for (const ref of row.references) {
      if (ref.hash && ref.hash !== row.hash) missing.push({ ref: row.ref, code: 'evidence-hash-conflict', evidence: ref });
    }
  }
  for (const row of evidence) {
    if (row.fixed || row.fixedState) continue;
    const restored = exportInlineContent(readBlob, row.hash);
    row.blob = { status: restored.status, hash: row.hash ?? null };
    if (!index.has(row.resolvedRef)) missing.push({ code: 'missing-revision', evidence: copy(row) });
  }
  return { schemaVersion: 1, domain: 'inline-utf8', projectId: state.project?.id ?? null,
    anchor: { seq: state.lastSeq ?? 0, hash: state.lastHash ?? 'genesis' },
    current: Object.values(state.docs || {}).filter((doc) => doc.source !== 'external').map(copy),
    revisions, associations, evidence, fixedContents, destinations: copy(destinations), missing,
    conflicts: destinationConflicts(state, destinations, bindingRoots) };
}
