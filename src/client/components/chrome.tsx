// Header/layout projections render supplied navigation, filters and status; callbacks remain page-owned, with no hooks/api imports.
// Page chrome: header (project picker, tabs, filters) and the layout shell.
import React from 'react';
import type * as View from '../model/view-types.ts';
import { cx, formatClock, shortId } from '../utils/format.ts';
import { hasActiveFilters } from '../model/filters.ts';
import { GROUP_OPTIONS } from '../model/grouping.ts';
import { Badge, Button, Chip, ErrorState, IconButton, Select, Tabs, ToastHost } from './primitives.tsx';
import { IconClose, IconInbox, IconPlus, IconRefresh, IconSearch } from './icons.tsx';
import { TAB_ITEMS, stateLabel } from '../model/labels.ts';
import { PanelIcon } from './slots.tsx';

export interface AppHeaderProps {
  project?: View.ProjectView | null;
  projects?: View.ProjectView[];
  projectsReady?: boolean;
  projectId?: string;
  navigationPending?: boolean;
  onChoose?: (id: string) => void;
  creating?: boolean;
  onNewTask?: () => void;
  onNewProject?: () => void;
  onOpenLatestSession?: () => void;
  onRefresh?: () => void;
  tab?: string;
  onTab?: (tab: string) => void;
  onView?: (view: string) => void;
  view?: string;
  showFilters?: boolean;
  onGroup?: (group: string) => void;
  filters?: View.Filters;
  query?: string;
  onQuery?: (value: string) => void;
  onStateFilter?: (state: string | null) => void;
  onGateOnly?: (enabled: boolean) => void;
  onPlanFilter?: (plan: string | null) => void;
  onClearFilters?: () => void;
  refreshedAt?: Date | string | number | null;
}
export interface AppLayoutProps extends AppHeaderProps {
  drawer?: React.ReactNode;
  access?: { code?: string } | null;
  onRecoverAccess?: () => void;
  navigationMessage?: string | null;
  onRetryNavigation?: () => void;
  onCancelNavigation?: () => void;
  onAcceptNavigation?: (() => void) | null;
  locationMessage?: string | null;
  projectsError?: string | null;
  onRefresh?: () => void;
  boardError?: string | null;
  nextTask?: View.Card | null;
  onOpenTask?: (id: string) => void;
  navigationPending?: boolean;
  boardMode?: boolean;
  tab?: string;
  children?: React.ReactNode;
  toasts?: View.Toast[];
  onDismissToast?: (id: string) => void;
}









