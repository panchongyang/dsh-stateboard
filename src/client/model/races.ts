// 轮询退避与抽屉身份的纯策略；不持有请求，避免与页面生命周期混淆。
/** 失败后指数退避，避免持续冲击服务端；次数 0 表示首次失败。 */
export function backoffDelay(attempt: number, baseMs?: number, maxMs?: number): number {
  const base = Number.isFinite(baseMs) && baseMs! > 0 ? baseMs! : 2000;
  const max = Number.isFinite(maxMs) && maxMs! > 0 ? maxMs! : 30000;
  // 非有限或非正次数按首次失败处理；上限在指数计算之后应用。
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const delay = base * Math.pow(2, safeAttempt);
  return Math.min(max, delay);
}

/** 成功后的常规轮询间隔。 */
export const POLL_INTERVAL_MS = 2000;
/** 单次看板读取的放弃期限，与轮询间隔分开定义。 */
export const REQUEST_TIMEOUT_MS = 8000;

/** 抽屉身份包含任务，切换任务必须重挂载，防止上一任务的表单、忙碌状态和错误泄漏。 */
export function drawerKey(projectId: unknown, taskId: unknown): string {
  return 'drawer:' + String(projectId || 'none') + ':' + String(taskId || 'none');
}
