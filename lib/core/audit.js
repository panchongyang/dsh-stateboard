// Audit records are declarations anchored to persisted evidence and worker identities.
// No report or evidence reference is executed by this module.
import { BoardError } from './errors.js';
import { canonicalJSON, newId, sha256 } from './util.js';

export const AUDIT_SCOPE_VERSION = 1;

function identity(value) {
  if (!value || typeof value !== 'object') return null;
  const sessionId = typeof value.sessionId === 'string' && value.sessionId ? value.sessionId : null;
  const agentId = typeof value.agentId === 'string' && value.agentId ? value.agentId : null;
  return sessionId || agentId ? { sessionId, agentId } : null;
}

export function auditWorkers(task) {
  const rows = [task.assignee, ...(task.evidence || []).map((row) => row.producedBy), ...(task.workers || [])];
  const unique = new Map();
  for (const row of rows) {
    const by = identity(row);
    if (by) unique.set(canonicalJSON(by), by);
  }
  return [...unique.values()];
}

export function sameAuditIdentity(a, b) {
  return Boolean((a?.sessionId && a.sessionId === b?.sessionId) || (a?.agentId && a.agentId === b?.agentId));
}

export function independenceProblem(task, actor) {
  const workers = auditWorkers(task);
  if (workers.length === 0) return 'worker-unknown';
  if (!actor?.sessionId || workers.some((worker) => sameAuditIdentity(worker, actor))) return 'not-independent';
  return null;
}

export function appendWorker(task, worker, at, cause) {
  const by = identity(worker);
  if (!by) return;
  const rows = Array.isArray(task.workers) ? task.workers : [];
  if (!rows.some((row) => row.sessionId === by.sessionId && row.agentId === by.agentId)) rows.push({ ...by, at, cause });
  task.workers = rows.slice(-20);
}

export function normalizeAudit(input, { required = false } = {}) {
  const invalid = (message) => { throw new BoardError('invalid-command', message, { status: 400 }); };
  if (input === undefined && !required) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('audit requires a report');
  const report = typeof input.report === 'string' ? input.report.trim() : '';
  if (report.length < 20 || report.length > 4000) invalid('audit.report must contain 20–4000 characters after trimming');
  const out = { report };
  if (input.checklist !== undefined) {
    if (!Array.isArray(input.checklist) || input.checklist.length > 50) invalid('audit.checklist must contain at most 50 items');
    out.checklist = input.checklist.map((row) => {
      if (!row || typeof row.item !== 'string' || !row.item.trim() || row.item.length > 200 || typeof row.ok !== 'boolean') invalid('audit checklist needs item (1–200 characters) and boolean ok');
      if (row.note !== undefined && (typeof row.note !== 'string' || row.note.length > 500)) invalid('audit checklist note must contain at most 500 characters');
      return { item: row.item.trim(), ok: row.ok, ...(row.note === undefined ? {} : { note: row.note }) };
    });
  }
  return out;
}

export function auditEvidenceSnapshot(task) {
  const rows = (task.evidence || []).filter((row) => !row.supersededAt).map((row) => ({
    id: row.id ?? null, kind: row.kind ?? null, ref: row.ref ?? null, hash: row.hash ?? null,
  }));
  rows.sort((a, b) => { const x = canonicalJSON(a); const y = canonicalJSON(b); return x < y ? -1 : x > y ? 1 : 0; });
  return { count: rows.length, digest: sha256(canonicalJSON(rows)) };
}

function canonicalSet(rows) {
  return [...new Set(rows.map((row) => canonicalJSON(row)))].sort();
}

/** Immutable delivery scope: administrative filing, ordering and revision are excluded. */
export function auditScopeDigest(task) {
  const acceptance = (task.acceptance || []).map((row) => ({
    id: row.id ?? null, text: row.text ?? '', met: Boolean(row.met),
    requiredKinds: canonicalSet(row.requiredKinds || []), evidenceIds: canonicalSet(row.evidenceIds || []),
  }));
  const evidence = (task.evidence || []).filter((row) => !row.supersededAt).map((row) => ({
    id: row.id ?? null, kind: row.kind ?? null, ref: row.ref ?? null, hash: row.hash ?? null,
    acceptanceId: row.acceptanceId ?? null,
    producedBy: { ...identity(row.producedBy), callId: row.producedBy?.callId ?? null }, fixed: row.fixed ?? null,
    fixedState: row.fixedState ?? null,
  }));
  return sha256(canonicalJSON({
    v: AUDIT_SCOPE_VERSION, title: task.title ?? '', description: task.description ?? '', deps: canonicalSet(task.deps || []),
    gate: Boolean(task.requiresAudit || task.labels?.includes('gate:audit')),
    acceptance: canonicalSet(acceptance), evidence: canonicalSet(evidence), workers: canonicalSet(auditWorkers(task)),
  }));
}

export function agentAuditValid(task) {
  const audit = task.lastAudit;
  return Boolean(audit?.verdict === 'pass' && audit.gate === true
    && typeof audit.report === 'string' && audit.report.trim().length >= 20 && audit.report.trim().length <= 4000
    && Number.isInteger(audit.taskRev) && audit.taskRev > 0 && audit.taskRev <= task.rev
    && audit.by?.kind === 'agent' && Boolean(audit.by.sessionId)
    && Array.isArray(audit.workers) && audit.workers.length > 0
    && !audit.workers.some((worker) => sameAuditIdentity(worker, audit.by))
    && independenceProblem(task, audit.by) === null
    && canonicalJSON(canonicalSet(audit.workers)) === canonicalJSON(canonicalSet(auditWorkers(task)))
    && canonicalJSON(audit.evidence) === canonicalJSON(auditEvidenceSnapshot(task))
    && audit.scopeVersion === AUDIT_SCOPE_VERSION && typeof audit.scopeDigest === 'string' && audit.scopeDigest === auditScopeDigest(task));
}

export function assertAuditScopeUnchanged(previous, next) {
  if (previous.state !== 'done' || previous.verifiedBy !== 'agent') return;
  if (auditScopeDigest(previous) === auditScopeDigest(next)) return;
  throw new BoardError('audit-scope-locked', 'Reopen this audited task before changing its delivery scope; administrative plan filing remains allowed.', {
    status: 409, details: { taskId: previous.id, next: 'Ask a human to reopen the task, then change the requirements and submit for a new explicit audit.' },
  });
}

export function makeAuditRecord(task, actor, at, verdict, payload, warnings = []) {
  return {
    id: newId('aud'), at, gate: Boolean(task.requiresAudit || task.labels?.includes('gate:audit')),
    by: { kind: actor.kind, sessionId: actor.sessionId || null, agentId: actor.agentId || null, via: actor.via || null },
    verdict, report: payload.report, checklist: payload.checklist || [],
    evidence: auditEvidenceSnapshot(task), workers: auditWorkers(task), scopeVersion: AUDIT_SCOPE_VERSION, scopeDigest: auditScopeDigest(task),
    warnings: warnings.slice(0, 20).map((row) => ({ ...row })), taskRev: task.rev,
  };
}
