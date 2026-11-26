import { BoardError } from '../errors.js';
import { versionRefProblem } from './workspace-record.js';

export function openWorkIntent(fields) {
  if (Object.hasOwn(fields, 'status')) throw new BoardError('invalid-command', 'intent creation does not accept status', { status: 400 });
  return { ...fields, status: 'open' };
}
function assertOpen(intent) {
  if (intent.status !== 'open') throw new BoardError('illegal-transition', 'intent is not open', { status: 409 });
}
export function completeWorkIntent(intent, fields) { assertOpen(intent); return { ...intent, ...fields, status: 'closed' }; }
export function abandonWorkIntent(intent, fields) { assertOpen(intent); return { ...intent, ...fields, status: 'abandoned' }; }

export function startWorkAttempt(task, lease, { intentId, summary, plannedSteps, expectedArtifacts }, at, actor) {
  if (!lease || lease.taskId !== task.id || !Number.isInteger(lease.token)) throw new BoardError('illegal-transition', "an attempt requires this task's lease", { status: 409 });
  if (typeof intentId !== 'string' || !intentId || typeof summary !== 'string' || !summary.trim()) {
    throw new BoardError('invalid-command', 'an attempt requires an id and summary', { status: 400 });
  }
  return openWorkIntent({
    id: intentId, taskId: task.id, token: lease.token, summary,
    plannedSteps: Array.isArray(plannedSteps) ? plannedSteps.map(String) : [],
    expectedArtifacts: Array.isArray(expectedArtifacts) ? expectedArtifacts.map(String) : [],
    attempt: (task.work?.attempt || 0) + 1, startedAt: at, actor: actor || {},
  });
}

export function closeSubmittedWork(intent, lease, at) {
  if (!lease || lease.taskId !== intent.taskId) throw new BoardError('illegal-transition', "intent submission requires this task's lease", { status: 409 });
  return completeWorkIntent(intent, { closedAt: at, token: lease.token });
}

function recoveryNote(note) {
  if (typeof note !== 'string' || !note.trim()) throw new BoardError('invalid-command', 'reconcile requires a note', { status: 400 });
  return note;
}

export function closeRecoveredWork(intent, note, closedBy, closedAt) {
  return completeWorkIntent(intent, { resolution: 'applied', resolutionNote: recoveryNote(note), closedAt, closedBy });
}

export function abandonWorkForRedo(intent, note, closedBy, closedAt) {
  return abandonWorkIntent(intent, { closeReason: 'reconcile-resume', resolution: 'redo', resolutionNote: recoveryNote(note), closedAt, closedBy });
}

export function abandonDiscardedWork(intent, note, closedBy, closedAt) {
  return abandonWorkIntent(intent, { closeReason: 'reconcile-discard', resolution: 'discarded', resolutionNote: recoveryNote(note), closedAt, closedBy });
}

export function abandonStoppedWork(intent, { closeReason, sideEffects, note, at, by, token }) {
  return abandonWorkIntent(intent, {
    closeReason, outcome: 'stopped', sideEffects, settlementNote: String(note || '').slice(0, 2000), closedAt: at, closedBy: by, token,
  });
}

// Evidence facts contain observation and link inputs only. Record identity,
// timestamps, ownership, acceptance coverage and replacement are model output.
export function materializeTaskEvidence(task, material, at, actor = {}) {
  const { id, kind, ref, hash, workspaceVersion, fixedState, fixedReason, summary, acceptanceId } = material;
  if (typeof id !== 'string' || !id || !['file', 'doc', 'test', 'command', 'url', 'note'].includes(kind) || typeof ref !== 'string' || !ref) {
    throw new BoardError('invalid-command', 'invalid evidence material', { status: 400 });
  }
  if (acceptanceId && !task.acceptance.some(item => item.id === acceptanceId)) {
    throw new BoardError('invalid-command', 'unknown acceptanceId: ' + acceptanceId, { status: 400 });
  }
  const content = kind === 'file' || kind === 'doc';
  const digest = typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash);
  if ((!content && hash != null) || (kind === 'file' && !digest)
    || Object.hasOwn(material, 'fixed')
    || (kind !== 'doc' && (workspaceVersion || fixedState || fixedReason))
    || (workspaceVersion !== undefined && (!digest || fixedState || versionRefProblem(workspaceVersion, { docId: ref, contentHash: hash })))
    || (fixedState === 'current-only' && (!digest || typeof fixedReason !== 'string' || !fixedReason))
    || (fixedState && fixedState !== 'current-only')
    || (fixedReason && fixedState !== 'current-only')) {
    throw new BoardError('invalid-command', 'content observation does not match evidence kind', { status: 400 });
  }
  return {
    id, taskId: task.id, kind, ref, hash: hash ?? null,
    ...(workspaceVersion ? { workspaceVersion: structuredClone(workspaceVersion) } : {}),
    ...(fixedState ? { fixedState } : {}),
    ...(fixedReason ? { fixedReason } : {}),
    summary: typeof summary === 'string' ? summary : '', acceptanceId: acceptanceId || null,
    verifiedAt: content ? at : null,
    producedBy: { sessionId: actor.sessionId || null, agentId: actor.agentId || null, callId: actor.callId || null },
    execution: null, at,
  };
}

