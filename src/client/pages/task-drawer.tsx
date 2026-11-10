// Task container owns task reads, guarded operations and composer state; Drawer receives live navigation suspension through props.
// Task drawer: frame (header, next action, overflow menu, focus/close).
// Detail -> ./task-detail.js, write-op forms -> ./task-composer.js.
import React from 'react';
import type * as View from '../model/view-types.ts';
import { DRIFT_WAIVER_LABELS, errorText, opLabel, reasonText, stateLabel, stateTone } from '../model/labels.ts';
import { copyText, cx, shortId } from '../utils/format.ts';
import { commandBody } from '../model/payloads.ts';
import { openSessionById } from '../model/session-jump.ts';
import { pickTaskSession } from '../model/selectors.ts';
import { command as sendCommand } from '../api/transport.ts';
import { PageNavigationContext, usePageWrite } from '../hooks/page-navigation.ts';
import { useTask } from '../hooks/use-page-read.ts';
import { Drawer } from '../components/drawer.tsx';
import { Button, ErrorState, Input, LoadingState, StatusDot, Switch } from '../components/primitives.tsx';
import { IconCopy } from '../components/icons.tsx';
import { TaskDetail } from '../components/task-detail.tsx';
import { TaskComposer } from '../components/task-composer.tsx';

export interface TaskLoadingProps {
  suspended?: boolean | (() => boolean);
  onClose?: () => void;
  error?: string | null;
  onRetry?: () => void;
}
export interface DriftWaiverProps {
  warnings?: View.Warning[];
  reason?: string;
  onCancel?: () => void;
  onReason: (value: string) => void;
  busy?: boolean;
  onRefresh?: () => void;
  onWaive?: () => void;
}
export interface TaskHeadProps {
  task: View.TaskDetail;
  target: View.TaskSession;
  creatorId?: string | null;
  notify: View.Notify;
}
export interface TaskDrawerProps {
  projectId: string;
  taskId: string;
  refreshKey?: number;
  initial?: { view?: View.TaskView };
  notify?: View.Notify;
  onChanged?: () => void;
  onClose?: () => void;
  onOpenDoc?: (id: string) => void;
}
export interface TaskMenuProps {
  view: View.TaskView;
  task: View.TaskDetail;
  busy?: boolean;
  opInfo: (name: string) => View.AllowedOp;
  gateOp: View.AllowedOp;
  onAct: (op: string, extra?: Record<string, unknown>) => void;
  gateOn?: boolean;
  confirmOp?: string | null;
  onCloseMenu: () => void;
  onCloseConfirm: () => void;
  reason?: string;
  onReason: (value: string) => void;
  onPick: (item: View.MenuItem) => void;
  onConfirm?: (op: string) => void;
  onOpenComposer?: (name: string) => void;
}














const useState = React.useState;

/** Pure: the single next action for a task, derived from state + allowedOps. */
export function nextActionFor(task: View.Task, ops: View.AllowedOp[] | undefined) {
  const state = task && task.state ? task.state : '';
  const list = ops || [];
  function on(name: string) {
    for (let i = 0; i < list.length; i += 1) if (list[i].op === name && list[i].enabled) return true;
    return false;
  }
  const byState: Record<string, string[]> = {
    ready: ['claim'],
    in_progress: ['submit', 'block', 'release'],
    review: ['verify', 'reject'],
    blocked: ['unblock'],
    interrupted: ['reconcile'],
  };
  const candidates = byState[state] || [];
  for (let j = 0; j < candidates.length; j += 1) {
    if (on(candidates[j])) return { op: candidates[j], primary: j === 0 };
  }
  return null;
}

/** Danger ops confirm in place inside the menu. */
const CONFIRM_META: Record<string, { title: string; ok: string; reason: string; needsReason: boolean }> = {
  reject: { title: '驳回这个任务？', ok: '驳回', reason: '在界面中驳回', needsReason: true },
  cancel: { title: '取消这个任务？', ok: '取消任务', reason: '在界面中取消', needsReason: true },
  reopen: { title: '重新打开这个任务？', ok: '重开', reason: '在界面中重开', needsReason: false },
};

