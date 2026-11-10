// 计划编辑器的纯模型：表单播种、字段校验、差异摘要、CAS 命令与不可变更新。
// 编辑键仅在本模块递增，既有任务身份与草稿依赖引用不能随重新渲染变化。
import type { Acceptance, Task, PlanStep, Plan, EditTask, EditStep, EditForm, EditPayloadTask, EditPayloadStep, EditStepsResult, EditEntry, EditDiff, PlanCommand } from './types.ts';

let editKeySeq = 0;

/** 编辑键在当前模块实例内单调递增，生成后保持稳定以便引用。 */
export function planEditKey(prefix: string): string {
  editKeySeq += 1;
  return prefix + '_' + editKeySeq;
}

/** 支持半角与全角逗号，去空白、按首次出现去重，不改变依赖输入顺序。 */
export function planEditSplitList(text: unknown): string[] {
  const out: string[] = [];
  String(text == null ? '' : text)
    .split(/[,，]/)
    .forEach((part) => {
      const value = String(part).trim();
      if (value !== '' && out.indexOf(value) === -1) out.push(value);
    });
  return out;
}

/** 一行一条，丢弃空行与首尾空白，不对内容排序或去重。 */
export function planEditSplitLines(text: unknown): string[] {
  const out: string[] = [];
  String(text == null ? '' : text)
    .split(/\r?\n/)
    .forEach((line) => {
      const value = String(line).trim();
      if (value !== '') out.push(value);
    });
  return out;
}

/** 将验收项对象或旧字符串投影为表单文字，缺少文字只显示空串。 */
function acceptanceText(item: Acceptance | string): string {
  if (item == null) return '';
  if (typeof item === 'string') return item;
  return item.text == null ? '' : String(item.text);
}

/** 由步骤与可选完整任务表播种；草稿保留原 key，让依赖与差异仍指向同一任务。 */
export function planEditSeed(steps: PlanStep[], tasksById?: Record<string, Task> | null): EditForm {
  const form: EditForm = { steps: [] };
  const usedKeys = new Set<string>();

  // 完整任务优先补齐字段；草稿原 key 尽量保留，避免依赖与差异匹配断开。
  (Array.isArray(steps) ? steps : []).forEach((step) => {
    if (!step) return;
    const entry: EditStep & { tasks: EditTask[] } = { key: planEditKey('s'), id: step.id || '', title: step.title || '', tasks: [] };
    (Array.isArray(step.tasks) ? step.tasks : []).forEach((task) => {
      if (!task) return;
      const full = tasksById && task.id ? (tasksById[task.id] || null) : null;
      const source = full || task;
      let key = typeof task.key === 'string' ? task.key : '';
      if (key === '' || usedKeys.has(key)) {
        do { key = planEditKey('t'); } while (usedKeys.has(key));
      }
      usedKeys.add(key);
      const acceptance = Array.isArray(source.acceptance) ? source.acceptance : [];
      const deps = Array.isArray(source.deps) ? source.deps : [];
      const labels = Array.isArray(source.labels) ? source.labels : [];
      entry.tasks.push({
        key,
        taskId: full && full.id ? full.id : (task.id || ''),
        title: source.title || '',
        description: source.description || '',
        priority: String(Number.isInteger(source.priority) ? source.priority : 100),
        weight: String(typeof source.weight === 'number' && source.weight > 0 ? source.weight : 1),
        deps: deps.join(', '),
        acceptance: acceptance.map(acceptanceText).filter(Boolean).join('\n'),
        acceptanceOriginal: acceptance.map((item) => {
          return { text: acceptanceText(item), requiredKinds: item && Array.isArray(item.requiredKinds) ? item.requiredKinds.slice() : null };
        }),
        labels: labels.join(', '),
        requiresAudit: Boolean(source.requiresAudit),
      });
    });
    form.steps.push(entry);
  });
  if (form.steps.length === 0) {
    form.steps.push({ key: planEditKey('s'), id: '', title: '', tasks: [] });
  }
  return form;
}