function matchKey(row, fileIdentity) {
  if (row.kind === 'file') return typeof fileIdentity === 'string' && fileIdentity.startsWith('file:') ? fileIdentity : null;
  const ref = String(row.ref || '');
  if (!ref) return null;
  if (row.kind === 'doc') {
    const split = ref.lastIndexOf('@');
    return 'doc:' + (split > 0 ? ref.slice(0, split) : ref);
  }
  return row.kind === 'command' || row.kind === 'test' ? 'cmd:' + ref : null;
}

function appendEvidence(task, row) {
  if (task.evidence.some(item => item.id === row.id)) throw new BoardError('invalid-command', 'duplicate evidence identifier', { status: 400 });
  task.evidence.push(row);
  if (row.acceptanceId) {
    const acceptance = task.acceptance.find(item => item.id === row.acceptanceId);
    acceptance.met = true;
    if (!acceptance.evidenceIds.includes(row.id)) acceptance.evidenceIds.push(row.id);
  }
}

export function assertReviewCoverage(task) {
  for (const acceptance of task.acceptance) {
    const items = task.evidence.filter(row => !row.supersededAt && row.acceptanceId === acceptance.id);
    if (!items.length) throw new BoardError('missing-evidence', 'acceptance has no active evidence: ' + acceptance.text, { status: 422 });
    const kinds = Array.isArray(acceptance.requiredKinds) ? acceptance.requiredKinds : [];
    if (kinds.length && !items.some(row => kinds.includes(row.kind))) {
      throw new BoardError('missing-evidence', 'acceptance requires kinds ' + kinds.join(',') + ': ' + acceptance.text, { status: 422 });
    }
  }
}

/** Pure calculation, shared by the authority and the read-only pre-review audit. */
export function evidenceForReview(task, materials, fileIdentities, at, actor) {
  const next = structuredClone(task);
  const added = materials.map(material => materializeTaskEvidence(task, material, at, actor));
  const replacements = new Map();
  for (const row of added) {
    const key = matchKey(row, fileIdentities[row.id]);
    if (key && !replacements.has(key)) replacements.set(key, row.id);
  }
  const retired = new Map();
  for (const row of next.evidence) {
    if (row.supersededAt) continue;
    const replacement = replacements.get(matchKey(row, fileIdentities[row.id]));
    if (replacement) retired.set(row.id, replacement);
  }
  const affected = new Set(next.evidence.filter(row => retired.has(row.id) && row.acceptanceId).map(row => row.acceptanceId));
  for (const id of affected) {
    const stillCovered = next.evidence.some(row => !row.supersededAt && !retired.has(row.id) && row.acceptanceId === id)
      || added.some(row => row.acceptanceId === id);
    if (!stillCovered) {
      const acceptance = next.acceptance.find(item => item.id === id);
      throw new BoardError('missing-evidence', 'resubmit would replace the last evidence of an acceptance: ' + (acceptance ? acceptance.text : id), {
        status: 422, details: { acceptanceId: id,
          refs: next.evidence.filter(row => retired.has(row.id) && row.acceptanceId === id).map(row => row.ref),
          hint: 'include fresh evidence for this acceptance in the same submit, or begin a new attempt' },
      });
    }
  }
  for (const row of next.evidence) {
    if (!retired.has(row.id)) continue;
    row.supersededAt = at;
    row.supersededBy = retired.get(row.id);
    row.supersedeReason = 'resubmitted';
  }
  for (const row of added) appendEvidence(next, row);
  assertReviewCoverage(next);
  for (const item of next.acceptance) item.met = true;
  return { next, added };
}

/** A refresh only changes the byte identity; ref, linkage and summary are model facts. */
export function refreshTaskFiles(task, observations, at, actor) {
  const next = structuredClone(task);
  const refreshed = [];
  for (const sample of observations) {
    const rows = sample.evidenceIds.map(id => next.evidence.find(row => row.id === id));
    const first = rows[0];
    if (!first || rows.some(row => !row || row.kind !== 'file' || row.supersededAt || row.acceptanceId !== first.acceptanceId)
      || new Set(sample.evidenceIds).size !== rows.length || !/^[a-f0-9]{64}$/.test(sample.hash)) {
      throw new BoardError('invalid-command', 'invalid file refresh observation', { status: 400 });
    }
    const replacement = materializeTaskEvidence(next, {
      id: sample.newEvidenceId, kind: 'file', ref: first.ref, hash: sample.hash, acceptanceId: first.acceptanceId, summary: first.summary,
    }, at, actor);
    for (const old of rows) {
      old.supersededAt = at;
      old.supersededBy = replacement.id;
      old.supersedeReason = 'verify-refresh';
    }
    appendEvidence(next, replacement);
    refreshed.push({ evidenceId: replacement.id, supersededIds: rows.map(row => row.id), ref: first.ref, oldHash: first.hash, newHash: replacement.hash });
  }
  return { next, refreshed };
}
