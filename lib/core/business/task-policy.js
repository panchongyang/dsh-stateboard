// Pure use-case decisions. Facts (including evidence observations) are inputs;
// no handle, filesystem, clock, Git or ID generator belongs to a policy.
import { BoardError } from '../errors.js';
import { isAuditGate, normalizeAudit, verificationRoleProblem } from '../audit.js';
import { normalizeSideEffects } from '../intent.js';
import { resolveAuditGate } from '../normalize.js';

export function beginDecision(openIntent, summary) {
  if (openIntent) throw new BoardError('illegal-transition', 'an intent is already open', { status: 409 });
  const text = typeof summary === 'string' ? summary.trim() : '';
  if (text === '') throw new BoardError('invalid-command', 'begin requires a summary', { status: 400 });
  return { summary: text };
}
export function submissionDecision(intent, policy, evidence) {
  if (!intent && policy.requireIntentFor === 'all') throw new BoardError('illegal-transition', 'begin an intent before submitting', { status: 409 });
  const rawEvidence = Array.isArray(evidence) ? evidence : [];
  if (rawEvidence.length === 0) throw new BoardError('missing-evidence', 'submit requires at least one evidence item', { status: 422 });
  return { rawEvidence };
}
export function verificationDecision(task, cmd) {
  const isHuman = cmd.actor?.kind === 'human';
  const problem = verificationRoleProblem(task, cmd.actor);
  if (problem) throw new BoardError('forbidden-role', 'verification requires a human or an authorized agent; audit gates require independence', { status: 403, details: { reason: problem } });
  if (!isHuman && (Object.hasOwn(cmd, 'refreshDrift') || Object.hasOwn(cmd, 'acknowledgeDrift'))) throw new BoardError('forbidden-role', 'drift refresh and acknowledgement are human only', { status: 403, details: { reason: 'drift-human-only' } });
  if (!task.acceptance.every((acceptance) => acceptance.met)) throw new BoardError('acceptance-unmet', 'acceptance is not fully met', { status: 422 });
  return { isHuman, payload: normalizeAudit(cmd.audit, { required: !isHuman && isAuditGate(task) }) };
}
export function assertDriftDecision(warnings, cmd, reason) {
  const hard = warnings.filter((warning) => warning.severity === 'error');
  if (hard.length === 0) return;
  const isHuman = cmd.actor?.kind === 'human';
  if (!isHuman || cmd.acknowledgeDrift !== true) throw new BoardError('evidence-drift', 'evidence no longer matches the workspace; fix or re-submit before verify', {
    status: 409, details: { warnings: hard, canAcknowledgeDrift: isHuman,
      canRefresh: isHuman && hard.some((warning) => warning.code === 'file-drift'),
      next: isHuman ? 'refresh or acknowledge drift with a reason' : 'reject for rework, or ask a human to handle the drift' },
  });
  if (reason.length < 4) throw new BoardError('invalid-command', 'acknowledgeDrift requires a reason (at least 4 characters)', { status: 400 });
}
export function rejectionDecision(cmd, lease) {
  const reason = typeof cmd.reason === 'string' ? cmd.reason.trim() : '';
  if (reason === '') throw new BoardError('invalid-command', 'reject requires a reason', { status: 400 });
  const isHuman = cmd.actor?.kind === 'human';
  if (!isHuman && (cmd.actor?.kind !== 'agent' || (lease && lease.sessionId !== cmd.actor?.sessionId))) throw new BoardError('forbidden-role', 'only an agent, live lease owner or a human can reject', { status: 403 });
  return { reason, isHuman };
}
export function cancelDecision(task, actor, lease) {
  if (actor?.kind !== 'human' && isAuditGate(task)) throw new BoardError('forbidden-role', 'only a human can cancel a gated task', { status: 403, details: { gateLocked: true } });
  if (!actor || (actor.kind !== 'human' && lease && lease.sessionId !== actor.sessionId)) throw new BoardError('forbidden-role', 'only the lease owner or a human can cancel', { status: 403 });
}

export function gateDecision(task, requiresAudit, actor) {
  if (typeof requiresAudit !== 'boolean') throw new BoardError('invalid-command', 'requiresAudit must be a boolean', { status: 400 });
  if (actor?.kind !== 'human' && (task.state === 'review' || !requiresAudit)) {
    throw new BoardError('forbidden-role', 'agents cannot disable the audit gate; a human must do it', { status: 403, details: { gateLocked: true, reason: task.state === 'review' ? 'review-gate-locked' : 'gate-locked' } });
  }
  return isAuditGate(task) !== requiresAudit;
}

export function metadataDecision(task, input, actor, hasLease) {
  // Check the requested gate change before checking the lease, as in task.update.
  resolveAuditGate(input, task, actor);
  return hasLease || !(actor?.kind === 'human' || ['backlog', 'ready'].includes(task.state));
}

export function stoppedIntentDecision(task, intent, cmd, closeReason) {
  if (!intent) {
    if (cmd.intent !== undefined) throw new BoardError('invalid-command', 'intent settlement is only valid while an intent is open', { status: 400, details: { taskId: task.id } });
    return null;
  }
  const outcome = cmd.intent?.outcome;
  if (outcome !== 'stopped') {
    throw new BoardError('intent-unresolved', 'open intent ' + intent.id + ' cannot be closed by ' + closeReason + '; declare intent.outcome=stopped with sideEffects, or use task.interrupt', {
      status: 409,
      details: { taskId: task.id, intentId: intent.id, outcome: outcome === undefined ? 'missing' : String(outcome), hint: 'use task.interrupt, then task.reconcile(resume|completed|discard)', allowedOps: ['task.interrupt'] },
    });
  }
  return {
    intentId: intent.id,
    outcome,
    sideEffects: normalizeSideEffects(cmd.intent.sideEffects, { required: true }),
    note: String(cmd.intent.note || cmd.note || cmd.reason || '').slice(0, 2000),
  };
}
