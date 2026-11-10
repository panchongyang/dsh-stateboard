// Plan container owns list/detail reads and guarded create/archive/focus commands; composer drafts remain local to this page.
// Plans management: list, create composer, archive/unarchive, focus.
import React from 'react';
import type * as View from '../model/view-types.ts';
import { cx, formatDateTime, percentOf } from '../utils/format.ts';
import { Badge, Button, EmptyState, ErrorState, Input, LoadingState, ProgressBar, Textarea } from '../components/primitives.tsx';
import { errorText, planCanEdit, planCreatedId, planStatusLabel, planStatusTone } from '../model/labels.ts';
import { command as sendCommand, getPlan, getPlans } from '../api/transport.ts';
import { usePageWrite } from '../hooks/page-navigation.ts';
import { IconPlan, IconPlus } from '../components/icons.tsx';
import { PlanDetailPane } from '../components/plan.tsx';
import { PlanEditPanel } from './plan-edit.tsx';

export interface PlanCardProps {
  summary: View.PlanSummary;
  selected?: boolean;
  onSelect: (summary: View.PlanSummary) => void;
}
export interface PlanComposerProps {
  title?: string;
  onCancel?: () => void;
  onTitle: (value: string) => void;
  onSubmit: () => void;
  goal?: string;
  onGoal: (value: string) => void;
  busy?: boolean;
}
export interface PlanPaneProps {
  initial?: View.PlansInitial;
  notify: View.Notify;
  projectId: string;
  onChanged?: () => void;
  board?: View.BoardView | null;
  onOpenTask?: (id: string) => void;
}
export interface PlansViewProps {
  plans?: View.PlanSummary[];
  focusPlan?: View.PlanSummary | null;
  creating?: boolean;
  createTitle?: string;
  createGoal?: string;
  busy?: boolean;
  error?: string | null;
  showEmpty?: boolean;
  selected?: View.PlanSummary | null;
  detail?: View.PlanDetail | null;
  confirmArchive?: boolean;
  previewInitial?: View.PlansInitial | null;
  onBeforeEdit: () => void;
  onCancelCreate: () => void;
  onStartCreate: () => void;
  onTitle: (value: string) => void;
  onGoal: (value: string) => void;
  onSubmitCreate: () => void;
  onSelect: (summary: View.PlanSummary) => void;
  projectId: string;
  notify: View.Notify;
  onEditDone?: (result: { mode: string }) => void;
  board?: View.BoardView | null;
  onOpenTask?: (id: string) => void;
  onFocus?: () => void;
  onAskArchive: () => void;
  onCancelArchive: () => void;
  onConfirmArchive?: () => void;
  onUnarchive?: () => void;
}









const useState = React.useState;
const useEffect = React.useEffect;

/** Pure: stable client-side order for plan summaries (active -> draft -> archived, then updatedAt). */
export function sortPlanSummaries(list: View.PlanSummary[]) {
  const ORDER: Record<string, number> = { active: 0, draft: 1, archived: 2 };
  const copy = (list || []).slice();
  copy.sort(function(a, b) {
    const ka = ORDER[a.status!] == null ? 9 : ORDER[a.status!];
    const kb = ORDER[b.status!] == null ? 9 : ORDER[b.status!];
    if (ka !== kb) return ka - kb;
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  });
  return copy;
}

/** Single selectable row in the plans list: title, status, progress, focus. */
export function PlanCard(props: PlanCardProps) {
  const summary = props.summary;
  const progress = summary.progress || { done: 0, total: 0, percent: 0 };
  return <li className="pb-plans__item">
    <button type="button" className={cx('pb-plan-card', props.selected ? 'pb-plan-card--selected' : null)} aria-pressed={props.selected ? 'true' : 'false'} onClick={function() { props.onSelect(summary); }}>
      <span className="pb-plan-card__head">
        <span className="pb-plan-card__title">{summary.title}</span>
        {summary.focus ? <Badge tone="accent">{'已聚焦'}</Badge> : null}
      </span>
      <span className="pb-plan-card__meta">
        <Badge tone={planStatusTone(summary.status)}>{planStatusLabel(summary.status)}</Badge>
        <span className="pb-plan-card__stat">{progress.done + '/' + progress.total + ' 已完成 · ' + percentOf(progress.percent) + '%'}</span>
        <span className="pb-plan-card__stat">{(summary.taskCount || 0) + ' 任务'}</span>
      </span>
      <ProgressBar value={progress.percent} tone="accent" thin={true} label={summary.title + ' 完成度'} />
      <span className="pb-plan-card__date">{'更新于 ' + formatDateTime(summary.updatedAt)}</span>
    </button>
  </li>;
}

