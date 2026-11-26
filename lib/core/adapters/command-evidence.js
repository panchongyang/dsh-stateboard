// Observation capabilities return facts. Only model operations make log records.
import { assertAcceptanceEvidence, assertEvidenceReadyForReview, auditEvidence, evidenceIdentity, normalizeEvidence, supersedeResubmitted } from '../evidence.js';

export function createEvidencePort(facts, documents) {
  return Object.freeze({
    normalize(task, raw, at, actor, observedDocs) {
      return normalizeEvidence(facts, task, raw, at, actor, observedDocs && documents.hasOwningSpace ? (doc) => {
        if (!observedDocs.has(doc.id)) observedDocs.set(doc.id, documents.capture(doc, { allowUnretained: true }));
        return observedDocs.get(doc.id);
      } : undefined);
    },
    supersede: (task, added, at) => supersedeResubmitted(facts, task, added, at),
    assertCoverage: assertAcceptanceEvidence,
    assertReview: (task, stage, options) => assertEvidenceReadyForReview(facts, task, stage, options),
    audit: task => auditEvidence(facts, task), identity: row => evidenceIdentity(facts, row),
  });
}
