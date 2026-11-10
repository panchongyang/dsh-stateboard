import fs from 'node:fs';
import path from 'node:path';
import { BoardError } from './errors.js';
import { canonicalKey, isInside, newId, sha256 } from './util.js';
import { hashFileStream } from './documents/read.js';
import { isExternal } from './documents/external-model.js';
import { migrationBlobReader } from './documents/migration-blob.js';
import { auditFixedEvidence } from './documents/fixed-content.js';
import { auditCurrentOnlyDoc, autoExternalEvidence, rememberAutoApproval } from './documents/fixed-auto.js';

// Evidence normalization: hashing, containment and acceptance linkage. Kept out
// of service.js because it is the one command path that touches the filesystem.

/** Evidence files are hashed, never loaded: a 2 GB log must not become a 2 GB read. */
export const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;

// The streaming hash moved to the shared document reader so an evidence file and
// a workspace document are provably hashed the same way. Behaviour here is
// unchanged: same algorithm, same 16 MiB caller-side cap, same failure mode.
export function hashFileSync(file) {
  return hashFileStream(file);
}

/** Hash a workspace file after proving it stays inside the workspace (links included). */
function normalizeFileEvidence(handle, ref, raw, at) {
  const absolute = path.isAbsolute(ref) ? ref : path.resolve(handle.workspacePath, ref);
  if (!isInside(handle.workspacePath, absolute)) throw new BoardError('invalid-command', 'evidence file escapes the workspace: ' + ref, { status: 400 });
  let stat;
  try { stat = fs.statSync(absolute); } catch { throw new BoardError('missing-evidence', 'file not found: ' + ref, { status: 422 }); }
  if (!stat.isFile()) throw new BoardError('missing-evidence', 'not a file: ' + ref, { status: 422 });
  // A path can be inside the workspace and still resolve outside it: junctions
  // and symlinks answer the lexical check but point anywhere.
  let real;
  let realRoot;
  try {
    real = fs.realpathSync(absolute);
    realRoot = fs.realpathSync(handle.workspacePath);
  } catch {
    throw new BoardError('missing-evidence', 'file not found: ' + ref, { status: 422 });
  }
  if (!isInside(realRoot, real)) {
    throw new BoardError('invalid-command', 'evidence file escapes the workspace through a link: ' + ref, { status: 400 });
  }
  const realStat = fs.statSync(real);
  if (realStat.size > MAX_EVIDENCE_BYTES) {
    throw new BoardError('invalid-command', 'evidence file is too large (' + realStat.size + ' bytes): ' + ref, { status: 413 });
  }
  const actual = hashFileSync(real);
  if (typeof raw.hash === 'string' && raw.hash !== '' && raw.hash !== actual) {
    throw new BoardError('missing-evidence', 'file hash mismatch: ' + ref, { status: 422, details: { expected: raw.hash, actual } });
  }
  return { hash: actual, verifiedAt: at };
}

