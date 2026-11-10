// Page shell owns project navigation, resource hooks, filters and tab orchestration; intent fencing preserves mounted drafts.
// Page shell: data wiring ({data, actions, ui}) and the tab content switch.
import React from 'react';
import type * as View from '../model/view-types.ts';
import { useProjects, useBoard, usePlans, usePageAccess, useMainViewCwd, useFlowSessions } from '../hooks/use-page-read.ts';
import { useToasts } from '../hooks/use-toasts.ts';
import { useBoardSearchShortcut, useBoardView } from '../hooks/use-board-view.ts';
import { PageNavigationContext } from '../hooks/page-navigation.ts';
import { locateProject, createProjectNavigation } from '../model/project-location.ts';
import { confirmPageReload } from '../model/page-access.ts';
import { drawerKey } from '../model/races.ts';
import { saveLastProject, readFilters, saveFilters, defaultFilters } from '../model/storage.ts';
import { priorityRanks, planCatalog } from '../model/selectors.ts';
import { latestSessionFor, openSessionById } from '../model/session-jump.ts';
import { consumePendingJump, JUMP_EVENT } from '../model/state.ts';
import { EmptyState, LoadingState, ErrorState, Button } from '../components/primitives.tsx';
import { IconBoard } from '../components/icons.tsx';
import { AppLayout } from '../components/chrome.tsx';
import { TaskList, BoardView } from '../components/board.tsx';
import { FlowView } from '../components/flow-view.tsx';
import type { FlowViewProps } from '../components/flow-view.tsx';
import { DocsPane } from './docs.tsx';
import { PlanPane } from './plans.tsx';
import { HealthPane } from './health.tsx';
import { CreateProject } from './create-project.tsx';
import { TaskDrawer } from './task-drawer.tsx';
import { NewTaskDrawer } from './task-create.tsx';

export interface BoardPageProps {

}
export interface BoardContentProps {
  creating?: boolean;
  createPath?: string;
  projects: ReturnType<typeof useProjects>;
  board: ReturnType<typeof useBoard>;
  projectId?: string;
  tab?: string;
  view?: string;
  flowFocus?: string | null;
  onFlowFocus?: (id: string | null) => void;
  onHealth?: () => void;
  docFocus?: string | null;
  tasks?: View.Card[];
  ranks?: Record<string, number>;
  filters?: View.Filters;
  onOpenTask?: (id: string) => void;
  onCreated: (project: View.Project) => void;
  onRetry?: () => void;
  onCreate?: () => void;
  plans?: View.PlanSummary[];
  onClearFilters: () => void;
  notify: View.Notify;
  onChanged?: () => void;
  onChoose?: (id: string) => void;
  onProjectsCreated?: (project: View.Project) => void;
}





















const useState = React.useState;
const useEffect = React.useEffect;
const useCallback = React.useCallback;
const useMemo = React.useMemo;

