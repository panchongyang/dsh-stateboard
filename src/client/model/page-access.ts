// 页面能力凭据的诊断状态，与任务租约及模型密钥无关。
// 拒绝只发布提示，不自动重试写入或刷新，以免丢失编辑草稿。
import type { ApiError } from './types.ts';
interface AccessNotice { code: string; token: string | null }
interface ReloadWindow { confirm(message: string): boolean; location: { reload(): void } }
let notice: AccessNotice | null = null;
let revision = 0;
const listeners = new Set<(value: AccessNotice | null) => void>();

// 同步通知保持失败修订号与提示的可见顺序，订阅者不会读到半次更新。
function emit(value: AccessNotice | null): void { notice = value; listeners.forEach((fn) => { fn(value); }); }
export function accessSnapshot(): AccessNotice | null { return notice; }
export function accessRevision(): number { return revision; }
export function subscribeAccess(fn: (value: AccessNotice | null) => void): () => void { listeners.add(fn); return function () { listeners.delete(fn); }; }

// 只处理页面装配与凭据失配；普通业务失败不使整页失效。
export function accessFailed(error: ApiError, token: string | null): void {
  if (error.code !== 'token-mismatch' && error.code !== 'page-config-missing') return;
  revision += 1;
  emit({ code: error.code, token });
}
export function accessSucceeded(token: string, startedAt: number): void {
  // 旧请求的迟到成功不能抹掉它发起之后才出现的拒绝提示。
  if (notice && notice.token === token && startedAt === revision) emit(null);
}

// 刷新有丢失草稿风险，必须由用户明确确认，缺少宿主能力时保持原页。
export function confirmPageReload(win?: ReloadWindow | null): boolean {
  win = win || (typeof window !== 'undefined' ? window : null);
  if (!win || typeof win.confirm !== 'function' || !win.location) return false;
  if (!win.confirm('重新加载会离开当前页面，未保存的编辑可能丢失。请先保存或复制草稿。确定重新加载以获取新的页面凭据吗？')) return false;
  win.location.reload();
  return true;
}