export function normalizeEvidence(handle, task, raw, at, actor) {
  const kind = raw.kind;
  if (!['file', 'command', 'doc', 'url', 'note', 'test'].includes(kind)) {
    throw new BoardError('invalid-command', 'unknown evidence kind: ' + kind, { status: 400 });
  }
  let ref = String(raw.ref || '');
  if (ref === '') throw new BoardError('invalid-command', 'evidence ref is required', { status: 400 });
  const summary = typeof raw.summary === 'string' ? raw.summary : '';
  let hash = null;
  let verifiedAt = null;
  let fixed = null;
  let fixedState = null;
  let fixedReason = null;
  let approval = null;
  if (kind === 'doc' && ['fixed', 'fixedConfirmed', 'bindingId'].some((field) => Object.hasOwn(raw, field))) {
    throw new BoardError('invalid-command', 'doc evidence is pinned automatically; pass only the docId', { status: 400 });
  }
  if (Object.hasOwn(raw, 'fixed') && kind !== 'doc') throw new BoardError('invalid-fixed-reference', 'fixed is only valid for doc evidence', { status: 400 });
  if (kind === 'file') {
    ({ hash, verifiedAt } = normalizeFileEvidence(handle, ref, raw, at));
  } else if (kind === 'doc') {
    const atIndex = ref.lastIndexOf('@');
    const docId = atIndex > 0 ? ref.slice(0, atIndex) : ref;
    const rev = atIndex > 0 ? Number.parseInt(ref.slice(atIndex + 1), 10) : NaN;
    const doc = handle.state.docs[docId];
    if (!doc) throw new BoardError('missing-evidence', 'doc not found: ' + docId, { status: 422 });
    const archive = doc.migration?.history.find((row) => row.sourceRev === rev);
    if (archive) {
      const body = migrationBlobReader(handle.store)(archive.sourceHash);
      if (body === null || sha256(body) !== archive.sourceHash) throw new BoardError('missing-evidence', 'original inline archive missing or corrupt: ' + ref, { status: 422 });
      hash = archive.sourceHash;
    } else if (isExternal(doc)) {
      // For external docs `@rev` is the metadata revision, not a content
      // identity: ignore it and let the auto shell pin or degrade the current
      // locator. Inline docs below keep their historical docId@rev mapping.
      ref = docId;
      ({ hash, fixed, fixedState, fixedReason, approval } = autoExternalEvidence(handle, doc));
    } else {
      if (Number.isInteger(rev) && rev !== doc.rev) throw new BoardError('missing-evidence', 'doc rev mismatch: ' + ref + ' (current ' + doc.rev + ')', { status: 422 });
      hash = doc.hash;
    }
    verifiedAt = at;
  }
  if (raw.acceptanceId && !task.acceptance.some((item) => item.id === raw.acceptanceId)) {
    throw new BoardError('invalid-command', 'unknown acceptanceId: ' + raw.acceptanceId, { status: 400 });
  }
  const row = {
    id: newId('ev'),
    taskId: task.id,
    kind,
    ref,
    hash,
    ...(fixed ? { fixed } : {}),
    ...(fixedState ? { fixedState } : {}),
    ...(fixedReason ? { fixedReason } : {}),
    summary,
    acceptanceId: raw.acceptanceId || null,
    verifiedAt,
    producedBy: { sessionId: actor.sessionId || null, agentId: actor.agentId || null, callId: actor.callId || null },
    execution: null,
    at,
  };
  rememberAutoApproval(row, approval);
  return row;
}

function resolvedFileKey(handle, ref) {
  const text = String(ref || '');
  if (text === '') return null;
  const absolute = path.isAbsolute(text) ? text : path.resolve(handle.workspacePath, text);
  if (!isInside(handle.workspacePath, absolute)) return null;
  let resolved = absolute;
  try { resolved = fs.realpathSync(absolute); } catch { /* missing: compare the lexical path */ }
  return canonicalKey(resolved);
}

/**
 * Identity used to chain evidence: a later submission replaces the active rows
 * for the same file/doc/command. A deleted file falls back to its lexical path,
 * so restoring it can still retire the old row.
 */
export function evidenceIdentity(handle, evidence) {
  if (!evidence || typeof evidence.kind !== 'string') return null;
  if (evidence.kind === 'file') {
    const key = resolvedFileKey(handle, evidence.ref);
    return key ? 'file:' + key : null;
  }
  if (evidence.kind === 'doc') {
    const ref = String(evidence.ref || '');
    const atIndex = ref.lastIndexOf('@');
    const docId = atIndex > 0 ? ref.slice(0, atIndex) : ref;
    return docId ? 'doc:' + docId : null;
  }
  if (evidence.kind === 'command' || evidence.kind === 'test') {
    const ref = String(evidence.ref || '');
    return ref ? 'cmd:' + ref : null;
  }
  return null;
}

/**
 * A resubmitted row retires the active rows for the same identity, so a
 * reject -> edit -> submit loop does not leave two contradicting snapshots of
 * the same path. Old rows stay in the log as superseded history. A replacement
 * must still cover every acceptance it takes over, or the whole command fails
 * before anything is written.
 */