export function AppHeader(props: AppHeaderProps) {
  const project = props.project;
  const projects = props.projects || [];
  const phase = project && project.phase ? project.phase : null;
  const options = [{ value: '', label: props.projectsReady ? '请选择项目' : '正在加载项目' }].concat(projects.map(function(item) {
    return { value: item.id!, label: item.name + ' · ' + shortId(item.id, 10) };
  }));
  if (props.projectId && !projects.some(function(item) { return item.id === props.projectId; })) {
    options.push({ value: props.projectId, label: project ? project.name! : '当前项目（列表中未找到）' });
  }
  return <header className="pb-header" style={props.navigationPending ? { position: 'relative', zIndex: 21 } : undefined}>
    <div className="pb-header__top">
      <div className="pb-brand">
        <span className="pb-brand__mark">
          <PanelIcon size={18} />
        </span>
        <div className="pb-brand__text">
          <h1 className="pb-brand__title">{'项目板'}</h1>
          <p className="pb-brand__sub" title={project ? project.workspacePath : ''}>{project ? project.name + ' · ' + (project.workspacePath || '') : (props.projectsReady ? '请选择要查看的项目' : '正在加载项目列表')}</p>
        </div>
      </div>
      {project ? <div className="pb-header__chips">
        {phase ? <Badge tone={phase === 'active' ? 'success' : 'neutral'}>{phase === 'active' ? '活动' : phase}</Badge> : null}
        {project.readOnly ? <Badge tone="warn">{'只读'}</Badge> : null}
        {project.rev != null ? <Badge tone="neutral" mono={true}>{'修订 ' + project.rev}</Badge> : null}
      </div> : null}
      <div className="pb-header__actions">
        <div className="pb-project-select">
          <Select compact={true} ariaLabel="选择项目" value={props.projectId || ''} onChange={function(event) { if (props.onChoose) props.onChoose(event.target.value); }} options={options} />
        </div>
        {project && !props.creating ? <Button
          variant="primary"
          icon={IconPlus}
          size="sm"
          disabled={Boolean(project.readOnly || props.navigationPending)}
          title={project.readOnly ? '项目只读（其他进程持有写锁）' : '新建任务（task.create）'}
          onClick={props.onNewTask}
        >{'新建任务'}</Button> : null}
        <Button variant={!project && !props.creating ? 'primary' : 'secondary'} icon={props.creating ? IconClose : IconPlus} size="sm" onClick={props.onNewProject} disabled={props.navigationPending}>{props.creating ? '收起' : '新建项目'}</Button>
        {project ? <Button size="sm" variant="secondary" icon={IconInbox} title="跳到这个工作区最近的会话" onClick={props.onOpenLatestSession}>{'最近会话'}</Button> : null}
        <IconButton label="刷新" title="刷新" icon={IconRefresh} onClick={props.onRefresh} />
      </div>
    </div>
    <div className="pb-header__bottom" inert={props.navigationPending ? '' : undefined}>
      <Tabs items={TAB_ITEMS} value={props.tab} onChange={props.onTab} />
      {// The switch only steers the board tab: on docs/plan/health, without a
        // selected project, or while the project form is open it would be a dead
        // control, so it stays out of the header entirely.
        props.onView && props.tab === 'board' && props.project && !props.creating ? <div className="pb-viewswitch" role="group" aria-label="视图">
        <button type="button" className={cx('pb-viewswitch__btn', props.view === 'board' ? 'pb-viewswitch__btn--on' : null)} onClick={function() { props.onView!('board'); }}>{'看板'}</button>
        <button type="button" className={cx('pb-viewswitch__btn', props.view === 'list' ? 'pb-viewswitch__btn--on' : null)} onClick={function() { props.onView!('list'); }}>{'列表'}</button>
      </div> : null}
      {props.showFilters && props.view === 'list' && props.onGroup ? <div className="pb-groupby">
        <Select compact={true} ariaLabel="分组方式" value={(props.filters && props.filters.group) || 'none'} options={GROUP_OPTIONS} onChange={function(event) { props.onGroup!(event.target.value); }} />
      </div> : null}
      {props.showFilters ? <div className="pb-filters">
        <div className="pb-search">
          <IconSearch size={14} />
          <input
            id="pb-search"
            type="search"
            className="pb-search__input"
            placeholder="搜索任务 / id / 标签…（按 / 聚焦）"
            value={props.query || ''}
            onChange={function(event) { if (props.onQuery) props.onQuery(event.target.value); }}
            onKeyDown={function(event) {
              if (event.key === 'Escape') {
                if (props.onQuery) props.onQuery('');
                event.currentTarget.blur();
              }
            }}
            aria-label="搜索任务"
          />
        </div>
        <div className="pb-filter-chips">
          <Chip active={!props.filters!.state} onClick={function() { if (props.onStateFilter) props.onStateFilter(null); }}>{'全部'}</Chip>
          {['ready', 'in_progress', 'review'].map(function(key) {
            return <Chip key={key} active={props.filters!.state === key} onClick={function() { if (props.onStateFilter) props.onStateFilter(props.filters!.state === key ? null : key); }}>{stateLabel(key)}</Chip>;
          })}
          <Chip active={props.filters!.gateOnly} onClick={function() { if (props.onGateOnly) props.onGateOnly(!props.filters!.gateOnly); }} title="只看需要第三方审计的任务">{'需审计'}</Chip>
          <Chip active={props.filters!.plan === 'in'} onClick={function() { if (props.onPlanFilter) props.onPlanFilter(props.filters!.plan === 'in' ? null : 'in'); }} title="只看落在当前计划步骤里的任务">{'计划内'}</Chip>
          <Chip active={props.filters!.plan === 'out'} onClick={function() { if (props.onPlanFilter) props.onPlanFilter(props.filters!.plan === 'out' ? null : 'out'); }} title="只看不在计划里的任务（临时插入）">{'计划外'}</Chip>
        </div>
        {hasActiveFilters(props.filters)
          ? <button type="button" className="pb-filter-clear" title="清除搜索、状态、审计与计划过滤" onClick={props.onClearFilters}>{'清除筛选'}</button>
          : null}
      </div> : null}
      <div className="pb-header__spacer" />
      {props.refreshedAt
        ? <span className="pb-updated">
          <span className="pb-updated__dot" />
          {'更新于 ' + formatClock(props.refreshedAt)}
        </span>
        : null}
    </div>
  </header>;
}

