// Board/card/list projections derive filtered groups and shared ranks from props; no page resource reads or commands.
// Board views: five columns, cards, the flat list and the attention tray.
import React from 'react';
import type * as View from '../model/view-types.ts';
import { filterCards, hasActiveFilters, isGate } from '../model/filters.ts';
import { GROUP_OPTIONS, groupTasks, normalizeGroupMode } from '../model/grouping.ts';
import { needYouCount, planCatalog, planMeta, priorityRanks, rankTier } from '../model/selectors.ts';
import { blockerLabel, stateLabel, stateTone } from '../model/labels.ts';
import { Badge, Button, EmptyState, ErrorState, LoadingState, StatTile, StatusDot } from './primitives.tsx';
import { cx, percentOf } from '../utils/format.ts';
import { IconBoard, IconInbox, IconWarning } from './icons.tsx';

export interface CardPlanLabelProps {
  meta: { planTitle?: string; stepTitle?: string; title: string };
}
export interface TaskCardProps {
  card: View.Card;
  rank?: number | null;
  plans?: View.PlanSummary[];
  onOpen?: (id: string) => void;
}
export interface TaskRowProps {
  card: View.Card;
  ranks: Record<string, number>;
  plans?: View.PlanSummary[];
  onOpen?: (id: string) => void;
}
export interface TaskListProps {
  ranks?: Record<string, number>;
  plans?: View.PlanSummary[];
  filters?: View.Filters;
  tasks?: View.Card[];
  onOpen?: (id: string) => void;
  onClearFilters?: () => void;
}
export interface BoardColumnProps {
  cards?: View.Card[];
  column: View.Column;
  ranks?: Record<string, number>;
  plans?: View.PlanSummary[];
  onOpen?: (id: string) => void;
}
export interface AttentionTrayProps {
  attention: View.Attention;
  ranks?: Record<string, number>;
  plans?: View.PlanSummary[];
  onOpen?: (id: string) => void;
}
export interface BoardViewProps {
  board?: View.BoardView | null;
  error?: string | null;
  filters?: View.Filters;
  plans?: View.PlanSummary[];
  onOpen?: (id: string) => void;
  onClearFilters?: () => void;
}








const useState = React.useState;

export const COLUMNS = [
  { key: 'backlog', label: '待办', hint: '未进入队列' },
  { key: 'ready', label: '就绪', hint: '可领取' },
  { key: 'in_progress', label: '进行中', hint: '持有租约' },
  { key: 'review', label: '评审中', hint: '等待验证' },
  { key: 'done', label: '已完成', hint: '终态' },
];

/** Plan + step, with the step kept visible when the plan name has to ellipsize. */
function CardPlanLabel(props: CardPlanLabelProps) {
  const meta = props.meta;
  if (!meta.planTitle || !meta.stepTitle) {
    return <span className="pb-card__plan" title={meta.title}>{meta.title}</span>;
  }
  return <span className="pb-card__plan" title={meta.title}>
    <span className="pb-card__plan-name">{meta.planTitle}</span>
    <span className="pb-card__plan-sep">{' · '}</span>
    <span className="pb-card__plan-step">{meta.stepTitle}</span>
  </span>;
}

/** The card carries only a title and one meta line (P6). */
export function TaskCard(props: TaskCardProps) {
  const card = props.card;
  const acceptance = card.acceptance || { met: 0, total: 0 };
  const gate = isGate(card);
  const tier = rankTier(props.rank!);
  const meta = planMeta(props.plans, card.planRef);
  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (props.onOpen) props.onOpen(card.id!);
    }
  }
  return <article
    className={'pb-card pb-card--' + (card.state || 'ready')}
    role="button"
    tabIndex={0}
    aria-label={card.title + '，' + stateLabel(card.state) + (gate ? '，需审计' : '')}
    onClick={function() { if (props.onOpen) props.onOpen(card.id!); }}
    onKeyDown={onKeyDown}
  >
    <h3 className="pb-card__title" title={card.title}>{card.title}</h3>
    <div className="pb-card__meta">
      {props.rank
        ? <Badge tone={tier === 'top' ? 'accent' : 'muted'} mono={true} className="pb-card__rank">{'#' + props.rank}</Badge>
        : null}
      <span className="pb-card__acc" title={'验收 ' + acceptance.met + '/' + acceptance.total}>{acceptance.met + '/' + acceptance.total}</span>
      {gate ? <Badge tone="violet">{'需审计'}</Badge> : null}
      <CardPlanLabel meta={meta} />
    </div>
    {card.blocked ? <div className="pb-card__blocked">
      <IconWarning size={13} />
      <span>{blockerLabel(card.blocked.code) + (card.blocked.note ? ' · ' + card.blocked.note : '')}</span>
    </div> : null}
  </article>;
}

