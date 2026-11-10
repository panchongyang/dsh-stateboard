// 任务卡筛选的纯投影：看板列与列表共用谓词，避免相同条件显示出不同任务。
import type { Task, Filters } from './types.ts';
export function isGate(card: Task): boolean {
  if (!card) return false;
  if (card.requiresAudit === true) return true;
  return Array.isArray(card.labels) && card.labels.indexOf('gate:audit') >= 0;
}

export function cardHaystack(card: Task): string {
  const parts = [card.title, card.id];
  if (Array.isArray(card.labels)) parts.push(card.labels.join(' '));
  if (card.owner && card.owner.sessionId) parts.push(card.owner.sessionId);
  if (card.planRef && card.planRef.planId) parts.push(card.planRef.planId);
  if (card.blocked) {
    parts.push(card.blocked.code || '');
    parts.push(card.blocked.note || '');
  }
  return parts.filter(Boolean).join(' ').toLowerCase();
}

/** 查询、状态与审计门共同筛选看板列，所有条件取交集。 */
export function filterCards(cards: Task[], filters?: Filters): Task[] {
  const options = filters || {};
  const query = String(options.query || '').trim().toLowerCase();
  const state = options.state || null;
  const gateOnly = options.gateOnly === true;
  const plan = options.plan || null;
  // 先缩小状态与归属范围，再做文本匹配；空查询不能误排除合法任务。
  return (cards || []).filter((card) => {
    if (!card) return false;
    if (state && card.state !== state) return false;
    if (gateOnly && !isGate(card)) return false;
    if (plan === 'in' && !card.planRef) return false;
    if (plan === 'out' && card.planRef) return false;
    if (!query) return true;
    return cardHaystack(card).indexOf(query) >= 0;
  });
}

export function hasActiveFilters(filters?: Filters): boolean {
  const options = filters || {};
  return Boolean(String(options.query || '').trim() || options.state || options.gateOnly || options.plan);
}
