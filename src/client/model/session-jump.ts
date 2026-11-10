// 宿主会话导航适配器：选择仍由纯模型完成，缺少宿主能力时只提示，不伪造成功。
import type { HostServices, SessionTarget } from './types.ts';
/** 宿主会话跳转的适配边界，目标选择保持在纯选择器中。 */
import { pluginCtx } from './state.ts';
import { pickLatestSession } from './selectors.ts';

/** 所有会话跳转入口共用此出口，统一处理缺能力与失败提示。 */
export function openSessionById(sessionId: string, notify?: (tone: string, message: string) => void): boolean {
  const say = notify || function () {};
  if (!sessionId) { say('info', '这个工作区还没有会话'); return false; }
  // 能力获取与跳转分别处理异常，区分不支持导航和目标会话失效。
  let nav: HostServices['uiWorkspace'] | null = null;
  try { nav = pluginCtx && pluginCtx.get ? pluginCtx.get('uiWorkspace') : null; } catch (error) { nav = null; }
  if (!nav || typeof nav.openSession !== 'function') { say('error', '当前界面不支持跳转会话'); return false; }
  try { nav.openSession(sessionId); return true; }
  catch (error) { say('error', '会话不存在或已归档'); return false; }
}

export function latestSessionFor(workspacePath: unknown): SessionTarget | null {
  let sessions: HostServices['sessions'] | null = null;
  try { sessions = pluginCtx && pluginCtx.get ? pluginCtx.get('sessions') : null; } catch (error) { sessions = null; }
  if (!sessions || !sessions.list || typeof sessions.list.getSnapshot !== 'function') return null;
  const snapshot = sessions.list.getSnapshot();
  return pickLatestSession(snapshot && snapshot.byId, workspacePath);
}
