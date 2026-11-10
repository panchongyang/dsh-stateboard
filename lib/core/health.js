import { progressOf } from './model.js';
import { policyOf } from './normalize.js';
import { auditEvidence } from './evidence.js';
import { checkState } from './fsck.js';
import { isLeaseReclaimable } from './lease.js';

/** Cheap observation only. Never re-read evidence, blobs, bindings or Git. */
export function healthSummary(handle) {
  handle._ensureOpen();
  const warnings = [];
  const now = handle._nowMs();
  for (const lease of handle.leases.values()) {
    if (isLeaseReclaimable(handle, lease, now)) warnings.push('lease reclaimable: ' + lease.taskId);
    else if (Date.parse(lease.expiresAt) <= now) warnings.push('lease expired but renewable: ' + lease.taskId);
  }
  warnings.push('evidence unchecked: brief is an in-memory summary; request health for a full isolated audit');
  return { ok: false, evidenceAudit: { status: 'unchecked' }, total: warnings.length, warnings: warnings.slice(0, 5) };
}

/** Synchronous compatibility implementation; hosts use the isolated adapter. */
export function fullHealth(handle, { includeEvidenceWarnings = false } = {}) {
  const now = handle._nowMs();
  const leases = [...handle.leases.values()];
  const checked = checkState(handle.state, { leases, now });
  const warnings = checked.warnings.slice();
  const graceMs = policyOf(handle.state.project).leaseGraceSec * 1000;
  for (const lease of leases) {
    if (isLeaseReclaimable(handle, lease, now)) {
      warnings.push('lease reclaimable: ' + lease.taskId);
    } else if (Date.parse(lease.expiresAt) <= now) {
      warnings.push('lease expired but renewable: ' + lease.taskId + ' (grace until ' + new Date(Date.parse(lease.expiresAt) + graceMs).toISOString() + ')');
    }
  }
  let evidenceProblems = 0;
  for (const task of Object.values(handle.state.tasks)) {
    if (!Array.isArray(task.evidence) || task.evidence.length === 0) continue;
    for (const warning of auditEvidence(handle, task)) {
      if (warning.severity !== 'error' && !includeEvidenceWarnings) continue;
      evidenceProblems += 1;
      if (evidenceProblems <= 10) warnings.push('evidence ' + warning.code + ': ' + task.id + ' ' + warning.message);
    }
  }
  const intents = Object.values(handle.state.intents).filter((intent) => intent.status === 'open');
  return {
    ok: warnings.length === 0,
    hashChain: 'ok',
    seq: handle.rev,
    lastAt: handle.state.project.updatedAt,
    readOnly: handle.readOnly,
    leases,
    intents,
    checks: checked.checks,
    warnings,
    counts: progressOf(handle.state),
  };
}
