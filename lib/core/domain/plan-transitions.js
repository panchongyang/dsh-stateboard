// Plan model: legal head edges and immutable version replacement.
import { BoardError } from '../errors.js';
import { planTitleConflict } from '../../shared/plan-rules.js';

export function draftHead(id, title, draft, at) {
  return { id, title, status: 'draft', rev: 1, currentVersion: 0, draft, archivedFrom: null, createdAt: at, updatedAt: at };
}
export function assertPublishHead(head) {
  if (head.status === 'archived') throw new BoardError('plan-archived', 'plan is archived', { status: 409 });
  if (head.status !== 'draft') throw new BoardError('plan-not-draft', 'plan is ' + head.status + ', not draft', { status: 409 });
}
export function publishedHead(input, at) {
  const { planId, title, head } = input;
  if (head) assertPublishHead(head);
  return { id: planId, title, status: 'active', rev: head ? head.rev + 1 : 2, currentVersion: 1,
    draft: null, archivedFrom: null, createdAt: head ? head.createdAt : at, updatedAt: at };
}
export function planVersionPayload(fields) {
  const { id, version, title, goal, assumptions, risks, steps, createdAt, publishedAt, supersedes } = fields;
  const plan = { id, version, status: 'published', title, goal, assumptions, risks, steps, createdAt, publishedAt };
  if (supersedes !== undefined) plan.supersedes = supersedes;
  return plan;
}
export function revisePlanHead(head, version, at, title = head.title) {
  if (head.status !== 'active') throw new BoardError('plan-not-active', 'plan is ' + head.status + ', not active', { status: 409 });
  if (version !== head.currentVersion + 1) throw new BoardError('stale-revision', 'plan revision must follow the current version', { status: 409 });
  return { ...head, title, rev: head.rev + 1, currentVersion: version, updatedAt: at };
}
export function supersedePlanVersion(plan, replacement) {
  if (plan.status !== 'published' || replacement.planId !== plan.id || replacement.version !== plan.version + 1) throw new BoardError('illegal-transition', 'only the current published plan version can be superseded by its successor', { status: 409 });
  return { ...plan, status: 'superseded', supersededBy: replacement };
}
export function archivePlan(head, at) {
  if (head.status === 'archived') throw new BoardError('plan-archived', 'plan is already archived', { status: 409 });
  if (!['draft', 'active'].includes(head.status)) throw new BoardError('illegal-transition', 'plan cannot be archived', { status: 409 });
  return { ...head, status: 'archived', archivedFrom: head.status, rev: head.rev + 1, updatedAt: at };
}
export function unarchivePlan(head, at) {
  if (head.status !== 'archived') throw new BoardError('illegal-transition', 'plan is not archived', { status: 409 });
  const status = head.archivedFrom || 'active';
  if (!['draft', 'active'].includes(status)) throw new BoardError('illegal-transition', 'invalid archived plan origin', { status: 409 });
  return { ...head, status, archivedFrom: null, rev: head.rev + 1, updatedAt: at };
}

export function assertPlanTitleUnique(heads, title, excludeId = null) {
  const conflict = planTitleConflict(heads, title, excludeId);
  if (conflict) throw new BoardError('plan-title-taken', 'plan title already taken: ' + title, { status: 409, details: conflict });
}