/** 组装 plan.revise 步骤体：既有任务保留身份与编辑键，新任务只带计划内 key，身份由核心生成。 */
export function planEditSteps(form: EditForm | null): EditStepsResult {
  const errors = [];
  const stepsInput = form && Array.isArray(form.steps) ? form.steps : [];
  if (stepsInput.length === 0) errors.push('计划至少需要一个步骤');

  // 错误按步骤与任务输入顺序累积；去重索引只用于检查，不能改变提交顺序。
  const seenTaskIds = new Map<string, string>();
  const seenKeys = new Set<string>();
  const steps: EditPayloadStep[] = [];
  for (let s = 0; s < stepsInput.length; s += 1) {
    const step: EditStep = stepsInput[s] || {};
    const stepTitle = String(step.title || '').trim();
    if (stepTitle === '') errors.push('第 ' + (s + 1) + ' 个步骤缺少标题');
    const stepTasks = [];
    const tasks = Array.isArray(step.tasks) ? step.tasks : [];
    for (let t = 0; t < tasks.length; t += 1) {
      const task: EditTask = tasks[t] || {};
      const title = String(task.title || '').trim();
      const taskId = typeof task.taskId === 'string' ? task.taskId.trim() : '';
      const key = typeof task.key === 'string' ? task.key.trim() : '';
      const where = '步骤「' + (stepTitle || '第 ' + (s + 1) + ' 步') + '」';
      if (title === '') errors.push(where + '第 ' + (t + 1) + ' 个任务缺少标题');
      if (key === '') errors.push(where + '第 ' + (t + 1) + ' 个任务缺少 key');
      else if (seenKeys.has(key)) errors.push('任务 key 重复：' + key);
      else seenKeys.add(key);
      if (taskId !== '' && seenTaskIds.has(taskId)) errors.push('任务 ' + taskId + ' 出现在多个步骤里');
      else if (taskId !== '') seenTaskIds.set(taskId, title);
      const priorityRaw = String(task.priority == null ? '' : task.priority).trim();
      const priority = priorityRaw === '' ? 100 : Number(priorityRaw);
      if (!Number.isInteger(priority)) errors.push('任务「' + title + '」的优先级必须是整数');
      const weightRaw = String(task.weight == null ? '' : task.weight).trim();
      const weight = weightRaw === '' ? 1 : Number(weightRaw);
      if (!Number.isFinite(weight) || weight <= 0) errors.push('任务「' + title + '」的权重必须是大于 0 的数字');
      const acceptance = planEditSplitLines(task.acceptance).map((text) => {
        const original = (task.acceptanceOriginal || []).find((item) => { return String(item.text).trim() === text; });
        // 只为文字未变的验收项继承证据类型要求，编辑后的新标准不能套用旧要求。
        return original && Array.isArray(original.requiredKinds)
          ? { text, requiredKinds: original.requiredKinds.slice() }
          : { text };
      });
      if (taskId === '' && acceptance.length === 0) errors.push('新任务「' + title + '」至少需要一条验收标准');
      const entry: EditPayloadTask = {
        key,
        title,
        description: String(task.description == null ? '' : task.description),
        priority,
        weight,
        deps: planEditSplitList(task.deps),
        labels: planEditSplitList(task.labels),
        acceptance,
        requiresAudit: Boolean(task.requiresAudit),
      };
      if (taskId !== '') entry.taskId = taskId;
      stepTasks.push(entry);
    }
    let stepId = typeof step.id === 'string' && step.id.trim() !== '' ? step.id.trim() : (step.key || '');
    if (stepId === '') stepId = 'step_' + (s + 1);
    steps.push({ id: stepId, title: stepTitle, tasks: stepTasks });
  }

  // 有任一错误就不返回步骤体，防止部分有效的数据被误提交。
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, steps };
}