export function AppLayout(props: AppLayoutProps) {
  return <div className="pb-root">
    <AppHeader {...Object.assign({}, props, { drawerOpen: Boolean(props.drawer) })} />
    {props.access ? <div className="pb-banner pb-banner--danger" role="alert">
      <span>{props.access.code === 'page-config-missing' ? '页面凭据未装配。当前内容已保留。' : '页面凭据与当前插件实例不匹配。当前内容已保留，操作不会自动重试。'}</span>
      <Button size="sm" onClick={props.onRecoverAccess}>{'保留草稿后重新加载页面'}</Button>
    </div> : null}
    {props.navigationMessage ? <div className="pb-banner" role="alert" style={{ position: 'relative', zIndex: 21 }}>
      <span>{props.navigationMessage}</span>
      <Button size="sm" onClick={props.onRetryNavigation}>{'重试定位'}</Button>
      <Button size="sm" onClick={props.onCancelNavigation}>{'取消跳转，继续当前项目'}</Button>
      {props.onAcceptNavigation ? <Button size="sm" onClick={props.onAcceptNavigation}>{'确认切换项目'}</Button> : null}
    </div> : null}
    {props.locationMessage ? <div className="pb-banner" role="status">{props.locationMessage}</div> : null}
    {props.projectsError ? <div className="pb-banner pb-banner--danger">
      <ErrorState message={props.projectsError} action={<Button size="sm" onClick={props.onRefresh}>{'重试'}</Button>} />
    </div> : null}
    {props.boardError ? <div className="pb-banner pb-banner--danger">
      <ErrorState message={props.boardError} action={<Button size="sm" onClick={props.onRefresh}>{'重试'}</Button>} />
    </div> : null}
    {props.nextTask ? <div className="pb-nextbar">
      <span className="pb-nextbar__label">{'下一个'}</span>
      <button type="button" className="pb-nextbar__btn" onClick={function() { if (props.onOpenTask) props.onOpenTask(props.nextTask!.id!); }}>
        <span className="pb-nextbar__rank">{'#1'}</span>
        <span className="pb-nextbar__title">{props.nextTask.title}</span>
        <span className="pb-nextbar__meta">{'P' + (props.nextTask.priority == null ? 100 : props.nextTask.priority)}</span>
      </button>
    </div> : null}
    <main inert={props.navigationPending ? '' : undefined} className={cx('pb-main', props.boardMode ? 'pb-main--board' : null, props.tab === 'docs' ? 'pb-main--docs' : null)}>{props.tab ? <div key={props.tab} className="pb-tabpanel">{props.children}</div> : props.children}</main>
    <div style={{ display: 'contents' }} inert={props.navigationPending ? '' : undefined}>{props.drawer}</div>
    <ToastHost toasts={props.toasts} onDismiss={props.onDismissToast} />
  </div>;
}