export function supersedeResubmitted(handle, task, added, at) {
  const replacementFor = new Map();
  for (const evidence of added) {
    const identity = evidenceIdentity(handle, evidence);
    if (identity && !replacementFor.has(identity)) replacementFor.set(identity, evidence);
  }
  if (replacementFor.size === 0) return [];
  const retiring = [];
  for (const evidence of task.evidence || []) {
    if (evidence.supersededAt) continue;
    const identity = evidenceIdentity(handle, evidence);
    if (identity && replacementFor.has(identity)) retiring.push({ evidence, identity });
  }
  if (retiring.length === 0) return [];
  const retiringIds = new Set(retiring.map((item) => item.evidence.id));
  const affected = [...new Set(retiring.map((item) => item.evidence.acceptanceId).filter(Boolean))];
  for (const acceptanceId of affected) {
    const stillCovered = (task.evidence || []).some((evidence) => !evidence.supersededAt && !retiringIds.has(evidence.id) && evidence.acceptanceId === acceptanceId)
      || added.some((evidence) => evidence.acceptanceId === acceptanceId);
    if (!stillCovered) {
      const acceptance = (task.acceptance || []).find((item) => item.id === acceptanceId);
      throw new BoardError('missing-evidence', 'resubmit would replace the last evidence of an acceptance: ' + (acceptance ? acceptance.text : acceptanceId), {
        status: 422,
        details: {
          acceptanceId,
          refs: retiring.filter((item) => item.evidence.acceptanceId === acceptanceId).map((item) => item.evidence.ref),
          hint: 'include fresh evidence for this acceptance in the same submit, or begin a new attempt',
        },
      });
    }
  }
  for (const item of retiring) {
    const replacement = replacementFor.get(item.identity);
    item.evidence.supersededAt = at;
    item.evidence.supersededBy = replacement ? replacement.id : null;
    item.evidence.supersedeReason = 'resubmitted';
  }
  return retiring.map((item) => item.evidence.id);
}


/** Content observation only; this is not acceptance or command-result certification. */
export function evidenceVerified(handle, task, evidence) {
  if (!evidence) return false;
  if (Object.hasOwn(evidence, 'fixed')) return evidence.kind === 'doc' && Boolean(evidence.verifiedAt) && !auditFixedEvidence(handle, evidence);
  return (evidence.kind === 'file' || evidence.kind === 'doc') && Boolean(evidence.hash && evidence.verifiedAt);
}

/** Review coverage counts material and any explicit kind requirement, not correctness. */
export function assertAcceptanceEvidence(task) {
  for (const acceptance of task.acceptance) {
    const items = task.evidence.filter((row) => !row.supersededAt && row.acceptanceId === acceptance.id);
    if (items.length === 0) throw new BoardError('missing-evidence', 'acceptance has no active evidence: ' + acceptance.text, { status: 422 });
    const kinds = Array.isArray(acceptance.requiredKinds) ? acceptance.requiredKinds : [];
    if (kinds.length > 0 && !items.some((row) => kinds.includes(row.kind))) {
      throw new BoardError('missing-evidence', 'acceptance requires kinds ' + kinds.join(',') + ': ' + acceptance.text, { status: 422 });
    }
    acceptance.met = true;
  }
}

function pathFor(handle, ref) {
  const absolute = path.isAbsolute(ref) ? ref : path.resolve(handle.workspacePath, ref);
  if (!isInside(handle.workspacePath, absolute)) return null;
  try {
    const real = fs.realpathSync(absolute);
    if (!isInside(fs.realpathSync(handle.workspacePath), real)) return null;
    return real;
  } catch {
    return null;
  }
}

/**
 * Re-check recorded content against current observations. Command/test metadata
 * is historical submitter material, never an execution or correctness gate.
 */
function auditMigratedInline(handle, evidence, doc, pinnedRev) {
  const warning = (code, severity = 'error') => ({ evidenceId: evidence.id, code, severity, message: 'original inline archive: ' + evidence.ref });
  if (!evidence.hash) return warning('doc-unhashed', 'warning');
  const revision = Number.isInteger(pinnedRev) ? pinnedRev : doc.migration.sourceRev;
  // Bare inline references tracked the head before migration; an older matching
  // archive must not erase their pre-existing drift or relax the verify gate.
  if (!Number.isInteger(pinnedRev) && evidence.hash !== doc.migration.sourceHash) return warning('doc-drift');
  const row = doc.migration.history.find((entry) => entry.sourceHash === evidence.hash && entry.sourceRev === revision);
  if (!row) return warning('doc-drift');
  const body = migrationBlobReader(handle.store)(evidence.hash);
  if (body === null) return warning('doc-blob-missing');
  if (sha256(body) !== evidence.hash) return warning('doc-blob-corrupt');
  return null;
}

