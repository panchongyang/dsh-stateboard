import { BoardError } from '../../errors.js';
import { planLiveWorkFact } from '../../../shared/plan-rules.js';
import { draftHead, publishedHead, planVersionPayload, archivePlan, unarchivePlan, assertPublishHead } from '../plan-transitions.js';
import { fields, id, invalid, requireHead, notArchived, headRev, activeVersion, titleOf, metadata, draftOf, stepsOf, revisedVersion, markVersion, requireTransition } from './plans-shared.js';

export function createDraft(work, args) {
  fields(args, ['planId', 'title', 'goal', 'assumptions', 'risks', 'steps']);
  const planId = id(args.planId);
  if (work.state.planHeads[planId]) invalid('plan already exists: ' + planId);
  const title = titleOf(work, args.title);
  const head = draftHead(planId, title, draftOf(args), work.clock().toISOString());
  return { events: [{ type: 'plan/created', data: head }], entityRev: head.rev };
}
export function editDraft(work, args) {
  fields(args, ['planId', 'expectedRev', 'title', 'goal', 'assumptions', 'risks', 'steps']);
  const head = requireHead(work, args.planId);
  assertPublishHead(head);
  headRev(head, args.expectedRev);
  const title = typeof args.title === 'string' && args.title.trim() ? titleOf(work, args.title, head.id) : head.title;
  const next = { ...head, title, draft: draftOf(args, head.draft || {}), rev: head.rev + 1, updatedAt: work.clock().toISOString() };
  return { events: [{ type: 'plan/updated', data: next }], entityRev: next.rev };
}
export function publishVersion(work, args) {
  fields(args, ['planId', 'expectedRev', 'steps']);
  const head = requireHead(work, args.planId);
  assertPublishHead(head);
  headRev(head, args.expectedRev);
  const steps = stepsOf(args.steps);
  const at = work.clock().toISOString();
  const plan = planVersionPayload({ id: head.id, version: 1, title: head.title, ...metadata(head.draft || {}),
    steps, createdAt: head.createdAt, publishedAt: at });
  const next = publishedHead({ planId: head.id, title: head.title, head }, at);
  markVersion(work, head.id, 1, 'publish', steps);
  return { events: [{ type: 'plan/published', data: plan, head: next }], entityRev: next.rev };
}
export function reviseVersion(work, args) {
  fields(args, ['planId', 'baseVersion', 'title', 'goal', 'assumptions', 'risks', 'steps']);
  const { head, plan } = activeVersion(work, args.planId, args.baseVersion);
  return revisedVersion(work, head, plan, args, stepsOf(args.steps, plan.steps));
}
export function rename(work, args) {
  fields(args, ['planId', 'expectedRev', 'title']);
  const head = requireHead(work, args.planId);
  notArchived(head);
  headRev(head, args.expectedRev);
  const next = { ...head, title: titleOf(work, args.title, head.id), rev: head.rev + 1, updatedAt: work.clock().toISOString() };
  return { events: [{ type: 'plan/updated', data: next }], entityRev: next.rev };
}
export function archive(work, args) {
  fields(args, ['planId', 'expectedRev']);
  const head = requireHead(work, args.planId);
  notArchived(head);
  headRev(head, args.expectedRev);
  const liveWork = planLiveWorkFact(work.state, head, work.leases);
  if (liveWork) throw new BoardError('plan-has-live-work', 'plan has live work on ' + liveWork.taskId, { status: 409 });
  const at = work.clock().toISOString();
  const next = archivePlan(head, at);
  const events = [{ type: 'plan/archived', data: next }];
  if (work.state.project.focusPlanId === head.id) events.push({ type: 'project/updated', data: { ...work.state.project, focusPlanId: null, updatedAt: at } });
  return { events, entityRev: next.rev };
}
export function unarchive(work, args) {
  fields(args, ['planId', 'expectedRev']);
  const head = requireHead(work, args.planId);
  if (head.status !== 'archived') throw new BoardError('illegal-transition', 'plan is not archived', { status: 409 });
  headRev(head, args.expectedRev);
  const next = unarchivePlan(head, work.clock().toISOString());
  return { events: [{ type: 'plan/unarchived', data: next }], entityRev: next.rev };
}
function focusEvents(work, planId) {
  if (planId !== null) {
    const head = requireHead(work, planId);
    if (head.status !== 'active') throw new BoardError('plan-not-active', 'focus requires an active plan', { status: 409 });
  }
  if (work.state.project.focusPlanId === planId) return [];
  const project = { ...work.state.project, focusPlanId: planId, updatedAt: work.clock().toISOString() };
  return [{ type: 'plan/focused', data: { planId, projectRev: work.rev + 1 } }, { type: 'project/updated', data: project }];
}
export function focus(work, args, request) {
  fields(args, ['planId']);
  if (request.actor?.kind !== 'human') throw new BoardError('forbidden-role', 'plan.focus is human only', { status: 403 });
  const events = focusEvents(work, args.planId);
  return { events, ...(events.length ? { entityRev: work.rev + 1 } : {}) };
}
export function autoFocus(work, args) {
  fields(args, ['planId']);
  if (work.state.project.focusPlanId) return { events: [] };
  // This operation is publication-specific, not an agent focus override.
  requireTransition(work, args.planId, 1, ['publish']);
  const { plan } = activeVersion(work, args.planId, 1);
  if (plan.version !== 1) invalid('automatic focus requires initial publication');
  return { events: focusEvents(work, args.planId) };
}