/** 比较保存基线与当前步骤；既有任务按 taskId 匹配，草稿按 key 匹配，移除既有任务只列为孤儿候选。 */
export function planEditDiff(oldSteps: EditPayloadStep[], newSteps: EditPayloadStep[]): EditDiff {
  const oldList = Array.isArray(oldSteps) ? oldSteps : [];
  const newList = Array.isArray(newSteps) ? newSteps : [];
  const oldEntries: EditEntry[] = [];
  oldList.forEach((step) => {
    (step && Array.isArray(step.tasks) ? step.tasks : []).forEach((task) => {
      if (task) oldEntries.push({ stepId: step.id, task });
    });
  });
  const newEntries: EditEntry[] = [];
  newList.forEach((step) => {
    (step && Array.isArray(step.tasks) ? step.tasks : []).forEach((task) => {
      if (task) newEntries.push({ stepId: step.id, task });
    });
  });

  // 先按任务身份匹配，再用草稿 key；移除的既有任务只作为孤儿候选，不删除。
  const oldByKey = new Map<string, EditEntry>();
  oldEntries.forEach((entry) => {
    const key = planMatchKey(entry.task);
    if (key !== 'key:') oldByKey.set(key, entry);
  });
  let added = 0;
  let updated = 0;
  const matchedOld = new Set<EditEntry>();
  newEntries.forEach((entry) => {
    const old = oldByKey.get(planMatchKey(entry.task)) || null;
    if (!old) { added += 1; return; }
    matchedOld.add(old);
    if (taskSignature(old) !== taskSignature(entry)) updated += 1;
  });
  let removed = 0;
  const removedTasks: { taskId: string; title: string }[] = [];
  oldEntries.forEach((entry) => {
    if (matchedOld.has(entry)) return;
    removed += 1;
    if (entry.task.taskId) removedTasks.push({ taskId: entry.task.taskId, title: entry.task.title });
  });
  const oldIds = new Set(oldList.map((step) => { return step && step.id; }).filter(Boolean));
  const newIds = new Set(newList.map((step) => { return step && step.id; }).filter(Boolean));
  let stepsAdded = 0;
  let stepsRemoved = 0;
  let stepsChanged = 0;
  newList.forEach((step) => { if (step && step.id && !oldIds.has(step.id)) stepsAdded += 1; });
  oldList.forEach((step) => { if (step && step.id && !newIds.has(step.id)) stepsRemoved += 1; });
  const oldById = new Map(oldList.filter((step) => { return step && step.id; }).map((step) => { return [step.id, step]; }));
  newList.forEach((step) => {
    if (!step || !step.id) return;
    const previous = oldById.get(step.id);
    if (previous && String(previous.title || '') !== String(step.title || '')) stepsChanged += 1;
  });
  return {
    added,
    updated,
    removed,
    removedTasks,
    stepsAdded,
    stepsRemoved,
    stepsChanged,
    changed: added > 0 || updated > 0 || removed > 0 || stepsAdded > 0 || stepsRemoved > 0 || stepsChanged > 0,
  };
}

/** 匹配键优先使用任务身份，否则使用计划内 key，避免混淆草稿和既有任务。 */
function planMatchKey(task: EditPayloadTask): string {
  return task.taskId ? 'id:' + task.taskId : 'key:' + (task.key || '');
}

/** 差异比较的稳定快照：集合字段复制后排序，不能修改原任务数组。 */
function taskSignature(entry: EditEntry): string {
  const task = entry.task;
  return JSON.stringify([
    entry.stepId,
    String(task.title || ''),
    String(task.description || ''),
    task.priority == null ? 100 : task.priority,
    task.weight == null ? 1 : task.weight,
    (task.deps || []).slice().sort(),
    (task.labels || []).slice().sort(),
    (task.acceptance || []).map((item) => {
      return JSON.stringify([item && item.text ? item.text : '', ((item && item.requiredKinds) || []).slice().sort()]);
    }).sort(),
    Boolean(task.requiresAudit),
  ]);
}

