// The only observed submission facts the task commands can send to the model.
import { evidenceForReview } from '../domain/work-transitions.js';

export function observeReviewEvidence(read, task, rawEvidence, actor, stage) {
  const at = read.clock().toISOString();
  const observedDocs = new Map();
  const observed = rawEvidence.map(raw => read.evidence.normalize(task, raw, at, actor || {}, observedDocs));
  const materials = observed.map(({ id, kind, ref, hash, fixedState, fixedReason, summary, acceptanceId }) =>
    ({ id, kind, ref, hash, fixedState, fixedReason, summary, acceptanceId }));
  const captures = [...observedDocs].filter(([, sample]) => !sample.currentOnly)
    .map(([docId, { contentHash, size }]) => ({ docId, contentHash, size }));
  const capturedDocs = new Set(captures.map(sample => sample.docId));
  const capturedRefs = new Set(materials.filter(row => row.kind === 'doc' && capturedDocs.has(row.ref)).map(row => row.id));
  const fileIdentities = Object.fromEntries([...task.evidence, ...observed]
    .filter(row => row.kind === 'file' && !row.supersededAt).map(row => [row.id, read.evidence.identity(row)]));
  // This isolated preview is input to the observation port, never an operation argument.
  const { next } = evidenceForReview(task, materials, fileIdentities, at, actor);
  return { materials, fileIdentities, captures, warnings: read.evidence.assertReview(next, stage, { capturedRefs }) };
}
