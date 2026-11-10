// Read-only Flow projection. BoardPage owns navigation, search and task editing.
import React from 'react';
import type { BoardView } from '../model/view-types.ts';
import type { SessionSnapshot } from '../model/types.ts';
import { cardHaystack, isGate } from '../model/filters.ts';
import { blockerLabel, stateLabel, stateTone } from '../model/labels.ts';
import { buildFlowModel, flowChain, flowNowGroups, flowOrderTasks, flowUnlockCount, flowWaitState, flowWindow, layoutFlowLane } from '../model/flow-layout.ts';
import { cx, formatDateTime, percentOf, shortId } from '../utils/format.ts';
import { IconCheck, IconChevron, IconClose, IconHealth, IconInbox, IconPlay, IconWarning } from './icons.tsx';
import { Button, IconButton, StatusDot } from './primitives.tsx';

type Model = ReturnType<typeof buildFlowModel>;
type Lane = Model['lanes'][number];
type Task = Model['tasks'][number];
type Layout = ReturnType<typeof layoutFlowLane>;
type Node = Layout['nodes'][number];

export interface FlowViewProps {
  board: BoardView;
  query?: string;
  focus?: string | null;
  onFocus?: (id: string | null) => void;
  onOpen?: (id: string) => void;
  onHealth?: () => void;
  sessions?: SessionSnapshot['byId'];
}

interface Highlight {
  active: string | null;
  chain: ReadonlySet<string>;
  chainLane?: Lane;
  matches: ReadonlySet<string>;
  search: string;
}

interface Interaction {
  model: Model;
  highlight: Highlight;
  sessions?: SessionSnapshot['byId'];
  open: (id: string) => void;
  hover: (id: string | null) => void;
}

const PALETTE = ['accent', 'violet', 'teal', 'rose', 'amber', 'success', 'cyan', 'indigo'];
const FRONT_X = 96;
const FRONT_WIDTH = 230;
const STATION_WIDTH = 144;
const COLUMN_GAP = 37;
// Fit two full title lines alongside the status and acceptance rows.
const TRACK_CARD_HEIGHT = 86;
const TRACK_CARD_CENTER = TRACK_CARD_HEIGHT / 2;
const ROW_HEIGHT = TRACK_CARD_HEIGHT + 14;
const TRACK_TOP = 25;

export function FlowView({ board, query, focus, onFocus, onOpen, onHealth, sessions }: FlowViewProps) {
  const model = React.useMemo(() => buildFlowModel(board), [board]);
  const [hovered, hover] = React.useState<string | null>(null);
  const search = query?.trim().toLowerCase() || '';
  const matches = React.useMemo(() => new Set(search ? model.tasks.filter((task) =>
    (cardHaystack(task) + ' ' + (model.laneByTask.get(task.id)?.title || '').toLowerCase()).includes(search)
  ).map((task) => task.id) : []), [model, search]);
  const pinned = focus && model.byId.has(focus) ? focus : null;
  const active = hovered && model.byId.has(hovered) ? hovered : pinned;
  const chainLane = active ? model.laneByTask.get(active) : undefined;
  const chain = React.useMemo(() => active ? flowChain(model, active, chainLane) : new Set<string>(), [model, active, chainLane]);
  const highlight = { active, chain, chainLane, matches, search };
  const interaction = {
    model, highlight, hover, sessions,
    open: (id: string) => {
      hover(null);
      onFocus?.(id);
      onOpen?.(id);
    },
  };
  return <div className="pb-board-flow">
    <NowBand ui={interaction} counts={board.counts} onHealth={onHealth} />
    <div className="pb-flow__body">
      <section className="pb-flow__lanes" aria-label="计划泳道">
        <div className="pb-flow__section-head">
          <h2>计划泳道</h2>
          <div className="pb-flow__controls">
            {search ? <span role="status">{matches.size ? matches.size + ' 项匹配' : '没有匹配任务'}</span> : null}
            {pinned ? <Button size="sm" variant="ghost" icon={IconClose} onClick={() => onFocus?.(null)}>清除链路聚焦</Button> : null}
          </div>
        </div>
        {model.lanes.length ? model.lanes.map((lane) => <FlowLane key={lane.key} lane={lane} ui={interaction} pinned={pinned} />)
          : <p className="pb-flow__panel pb-flow__empty">暂无任务。新建任务后可以在这里查看推进情况。</p>}
      </section>
      <FlowRail ui={interaction} />
    </div>
  </div>;
}