function TaskLoading(props: TaskLoadingProps) {
  return <Drawer suspended={props.suspended} titleId="pb-task-drawer-title" onClose={props.onClose} head={<div className="pb-drawer__title">
    <span className="pb-drawer__eyebrow">{'任务'}</span>
    <h2 className="pb-drawer__h2" id="pb-task-drawer-title">{'加载中…'}</h2>
  </div>}>
    <div className="pb-drawer__body">
      {props.error
        ? <ErrorState message={props.error} block={true} action={<Button size="sm" onClick={props.onRetry}>{'重试'}</Button>} />
        : <LoadingState label="任务加载中" />}
    </div>
  </Drawer>;
}

/** Human-only waiver shown when verify refuses because evidence drifted. */
function DriftWaiver(props: DriftWaiverProps) {
  const warnings = props.warnings || [];
  const canWaive = String(props.reason || '').trim().length >= 4;
  const canRefresh = warnings.some(function(warning) { return warning.code === 'file-drift'; });
  return <div className="pb-composer pb-composer--danger">
    <div className="pb-composer__head">
      <span className="pb-composer__title">{'证据漂移 · ' + warnings.length + ' 项'}</span>
      <button type="button" className="pb-composer__close" aria-label="收起" title="收起" onClick={props.onCancel}>{'×'}</button>
    </div>
    <div className="pb-composer__body">
      <p className="pb-hint">{'verify 复核发现证据与提交时不一致。内容变更的文件可以刷新 hash 后 verify；其余情况需要重新提交证据，或作为人类写下理由后豁免这一次。'}</p>
      <ul className="pb-warnings">
        {warnings.map(function(warning, index) {
          return <li key={index} className="pb-warning">
            <span>{(DRIFT_WAIVER_LABELS[warning.code!] || warning.code) + '：' + warning.message}</span>
          </li>;
        })}
      </ul>
      <Input id="pb-drift-reason" label="理由（必填，写入审计记录）" placeholder="例如：设计稿提交后有注释修订，内容已人工复核" value={props.reason} onChange={function(event) { props.onReason(event.target.value); }} />
      <div className="pb-composer__actions">
        <Button size="sm" variant="ghost" onClick={props.onCancel}>{'取消'}</Button>
        {canRefresh ? <Button size="sm" variant="primary" disabled={props.busy || !canWaive} onClick={props.onRefresh}>{props.busy ? '处理中…' : '刷新证据并 verify'}</Button> : null}
        <Button size="sm" variant={canRefresh ? 'ghost' : 'primary'} disabled={props.busy || !canWaive} onClick={props.onWaive}>{props.busy ? '处理中…' : '人工豁免并 verify'}</Button>
      </div>
    </div>
  </div>;
}

/** Drawer header: state, title, priority/weight, sessions and copyable id. */
function TaskHead(props: TaskHeadProps) {
  const task = props.task;
  const target = props.target;
  const creatorId = props.creatorId;
  return <div className="pb-drawer__title">
    <span className="pb-drawer__eyebrow">
      <StatusDot tone={stateTone(task.state)} />
      {stateLabel(task.state) + ' · 修订 ' + task.rev}
    </span>
    <h2 className="pb-drawer__h2" id="pb-task-drawer-title">{task.title}</h2>
    <p className="pb-drawer__meta">
      <span>{'P' + (task.priority != null ? task.priority : 100)}</span>
      <span>{'权重 ' + (task.weight || 1)}</span>
      {target.sessionId
        ? <button type="button" className="pb-session-link" title={'跳到会话 ' + target.sessionId} onClick={function() { openSessionById(target.sessionId!, props.notify); }}>{(target.source === 'creator' ? '创建者 · ' : '会话 · ') + shortId(target.sessionId, 8)}</button>
        : <span>{'无关联会话'}</span>}
      {// The creator is claimed work's most useful "who do I ask" clue, so it
        // stays visible even when a different session owns the task.
        creatorId && creatorId !== target.sessionId
        ? <button type="button" className="pb-session-link" title={'跳到创建者会话 ' + creatorId} onClick={function() { openSessionById(creatorId!, props.notify); }}>{'创建者 · ' + shortId(creatorId, 8)}</button>
        : null}
      <span className="pb-idchip">
        <span className="pb-mono">{shortId(task.id, 12)}</span>
        <button type="button" className="pb-copy" title="复制任务 ID" aria-label="复制任务 ID" onClick={function() { if (copyText(task.id)) props.notify('success', '已复制 ' + task.id); }}>
          <IconCopy size={12} />
        </button>
      </span>
    </p>
  </div>;
}

