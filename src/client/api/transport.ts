// The only HTTP/capability boundary: owns headers, timeout and error envelopes, never navigation.
import type { ApiError, ClientError, Project, TaskView, Plan, Doc, DocView, CommandBody, CommandResult, ExternalBody } from '../model/types.ts';
import type { BoardView as ClientBoardView, RegisterResult } from '../model/view-types.ts';
import { accessFailed, accessSucceeded, accessRevision } from '../model/page-access.ts';

interface PageConfig { base: string; token: string }
// 宿主注入的是全局对象属性；这里只投影类型，不创建新的全局词法绑定。
type PageGlobal = typeof globalThis & { __PROJECT_BOARD__?: PageConfig };
export interface ApiOptions { method?: string; body?: BodyInit; timeoutMs?: number; signal?: AbortSignal }
export interface InspectOptions { preview?: boolean; fresh?: boolean; signal?: AbortSignal }
interface ApiEnvelope { ok?: boolean; error?: ApiError }
interface ProjectsResponse { projects?: Project[] }
interface BoardResponse extends ClientBoardView { project?: Project }
interface TaskResponse extends TaskView {}
interface PlanResponse { head?: Plan; steps?: Plan['steps'] }
interface PlansResponse { plans?: Plan[] }
interface DocsResponse { docs?: Doc[]; schemaVersion?: unknown }
interface DocResponse { doc: Doc & { id: string; title: string; kind: string; rev: number }; body?: string }
// Health projects only fields consumed by the fixed-interval health hook/page.
interface HealthResponse { health?: import('../model/view-types.ts').Health }
interface CreateProjectResponse { project: Project & { id: string } }

export function cfg(): PageConfig | null {
  return (globalThis as PageGlobal).__PROJECT_BOARD__ || null;
}

export function newCmdId(): string {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return 'cmd_' + globalThis.crypto.randomUUID();
  } catch (error) { /* fall through */ }
  return 'cmd_' + Date.now() + '_' + Math.random().toString(36).slice(2);
}

export async function api<T = unknown>(path: string, options?: ApiOptions): Promise<T> {
  const config = cfg();
  if (!config || !config.token) {
    const missing: ClientError = new Error('页面凭据尚未装配。请保留草稿后重新加载页面；若仍失败，请联系维护者检查插件装配。');
    missing.code = 'page-config-missing';
    accessFailed(missing, null);
    throw missing;
  }
  const startedAt = accessRevision();
  const headers: Record<string, string> = { 'x-project-board-token': config.token };
  const init: RequestInit = { method: (options && options.method) || 'GET', headers, cache: 'no-store' };
  if (options && options.body) {
    headers['content-type'] = 'application/json';
    init.body = options.body;
  }
  // A request that never settles would keep the poll loop waiting forever.
  const timeoutMs = options && Number.isFinite(options.timeoutMs) ? options.timeoutMs! : 8000;
  let controller: AbortController | null = null;
  let timer: number | null = null;
  if (timeoutMs > 0) {
    try { controller = new AbortController(); } catch (error) { controller = null; }
  }
  // These callbacks are only installed while controller exists; finally removes the listener.
  const onAbort = function () { controller!.abort(); };
  if (options && options.signal) {
    if (options.signal.aborted) throw new Error('请求已取消');
    if (controller) options.signal.addEventListener('abort', onAbort, { once: true });
    else init.signal = options.signal;
  }
  if (controller) {
    init.signal = controller.signal;
    timer = setTimeout(function () { try { controller!.abort(); } catch (error) { /* gone */ } }, timeoutMs);
  }
  let response: Response;
  let text: string;
  try {
    response = await fetch(config.base + path, init);
    text = await response.text();
    if ((controller && controller.signal.aborted) || (options && options.signal && options.signal.aborted)) {
      throw new DOMException('Request cancelled', 'AbortError');
    }
  } catch (reason: unknown) {
    if (reason && (reason as { name?: unknown }).name === 'AbortError') throw new Error('请求超时或已取消，请重试');
    throw reason;
  } finally {
    if (timer) clearTimeout(timer);
    if (options && options.signal && controller) options.signal.removeEventListener('abort', onAbort);
  }
  // JSON stays unknown; envelope projections below follow the HTTP contract only.
  // They deliberately add no validation/fallback: malformed JSON shapes keep their existing failure behavior.
  let value: unknown = null;
  try {
    value = text ? JSON.parse(text) : {};
  } catch (error) {
    value = { ok: false, error: { message: text || response.statusText } };
  }
  if (!response.ok || (value as ApiEnvelope).ok === false) {
    const failure: ClientError = new Error(((value as ApiEnvelope).error && (value as ApiEnvelope).error!.message) || response.statusText || '请求失败');
    failure.code = (value as ApiEnvelope).error && (value as ApiEnvelope).error!.code;
    failure.details = (value as ApiEnvelope).error && (value as ApiEnvelope).error!.details;
    failure.status = response.status;
    if (response.status === 403 && cfg() && cfg()!.token === config.token) accessFailed(failure, config.token);
    throw failure;
  }
  if (cfg() && cfg()!.token === config.token) accessSucceeded(config.token, startedAt);
  return value as T;
}