/** 保存的 CAS：活动计划比较 baseVersion，草稿比较头修订。 */
// 已发布计划比较版本，草稿比较头修订；两条 CAS 口径不可互换。
export function planEditPayload(head: Plan, steps: EditPayloadStep[]): PlanCommand {
  const planId = head.id;
  if (head.status === 'active') {
    return { op: 'plan.revise', planId, baseVersion: head.currentVersion, steps };
  }
  return { op: 'plan.revise', planId, expected: { entityRev: head.rev }, steps };
}

/** 只组装草稿发布命令，CAS 仍使用头修订。 */
export function planEditPublishPayload(head: Plan): PlanCommand {
  return { op: 'plan.publish', planId: head.id, expected: { entityRev: head.rev } };
}

// 不可变表单更新：只复制被修改的路径，保留未变条目的引用与输入顺序。
// 删除最后一步仍保留一个空步骤，让后续编辑始终有落点。

export function planEditAddStep(form: EditForm): EditForm {
  const steps = (form && Array.isArray(form.steps) ? form.steps : []).slice();
  steps.push({ key: planEditKey('s'), id: '', title: '', tasks: [] });
  return { steps };
}

export function planEditRemoveStep(form: EditForm, stepKey: string | undefined): EditForm {
  const steps = (form && Array.isArray(form.steps) ? form.steps : []).filter((step) => { return step.key !== stepKey; });
  if (steps.length === 0) steps.push({ key: planEditKey('s'), id: '', title: '', tasks: [] });
  return { steps };
}

export function planEditPatchStep(form: EditForm, stepKey: string | undefined, patch: Partial<EditStep>): EditForm {
  return {
    steps: (form && Array.isArray(form.steps) ? form.steps : []).map((step) => {
      return step.key === stepKey ? Object.assign({}, step, patch) : step;
    }),
  };
}

function planEditUsedTaskKeys(form: EditForm): Set<string> {
  const used = new Set<string>();
  (form && Array.isArray(form.steps) ? form.steps : []).forEach((step) => {
    (step && Array.isArray(step.tasks) ? step.tasks : []).forEach((task) => {
      if (task && typeof task.key === 'string' && task.key !== '') used.add(task.key);
    });
  });
  return used;
}

export function planEditAddTask(form: EditForm, stepKey: string | undefined): EditForm {
  const used = planEditUsedTaskKeys(form);
  let key = planEditKey('t');
  while (used.has(key)) key = planEditKey('t');
  return {
    steps: (form && Array.isArray(form.steps) ? form.steps : []).map((step) => {
      if (step.key !== stepKey) return step;
      const tasks = (step.tasks || []).concat([{
        key, taskId: '', title: '', description: '',
        priority: '', weight: '', deps: '', acceptance: '', labels: '', requiresAudit: false,
      }]);
      return Object.assign({}, step, { tasks });
    }),
  };
}

export function planEditRemoveTask(form: EditForm, stepKey: string | undefined, taskKey: string | undefined): EditForm {
  return {
    steps: (form && Array.isArray(form.steps) ? form.steps : []).map((step) => {
      if (step.key !== stepKey) return step;
      return Object.assign({}, step, { tasks: (step.tasks || []).filter((task) => { return task.key !== taskKey; }) });
    }),
  };
}

export function planEditPatchTask(form: EditForm, stepKey: string | undefined, taskKey: string | undefined, patch: Partial<EditTask>): EditForm {
  return {
    steps: (form && Array.isArray(form.steps) ? form.steps : []).map((step) => {
      if (step.key !== stepKey) return step;
      return Object.assign({}, step, {
        tasks: (step.tasks || []).map((task) => {
          return task.key === taskKey ? Object.assign({}, task, patch) : task;
        }),
      });
    }),
  };
}
