// 外置文档写入体与错误分类的纯转换；只发送允许字段，避免扩大写入协议。
import type { Doc, Locator, DocView, FormGuard, Links, PlanRef, ExternalInput, ExternalBody, PayloadResult, ApiError, ExternalErrorView } from './types.ts';
import { AVAILABILITY_COPY, MANAGEMENT_NEXT, availabilityFromCode, confirmBlock, previewState, schemaBlock, writeBlock } from './external-docs.ts';

function text(value: unknown): string { return String(value == null ? '' : value).trim(); }

/** 提前展示与服务端相同的路径词法问题（契约 §3.1），不代替服务端安全检查。 */
export function relPathProblem(value: unknown): string {
  const path = String(value == null ? '' : value);
  if (text(path) === '') return '请填写相对路径';
  if (path.indexOf('\\') >= 0) return '路径分隔符请用 /（例如 docs/notes.md），不要用反斜线';
  if (/^\//.test(path) || /^[A-Za-z]:/.test(path)) return '请填写相对于工作区根目录的路径，不要写绝对路径或盘符';
  if (path.split('/').some(function (segment) { return segment === '..' || segment === '.' || segment === ''; })) {
    return '路径里不能有空段、. 或 ..';
  }
  return '';
}

/** 守卫携带表单打开时的列表版本、登记修订与确认指纹；旧草稿不能套用更新的 metaRev 提交。 */
function guardError(view: DocView, guard?: FormGuard): string {
  if (!guard) return '';
  const blocked = schemaBlock(guard.listSchema);
  if (blocked) return blocked;
  if (guard.baseRev !== undefined && view && view.metaRev !== guard.baseRev) {
    return '登记信息已变化（metaRev ' + guard.baseRev + ' → ' + view.metaRev + '），草稿没有提交，请重新打开表单';
  }

  // 表单绑定打开时的修订与内容，不能悄悄用新观测为旧草稿重设基线。
  const hash = view && view.observation ? view.observation.contentHash : null;
  if (guard.baseHash !== undefined && (hash || null) !== (guard.baseHash || null)) return '文件内容已变化，草稿没有提交，请重新打开确认';
  return '';
}

function linksOf(taskIds?: string[], planRefs?: PlanRef[]): { taskIds: string[]; planRefs: PlanRef[] } {
  return { taskIds: Array.from(new Set(taskIds || [])), planRefs: (planRefs || []).slice() };
}

function sameLinks(a: Links | undefined, b: Links | undefined): boolean {
  const left = linksOf(a && a.taskIds, a && a.planRefs);
  const right = linksOf(b && b.taskIds, b && b.planRefs);
  return JSON.stringify(left.taskIds.slice().sort()) === JSON.stringify(right.taskIds.slice().sort())
    && JSON.stringify(left.planRefs) === JSON.stringify(right.planRefs);
}

/** 登记外置文档；只组装允许字段，不创建目标文件。 */
export function registerPayload(input: ExternalInput, guard?: FormGuard): PayloadResult {
  const blockedSchema = guard ? schemaBlock(guard.listSchema) : '';
  if (blockedSchema) return { error: blockedSchema };
  const title = text(input && input.title);
  if (!title) return { error: '请填写标题' };
  const problem = relPathProblem(input && input.relPath);
  if (problem) return { error: problem };
  const body: ExternalBody = { title, kind: (input && input.kind) || 'note', relPath: String(input.relPath) };
  const bindingId = text(input && input.bindingId);
  if (bindingId) body.bindingId = bindingId;
  const taskIds = (input && input.taskIds) || [];
  if (taskIds.length) body.links = linksOf(taskIds, []);
  return { body };
}

/** 重定位只发送变化的位置字段，不移动工作区文件。 */
export function relocatePayload(view: DocView & { doc: Doc & { locator: Locator } }, input: ExternalInput, guard?: FormGuard): PayloadResult {
  const blocked = writeBlock(view, guard && guard.listSchema) || guardError(view, guard);
  if (blocked) return { error: blocked };
  const locator = view.doc.locator;
  const bindingId = text(input && input.bindingId) || locator.bindingId;
  const relPath = input && input.relPath != null && text(input.relPath) !== '' ? String(input.relPath) : locator.relPath;
  const problem = relPathProblem(relPath);
  if (problem) return { error: problem };
  const body: ExternalBody = { expectedMetaRev: view.metaRev };
  if (bindingId !== locator.bindingId) body.bindingId = bindingId;
  if (relPath !== locator.relPath) body.relPath = relPath;
  if (body.bindingId === undefined && body.relPath === undefined) return { error: '位置没有变化' };
  return { body };
}

/** 更新登记元信息，只发送实际变化的字段。 */
export function metaPayload(view: DocView & { doc: Doc }, draft: ExternalInput, guard?: FormGuard): PayloadResult {
  const blocked = writeBlock(view, guard && guard.listSchema) || guardError(view, guard);
  if (blocked) return { error: blocked };
  const doc = view.doc;
  const body: ExternalBody = { expectedMetaRev: view.metaRev };
  const title = text(draft && draft.title);
  if (!title) return { error: '标题不能为空' };
  if (title !== doc.title) body.title = title;
  if (draft.kind && draft.kind !== doc.kind) body.kind = draft.kind;
  if (draft.taskIds && !sameLinks({ taskIds: draft.taskIds, planRefs: (doc.links || {}).planRefs }, doc.links)) {
    body.links = linksOf(draft.taskIds, (doc.links || {}).planRefs);
  }

  // 管理状态只沿允许边转换；从归档恢复必须携带原因，读取本身不触发转换。
  if (draft.status && draft.status !== doc.status) {
    if ((MANAGEMENT_NEXT[doc.status!] || []).indexOf(draft.status) < 0) return { error: '不能从「' + doc.status + '」直接改为「' + draft.status + '」' };
    body.status = draft.status;
    const reason = text(draft.reason);
    if (doc.status === 'archived' && !reason) return { error: '从归档重新打开需要填写原因' };
    if (reason) body.reason = reason;
  }
  if (Object.keys(body).length === 1) return { error: '没有改动' };
  return { body };
}

/** 确认携带最后一次观测的完整指纹与登记修订，由服务端再次校验。 */
export function confirmPayload(view: DocView, acknowledgedTruncation: boolean, guard?: FormGuard): PayloadResult {
  const blocked = confirmBlock(view, guard && guard.listSchema) || guardError(view, guard);
  if (blocked) return { error: blocked };
  const preview = previewState(view);
  if (preview.truncated && !acknowledgedTruncation) return { error: '预览已截断：请先勾选「我知道只看到了部分正文，确认针对完整文件」' };
  // 先通过完整内容指纹守卫，再组装确认体；截断预览的同意不等于内容确认。
  return { body: { expectedMetaRev: view.metaRev, expectedContentHash: view.observation!.contentHash } };
}

/** 解除登记只改变登记状态，保留审计记录与工作区文件。 */
export function unregisterPayload(view: DocView, reason: unknown, guard?: FormGuard): PayloadResult {
  const blocked = writeBlock(view, guard && guard.listSchema) || guardError(view, guard);
  if (blocked) return { error: blocked };
  const body: ExternalBody = { expectedMetaRev: view.metaRev };
  if (text(reason)) body.reason = text(reason);
  return { body };
}

/** 将错误投影为说明与后续动作：重新观测、转入外置面板或无动作；不自动重放失败写入。 */
export function externalErrorView(error: unknown): ExternalErrorView {
  const code = (error && (error as ApiError).code) as string | undefined;
  const details = ((error && (error as ApiError).details) || {}) as NonNullable<ApiError['details']>;
  if (code === 'stale-revision') {
    if (details.currentContentHash) {
      return { code, action: 'reinspect', message: '文件内容在上次观测之后变了，确认被拒绝。请点「重新读取文件」、看过新内容后再确认。' };
    }
    const current = details.currentMetaRev != null ? '（当前 metaRev ' + details.currentMetaRev + '）' : '';
    return { code, action: 'reinspect', message: '登记信息已被别处修改' + current + '。请重新读取后再重试，你的输入不会自动重放。' };
  }
  if (code === 'external-doc-operation-required') {
    return { code, action: 'use-external', message: '这是外置文档，旧的内嵌文档入口不能读写它；已改用外置文档面板。' };
  }
  if (code === 'illegal-transition') return { code, action: 'reinspect', message: '当前状态不允许这个操作（已解除登记的文档不能再修改，或管理状态转换不合法）。' };
  if (code === 'missing-binding') return { code, action: null, message: '指定的绑定不是本项目当前有效的绑定。请填写有效的 bindingId，或留空使用主工作区。' };
  if (code === 'bindings-unreadable') return { code, action: null, message: '绑定注册表暂时不可读，写入已拒绝，稍后重试。' };
  const availability = availabilityFromCode(code);
  if (availability) {
    const copy = AVAILABILITY_COPY[availability];
    return { code, action: 'reinspect', message: copy.title + '。' + copy.hint };
  }
  const message = ((error && (error as ApiError).message) || '请求失败') as string;
  return { code: code || null, action: null, message };
}

export function externalErrorText(error: unknown): string {
  const view = externalErrorView(error);
  return view.message + (view.code ? ' [' + view.code + ']' : '');
}

/** 登记与重定位的新目标必须现在存在，不能套用已登记文档的通用重定位补救。 */
export function targetErrorView(error: unknown): ExternalErrorView {
  const availability = availabilityFromCode((error && (error as ApiError).code) as string | undefined);
  if (!availability) return externalErrorView(error);
  const copy = AVAILABILITY_COPY[availability];
  return {
    code: (error as ApiError).code, action: null,
    message: copy.title + '。新的目标必须是绑定根目录内此刻存在的普通文件；请检查 bindingId 和路径后重试。',
  };
}