const NOW_LABELS = { running: '进行中', review: '待验收', audit: '待审计', exceptions: '异常' };
type NowScope = keyof typeof NOW_LABELS;
const ATTENTION_SCOPES: readonly NowScope[] = ['review', 'audit', 'exceptions'];

function NowBand({ ui, counts, onHealth }: { ui: Interaction; counts?: BoardView['counts']; onHealth?: () => void }) {
  const { model } = ui;
  const groups = React.useMemo(() => flowNowGroups(model.nowCards), [model]);
  const [scope, setScope] = React.useState<NowScope | null>(null);
  const capacity = model.maxInProgress;
  const available = capacity === undefined ? 0 : Math.max(0, capacity - model.inProgress);
  const overCapacity = capacity !== undefined && model.inProgress > capacity;
  const next = model.queue.slice(0, Math.min(2, available));
  const count = (key: NowScope, value: React.ReactNode = groups[key].length) => <button type="button" key={key}
    className={cx('pb-flow__now-count', key === 'exceptions' && groups[key].length > 0 && 'pb-flow__warning')}
    aria-haspopup="dialog" disabled={!groups[key].length} onClick={() => setScope(key)}>
    {NOW_LABELS[key]} <strong>{value}</strong>
  </button>;

  return <section className="pb-flow__panel pb-flow__now" aria-label="现在">
    <div className="pb-flow__now-groups">
      <div className="pb-flow__now-group">
        <div className="pb-flow__now-head">
          <h2><IconPlay />正在推进</h2>
          {count('running', capacity === undefined ? model.inProgress : model.inProgress + ' / ' + capacity)}
          {groups.sessionCount > 1 ? <span>{groups.sessionCount} 个会话</span> : null}
          {overCapacity ? <span className="pb-flow__warning"><IconWarning size={13} />超出并行上限</span> : null}
        </div>
        <NowPreview tasks={groups.runningPreview} ui={ui} empty="暂无进行中的任务" />
      </div>
      <div className="pb-flow__now-group pb-flow__now-group--attention">
        <div className="pb-flow__now-head">
          <h2><IconInbox />需要处理</h2>
          {ATTENTION_SCOPES.map((key) => count(key))}
        </div>
        <NowPreview tasks={groups.attention.slice(0, 2)} ui={ui} empty="没有待处理的任务" />
      </div>
    </div>
    <div className="pb-flow__now-meta">
      {available ? <div className="pb-flow__slot">
        <span>并行余量 {available} · 就绪候选</span>
        {next.length ? next.map((task) => <button type="button" key={task.id} title={task.title} onClick={() => ui.open(task.id)}>
          <strong>#{model.queueRank.get(task.id)}</strong> {task.title}
        </button>) : <span>暂无</span>}
      </div> : null}
      <div className="pb-flow__summary">
        {counts?.percent === undefined ? null : <span>项目完成度 <strong>{percentOf(counts.percent)}%</strong></span>}
        {onHealth ? <Button variant="ghost" size="sm" icon={IconHealth} onClick={onHealth}>查看健康</Button> : null}
      </div>
    </div>
    {scope ? <NowDialog scope={scope} tasks={groups[scope]} ui={ui} onClose={() => setScope(null)} /> : null}
  </section>;
}

function NowPreview({ tasks, ui, empty }: { tasks: readonly Task[]; ui: Interaction; empty: string }) {
  if (!tasks.length) return <p className="pb-flow__now-empty">{empty}</p>;
  return <div className="pb-flow__now-preview">
    {tasks.map((task) => <FlowCard key={task.id} task={task} ui={ui} variant="now" />)}
  </div>;
}

