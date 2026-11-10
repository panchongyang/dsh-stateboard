// 任务排名、计划元信息与工作区目标的纯选择器；宿主跳转副作用由会话适配器承担。
import type { Task, Plan, Board, PlanRef, Project, Session, SessionTarget, TaskSession } from './types.ts';
import { isGate } from './filters.ts';

/** 活动任务按优先级、更新时间升序排名；完成与取消任务不参与。 */
export function priorityRanks(tasks: Task[]): Record<string, number> {
  const active = (tasks || []).filter((task) => {
    return task && task.id && task.state !== 'done' && task.state !== 'canceled';
  });
  const sorted = active.slice().sort((a, b) => {
    const pa = a.priority == null ? 100 : a.priority;
    const pb = b.priority == null ? 100 : b.priority;
    if (pa !== pb) return pa - pb;
    return String(a.updatedAt || '').localeCompare(String(b.updatedAt || ''));
  });
  const out: Record<string, number> = {};
  // 排名只针对活动且有身份的任务；复制后排序，不能改变输入列表次序。
  sorted.forEach((task, index) => { out[task.id!] = index + 1; });
  return out;
}

/** 优先级徽标的唯一强调阈值：只突出前 3 名，组件不自行复制排名规则。 */
export const TOP_RANK_LIMIT = 3;

export function rankTier(rank: number): 'top' | 'rest' {
  return Number.isInteger(rank) && rank >= 1 && rank <= TOP_RANK_LIMIT ? 'top' : 'rest';
}

/** 计划目录按看板活动计划、计划列表、聚焦计划的顺序取首次出现；较慢请求不能覆盖已选快照。 */
export function planCatalog(board: Board | null, plans?: Plan[]): Plan[] {
  const out: Plan[] = [];
  const seen: Record<string, boolean> = {};
  function add(plan: Plan): void {
    if (!plan || !plan.id || seen[plan.id]) return;
    seen[plan.id] = true;
    const steps = Array.isArray(plan.steps) ? plan.steps : [];
    out.push({
      id: plan.id,
      title: plan.title || '',
      steps: steps.map((step) => {
        return { id: step && step.id, title: (step && step.title) || '' };
      }),
    });
  }
  // 按既有来源顺序取首次命中，后来的同名计划不能覆盖先前选定的快照。
  if (board && Array.isArray(board.plans)) board.plans.forEach(add);
  if (Array.isArray(plans)) plans.forEach(add);
  if (board && board.plan) add(board.plan);
  return out;
}

/** 卡片显示计划与步骤名称，缺少计划引用表示计划外。 */
export function planMeta(catalog: Plan[] | undefined, planRef?: PlanRef): { key: string; title: string; planTitle: string | undefined; stepTitle: string; known: boolean } {
  if (!planRef) return { key: 'out', title: '计划外', planTitle: '', stepTitle: '', known: false };
  let plan: Plan | null = null;
  const list = Array.isArray(catalog) ? catalog : [];
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] && list[i].id === planRef.planId) { plan = list[i]; break; }
  }
  let stepTitle = '';
  if (plan && planRef.stepId && Array.isArray(plan.steps)) {
    for (let j = 0; j < plan.steps.length; j += 1) {
      if (plan.steps[j] && plan.steps[j].id === planRef.stepId) { stepTitle = plan.steps[j].title || ''; break; }
    }
  }
  const planTitle = plan ? plan.title : '';
  const title = planTitle
    ? (stepTitle ? planTitle + ' · ' + stepTitle : planTitle)
    : (stepTitle || '计划内');
  return {
    key: 'plan:' + planRef.planId + (planRef.stepId ? ':' + planRef.stepId : ''),
    title,
    planTitle,
    stepTitle,
    known: Boolean(plan),
  };
}