/** Create-draft composer: title required, goal optional; submits plan.create. */
export function PlanComposer(props: PlanComposerProps) {
  const canSubmit = String(props.title || '').trim() !== '';
  return <div className="pb-composer pb-plan-composer">
    <div className="pb-composer__head">
      <span className="pb-composer__title">{'新建计划'}</span>
      <button type="button" className="pb-composer__close" aria-label="关闭新建" onClick={props.onCancel}>{'×'}</button>
    </div>
    <div className="pb-composer__body">
      <Input
        id="pb-plan-create-title"
        label="标题"
        placeholder="例如：看板 v3 交付"
        value={props.title}
        onChange={function(event) { props.onTitle(event.target.value); }}
        onKeyDown={function(event) { if (event.key === 'Enter') props.onSubmit(); }}
      />
      <Textarea
        id="pb-plan-create-goal"
        label="目标（可选）"
        rows={3}
        placeholder="一句话描述这个计划要达成什么"
        value={props.goal}
        onChange={function(event) { props.onGoal(event.target.value); }}
      />
      <div className="pb-composer__actions">
        <Button size="sm" disabled={props.busy} onClick={props.onCancel}>{'取消'}</Button>
        <Button size="sm" variant="primary" busy={props.busy} disabled={!canSubmit} onClick={props.onSubmit}>{props.busy ? '创建中…' : '创建计划'}</Button>
      </div>
      <p className="pb-hint">{'创建后是草稿：任务数为 0，发布时才按步骤生成任务。'}</p>
    </div>
  </div>;
}