function NowDialog({ scope, tasks, ui, onClose }: { scope: NowScope; tasks: readonly Task[]; ui: Interaction; onClose: () => void }) {
  const dialog = React.useRef<HTMLDialogElement | null>(null);
  React.useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="pb-flow__dialog" aria-label={NOW_LABELS[scope]} onClose={onClose}
    onClick={(event: React.MouseEvent<HTMLDialogElement>) => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
    <div className="pb-flow__dialog-inner">
      <div className="pb-flow__section-head"><h2>{NOW_LABELS[scope]} · {tasks.length}</h2><IconButton icon={IconClose} label="关闭" onClick={() => dialog.current?.close()} /></div>
      <div className="pb-flow__dialog-grid">
        {tasks.map((task) => <FlowCard key={task.id} task={task} ui={ui} variant="now" onClick={() => {
          dialog.current?.close();
          ui.open(task.id);
        }} />)}
      </div>
      {tasks.length ? null : <p className="pb-flow__now-empty">该组暂无任务</p>}
    </div>
  </dialog>;
}

function taskClass(task: Task, { model, highlight }: Interaction) {
  const inFocusLane = highlight.chainLane && highlight.chainLane === model.laneByTask.get(task.id);
  return cx(
    (highlight.search && !highlight.matches.has(task.id) && !highlight.chain.has(task.id))
      || (inFocusLane && !highlight.chain.has(task.id) && !highlight.matches.has(task.id)) ? 'pb-flow--dim' : null,
    highlight.matches.has(task.id) && 'pb-flow--match',
    highlight.active === task.id && 'pb-flow--selected',
  );
}

function flowState(task: Task, model: Model): string | undefined {
  if (task.leaseExpired) return '租约超期';
  if (task.state !== 'backlog') return stateLabel(task.state);
  if (!task.deps) return '待办';
  const wait = flowWaitState(model, task);
  if (wait.kind === 'missing') return '前置不可用';
  if (wait.kind === 'not-ready') return '未就绪';
  return wait.lane ? '等 · ' + wait.lane.title : '待前置';
}

function FlowCard({ task, ui, variant, style, onClick }: { task: Task; ui: Interaction; variant?: 'now' | 'station'; style?: React.CSSProperties; onClick?: () => void }) {
  const { model } = ui;
  const isStation = variant === 'station';
  const isNow = variant === 'now';
  const rank = model.queueRank.get(task.id);
  const lane = model.laneByTask.get(task.id);
  const unlocks = flowUnlockCount(model, task.id);
  const session = task.owner?.sessionId;
  const sessionTitle = session ? ui.sessions?.[session]?.title : undefined;
  const owner = typeof sessionTitle === 'string' ? sessionTitle.trim() : '';
  const reason = task.blocked?.note || (task.blocked?.code ? blockerLabel(task.blocked.code) : undefined);
  return <button type="button" className={cx('pb-flow__task', variant && 'pb-flow__task--' + variant, taskClass(task, ui))}
    data-state={task.state} title={task.title} style={style}
    onClick={onClick || (() => ui.open(task.id))}
    onMouseEnter={() => ui.hover(task.id)} onMouseLeave={() => ui.hover(null)}
    onFocus={() => ui.hover(task.id)} onBlur={() => ui.hover(null)}>
    {isStation ? <span className="pb-flow__station-dot" aria-hidden="true" /> : null}
    {isStation ? null : <span className="pb-flow__task-head">
      <span><StatusDot tone={task.leaseExpired ? 'danger' : stateTone(task.state)} />{flowState(task, model)}</span>
      {rank ? <strong className="pb-flow__rank">#{rank}</strong> : null}
      {isNow && session ? <span className="pb-flow__task-owner" title={owner ? owner + ' · ' + session : session}>{owner || '会话 ' + shortId(session, 11)}</span> : null}
      {isNow && lane ? <span className="pb-flow__task-plan">{lane.title}</span> : null}
    </span>}
    <strong className="pb-flow__task-title">{task.title || task.id}</strong>
    {isNow && task.intent?.summary ? <span className="pb-flow__intent" title={task.intent.summary}>{task.intent.summary}</span> : null}
    {isNow && reason && !task.intent?.summary ? <span className="pb-flow__intent">{reason}</span> : null}
    <span className="pb-flow__task-foot">
      {isStation ? <span>{flowState(task, model)}</span> : null}
      {!isStation && task.acceptance?.total ? <span>验收 {task.acceptance.met}/{task.acceptance.total}</span> : null}
      {task.state === 'review' && isGate(task) ? <span>待审计</span> : null}
      {!isStation && unlocks ? <span className="pb-flow__unlock">→ 解锁 {unlocks}</span> : null}
    </span>
  </button>;
}

function FlowLane({ lane, ui, pinned }: { lane: Lane; ui: Interaction; pinned: string | null }) {
  const [collapse, setCollapse] = React.useState<{ closed: boolean; reveal?: string }>({ closed: lane.kind === 'legacy' });
  const [expanded, setExpanded] = React.useState(false);
  const keep = React.useMemo(() => new Set([...lane.tasks, ...lane.finished].filter((task) => task.id === pinned || ui.highlight.matches.has(task.id)).map((task) => task.id)), [lane, pinned, ui.highlight.matches]);
  const reveal = keep.size ? JSON.stringify([ui.highlight.search, pinned]) : undefined;
  const open = !collapse.closed || (reveal !== undefined && reveal !== collapse.reveal);
  const laneColor = PALETTE[lane.color];
  const steps = lane.steps;
  return <section className={cx('pb-flow__panel', 'pb-flow__lane', lane.kind === 'legacy' && 'pb-flow__lane--legacy')} data-color={laneColor}>
    <button type="button" className="pb-flow__lane-head" aria-expanded={open} onClick={() => setCollapse({ closed: open, reveal })}>
      <span className="pb-flow__plan-mark" aria-hidden="true" />
      <strong>{lane.title}</strong>
      {lane.focus ? <span className="pb-flow__focus-badge">已聚焦计划</span> : null}
      {steps.length ? <span className="pb-flow__steps" aria-label="计划步骤进度">
        {steps.map((step) => <span className="pb-flow__segment" title={step.title + ' · ' + step.done + '/' + step.total} key={step.id}>
          <span style={{ width: percentOf(step.total ? step.done / step.total : 0) + '%' }} />
        </span>)}
      </span> : null}
      <span className="pb-flow__lane-counts">
        <span>已完成 <strong>{lane.done}/{lane.total}</strong></span>
        <span>进行 <strong>{lane.counts.active}</strong></span>
        <span>就绪 <strong>{lane.counts.ready}</strong></span>
        <span>等待 <strong>{lane.counts.waiting}</strong></span>
      </span>
      <span className={cx('pb-flow__lane-chevron', open && 'pb-flow__lane-chevron--open')}><IconChevron /></span>
    </button>
    {open ? <div className="pb-flow__lane-body">
      {lane.kind === 'legacy' ? <p className="pb-flow__hint">这些任务引用的计划或步骤已不在活动版本中。</p> : null}
      {lane.kind === 'plan' && lane.hasEdges
        ? <FlowTrack lane={lane} ui={ui} keep={keep} expanded={expanded} toggle={() => setExpanded(!expanded)} />
        : <FlowGroups lane={lane} ui={ui} keep={keep} expanded={expanded} toggle={() => setExpanded(!expanded)} />}
      {lane.finished.some((task) => keep.has(task.id)) ? <div className="pb-flow__group">
        <h3>相关已完成任务</h3>
        <div className="pb-flow__group-grid">{lane.finished.filter((task) => keep.has(task.id)).map((task) =>
          <FlowCard key={task.id} ui={ui} task={task} />)}</div>
      </div> : null}
    </div> : null}
  </section>;
}

function nodePosition(node: Node) {
  return {
    x: node.column === 0 ? FRONT_X : FRONT_X + FRONT_WIDTH + COLUMN_GAP + (node.column - 1) * (STATION_WIDTH + COLUMN_GAP),
    y: TRACK_TOP + node.row * ROW_HEIGHT,
    width: node.column === 0 ? FRONT_WIDTH : STATION_WIDTH,
  };
}

function FlowTrack({ lane, ui, keep, expanded, toggle }: { lane: Lane; ui: Interaction; keep: ReadonlySet<string>; expanded: boolean; toggle: () => void }) {
  const layout = React.useMemo(() => layoutFlowLane(lane, ui.model, { keep, expanded }), [lane, ui.model, keep, expanded]);
  const positioned = new Map(layout.nodes.map((node) => [node.task.id, nodePosition(node)]));
  const width = Math.max(FRONT_X + FRONT_WIDTH + 10, ...layout.nodes.map((node) => {
    const pos = positioned.get(node.task.id)!;
    return pos.x + pos.width + 10;
  }));
  const height = TRACK_TOP + Math.max(1, layout.rows) * ROW_HEIGHT;
  const tail = layout.nodes.some((node) => node.column > 0);
  const frontier = layout.nodes.filter((node) => node.column === 0);
  const capsuleY = TRACK_TOP + TRACK_CARD_CENTER;
  return <div>
    <div className="pb-flow__track-scroll" role="region" aria-label={lane.title + '依赖线路'} tabIndex={0}>
      <div className="pb-flow__track" style={{ width, height }}>
        {frontier.length ? <span className="pb-flow__track-label" style={{ left: FRONT_X }}>当前前沿</span> : null}
        {tail ? <div className="pb-flow__tail-zone" style={{ left: FRONT_X + FRONT_WIDTH + 18 }}><span>等待前置完成</span></div> : null}
        <svg className="pb-flow__lines" width={width} height={height} aria-hidden="true">
          {frontier.map((node) => <path key={'origin:' + node.task.id} className="pb-flow__line--origin"
            d={`M 47 ${capsuleY} H 76 V ${positioned.get(node.task.id)!.y + TRACK_CARD_CENTER} H ${FRONT_X}`} />)}
          {layout.edges.map(({ from, to }) => {
            const start = positioned.get(from);
            const end = positioned.get(to);
            if (!start || !end) return null;
            const x = start.x + start.width;
            const y = start.y + TRACK_CARD_CENTER;
            const targetX = end.x;
            const targetY = end.y + TRACK_CARD_CENTER;
            const bend = x < targetX ? (x + targetX) / 2 : Math.max(x, end.x + end.width) + COLUMN_GAP / 2;
            const highlighted = ui.highlight.chain.has(from) && ui.highlight.chain.has(to);
            return <path key={from + ':' + to}
              className={cx(start.width === FRONT_WIDTH && 'pb-flow__line--front', highlighted && 'pb-flow__line--hot',
                ui.highlight.chainLane === lane && !highlighted && 'pb-flow__line--dim')}
              d={x < targetX ? `M ${x} ${y} H ${bend} V ${targetY} H ${targetX}`
                : `M ${x} ${y} H ${bend} V ${targetY} H ${end.x + end.width}`} />;
          })}
        </svg>
        <span className="pb-flow__capsule" style={{ top: capsuleY }}><IconCheck size={13} />{lane.done}</span>
        {layout.nodes.map((node) => {
          const pos = positioned.get(node.task.id)!;
          return <FlowCard key={node.task.id} task={node.task} ui={ui} variant={node.column === 0 ? undefined : 'station'}
            style={{ position: 'absolute', left: pos.x, top: pos.y, width: pos.width, height: TRACK_CARD_HEIGHT }} />;
        })}
      </div>
    </div>
    <LaneMore expanded={expanded} hidden={layout.hiddenFront + layout.hiddenTail} toggle={toggle} />
  </div>;
}

function FlowGroups({ lane, ui, keep, expanded, toggle }: { lane: Lane; ui: Interaction; keep: ReadonlySet<string>; expanded: boolean; toggle: () => void }) {
  const stepIds = new Set(lane.steps.flatMap((step) => step.tasks.map((task) => task.id)));
  const remainder = lane.tasks.filter((task) => !stepIds.has(task.id));
  const groups = lane.steps.length ? [...lane.steps, ...(remainder.length ? [{ id: 'other', title: '其他任务', tasks: remainder }] : [])]
    : [{ id: 'all', title: '', tasks: lane.tasks }];
  let hidden = 0;
  return <div>
    <div className="pb-flow__groups" data-stepped={lane.steps.length ? 'true' : 'false'}>
      {groups.map((group) => {
        const active = flowOrderTasks(ui.model, group.tasks);
        const { visible, overflow } = flowWindow(active, expanded ? active.length : 7, keep);
        hidden += overflow.length;
        return <div className="pb-flow__group" key={group.id}>
          {group.title ? <h3>{group.title}</h3> : null}
          <div className="pb-flow__group-grid">{visible.length ? visible.map((task) =>
            <FlowCard key={task.id} ui={ui} task={task} variant={task.state === 'backlog' ? 'station' : undefined} />)
            : <p className="pb-flow__empty">{group.tasks.length ? '没有待推进的任务' : '暂无任务'}</p>}</div>
        </div>;
      })}
    </div>
    <LaneMore expanded={expanded} hidden={hidden} toggle={toggle} />
  </div>;
}

function LaneMore({ expanded, hidden, toggle }: { expanded: boolean; hidden: number; toggle: () => void }) {
  if (!expanded && !hidden) return null;
  return <div className="pb-flow__more"><Button size="sm" variant="ghost" onClick={toggle}>{expanded ? '收起额外任务' : '展开其余 ' + hidden + ' 项'}</Button></div>;
}

const VERIFIED_BY = { human: '人工验收', agent: 'AI 审计（自述）', policy: '自动验收' };

function FlowRail({ ui }: { ui: Interaction }) {
  const { model } = ui;
  const [allReady, setAllReady] = React.useState(false);
  const ready = allReady ? model.queue : model.queue.slice(0, 8);
  return <aside className="pb-flow__rail" aria-label="就绪队列与最近完成">
    <section className="pb-flow__panel">
      <div className="pb-flow__rail-head"><h2><IconInbox />就绪队列</h2><span>{model.queue.length} 项</span></div>
      {ready.length ? <ol className="pb-flow__rail-list">{ready.map((task) =>
        <li key={task.id}><RailTask task={task} ui={ui} marker={'#' + model.queueRank.get(task.id)}
          meta={model.laneByTask.get(task.id)?.title} /></li>)}</ol> : <p className="pb-flow__empty">暂无就绪任务</p>}
      {model.queue.length > 8 ? <div className="pb-flow__more"><Button variant="ghost" size="sm" onClick={() => setAllReady(!allReady)}>
        {allReady ? '收起队列' : '查看其余 ' + (model.queue.length - 8) + ' 项'}</Button></div> : null}
    </section>
    <section className="pb-flow__panel">
      <div className="pb-flow__rail-head"><h2><IconCheck />最近完成</h2></div>
      {model.recent.length ? <ul className="pb-flow__rail-list">{model.recent.slice(0, 5).map((task) =>
        <li key={task.id}><RailTask task={task} ui={ui} marker="✓"
          meta={task.verifiedBy ? VERIFIED_BY[task.verifiedBy] || '验收方式未记录' : '验收方式未记录'}
          date={task.verifiedAt || undefined} /></li>)}</ul> : <p className="pb-flow__empty">暂无已完成的任务</p>}
    </section>
  </aside>;
}

function RailTask({ task, ui, marker, meta, date }: { task: Task; ui: Interaction; marker: string; meta?: string; date?: string }) {
  return <button type="button" className={cx('pb-flow__rail-task', taskClass(task, ui))} title={task.title} onClick={() => ui.open(task.id)}
    onMouseEnter={() => ui.hover(task.id)} onMouseLeave={() => ui.hover(null)}
    onFocus={() => ui.hover(task.id)} onBlur={() => ui.hover(null)}>
    <strong className={marker === '✓' ? 'pb-flow__done-mark' : 'pb-flow__rank'}>{marker}</strong>
    <span><strong>{task.title || task.id}</strong><small>{meta || '计划外'}</small></span>
    {date ? <time dateTime={date} title={formatDateTime(date)}>{formatDateTime(date).split(' ')[0]}</time> : null}
  </button>;
}