/** 从看板计划中按步骤身份投影任务所属步骤标题。 */
export function planStepTitle(plan: Plan, planRef: PlanRef): string {
  if (!plan || !planRef || !planRef.stepId) return '';
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  for (let i = 0; i < steps.length; i += 1) {
    if (steps[i] && steps[i].id === planRef.stepId) return steps[i].title || '';
  }
  return '';
}

/** 需处理数量为审计评审、阻塞与待对账的去重并集，不能重复计数。 */
export function needYouCount(board: Board): number {
  const seen: Record<string, boolean> = {};
  function add(card: Task) { if (card && card.id) seen[card.id] = true; }
  const attention = (board && board.attention) || {};
  (attention.blocked || []).forEach(add);
  (attention.interrupted || []).forEach(add);
  const review = (board && board.columns && board.columns.review) || [];
  review.forEach((card) => { if (isGate(card)) add(card); });
  return Object.keys(seen).length;
}

/** 路径格式只归一化分隔符与末尾斜线；大小写比较由 comparablePath 决定。 */
export function normalizeWorkspacePath(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '');
}

/** Windows 路径按大小写不敏感比较，其他路径保持精确大小写。 */
export function comparablePath(value: unknown): string {
  const text = normalizeWorkspacePath(value);
  if (text === '') return '';
  const windows = /^[a-z]:\//i.test(text) || text.indexOf('//') === 0;
  return windows ? text.toLowerCase() : text;
}

/** 精确目录优先，其次最近祖先项目，否则无匹配；额外返回是否精确，供页面说明。 */
export function matchProjectByCwd(projects: Project[] | null | undefined, cwd: unknown): { project: Project; exact: boolean } | null {
  const target = comparablePath(cwd);
  if (target === '') return null;
  const list = Array.isArray(projects) ? projects : [];
  let best: Project | null = null;
  let bestLength = -1;

  // 精确匹配立即返回；祖先匹配要求目录边界，防止同前缀的兄弟目录误命中。
  for (let i = 0; i < list.length; i += 1) {
    const project = list[i];
    const root = comparablePath(project && project.workspacePath);
    if (root === '') continue;
    if (root === target) return { project, exact: true };
    if (root.length > bestLength && target.length > root.length && target.slice(0, root.length + 1) === root + '/') {
      best = project;
      bestLength = root.length;
    }
  }
  return best ? { project: best, exact: false } : null;
}

/** 任务跳转优先租约持有者，其次最新证据生产者，最后退回创建者。 */
export function pickTaskSession(task: Task): TaskSession {
  if (!task) return { sessionId: null, source: null };
  if (task.owner && task.owner.sessionId) return { sessionId: task.owner.sessionId, source: 'owner' };
  const items = (task.evidence || []).slice().sort((a, b) => {
    return String(b.at || '').localeCompare(String(a.at || ''));
  });
  for (let i = 0; i < items.length; i += 1) {
    const produced = items[i] && items[i].producedBy;
    if (produced && produced.sessionId) return { sessionId: produced.sessionId, source: 'evidence' };
  }
  if (task.createdBy && task.createdBy.sessionId) return { sessionId: task.createdBy.sessionId, source: 'creator' };
  return { sessionId: null, source: null };
}

/** 工作区只选择最新的非空、非子代理会话；不跨目录猜测。 */
export function pickLatestSession(byId: Record<string, Session> | undefined, workspacePath: unknown): SessionTarget | null {
  const target = comparablePath(workspacePath);
  if (target === '') return null;
  let best: SessionTarget | null = null;
  // 时间相同时保留首次遍历命中，不能通过重新排序改变会话选择。
  Object.keys(byId || {}).forEach((id) => {
    const entry = byId![id] || {};
    if (!entry.cwd || entry.blank || entry.origin === 'subagent') return;
    if (comparablePath(entry.cwd) !== target) return;
    if (!best || (entry.updatedAt || 0) > (best.updatedAt || 0)) best = { sessionId: id, updatedAt: entry.updatedAt || 0 };
  });
  return best;
}