function rowTime(iso: string | undefined) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!then) return '';
  const diff = Date.now() - then;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  return Math.floor(diff / 86400000) + ' 天前';
}

export function TaskRow(props: TaskRowProps) {
  const card = props.card;
  const rank = props.ranks[card.id!];
  const acc = card.acceptance || { met: 0, total: 0 };
  const gate = isGate(card);
  const meta = planMeta(props.plans, card.planRef);
  return <li key={card.id} className="pb-row">
    <button type="button" className="pb-row__btn" onClick={function() { if (props.onOpen) props.onOpen(card.id!); }}>
      <span className={cx('pb-row__rank', rankTier(rank) === 'top' ? 'pb-row__rank--top' : null)}>{rank ? '#' + rank : '—'}</span>
      <StatusDot state={card.state} />
      <Badge tone={stateTone(card.state)} className="pb-row__state">{stateLabel(card.state)}</Badge>
      <span className="pb-row__title" title={card.title}>{card.title}</span>
      {gate ? <Badge tone="violet">{'需审计'}</Badge> : null}
      <span className={cx('pb-row__plan', card.planRef ? 'pb-row__plan--in' : null)} title={meta.title}>{meta.title}</span>
      <span className="pb-row__meta">{'验收 ' + acc.met + '/' + acc.total}</span>
      <span className="pb-row__p pb-mono">{'P' + (card.priority == null ? 100 : card.priority)}</span>
      <span className="pb-row__time">{rowTime(card.updatedAt)}</span>
    </button>
  </li>;
}

/** Flat priority queue: one row per active task, done folded away. */
export function TaskList(props: TaskListProps) {
  const ranks = props.ranks || {};
  const plans = props.plans;
  const [showDone, setShowDone] = useState(false);
  const filters = props.filters || {};
  const mode = normalizeGroupMode(filters.group!);
  const tasks = filterCards(props.tasks || [], filters);
  const active = tasks.filter(function(card) { return card.state !== 'done' && card.state !== 'canceled'; });
  const done = tasks.filter(function(card) { return card.state === 'done'; });
  const sorted = active.slice().sort(function(a, b) { return (ranks[a.id!] || 999) - (ranks[b.id!] || 999); });

  function row(card: View.Card) {
    return <TaskRow key={card.id} card={card} ranks={ranks} plans={plans} onOpen={props.onOpen} />;
  }

  if (tasks.length === 0) {
    return <EmptyState icon={IconInbox} title="没有任务" hint={hasActiveFilters(filters) ? '当前筛选没有命中，清除筛选或换一个分组条件。' : '清空筛选，或用 project_task 建一个。'} action={hasActiveFilters(filters) && props.onClearFilters ? <Button onClick={props.onClearFilters}>{'清除筛选'}</Button> : null} />;
  }

  if (mode !== 'none') {
    const groups = groupTasks(tasks, mode, plans).map(function(group) {
      const items = group.items.slice().sort(function(a, b) { return (ranks[a.id!] || 999) - (ranks[b.id!] || 999); });
      return { key: group.key, title: group.title, items };
    });
    let modeLabel = mode;
    GROUP_OPTIONS.forEach(function(option) { if (option.value === mode) modeLabel = option.label; });
    return <div className="pb-list pb-list--grouped">
      <div className="pb-list__summary">
        <span>{'分组：' + modeLabel}</span>
        <span>{tasks.length + ' 条' + (hasActiveFilters(filters) ? '（已筛选）' : '')}</span>
      </div>
      {groups.map(function(group) {
        return <section key={group.key} className="pb-group" aria-label={group.title}>
          <header className="pb-group__head">
            <h2 className="pb-group__title">{group.title}</h2>
            <span className="pb-group__count">{String(group.items.length)}</span>
          </header>
          <ul className="pb-rows">{group.items.map(row)}</ul>
        </section>;
      })}
    </div>;
  }

  return <div className="pb-list">
    <ul className="pb-rows">{sorted.map(row)}</ul>
    {done.length ? <div className="pb-done-fold">
      <button type="button" className="pb-fold__head" aria-expanded={showDone ? 'true' : 'false'} onClick={function() { setShowDone(!showDone); }}>{'已完成 · ' + done.length + ' 条 ' + (showDone ? '▴' : '▾')}</button>
      {showDone ? <ul className="pb-rows pb-rows--done">{done.map(row)}</ul> : null}
    </div> : null}
  </div>;
}

export function BoardColumn(props: BoardColumnProps) {
  const cards = props.cards || [];
  return <section className={cx('pb-col', 'pb-col--' + props.column.key, cards.length === 0 ? 'pb-col--empty' : null)} aria-label={props.column.label}>
    <header className="pb-col__head">
      <StatusDot state={props.column.key} />
      <span className="pb-col__label">{props.column.label}</span>
      <span className="pb-col__count">{String(cards.length)}</span>
    </header>
    <div className="pb-col__body">
      {cards.length
        ? cards.map(function(card) {
          return <TaskCard key={card.id} card={card} rank={props.ranks ? props.ranks[card.id!] : null} plans={props.plans} onOpen={props.onOpen} />;
        })
        : <p className="pb-col__empty">{props.column.hint}</p>}
    </div>
  </section>;
}

