// 已筛选任务的展示分桶：不修改卡片、计划目录或输入顺序，由调用方决定桶内排序。
import type { Task, Plan } from './types.ts';
import { planMeta } from './selectors.ts';
import { stateLabel } from './labels.ts';

export interface TaskGroup { key: string; title: string; items: Task[] }

export const GROUP_MODES = ['none', 'status', 'label', 'plan'];

export const GROUP_OPTIONS = [
  { value: 'none', label: '不分组' },
  { value: 'status', label: '按状态' },
  { value: 'label', label: '按标签' },
  { value: 'plan', label: '按计划步骤' },
];

/** 只接受已知分组模式，未知存储或界面值回到不分组。 */
export function normalizeGroupMode(value: string): string {
  return GROUP_MODES.indexOf(value) >= 0 ? value : 'none';
}

// 状态顺序来自生命周期，不依赖标签对象的键顺序；阻塞与待对账排在终态之前。
const STATUS_ORDER = ['backlog', 'ready', 'in_progress', 'review', 'blocked', 'interrupted', 'done', 'canceled'];

function groupByStatus(tasks: Task[]): TaskGroup[] {
  const buckets: Record<string, Task[]> = {};
  const seen: string[] = [];
  tasks.forEach((task) => {
    const key = task && task.state ? task.state : 'unknown';
    if (!buckets[key]) { buckets[key] = []; seen.push(key); }
    buckets[key].push(task);
  });
  const ordered = STATUS_ORDER.filter((key) => { return Boolean(buckets[key]); });
  const extra = seen.filter((key) => { return STATUS_ORDER.indexOf(key) < 0; }).sort();
  return ordered.concat(extra).map((key) => {
    return { key: 'state:' + key, title: stateLabel(key), items: buckets[key] };
  });
}

function groupByLabel(tasks: Task[]): TaskGroup[] {
  const buckets: Record<string, Task[]> = {};
  const order: string[] = [];
  function add(label: string, task: Task): void {
    if (!buckets[label]) { buckets[label] = []; order.push(label); }
    buckets[label].push(task);
  }
  tasks.forEach((task) => {
    const labels = task && Array.isArray(task.labels) ? task.labels.filter(Boolean) : [];
    const seen: string[] = [];
    labels.forEach((label) => {
      if (seen.indexOf(label) >= 0) return;
      seen.push(label);
      add(label, task);
    });
    if (seen.length === 0) add('无标签', task);
  });
  // 多标签任务可进入多个桶，但同一任务的重复标签只计一次；无标签桶置后。
  const ordered = order.filter((label) => { return label !== '无标签'; }).sort();
  if (order.indexOf('无标签') >= 0) ordered.push('无标签');
  return ordered.map((label) => {
    return { key: 'label:' + label, title: label, items: buckets[label] };
  });
}

function groupByPlan(tasks: Task[], plans?: Plan[]): TaskGroup[] {
  const catalog = Array.isArray(plans) ? plans : [];
  const buckets: Record<string, TaskGroup> = {};
  const order: string[] = [];
  tasks.forEach((task) => {
    const meta = planMeta(catalog, task && task.planRef);
    if (!buckets[meta.key]) {
      buckets[meta.key] = { key: meta.key, title: meta.title, items: [] };
      order.push(meta.key);
    }
    buckets[meta.key].items.push(task);
  });

  // 已知步骤按计划目录排列；未知引用保留首次出现顺序，计划外始终置后。
  const ordered = [];
  const used: Record<string, boolean> = {};
  catalog.forEach((plan) => {
    const steps = Array.isArray(plan.steps) ? plan.steps : [];
    steps.forEach((step) => {
      const key = 'plan:' + plan.id + ':' + step.id;
      if (buckets[key] && !used[key]) { used[key] = true; ordered.push(key); }
    });
    const planKey = 'plan:' + plan.id;
    if (buckets[planKey] && !used[planKey]) { used[planKey] = true; ordered.push(planKey); }
  });
  order.forEach((key) => {
    if (key === 'out' || used[key]) return;
    used[key] = true;
    ordered.push(key);
  });
  if (buckets.out) ordered.push('out');
  return ordered.map((key) => { return buckets[key]; });
}

/** 对已筛选列表分组；不分组返回空组以保留平铺队列。多标签任务有意同时出现在多个桶中。 */
export function groupTasks(tasks: Task[], mode: string, plans?: Plan[]): TaskGroup[] {
  const list = Array.isArray(tasks) ? tasks : [];
  const value = normalizeGroupMode(mode);
  if (value === 'status') return groupByStatus(list);
  if (value === 'label') return groupByLabel(list);
  if (value === 'plan') return groupByPlan(list, plans);
  return [];
}
