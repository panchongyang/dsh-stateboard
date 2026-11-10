// 插件入口与页面共享的单例：保存宿主上下文及尚未被页面消费的跳转目标。
// 双入口会让跳转静默失效：宿主上下文与跳转槽必须来自同一个模块实例。
import type { PluginContext } from './types.ts';
const JUMP_EVENT = 'project-board:jump';
let pendingJumpCwd: string | null = null;
export let pluginCtx: PluginContext | null = null;

export function setPluginCtx(ctx: PluginContext): void {
  pluginCtx = ctx;
}

export function consumePendingJump(): string | null {
  // 先取出再清空，确保一次跳转意图只被消费一次。
  const value = pendingJumpCwd;
  pendingJumpCwd = null;
  return value;
}

export function requestBoardJump(cwd: unknown): void {
  pendingJumpCwd = typeof cwd === 'string' ? cwd : '';

  // 即使宿主不支持事件，仍保留槽中的目标，让稍后挂载的页面读取。
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent(JUMP_EVENT, { detail: { cwd: pendingJumpCwd } }));
    }
  } catch (error) { /* dispatch is best-effort */ }
}

export { JUMP_EVENT };
