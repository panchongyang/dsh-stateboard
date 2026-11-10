// Plan editor owns hydration, drafts and CAS writes; stale revisions preserve the draft and expose conflict actions.
// Plan detail editor: page orchestration (PlanEditPanel) plus the read-mostly
// view tree (PlanEditPane / PlanEditDiffPanel). The panel owns the draft form,
// hydrates full task fields, sends plan.revise / plan.publish and surfaces the
// baseVersion conflict banner without ever clearing the human's draft.

import React from 'react';
import type * as View from '../model/view-types.ts';
import { errorText, planStatusLabel, planStatusTone } from '../model/labels.ts';
import { Badge, Button, ErrorState, LoadingState } from '../components/primitives.tsx';
import { IconPlus, IconWarning } from '../components/icons.tsx';
import { command as sendCommand, getTask } from '../api/transport.ts';
import { usePageWrite } from '../hooks/page-navigation.ts';
import {
  planEditAddStep, planEditDiff, planEditPayload, planEditPublishPayload,
  planEditSeed, planEditSteps,
} from '../model/plan-edit.ts';
import { PlanEditStep } from '../components/plan-edit-task.tsx';

export interface PlanEditPanelProps {
  initial?: View.PlanEditInitial;
  summary?: View.PlanSummary;
  detail?: View.PlanDetail | null;
  projectId?: string;
  onDone: (result: { mode: string }) => void;
  notify: View.Notify;
}
export interface PlanEditPaneProps {
  summary?: View.PlanSummary;
  isDraft?: boolean;
  form?: View.EditForm;
  parsed?: import('../model/types.ts').EditStepsResult;
  busy?: boolean;
  onCancel?: () => void;
  conflict?: boolean;
  onReload?: () => void;
  onKeepEditing?: () => void;
  error?: string | null;
  onForm: (form: View.EditForm) => void;
  onSave?: () => void;
  onPublish?: () => void;
  confirming?: boolean;
  publishConfirm?: boolean;
  diff?: import('../model/types.ts').EditDiff | null;
  onConfirm?: () => void;
  onCloseConfirm?: () => void;
}
export interface PlanEditDiffPanelProps {
  diff?: import('../model/types.ts').EditDiff | null;
  publish?: boolean;
  busy?: boolean;
  onClose?: () => void;
  onConfirm?: () => void;
}








const useState = React.useState;
const useEffect = React.useEffect;