export function BoardPage(_props?: BoardPageProps) {
  const projectsState = useProjects();
  const navigation = useMemo(function() { return createProjectNavigation(consumePendingJump()); }, []);
  const [locationState, setLocationState] = useState(navigation.snapshot);
  const projectId = locationState.projectId;
  const createPath = locationState.createPath;
  const mainCwd = useMainViewCwd();
  const access = usePageAccess();
  const [tab, setTab] = useState('board');
  const { view, focus: flowFocus, applyView, applyFocus, resetFocus, linkedProjectId } = useBoardView(projectId);
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [creatingTask, setCreatingTask] = useState(false);
  const [docFocus, setDocFocus] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const [filters, setFilters] = useState(readFilters);
  const boardState = useBoard(projectId);
  const plansState = usePlans(projectId);
  const toastState = useToasts();
  // Filter state lives in one object so the board and list read the exact same
  // conditions, and every change round-trips through localStorage (P7).
  useEffect(function() { saveFilters(filters); }, [filters]);
  function patchFilters(patch: Partial<View.Filters>) {
    setFilters(function(previous) { return Object.assign({}, previous, patch); });
  }
  function clearFilters() { setFilters(defaultFilters()); }
  // One catalog feeds every card/row: active plans from the board read model,
  // the focused plan, and (namesake fallback) the all-plans view.
  const planList = useMemo(function() {
    return planCatalog(boardState.board, plansState.plans);
  }, [boardState.board, plansState.plans]);
  useEffect(function() {
    let previousId = navigation.snapshot().projectId;
    const off = navigation.subscribe(function(next) {
      if (next.projectId !== previousId) {
        setCreating(false); setSelectedTask(null); setCreatingTask(false); setDocFocus(null);
        if (previousId) resetFocus(next.projectId);
        saveLastProject(next.projectId);
      }
      previousId = next.projectId;
      setLocationState(next);
    });
    navigation.start();
    return function() { off(); navigation.stop(); };
  }, [navigation]);
  const hasEditor = Boolean(creating || selectedTask || creatingTask || (projectId && (tab === 'docs' || tab === 'plan')));
  useEffect(function() {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
    // Synchronous intent publication closes the pre-render old-callback window.
    function onJump() { navigation.jump(consumePendingJump(), hasEditor); }
    window.addEventListener(JUMP_EVENT, onJump);
    return function() { window.removeEventListener(JUMP_EVENT, onJump); };
  }, [navigation, hasEditor]);
  useEffect(function() {
    if (!navigation.snapshot().located && !locationState.intent && linkedProjectId && !projectsState.error) {
      if (!projectsState.ready || projectsState.loading) return;
      if (projectsState.projects.some((project) => project.id === linkedProjectId)) {
        navigation.choose(linkedProjectId);
        return;
      }
    }
    navigation.resolve(projectsState, mainCwd, false as unknown as import('../model/types.ts').NavigationIntent);
  }, [navigation, locationState.intent, linkedProjectId, mainCwd, projectsState.projects, projectsState.ready, projectsState.loading, projectsState.error]);
  const target = locationState.intent ? locateProject(projectsState, locationState.intent.cwd) : null;
  const navigationMessage = navigationNotice(target);
  useBoardSearchShortcut();
  function choose(id: string) {
    if (locationState.intent && hasEditor && id !== projectId && !window.confirm('切换项目会关闭当前编辑器，未保存内容将丢失。确定切换？')) return;
    navigation.choose(id);
  }
  function acceptNavigation() {
    if (hasEditor && !window.confirm('切换项目会关闭当前编辑器，未保存内容将丢失。确定切换？')) return;
    navigation.resolve(projectsState, mainCwd, locationState.intent);
  }
  function changed() {
    setRefreshKey(function(value) { return value + 1; });
    boardState.reload();
    projectsState.reload();
    plansState.reload();
  }
  const refreshAll = useCallback(function() {
    return Promise.all([boardState.reload(false), projectsState.reload(false), plansState.reload(false)]);
  }, [boardState.reload, projectsState.reload, plansState.reload]);
  const openTask = useCallback(function(id: string) { setSelectedTask(id); setCreatingTask(false); }, []);
  const openDoc = useCallback(function(id: string) { setDocFocus(id); setSelectedTask(null); setTab('docs'); }, []);
  const closeTask = useCallback(function() { setSelectedTask(null); }, []);
  const openNewTask = useCallback(function() { setSelectedTask(null); setCreatingTask(true); }, []);
  const closeNewTask = useCallback(function() { setCreatingTask(false); }, []);
  function projectCreated(project: View.Project) {
    projectsState.reload();
    // A write already sent may finish, but cannot supersede a newer navigation.
    if (navigation.snapshot() !== locationState) return;
    setCreating(false);
    navigation.choose(project.id!);
  }
  function taskCreated(taskId: string) {
    setCreatingTask(false);
    changed();
    if (taskId) setSelectedTask(taskId);
  }
  const current = currentProject(projectsState.projects, projectId);
  function openLatestSession() {
    openProjectSession(current, boardState.board, toastState.push);
  }
  const priority = boardPriority(boardState.board);
  const allTasks = priority.tasks;
  const ranks = priority.ranks;
  const nextTask = priority.next;
  const content = <BoardContent
    creating={creating}
    createPath={createPath}
    projectId={projectId}
    tab={tab}
    view={view}
    flowFocus={flowFocus}
    onFlowFocus={applyFocus}
    onHealth={() => setTab('health')}
    docFocus={docFocus}
    projects={projectsState}
    board={boardState}
    tasks={allTasks}
    ranks={ranks}
    filters={filters}
    plans={planList}
    onChoose={choose}
    onOpenTask={openTask}
    onChanged={changed}
    notify={toastState.push}
    onRetry={refreshAll}
    onCreate={function() { navigation.cancel(); setCreating(true); }}
    onClearFilters={clearFilters}
    onCreated={projectCreated}
    onProjectsCreated={projectCreated}
  />;
  return <PageNavigationContext.Provider value={{ navigation, projectId, selectionVersion: locationState.selectionVersion }}>
    <AppLayout
      project={current || (boardState.board ? boardState.board.project : null)}
      projects={projectsState.projects}
      projectId={projectId}
      onChoose={choose}
      onRefresh={refreshAll}
      onNewProject={function() { if (!locationState.intent) { navigation.cancel(); setCreating(!creating); } }}
      onNewTask={openNewTask}
      onOpenLatestSession={openLatestSession}
      creating={creating}
      tab={tab}
      onTab={setTab}
      view={view}
      onView={applyView}
      boardMode={tab === 'board' && view === 'board'}
      nextTask={view === 'flow' && tab === 'board' ? null : nextTask}
      onOpenTask={openTask}
      query={filters.query}
      onQuery={function(value) { patchFilters({ query: value }); }}
      filters={filters}
      onStateFilter={function(value) { patchFilters({ state: value }); }}
      onGateOnly={function(value) { patchFilters({ gateOnly: value }); }}
      onPlanFilter={function(value) { patchFilters({ plan: value }); }}
      onGroup={function(value) { patchFilters({ group: value }); }}
      onClearFilters={clearFilters}
      refreshedAt={boardState.refreshedAt}
      projectsError={projectsState.error}
      boardError={boardState.error || plansState.error}
      access={access}
      onRecoverAccess={function() { confirmPageReload(); }}
      projectsReady={projectsState.ready}
      navigationPending={Boolean(target)}
      navigationMessage={navigationMessage}
      onCancelNavigation={navigation.cancel}
      onRetryNavigation={function() { projectsState.reload(false); }}
      onAcceptNavigation={target && target.phase === 'matched' ? acceptNavigation : null}
      locationMessage={projectId && projectsState.ready && !projectsState.error && !projectsState.loading && !current
        ? '当前项目已不在列表中。已保留当前内容；请重试或手动选择项目。'
        : (!projectId && createPath ? '会话目录尚未匹配到项目，可选择已有项目或主动新建。' : null)}
      toasts={toastState.toasts}
      onDismissToast={toastState.dismiss}
      showFilters={tab === 'board' && projectsState.projects.length > 0 && !creating}
      children={content}
      drawer={// Keyed by task: switching tasks remounts the drawer instead of carrying
        // the previous task's composer state, busy flag and error across.
        selectedTask ? <TaskDrawer
        key={drawerKey(projectId, selectedTask)}
        projectId={projectId}
        taskId={selectedTask}
        refreshKey={refreshKey}
        onClose={closeTask}
        onChanged={changed}
        notify={toastState.push}
        onOpenDoc={openDoc}
      /> : (creatingTask ? <NewTaskDrawer
        key={drawerKey(projectId, 'new-task')}
        projectId={projectId}
        readOnly={Boolean(current && current.readOnly)}
        onClose={closeNewTask}
        onCreated={taskCreated}
        notify={toastState.push}
      /> : null)}
    />
  </PageNavigationContext.Provider>;
}
export function BoardContent(props: BoardContentProps) {
  const creating = props.creating;
  const createPath = props.createPath;
  const projectsState = props.projects;
  const boardState = props.board;
  const projectId = props.projectId;
  const tab = props.tab;
  const view = props.view;
  const docFocus = props.docFocus;
  const allTasks = props.tasks;
  const ranks = props.ranks;
  const filters = props.filters;
  const openTask = props.onOpenTask;
  let content;
  if (creating) {
    content = <div className="pb-page pb-page--narrow">
      <CreateProject key={createPath || 'new'} initialPath={createPath} hint={createPath ? '当前会话的工作区还没有项目板，确认路径后直接创建。' : undefined} onCreated={function(project) { props.onCreated(project); }} />
    </div>;
  } else if (!projectId && !projectsState.ready) {
    content = projectsState.error
      ? <ErrorState message="项目列表加载失败，尚不能判断是否存在项目" detail={projectsState.error} action={<Button onClick={props.onRetry}>{'重试'}</Button>} />
      : <LoadingState label="正在加载项目并定位工作区" />;
  } else if (!projectId) {
    content = <EmptyState icon={IconBoard} title={projectsState.projects.length ? '选择一个项目' : '暂无项目'} hint={createPath ? '当前会话目录未匹配到项目；可手动选择或新建。' : '工作区尚未确定；请选择项目，或主动新建。'} action={<Button onClick={props.onCreate}>{'新建项目'}</Button>} />;
  } else if (tab === 'board' && !boardState.board) {
    content = boardState.error
      ? <ErrorState message={boardState.error} action={<Button onClick={props.onRetry}>{'重试'}</Button>} />
      : <LoadingState label="看板加载中" />;
  } else if (tab === 'board') {
    if (view === 'flow' && boardState.board) {
      content = <FlowBoard
        key={projectId}
        board={boardState.board}
        query={filters?.query}
        focus={props.flowFocus}
        onFocus={props.onFlowFocus}
        onOpen={openTask}
        onHealth={props.onHealth}
      />;
    } else if (view === 'list') {
      content = <TaskList
        tasks={allTasks}
        ranks={ranks}
        filters={filters}
        plans={props.plans}
        onOpen={openTask}
        onClearFilters={props.onClearFilters}
      />;
    } else {
      content = <BoardView
        board={boardState.board}
        error={boardState.error}
        filters={filters}
        plans={props.plans}
        onOpen={openTask}
        onClearFilters={function() { props.onClearFilters(); }}
      />;
    }
  } else if (tab === 'docs') {
    content = <DocsPane
      key={projectId + ':' + (docFocus || 'docs')}
      projectId={projectId}
      notify={props.notify}
      tasks={allTasks}
      project={boardState.board && boardState.board.project}
      initial={docFocus ? { docId: docFocus } : undefined}
      onOpenTask={openTask}
    />;
  } else if (tab === 'plan') {
    content = <PlanPane
      key={projectId}
      projectId={projectId}
      board={boardState.board}
      onOpenTask={openTask}
      notify={props.notify}
      onChanged={props.onChanged}
    />;
  } else {
    content = <HealthPane projectId={projectId} />;
  }
  return content;
}