export function TaskDrawer(props: TaskDrawerProps) {
  const command = usePageWrite(sendCommand);
  const scope = React.useContext(PageNavigationContext);
  function suspended() { return Boolean(scope && scope.navigation.snapshot().intent); }
  const projectId = props.projectId;
  const taskId = props.taskId;
  const state = useTask(projectId, taskId, props.refreshKey, props.initial);
  const view = state.view as (View.TaskView & { task: View.TaskDetail }) | null;
  const notify = props.notify || function() { };
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [beginSummary, setBeginSummary] = useState(''); const [evidenceKind, setEvidenceKind] = useState('file'); const [evidenceRef, setEvidenceRef] = useState('');
  const [evidenceSummary, setEvidenceSummary] = useState(''); const [acceptanceId, setAcceptanceId] = useState(''); const [note, setNote] = useState('');
  const [blockCode, setBlockCode] = useState('external-dependency'); const [blockNote, setBlockNote] = useState('');
  const [choice, setChoice] = useState('completed'); const [reconcileNote, setReconcileNote] = useState(''); const [reason, setReason] = useState('');
  const [composer, setComposer] = useState<string | null>(null); const [confirmOp, setConfirmOp] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false); const [timelineOpen, setTimelineOpen] = useState(false);
  const [drift, setDrift] = useState<View.Warning[] | null>(null); const [driftReason, setDriftReason] = useState('');

  function reload() {
    state.reload();
    if (props.onChanged) props.onChanged();
  }

  function act(op: string, extra?: Record<string, unknown>) {
    if (!view || busy || !(view.allowedOps || []).some(function(item) { return item.op === op && item.enabled; })) return;
    setBusy(true);
    setError(null);
    setDrift(null);
    command(projectId, commandBody(view, op, extra))
      .then(function() {
        setBusy(false);
        setComposer(null);
        notify('success', opLabel(op) + '成功');
        reload();
      })
      .catch(function(failure) {
        setBusy(false);
        const reasons = failure && failure.code === 'evidence-drift' && failure.details && failure.details.canAcknowledgeDrift !== false && Array.isArray(failure.details.warnings)
          ? failure.details.warnings
          : null;
        setDrift(reasons && reasons.length ? reasons : null);
        setError(errorText(failure));
        notify('error', errorText(failure));
      });
  }

  function opInfo(name: string) {
    const list = (view && view.allowedOps) || [];
    for (let i = 0; i < list.length; i += 1) if (list[i].op === name) return list[i];
    return { op: name, enabled: false, reason: 'not available' };
  }

  if (!view) return <TaskLoading suspended={suspended} onClose={props.onClose} error={state.error} onRetry={state.reload} />;

  const task = view.task;
  const gateOn = task.requiresAudit === true || (task.labels || []).indexOf('gate:audit') >= 0;
  const gateOp = opInfo('gate');
  const acceptance = view.acceptance || [];
  const evidence = view.evidence || [];
  const linkedDocs = view.linkedDocs || [];
  const timeline = view.timeline || [];
  const met = acceptance.filter(function(item) { return item.met; }).length;
  const next = nextActionFor(task, view.allowedOps);
  const nextInfo = next ? opInfo(next.op) : null;
  const nextLabel = next ? opLabel(next.op) : '暂无可执行操作';
  let nextReason = '';
  if (!next) {
    const blockedReasons = (view.allowedOps || []).filter(function(op) { return !op.enabled && op.reason; });
    nextReason = blockedReasons.length ? reasonText(blockedReasons[0].reason) : '等待外部条件';
  } else if (nextInfo && !nextInfo.enabled) {
    nextReason = reasonText(nextInfo.reason);
  }
  const target = pickTaskSession(task);
  const creatorId = task.createdBy && task.createdBy.sessionId ? task.createdBy.sessionId : null;

  function runNext() {
    if (!next) return;
    if (next.op === 'claim' || next.op === 'verify' || next.op === 'unblock' || next.op === 'release') { act(next.op); return; }
    if (next.op === 'begin') { setComposer('begin'); return; }
    if (next.op === 'submit') { setComposer('submit'); return; }
    if (next.op === 'block') { setComposer('block'); return; }
    if (next.op === 'reconcile') { setComposer('reconcile'); return; }
    if (next.op === 'reject') { setMoreOpen(true); setConfirmOp('reject'); return; }
    act(next.op);
  }

  function pickMenuItem(item: View.MenuItem) {
    if (item.confirm) { setConfirmOp(item.op); return; }
    setMoreOpen(false);
    if (item.open) setComposer(item.open); else act(item.run!);
  }

  return <Drawer suspended={suspended} titleId="pb-task-drawer-title" onClose={props.onClose} head={<TaskHead task={task} target={target} creatorId={creatorId} notify={notify} />}>
    <div className="pb-nextwrap">
      <div className="pb-next" role="group" aria-label="下一步">
        <div className="pb-next__text">
          <span className="pb-next__label">{'下一步'}</span>
          <span className="pb-next__op">{nextLabel}</span>
          <span className="pb-next__reason" title={nextReason}>{nextReason}</span>
        </div>
        <div className="pb-next__actions">
          <Button variant="primary" size="sm" disabled={busy || !next} title={next ? '' : nextReason} onClick={runNext}>{busy ? '处理中…' : nextLabel}</Button>
          <Button size="sm" variant="ghost" aria-expanded={moreOpen ? 'true' : 'false'} onClick={function() { setConfirmOp(null); setMoreOpen(!moreOpen); }}>{'更多 ' + (moreOpen ? '▴' : '▾')}</Button>
        </div>
      </div>
      {moreOpen ? <TaskMenu
        view={view}
        task={task}
        busy={busy}
        gateOn={gateOn}
        gateOp={gateOp}
        confirmOp={confirmOp}
        reason={reason}
        onReason={setReason}
        onConfirm={function(op) { setConfirmOp(op); }}
        onCloseConfirm={function() { setConfirmOp(null); }}
        onCloseMenu={function() { setMoreOpen(false); }}
        onOpenComposer={function(name) { setComposer(name); }}
        onPick={pickMenuItem}
        onAct={act}
        opInfo={opInfo}
      /> : null}
    </div>
    <div className="pb-drawer__body">
      <TaskComposer
        composer={composer}
        view={view}
        busy={busy}
        acceptance={acceptance}
        opInfo={opInfo}
        act={act}
        onClose={function() { setComposer(null); }}
        fields={{
          beginSummary, evidenceKind, evidenceRef, evidenceSummary,
          acceptanceId, note, blockCode, blockNote, choice, reconcileNote,
        }}
        setters={{
          setBeginSummary, setEvidenceKind, setEvidenceRef, setEvidenceSummary,
          setAcceptanceId, setNote, setBlockCode, setBlockNote, setChoice, setReconcileNote,
        }}
      />
      {error ? <ErrorState message={error} block={true} action={<Button size="sm" onClick={function() { setError(null); state.reload(); }}>{'刷新'}</Button>} /> : null}
      {drift ? <DriftWaiver
        warnings={drift}
        reason={driftReason}
        busy={busy}
        onReason={setDriftReason}
        onCancel={function() { setDrift(null); setDriftReason(''); }}
        onRefresh={function() { act('verify', { refreshDrift: true, reason: driftReason.trim() }); }}
        onWaive={function() { act('verify', { acknowledgeDrift: true, reason: driftReason.trim() }); }}
      /> : null}
      <TaskDetail
        task={task}
        acceptance={acceptance}
        evidence={evidence}
        linkedDocs={linkedDocs}
        timeline={timeline}
        met={met}
        timelineOpen={timelineOpen}
        onToggleTimeline={function() { setTimelineOpen(!timelineOpen); }}
        notify={notify}
        onOpenDoc={props.onOpenDoc}
      />
    </div>
  </Drawer>;
}