/** Stateful editor container. Mounts per edit session; onDone reports the exit mode. */
export function PlanEditPanel(props: PlanEditPanelProps) {
  const command = usePageWrite(sendCommand);
  const initial = props.initial || {};
  const summary = props.summary || {};
  const detail = props.detail || {};
  const head = detail.head || null;
  const [form, setForm] = useState(initial.form || null);
  const [base, setBase] = useState(initial.base || []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(initial.error || null);
  const [conflict, setConflict] = useState(Boolean(initial.conflict));
  const [confirming, setConfirming] = useState(Boolean(initial.confirming));
  const [publishConfirm, setPublishConfirm] = useState(Boolean(initial.publishConfirm));
  const [busy, setBusy] = useState(false);

  useEffect(function() {
    if (form !== null || !head) return undefined;
    hydrate();
  }, []);

  function hydrate() {
    const steps = Array.isArray(detail.steps) ? detail.steps : [];
    const taskIds: string[] = [];
    steps.forEach(function(step) {
      (step && Array.isArray(step.tasks) ? step.tasks : []).forEach(function(task) {
        if (task && task.id) taskIds.push(task.id);
      });
    });
    if (taskIds.length === 0) {
      const seeded = planEditSeed(steps, null);
      setForm(seeded);
      setBase(planEditSteps(seeded).steps!);
      return;
    }
    setLoading(true);
    Promise.all(taskIds.map(function(id) { return getTask(props.projectId!, id); }))
      .then(function(views) {
        const byId: Record<string, View.Task> = {};
        views.forEach(function(view) {
          if (view && view.task) byId[view.task.id!] = view.task;
        });
        const seeded = planEditSeed(steps, byId);
        const parsed = planEditSteps(seeded);
        setForm(seeded);
        setBase(parsed.ok ? parsed.steps! : []);
      })
      .catch(function(failure) {
        setError(errorText(failure));
      })
      .finally(function() { setLoading(false); });
  }

  function done(mode: string) {
    props.onDone({ mode });
  }

  function submit(body: import('../model/types.ts').PlanCommand, message: string) {
    setBusy(true);
    setError(null);
    command(props.projectId!, body)
      .then(function() {
        setBusy(false);
        setConflict(false);
        setConfirming(false);
        setPublishConfirm(false);
        props.notify('success', message);
        done('saved');
      })
      .catch(function(failure) {
        setBusy(false);
        setConfirming(false);
        setPublishConfirm(false);
        // 409 / stale-revision: keep every keystroke, show the conflict bar.
        if (failure && failure.code === 'stale-revision') { setConflict(true); return; }
        const text = errorText(failure);
        setError(text);
        props.notify('error', text);
      });
  }

  function askSave() {
    const parsed = planEditSteps(form!);
    if (!parsed.ok) { setError(parsed.errors.join('；')); return; }
    setError(null);
    setConflict(false);
    setPublishConfirm(false);
    setConfirming(true);
  }

  function confirmSave() {
    const parsed = planEditSteps(form!);
    if (!parsed.ok || !head) {
      setError(parsed.ok ? '计划详情尚未载入' : parsed.errors.join('；'));
      setConfirming(false);
      return;
    }
    const message = head.status === 'active'
      ? '计划「' + summary.title + '」已修订为 v' + (head.currentVersion! + 1)
      : '计划「' + summary.title + '」草稿已保存';
    submit(planEditPayload(head, parsed.steps), message);
  }

  function askPublish() {
    const parsed = planEditSteps(form!);
    if (!parsed.ok) { setError(parsed.errors.join('；')); return; }
    setError(null);
    setConflict(false);
    setConfirming(false);
    setPublishConfirm(true);
  }

  function confirmPublish() {
    if (!head) return;
    submit(planEditPublishPayload(head), '计划「' + summary.title + '」已发布');
  }

  const parsed: import('../model/types.ts').EditStepsResult = form ? planEditSteps(form!) : { ok: false, errors: [] };
  const diff = parsed.ok ? planEditDiff(base, parsed.steps) : null;

  if (!props.projectId) {
    return <div className="pb-plan-editor">
      <ErrorState message="缺少项目上下文（projectId），请刷新页面后重试。" action={<Button size="sm" onClick={function() { done('cancel'); }}>{'返回'}</Button>} />
    </div>;
  }
  if (!head) {
    return <div className="pb-plan-editor">
      <ErrorState message="计划详情尚未载入，无法编辑。" action={<Button size="sm" onClick={function() { done('cancel'); }}>{'返回'}</Button>} />
    </div>;
  }
  if (form === null) {
    return <div className="pb-plan-editor">
      <LoadingState label={loading ? '正在载入任务详情' : '准备编辑器'} />
      {error ? <ErrorState message={error} action={<Button size="sm" onClick={hydrate}>{'重试'}</Button>} /> : null}
      <div className="pb-plan-editor__foot">
        <Button size="sm" onClick={function() { done('cancel'); }}>{'取消编辑'}</Button>
      </div>
    </div>;
  }
  return <PlanEditPane
    summary={summary}
    isDraft={summary.status === 'draft'}
    form={form}
    parsed={parsed}
    diff={diff}
    conflict={conflict}
    confirming={confirming}
    publishConfirm={publishConfirm}
    busy={busy}
    error={error}
    onForm={setForm}
    onCancel={function() { done('cancel'); }}
    onSave={askSave}
    onPublish={askPublish}
    onConfirm={publishConfirm ? confirmPublish : confirmSave}
    onCloseConfirm={function() { setConfirming(false); setPublishConfirm(false); }}
    onReload={function() { done('reload'); }}
    onKeepEditing={function() { setConflict(false); }}
  />;
}

/** Read-mostly editor view: head, steps, task fields, footer and confirm panel. */
export function PlanEditPane(props: PlanEditPaneProps) {
  const summary = props.summary || {};
  const isDraft = Boolean(props.isDraft);
  const form = props.form || { steps: [] };
  const steps = Array.isArray(form.steps) ? form.steps : [];
  const parsed = props.parsed || { ok: false, errors: [] };
  const canSave = parsed.ok && !props.busy;
  return <div className="pb-plan-editor">
    <header className="pb-plan-editor__head">
      <div className="pb-plan-editor__head-text">
        <h3 className="pb-plan-editor__title">{'编辑计划'}</h3>
        <p className="pb-plan-editor__meta">
          <Badge tone={planStatusTone(summary.status)}>{planStatusLabel(summary.status)}</Badge>
          <span>{summary.title}</span>
          {summary.currentVersion! > 0 ? <span>{'v' + summary.currentVersion}</span> : null}
          <span>{'head rev ' + (summary.rev == null ? '?' : summary.rev)}</span>
        </p>
      </div>
      <div className="pb-plan-editor__actions">
        <Button size="sm" disabled={props.busy} onClick={props.onCancel}>{'取消'}</Button>
      </div>
    </header>
    {props.conflict ? <div className="pb-plan-editor__conflict" role="alert">
      <IconWarning size={16} />
      <div className="pb-plan-editor__conflict-text">
        <p className="pb-plan-editor__conflict-title">{'保存失败：计划已被他人修改'}</p>
        <p className="pb-plan-editor__conflict-hint">{'当前版本已变（stale-revision）。你的修改仍完整保留在下面的表单里，不会被清空。'}</p>
      </div>
      <div className="pb-plan-editor__conflict-actions">
        <Button size="sm" disabled={props.busy} onClick={props.onReload}>{'重新载入计划'}</Button>
        <Button size="sm" variant="primary" disabled={props.busy} onClick={props.onKeepEditing}>{'保留我的修改'}</Button>
      </div>
    </div> : null}
    {props.error ? <div className="pb-plan-editor__error" role="alert">
      <IconWarning size={15} />
      <span>{props.error}</span>
    </div> : null}
    <ol className="pb-plan-editor__steps">
      {steps.map(function(step, index) {
        return <PlanEditStep
          key={step.key}
          index={index}
          step={step}
          stepsCount={steps.length}
          form={form}
          onForm={props.onForm}
        />;
      })}
    </ol>
    <Button size="sm" variant="ghost" icon={IconPlus} disabled={props.busy} onClick={function() { props.onForm(planEditAddStep(form)); }}>{'添加步骤'}</Button>
    <div className="pb-plan-editor__foot">
      <span className="pb-hint pb-plan-editor__foot-hint">
        {isDraft
          ? '保存更新草稿；发布后任务才会按步骤创建。'
          : '保存生成新版本；被移除的任务会标为 orphaned 而不是删除。'}
      </span>
      <Button size="sm" disabled={props.busy} onClick={props.onCancel}>{'取消编辑'}</Button>
      <Button size="sm" variant={isDraft ? 'secondary' : 'primary'} busy={props.busy} disabled={!canSave} onClick={props.onSave}>{'保存变更'}</Button>
      {isDraft
        ? <Button size="sm" variant="primary" busy={props.busy} disabled={!canSave} onClick={props.onPublish}>{'发布计划'}</Button>
        : null}
    </div>
    {(props.confirming || props.publishConfirm)
      ? <PlanEditDiffPanel diff={props.diff} publish={Boolean(props.publishConfirm)} busy={props.busy} onConfirm={props.onConfirm} onClose={props.onCloseConfirm} />
      : null}
  </div>;
}

/** Save/publish confirmation: diff summary, orphan warning, confirm actions. */
export function PlanEditDiffPanel(props: PlanEditDiffPanelProps) {
  const diff = props.diff || { added: 0, updated: 0, removed: 0, removedTasks: [], stepsAdded: 0, stepsRemoved: 0, stepsChanged: 0, changed: false };
  const removedTasks = Array.isArray(diff.removedTasks) ? diff.removedTasks : [];
  return <div className="pb-plan-editor__confirm" role="dialog" aria-label={props.publish ? '确认发布计划' : '确认保存计划变更'}>
    <p className="pb-plan-editor__confirm-title">{props.publish ? '发布这个计划？' : '确认保存这些变更？'}</p>
    <div className="pb-plan-editor__stats">
      <Badge tone="accent">{'新增 ' + diff.added}</Badge>
      <Badge tone="warn">{'修改 ' + diff.updated}</Badge>
      <Badge tone="danger">{'移除 ' + diff.removed}</Badge>
      {diff.stepsAdded > 0 ? <Badge tone="accent">{'步骤 +' + diff.stepsAdded}</Badge> : null}
      {diff.stepsRemoved > 0 ? <Badge tone="danger">{'步骤 −' + diff.stepsRemoved}</Badge> : null}
      {diff.stepsChanged > 0 ? <Badge tone="warn">{'步骤改名 ' + diff.stepsChanged}</Badge> : null}
    </div>
    {(!props.publish && removedTasks.length > 0) ? <div className="pb-plan-editor__orphans" role="alert">
      <IconWarning size={15} />
      <div className="pb-plan-editor__orphans-text">
        <p className="pb-plan-editor__orphans-title">{'这些任务会被标 orphaned，不会删除'}</p>
        <ul className="pb-plan-editor__orphans-list">
          {removedTasks.map(function(item) {
            return <li key={item.taskId}>{item.title}</li>;
          })}
        </ul>
      </div>
    </div> : null}
    {props.publish
      ? <p className="pb-hint pb-plan-editor__confirm-hint">{'发布后计划变为进行中：新增的 ' + diff.added + ' 个任务会立即创建，计划不能再退回草稿。'}</p>
      : <p className="pb-hint pb-plan-editor__confirm-hint">{'保存后计划版本 +1；被移除的任务保留在项目里，标记为 orphaned。'}</p>}
    <div className="pb-plan-editor__confirm-actions">
      <Button size="sm" disabled={props.busy} onClick={props.onClose}>{'继续编辑'}</Button>
      <Button size="sm" variant="primary" busy={props.busy} onClick={props.onConfirm}>{props.publish ? '确认发布' : '确认保存'}</Button>
    </div>
  </div>;
}
