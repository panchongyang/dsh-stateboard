// 表单到命令体的纯转换：只组装既有协议字段，不发送请求或替服务端改变状态。
import type { Evidence, TaskView, CommandBody, TaskInput, CreateTaskBody, CreateTaskResult, Links } from './types.ts';
export function buildEvidence(options?: Partial<Evidence>): Evidence {
  const input = options || {};
  const evidence: Evidence = {
    kind: input.kind || 'file',
    ref: String(input.ref || '').trim(),
    summary: String(input.summary || '').trim() || '证据',
  };
  if (input.acceptanceId) evidence.acceptanceId = input.acceptanceId;
  return evidence;
}

/** 发往命令接口的信封；保留任务修订与租约令牌，让服务端执行原有并发守卫。 */
export function commandBody(view: TaskView, op: string, extra?: Record<string, unknown>): CommandBody {
  const body: CommandBody = { op: 'task.' + op };
  if (view && view.task) {
    body.taskId = view.task.id;
    body.expected = { entityRev: view.task.rev };
  }
  if (view && view.lease) body.fencingToken = view.lease.token;

  // 附加字段按原有键顺序覆盖信封；只忽略 undefined，不能丢掉 false、0 或空串。
  const patch = extra || {};
  Object.keys(patch).forEach((key) => {
    if (patch[key] !== undefined) body[key] = patch[key];
  });
  return body;
}

/** 校验并组装 task.create，不接受 planRef：计划归属只能通过计划修订改变。返回结果供抽屉展示错误或提交。 */
export function createTaskPayload(input?: TaskInput): CreateTaskResult {
  const fields = input || {};
  const errors = [];
  const title = String(fields.title || '').trim();
  if (title === '') errors.push('标题必填');
  const acceptance = String(fields.acceptance || '')
    .split(/\r?\n/)
    .map((line) => { return line.trim(); })
    .filter(Boolean);
  if (acceptance.length === 0) errors.push('至少写一条验收项');
  const description = String(fields.description || '').trim();
  const priorityRaw = String(fields.priority == null ? '' : fields.priority).trim();
  let priority = null;
  if (priorityRaw !== '') {
    priority = Number(priorityRaw);
    if (!Number.isInteger(priority)) errors.push('优先级必须是整数');
  }

  // 校验失败不生成半成品命令；空优先级表示省略，而不是数值 0。
  if (errors.length > 0) return { ok: false, errors, body: null };
  const body: CreateTaskBody = {
    op: 'task.create',
    title,
    acceptance: acceptance.map((text) => { return { text }; }),
  };
  if (description) body.description = description;
  if (priority != null) body.priority = priority;
  if (fields.requiresAudit === true) body.requiresAudit = true;
  return { ok: true, errors: [], body };
}

/** doc.link 整体替换关联，因此必须原样携带计划引用。 */
export function docLinkPayload(links: Links, taskIds: string[]): Links {
  const planRefs = links && Array.isArray(links.planRefs) ? links.planRefs : [];
  // 链接整体替换时必须保留计划引用；任务按首次出现去重，不重新排序。
  const out = [];
  for (let i = 0; i < (taskIds || []).length; i += 1) {
    const id = taskIds[i];
    if (id && out.indexOf(id) < 0) out.push(id);
  }
  return { taskIds: out, planRefs };
}

/** 已有文档默认只读预览，只有调用方明确指定才进入编辑。 */
export function initialPreview(initial: { docId?: string; preview?: boolean }): boolean {
  return Boolean(initial && initial.docId) && initial.preview !== false;
}