function TaskMenu(props: TaskMenuProps) {
  const view = props.view;
  const task = props.task;
  const busy = props.busy;
  const opInfo = props.opInfo;

  function opKnown(name: string) {
    const list = (view && view.allowedOps) || [];
    for (let i = 0; i < list.length; i += 1) if (list[i].op === name) return true;
    return false;
  }
  const MENU_GROUPS: View.MenuGroup[] = [
    {
      id: 'govern', label: '治理', items: [
        { op: 'block', label: '标记阻塞', open: 'block', states: ['in_progress', 'review'] },
        { op: 'reconcile', label: '对账', open: 'reconcile', states: ['interrupted'] },
        { op: 'release', label: '释放租约', run: 'release', states: ['in_progress'] },
      ]
    },
    {
      id: 'danger', label: '危险', items: [
        { op: 'reject', label: '驳回', confirm: true },
        { op: 'cancel', label: '取消任务', confirm: true },
        { op: 'reopen', label: '重开', confirm: true },
      ]
    },
  ];
  const menuGroups = MENU_GROUPS.map(function(group) {
    return {
      id: group.id,
      label: group.label,
      items: group.items.filter(function(item) {
        if (!opKnown(item.op)) return false;
        if (item.states && item.states.indexOf(task.state!) < 0) return false;
        return true;
      }),
    };
  }).filter(function(group) { return group.items.length > 0; });

  function toggleGate() {
    if (!view || busy || !props.gateOp.enabled) return;
    props.onAct('gate', { requiresAudit: !props.gateOn });
  }

  function runConfirm() {
    const op = props.confirmOp;
    if (!op || !CONFIRM_META[op] || busy || !opInfo(op).enabled) return;
    const meta = CONFIRM_META[op];
    props.onCloseMenu();
    props.onCloseConfirm();
    props.onAct(op, { reason: String(props.reason).trim() || meta.reason });
  }

  return <div className="pb-menu" role="menu">
    {props.confirmOp ? null : <div className="pb-menu__row">
      <span className="pb-menu__row-label">{'审计门'}</span>
      <span className="pb-menu__row-hint">{props.gateOn ? '人类或独立 AI 审计' : '人类验收；可开启审计门'}</span>
      <Switch checked={props.gateOn} disabled={busy || !props.gateOp.enabled} onClick={toggleGate} label={props.gateOn ? '已开启' : '关闭'} title={props.gateOp.enabled ? '' : reasonText(props.gateOp.reason)} />
    </div>}
    {props.confirmOp ? <div className="pb-menu__confirm">
      <div className="pb-menu__confirm-title">{CONFIRM_META[props.confirmOp].title}</div>
      {CONFIRM_META[props.confirmOp].needsReason ? <Input id="pb-confirm-reason" label="说明（写进审计日志）" placeholder="写清原因" value={props.reason} onChange={function(event) { props.onReason(event.target.value); }} /> : <p className="pb-hint">{'重新打开后可以再次领取。'}</p>}
      <div className="pb-menu__confirm-actions">
        <Button size="sm" onClick={function() { props.onCloseConfirm(); }}>{'返回'}</Button>
        <Button variant="danger" size="sm" disabled={busy || !opInfo(props.confirmOp).enabled || (CONFIRM_META[props.confirmOp].needsReason && !String(props.reason).trim())} onClick={runConfirm}>{CONFIRM_META[props.confirmOp].ok}</Button>
      </div>
    </div> : menuGroups.map(function(group) {
      return <div key={group.id} className="pb-menu__group">
        <div className="pb-menu__label">{group.label}</div>
        {group.items.map(function(item) {
          const info = opInfo(item.op);
          return <button
            key={item.op}
            type="button"
            role="menuitem"
            className={cx('pb-menu__item', group.id === 'danger' && item.op !== 'reopen' ? 'pb-menu__item--danger' : null, info.enabled ? null : 'pb-menu__item--off')}
            disabled={busy || !info.enabled}
            title={info.enabled ? '' : reasonText(info.reason)}
            onClick={function() { props.onPick(item); }}
          >
            <span className="pb-menu__item-label">{item.label}</span>
            {info.enabled ? null : <span className="pb-menu__item-reason">{reasonText(info.reason)}</span>}
          </button>;
        })}
      </div>;
    })}
  </div>;
}