export function AttentionTray(props: AttentionTrayProps) {
  const attention = props.attention;
  const blocked = attention.blocked || [];
  const interrupted = attention.interrupted || [];
  if (!blocked.length && !interrupted.length) return null;
  function group(key: string, tone: string, label: string, list: View.Card[]) {
    return <div className={'pb-attention__card pb-attention__card--' + tone}>
      <header className="pb-attention__head">
        <IconWarning size={14} />
        <span>{label}</span>
        <span className="pb-attention__count">{String(list.length)}</span>
      </header>
      {list.length
        ? list.map(function(card) { return <TaskCard key={key + '-' + card.id} card={card} rank={props.ranks ? props.ranks[card.id!] : null} plans={props.plans} onOpen={props.onOpen} />; })
        : <p className="pb-attention__empty">{'无'}</p>}
    </div>;
  }
  return <div className="pb-attention">
    {group('blocked', 'danger', '阻塞', blocked)}
    {group('interrupted', 'warn', '待对账', interrupted)}
  </div>;
}

export function BoardView(props: BoardViewProps) {
  const board = props.board;
  if (!board) {
    if (props.error) return <ErrorState message={props.error} block={true} />;
    return <LoadingState label="看板加载中" />;
  }
  const filters = props.filters || {};
  const counts = board.counts || {};
  const plans = planCatalog(board, props.plans);
  const attention = board.attention || { blocked: [], interrupted: [] };
  // The tray obeys the same filter chain as the columns and the list.
  const filteredAttention = {
    blocked: filterCards(attention.blocked || [], filters),
    interrupted: filterCards(attention.interrupted || [], filters),
  };
  const active = hasActiveFilters(filters);
  const ranks = priorityRanks(
    Object.keys(board.columns || {}).reduce<View.Card[]>(function(list, key) {
      return list.concat(board!.columns![key] || []);
    }, []).concat(attention.blocked || [], attention.interrupted || [])
  );
  const gatedReview = ((board.columns && board.columns.review) || []).filter(isGate).length;
  const needYou = needYouCount(board);
  const filtered = COLUMNS.map(function(column) {
    const all = (board!.columns && board!.columns[column.key]) || [];
    return { column, all, cards: filterCards(all, filters) };
  });
  const visible = filtered.reduce(function(total, entry) { return total + entry.cards.length; }, 0)
    + filteredAttention.blocked.length + filteredAttention.interrupted.length;
  const totalCards = filtered.reduce(function(total, entry) { return total + entry.all.length; }, 0)
    + (attention.blocked || []).length + (attention.interrupted || []).length;
  return <div className="pb-board">
    <div className="pb-stats pb-stats--board">
      <StatTile tone="danger" value={needYou} label="需要你" hint={'阻塞 ' + (attention.blocked || []).length + ' · 待对账 ' + (attention.interrupted || []).length + ' · 审计 ' + gatedReview} />
      <StatTile
        tone="neutral"
        value={percentOf(counts.percent)}
        unit="%"
        label="完成度"
        hint={(counts.weightDone || 0) + '/' + (counts.weightTotal || 0) + ' 权重'}
        progress={counts.percent || 0}
      />
    </div>
    <AttentionTray attention={filteredAttention} ranks={ranks} plans={plans} onOpen={props.onOpen} />
    {totalCards === 0
      ? <EmptyState icon={IconBoard} title={active ? '没有匹配的任务' : '项目里还没有任务'} hint={active
        ? '试试清空搜索或放宽筛选。'
        : '让模型用 project_plan op=publish 发布计划，任务会自动出现在这里。'} action={active ? <Button onClick={props.onClearFilters}>{'清除筛选'}</Button> : null} />
      : <div className="pb-columns">
        {filtered.map(function(entry) {
          return <BoardColumn
            key={entry.column.key}
            column={entry.column}
            cards={entry.cards}
            ranks={ranks}
            plans={plans}
            onOpen={props.onOpen}
          />;
        })}
      </div>}
    <footer className="pb-board__foot">
      <span>{'共 ' + (counts.total || 0) + ' 个任务'}</span>
      <span>{'验收记录 ' + percentOf(counts.verifiedPercent) + '%'}</span>
      <span>{'待对账 ' + (counts.interrupted || 0)}</span>
      {active ? <span>{'筛选命中 ' + visible + '/' + totalCards}</span> : null}
      {board.rev != null ? <span>{'看板修订 ' + board.rev}</span> : null}
    </footer>
  </div>;
}