export function auditEvidence(handle, task) {
  const warnings = [];
  for (const evidence of task.evidence || []) {
    if (evidence.supersededAt) continue;
    if (Object.hasOwn(evidence, 'fixed')) {
      const warning = auditFixedEvidence(handle, evidence);
      if (warning) warnings.push(warning);
      continue;
    }
    if (evidence.kind === 'file') {
      const file = pathFor(handle, evidence.ref);
      if (!file) {
        warnings.push({ evidenceId: evidence.id, code: 'file-missing', severity: 'error', message: 'evidence file is missing or escapes the workspace: ' + evidence.ref });
      } else {
        let actual = null;
        try { actual = hashFileSync(file); } catch { /* missing */ }
        if (!actual) warnings.push({ evidenceId: evidence.id, code: 'file-missing', severity: 'error', message: 'evidence file is not readable: ' + evidence.ref });
        else if (evidence.hash && actual !== evidence.hash) warnings.push({ evidenceId: evidence.id, code: 'file-drift', severity: 'error', message: 'evidence file changed: ' + evidence.ref });
        else if (!evidence.hash) warnings.push({ evidenceId: evidence.id, code: 'file-unhashed', severity: 'warning', message: 'legacy file evidence has no hash: ' + evidence.ref });
      }
    } else if (evidence.kind === 'doc' && evidence.fixedState === 'current-only' && isExternal(handle.state.docs[evidence.ref])) {
      const warning = auditCurrentOnlyDoc(handle, evidence, handle.state.docs[evidence.ref]);
      if (warning) warnings.push(warning);
    } else if (evidence.kind === 'doc') {
      const atIndex = evidence.ref.lastIndexOf('@');
      const docId = atIndex > 0 ? evidence.ref.slice(0, atIndex) : evidence.ref;
      const pinnedRev = atIndex > 0 ? Number.parseInt(evidence.ref.slice(atIndex + 1), 10) : NaN;
      const doc = handle.state.docs[docId];
      if (!doc) {
        warnings.push({ evidenceId: evidence.id, code: 'doc-missing', severity: 'error', message: 'evidence doc is missing: ' + evidence.ref });
      } else if (doc.migration && !evidence.fixedState) {
        const warning = auditMigratedInline(handle, evidence, doc, pinnedRev);
        if (warning) warnings.push(warning);
      } else if (Number.isInteger(pinnedRev) && pinnedRev < doc.rev) {
        // docId@rev pins the bytes of that revision, and blobs are content-addressed:
        // the head moving forward must not invalidate evidence for an older revision.
        // Verify the pinned blob itself instead of comparing against the head hash.
        if (!evidence.hash) {
          warnings.push({ evidenceId: evidence.id, code: 'doc-unhashed', severity: 'warning', message: 'legacy doc evidence has no pinned hash: ' + evidence.ref });
        } else {
          const body = handle.store.readBlob(evidence.hash);
          if (body === null) {
            warnings.push({ evidenceId: evidence.id, code: 'doc-blob-missing', severity: 'error', message: 'evidence doc revision blob is missing: ' + evidence.ref });
          } else if (sha256(body) !== evidence.hash) {
            warnings.push({ evidenceId: evidence.id, code: 'doc-blob-corrupt', severity: 'error', message: 'evidence doc revision blob does not match its hash: ' + evidence.ref });
          }
        }
      } else if (evidence.hash && doc.hash !== evidence.hash) {
        warnings.push({ evidenceId: evidence.id, code: 'doc-drift', severity: 'error', message: 'evidence doc changed: ' + evidence.ref });
      }
    }
  }
  return warnings;
}

/**
 * One audit at the review boundary. The worker still holds the lease here, so a
 * content or structural failure (drift, missing file, invalid fixed reference) is thrown
 * back instead of becoming a review the human has to diagnose and reject.
 */
export function assertEvidenceReadyForReview(handle, task, stage) {
  const audit = auditEvidence(handle, task);
  const hard = audit.filter((warning) => warning.severity === 'error');
  if (hard.length > 0) {
    throw new BoardError('evidence-drift', 'evidence failed the pre-review audit: ' + hard.map((warning) => warning.code).join(', '), {
      status: 409,
      details: { warnings: hard, stage, canAcknowledgeDrift: false, canRefresh: false },
    });
  }
  return audit;
}