function FlowBoard(props: FlowViewProps) {
  return <FlowView {...props} sessions={useFlowSessions()} />;
}

function currentProject(projects: View.ProjectView[], projectId: string) {
  let current = null;
  for (let i = 0; i < projects.length; i += 1) {
    if (projects[i].id === projectId) current = projects[i];
  }
  return current;
}

function openProjectSession(current: View.ProjectView | null, board: View.BoardView | null, notify: View.Notify) {
  const workspacePath = current && current.workspacePath
    ? current.workspacePath
    : (board && board.project ? board.project.workspacePath : '');
  const hit = latestSessionFor(workspacePath);
  if (hit) openSessionById(hit.sessionId, notify);
  else notify('info', '这个工作区还没有会话');
}

function navigationNotice(target: import('../model/types.ts').LocationResult | null) {
  return target ? '跳转目标：' + (target.cwd || '未知目录') + '。' +
    (({ loading: '正在读取项目列表。', failed: '项目列表读取失败，请重试。', unknown: '无法确定目标，请手动选择项目。', unmatched: '没有匹配项目，请手动选择或取消跳转。', matched: '已找到项目“' + (target.project ? target.project.name : '') + '”。' } as Record<string, string>)[target.phase]) +
    '当前内容与草稿已保留，提交已暂停；取消跳转可继续编辑。' : null;
}

// Board/list ranking includes attention cards outside the five visible columns.
function boardPriority(board: View.BoardView | null): { tasks: View.Card[]; ranks: Record<string, number>; next: View.Card | null } {
  let allTasks: View.Card[] = [];
  if (board && board.columns) {
    Object.keys(board.columns).forEach(function(key) {
      allTasks = allTasks.concat(board.columns![key] || []);
    });
  }
  // blocked / interrupted live outside the five columns but still rank: the list
  // and the board must derive #1..#n from the same set or the numbers disagree.
  const attentionCards = (board && board.attention) || {};
  allTasks = allTasks.concat(attentionCards.blocked || [], attentionCards.interrupted || []);

  const ranks = priorityRanks(allTasks);
  let nextTask: View.Card | null = null;
  allTasks.forEach(function(task) { if (ranks[task.id!] === 1) nextTask = task; });

  return { tasks: allTasks, ranks, next: nextTask };
}
