// 项目定位与页面导航状态机：只接受明确目录，不用历史项目猜测当前写入目标。
import type { SessionSnapshot, ProjectState, LocationResult, NavigationState, NavigationIntent, ProjectNavigation, ClientError } from './types.ts';
import { matchProjectByCwd } from './selectors.ts';

export function mainViewCwd(snapshot: SessionSnapshot): string {
  const entries = Object.values((snapshot && snapshot.byId) || {}).filter((entry) => {
    return entry && entry.retainedBy && entry.retainedBy.mainView! > 0;
  });
  // 多个主视图引用无法唯一定位，宁可留空等待选择，也不选遍历中的第一个。
  return entries.length === 1 && typeof entries[0].cwd === 'string' ? entries[0].cwd : '';
}

export function locateProject(projectsState: ProjectState, cwd: string): LocationResult {
  if (!cwd) return { phase: 'unknown', cwd: '' };
  if (projectsState.error) return { phase: 'failed', cwd };
  if (!projectsState.ready || projectsState.loading) return { phase: 'loading', cwd };
  const match = matchProjectByCwd(projectsState.projects, cwd);
  return match ? { phase: 'matched', cwd, project: match.project, exact: match.exact } : { phase: 'unmatched', cwd };
}

// 导航意图与目录读取独立：保留已确认身份和草稿，但一旦出现意图就暂停旧目标写入。
export function createProjectNavigation(initialCwd: string | null): ProjectNavigation {
  let state: NavigationState = { projectId: '', selectionVersion: 0, located: false, createPath: '', intent: initialCwd === null ? null : { cwd: initialCwd, preserve: false } };
  const listeners = new Set<(state: NavigationState) => void>();
  let active = false;
  function update(next: NavigationState): void { state = next; listeners.forEach((fn) => { fn(state); }); }
  function choose(id: string, cwd?: string): void { update({ projectId: id, selectionVersion: state.selectionVersion + (id === state.projectId ? 0 : 1), located: true, createPath: cwd || '', intent: null }); }
  function cancel(): void { update(Object.assign({}, state, { located: true, intent: null })); }

  // 迟到确认只对原意图生效；读取失败或加载中不替换已确认的编辑目标。
  function resolve(catalog: ProjectState, mainCwd: string, accept?: NavigationIntent | null): void {
    if (accept && accept !== state.intent) return;
    if (!state.intent && state.located) return;
    const result = locateProject(catalog, state.intent ? state.intent.cwd : mainCwd);
    if (result.phase === 'loading' || result.phase === 'failed') return;
    if (state.intent && result.phase === 'matched' && result.project.id === state.projectId) { cancel(); return; }
    if (state.intent && state.intent.preserve && !accept) return;
    if (result.phase === 'unknown' && !state.intent) return;
    choose(result.phase === 'matched' ? result.project.id! : '', result.phase === 'unmatched' ? result.cwd : '');
  }

  // 身份加选择代次共同隔离旧回调；同项目重新读取不会使草稿失效。
  const page: ProjectNavigation = {
    snapshot: function () { return state; },
    subscribe: function (fn) { listeners.add(fn); return function () { listeners.delete(fn); }; },
    start: function () { active = true; },
    stop: function () { active = false; },
    assertWritable: function (confirmedId, selectionVersion) {
      if (!active || state.intent || state.projectId !== confirmedId || state.selectionVersion !== selectionVersion) {
        const error: ClientError = new Error('当前编辑目标尚未确认。草稿已保留，请先取消跳转或确认目标，再提交修改。');
        error.code = 'project-navigation-pending';
        throw error;
      }
    },
    jump: function (cwd, preserve) { update(Object.assign({}, state, { intent: { cwd: cwd || '', preserve: Boolean(preserve) } })); },
    choose, cancel, resolve,
  };
  return page;
}
