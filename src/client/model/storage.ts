// 视图与筛选的本地持久化：在 localStorage 边界归一化，读取失败不阻塞页面。
import type { Filters } from './types.ts';
import { normalizeGroupMode } from './grouping.ts';
import { STATE_LABELS } from './labels.ts';

export const LAST_PROJECT_KEY = 'projectBoard.lastProject';

export function readLastProject(): string {
  try {
    if (typeof localStorage === 'undefined') return '';
    return localStorage.getItem(LAST_PROJECT_KEY) || '';
  } catch (error) {
    return '';
  }
}

export function saveLastProject(id: string): void {
  try {
    if (typeof localStorage !== 'undefined' && id) localStorage.setItem(LAST_PROJECT_KEY, id);
  } catch (error) { /* private mode */ }
}

// 视图与筛选独立保存，切换布局不应清空筛选。
export const VIEW_KEY = 'projectBoard.view';
export const VIEWS = ['board', 'list'];

/** 未知的持久化视图回到看板，避免旧值使布局不可用。 */
export function normalizeView(value: string | null): string {
  return VIEWS.indexOf(value!) >= 0 ? value! : 'board';
}

export function readView(): string {
  try {
    if (typeof localStorage === 'undefined') return 'board';
    return normalizeView(localStorage.getItem(VIEW_KEY));
  } catch (error) { return 'board'; }
}

export function saveView(value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(VIEW_KEY, normalizeView(value));
  } catch (error) { /* private mode */ }
}

export const FILTERS_KEY = 'projectBoard.filters';

/** 默认筛选也是清除筛选的目标，每次返回独立对象。 */
export function defaultFilters(): Filters {
  return { query: '', state: null, gateOnly: false, plan: null, group: 'none' };
}

/** 未知状态、计划或分组模式回到关闭状态，避免旧存储悄悄筛空看板。 */
export function normalizeFilters(raw: unknown): Filters {
  // 存储内容可能来自旧版本或手工修改；未知选项必须关闭，不能悄悄筛空看板。
  const value: Record<string, unknown> = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const state = typeof value.state === 'string' && STATE_LABELS[value.state] ? value.state : null;
  const plan = value.plan === 'in' || value.plan === 'out' ? value.plan : null;
  return {
    query: typeof value.query === 'string' ? value.query : '',
    state,
    gateOnly: value.gateOnly === true,
    plan,
    group: normalizeGroupMode(value.group as string),
  };
}

// 禁用存储、损坏 JSON 或访问异常都退回同一组默认值。
export function readFilters(): Filters {
  try {
    if (typeof localStorage === 'undefined') return defaultFilters();
    const raw = localStorage.getItem(FILTERS_KEY);
    return raw ? normalizeFilters(JSON.parse(raw)) : defaultFilters();
  } catch (error) {
    return defaultFilters();
  }
}

export function saveFilters(value: unknown): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(FILTERS_KEY, JSON.stringify(normalizeFilters(value)));
  } catch (error) { /* private mode */ }
}