/** Plans management page: list, create composer, archive/unarchive, focus. */
export function PlanPane(props: PlanPaneProps) {
  const command = usePageWrite(sendCommand);
  const initial = props.initial || {};
  const notify = props.notify || function() { };
  const [plans, setPlans] = useState(initial.plans || null);
  const [focusId, setFocusId] = useState(initial.focusPlanId == null ? null : initial.focusPlanId);
  const [selected, setSelected] = useState(initial.selected || null);
  const [detail, setDetail] = useState(initial.detail || null);
  const [loading, setLoading] = useState(!initial.plans);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(Boolean(initial.creating));
  const [createTitle, setCreateTitle] = useState(initial.createTitle || '');
  const [createGoal, setCreateGoal] = useState(initial.createGoal || '');
  const [busy, setBusy] = useState(false); const [confirmArchive, setConfirmArchive] = useState(Boolean(initial.confirmArchive));

  function loadList() {
    return getPlans(props.projectId).then(function(value: { plans?: View.PlanSummary[]; focusPlanId?: string }) {
      setPlans(value.plans || []);
      setFocusId(value.focusPlanId == null ? null : value.focusPlanId);
      setError(null);
      setLoading(false);
      return value.plans || [];
    }).catch(function(reason) {
      setLoading(false);
      throw reason;
    });
  }

  function loadDetail(id: string) {
    return getPlan(props.projectId, id).then(function(value) {
      setDetail(value);
      return value;
    });
  }

  function selectCard(summary: View.PlanSummary) {
    if (!summary) return;
    setSelected(summary);
    setConfirmArchive(false);
    loadDetail(summary.id!).catch(function(reason) {
      setError(errorText(reason));
    });
  }

  function refreshAfterWrite(id: string) {
    loadList().then(function(list) {
      const hit = summaryById(list, id);
      if (hit) {
        setSelected(hit);
        loadDetail(hit.id!).catch(function(reason) { setError(errorText(reason)); });
      } else {
        setSelected(null);
        setDetail(null);
      }
      if (props.onChanged) props.onChanged();
    }).catch(function(reason) {
      setError(errorText(reason));
    });
  }

  useEffect(function() {
    if (!props.projectId) return undefined;
    if (initial.plans) return undefined;
    loadList().then(function(list) {
      let hit = null;
      for (let i = 0; i < list.length; i += 1) if (list[i].focus) { hit = list[i]; break; }
      if (!hit && list.length) hit = list[0];
      if (hit) selectCard(hit);
      else { setSelected(null); setDetail(null); }
    }).catch(function(reason) {
      setError(errorText(reason));
    });
  }, [props.projectId]);

  function fail(failure: unknown) {
    setBusy(false);
    setError(errorText(failure));
    notify('error', errorText(failure));
  }

  function submitCreate() {
    const title = String(createTitle || '').trim();
    if (!title || busy) return;
    setBusy(true);
    setError(null);
    command(props.projectId, { op: 'plan.create', title, goal: String(createGoal || '').trim() || undefined })
      .then(function(result) {
        setBusy(false);
        const id = planCreatedId(result);
        notify('success', '计划「' + title + '」已创建');
        setCreating(false);
        setCreateTitle('');
        setCreateGoal('');
        loadList().then(function(list) {
          const hit = summaryById(list, id);
          if (hit) {
            setSelected(hit);
            loadDetail(hit.id!).catch(function(reason) { setError(errorText(reason)); });
          }
          if (props.onChanged) props.onChanged();
        }).catch(fail);
      })
      .catch(fail);
  }

  function archiveSelected() {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    command(props.projectId, { op: 'plan.archive', planId: selected.id, expected: { entityRev: selected.rev } })
      .then(function() {
        setBusy(false);
        setConfirmArchive(false);
        notify('success', '计划「' + selected!.title + '」已归档');
        refreshAfterWrite(selected!.id!);
      })
      .catch(fail);
  }

  function unarchiveSelected() {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    command(props.projectId, { op: 'plan.unarchive', planId: selected.id, expected: { entityRev: selected.rev } })
      .then(function() {
        setBusy(false);
        notify('success', '计划「' + selected!.title + '」已恢复');
        refreshAfterWrite(selected!.id!);
      })
      .catch(fail);
  }

  function focusSelected() {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    command(props.projectId, { op: 'plan.focus', planId: selected.id })
      .then(function() {
        setBusy(false);
        notify('success', '已聚焦「' + selected!.title + '」');
        refreshAfterWrite(selected!.id!);
      })
      .catch(fail);
  }

  if (error && !plans) {
    return <ErrorState message={error} block={true} action={<Button size="sm" onClick={function() {
      setLoading(true);
      setError(null);
      loadList().catch(function(reason) { setError(errorText(reason)); });
    }}>{'重试'}</Button>} />;
  }
  if (!plans) return <LoadingState label="计划加载中" />;

  const sorted = sortPlanSummaries(plans);
  const focusPlan = summaryById(sorted, focusId);
  const showEmpty = sorted.length === 0 && !creating;

  return <PlansView
    key={selected ? selected.id : 'none'}
    projectId={props.projectId}
    plans={sorted}
    focusPlan={focusPlan}
    creating={creating}
    createTitle={createTitle}
    createGoal={createGoal}
    busy={busy}
    error={error}
    showEmpty={showEmpty}
    selected={selected}
    detail={detail}
    board={props.board}
    confirmArchive={confirmArchive}
    previewInitial={initial.editing || initial.editInitial ? initial : null}
    onBeforeEdit={function() { setConfirmArchive(false); }}
    onEditDone={function(result) { if (result && result.mode && result.mode !== 'cancel' && selected) refreshAfterWrite(selected!.id!); }}
    onOpenTask={props.onOpenTask}
    onStartCreate={function() { setCreating(true); }}
    onCancelCreate={function() { setCreating(false); }}
    onTitle={setCreateTitle}
    onGoal={setCreateGoal}
    onSubmitCreate={submitCreate}
    onSelect={selectCard}
    onAskArchive={function() { setConfirmArchive(true); }}
    onCancelArchive={function() { setConfirmArchive(false); }}
    onConfirmArchive={archiveSelected}
    onUnarchive={unarchiveSelected}
    onFocus={focusSelected}
    notify={notify}
  />;
}
function PlansView(props: PlansViewProps) {
  const sorted = props.plans || [];
  const focusPlan = props.focusPlan || null;
  const creating = props.creating;
  const createTitle = props.createTitle;
  const createGoal = props.createGoal;
  const busy = props.busy;
  const error = props.error;
  const showEmpty = props.showEmpty;
  const selected = props.selected;
  const detail = props.detail;
  const confirmArchive = props.confirmArchive;
  const previewInitial = props.previewInitial || {};
  const [editing, setEditing] = useState(Boolean(previewInitial.editing));

  function startEdit() {
    if (!selected || busy || !detail || !detail.head) return;
    props.onBeforeEdit();
    setEditing(true);
  }
  return <div className="pb-page pb-plans">
    <div className="pb-plans__head">
      <div className="pb-plans__head-text">
        <h2 className="pb-plans__title">{'计划'}</h2>
        <p className="pb-plans__meta">{sorted.length + ' 个计划 · ' + (focusPlan ? '聚焦「' + focusPlan.title + '」' : '未聚焦')}</p>
      </div>
      <div className="pb-plans__actions">
        {creating
          ? <Button variant="secondary" onClick={function() { props.onCancelCreate(); }}>{'收起'}</Button>
          : <Button variant="primary" icon={IconPlus} onClick={function() { props.onStartCreate(); }}>{'新建计划'}</Button>}
      </div>
    </div>
    {error ? <ErrorState message={error} /> : null}
    {creating ? <PlanComposer
      title={createTitle}
      goal={createGoal}
      busy={busy}
      onTitle={props.onTitle}
      onGoal={props.onGoal}
      onCancel={function() { props.onCancelCreate(); }}
      onSubmit={props.onSubmitCreate}
    /> : null}
    {showEmpty
      ? <EmptyState icon={IconPlan} title="还没有计划" hint="新建一个计划草稿：写清标题和目标，发布后按步骤生成任务。" action={<Button variant="primary" icon={IconPlus} onClick={function() { props.onStartCreate(); }}>{'新建计划'}</Button>} />
      : <div className="pb-plans__grid">
        <ul className="pb-plans__list">
          {sorted.map(function(summary) {
            return <PlanCard key={summary.id} summary={summary} selected={Boolean(selected && selected.id === summary.id)} onSelect={props.onSelect} />;
          })}
        </ul>
        <div className="pb-plans__detail">
          {selected
            ? (editing
              ? <PlanEditPanel
                key={selected.id}
                projectId={props.projectId}
                summary={selected}
                detail={detail}
                notify={props.notify}
                initial={previewInitial.editInitial || undefined}
                onDone={function(result) {
                  setEditing(false);
                  if (props.onEditDone && result && result.mode !== 'cancel') props.onEditDone(result);
                }}
              />
              : <PlanDetailPane
                summary={selected}
                detail={detail}
                board={props.board}
                busy={busy}
                confirmArchive={confirmArchive}
                canEdit={Boolean(detail && detail.head && planCanEdit(selected))}
                onStartEdit={startEdit}
                onOpenTask={props.onOpenTask}
                notify={props.notify}
                onFocus={props.onFocus}
                onAskArchive={function() { props.onAskArchive(); }}
                onCancelArchive={function() { props.onCancelArchive(); }}
                onConfirmArchive={props.onConfirmArchive}
                onUnarchive={props.onUnarchive}
              />)
            : <EmptyState icon={IconPlan} title="选择一张计划卡片" hint="点击左侧卡片查看详情与进度。" />}
        </div>
      </div>}
  </div>;
}

// Match the existing last-hit lookup; duplicate summaries are not reordered.
function summaryById(list: View.PlanSummary[], id: string | null) {
  let hit = null;
  for (let i = 0; i < list.length; i += 1) if (list[i].id === id) hit = list[i];
  return hit;
}