export function command(projectId: string, body: CommandBody): Promise<CommandResult> {
  const payload = Object.assign({}, body, { cmdId: body.cmdId || newCmdId() });
  return api('/projects/' + encodeURIComponent(projectId) + '/commands', { method: 'POST', body: JSON.stringify(payload) });
}

export function getProjects(options?: ApiOptions): Promise<ProjectsResponse> { return api('/projects', options); }
export function getBoard(projectId: string, options?: ApiOptions): Promise<BoardResponse> { return api('/projects/' + encodeURIComponent(projectId) + '/board', options); }
export function getTask(projectId: string, taskId: string, options?: ApiOptions): Promise<TaskResponse> { return api('/projects/' + encodeURIComponent(projectId) + '/tasks/' + encodeURIComponent(taskId), options); }
export function getPlan(projectId: string, planId?: string): Promise<PlanResponse> {
  if (planId) return api('/projects/' + encodeURIComponent(projectId) + '/plans/' + encodeURIComponent(planId));
  return api('/projects/' + encodeURIComponent(projectId) + '/plans/current');
}
export function getPlans(projectId: string, options?: ApiOptions): Promise<PlansResponse> { return api('/projects/' + encodeURIComponent(projectId) + '/plans', options); }
export function getDocs(projectId: string): Promise<DocsResponse> { return api('/projects/' + encodeURIComponent(projectId) + '/docs'); }
export function getDoc(projectId: string, docId: string): Promise<DocResponse> { return api('/projects/' + encodeURIComponent(projectId) + '/docs/' + encodeURIComponent(docId)); }
function externalBase(projectId: string): string { return '/projects/' + encodeURIComponent(projectId) + '/docs/external'; }
function externalWrite(path: string, method: string, body: ExternalBody & { cmdId?: string }): Promise<unknown> {
  const payload = Object.assign({ schemaVersion: 1 }, body, { cmdId: (body && body.cmdId) || newCmdId() });
  return api(path, { method, body: JSON.stringify(payload), timeoutMs: 15000 });
}
export function listExternalDocs(projectId: string): Promise<DocsResponse> { return api(externalBase(projectId) + '?includeUnregistered=1'); }
export function inspectExternalDoc(projectId: string, docId: string, options?: InspectOptions): Promise<DocView> {
  const query = options && options.preview === false ? [] : ['preview=1'];
  if (options && options.fresh) query.push('fresh=1');
  return api(externalBase(projectId) + '/' + encodeURIComponent(docId) + (query.length ? '?' + query.join('&') : ''), { signal: options && options.signal, timeoutMs: 15000 });
}
export function registerExternalDoc(projectId: string, body: ExternalBody): Promise<RegisterResult> { return externalWrite(externalBase(projectId), 'POST', body) as Promise<RegisterResult>; }
export function updateExternalDoc(projectId: string, docId: string, body: ExternalBody): Promise<unknown> { return externalWrite(externalBase(projectId) + '/' + encodeURIComponent(docId), 'PATCH', body); }
export function externalDocAction(projectId: string, docId: string, action: string, body: ExternalBody): Promise<unknown> {
  return externalWrite(externalBase(projectId) + '/' + encodeURIComponent(docId) + '/' + action, 'POST', body);
}
export function getHealth(projectId: string): Promise<HealthResponse> { return api('/projects/' + encodeURIComponent(projectId) + '/health'); }
export function createProjectApi(body: { name?: string; workspacePath?: string }): Promise<CreateProjectResponse> { return api('/projects', { method: 'POST', body: JSON.stringify(body) }); }
