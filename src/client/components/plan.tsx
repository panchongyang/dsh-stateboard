// Plan detail and task-row projections render supplied progress and callbacks; session navigation uses the shared model adapter.
// Plan detail: steps, progress, notes and the out-of-plan task list.
import React from 'react';
import type * as View from '../model/view-types.ts';
import { Badge, Button, ProgressBar, Section, StatusDot } from './primitives.tsx';
import { cx, formatDateTime, percentOf, shortId } from '../utils/format.ts';
import { planCanArchive, planCanFocus, planCanUnarchive, planStatusLabel, planStatusTone, stateLabel, stateTone } from '../model/labels.ts';
import { IconCheck, IconEdit, IconEye, IconPlan } from './icons.tsx';
import { openSessionById } from '../model/session-jump.ts';

export interface PlanTaskRowProps {
  card: View.Task;
  onOpen?: (id: string) => void;
}
export interface PlanDetailPaneProps {
  summary?: View.PlanSummary;
  detail?: View.PlanDetail | null;
  board?: View.BoardView | null;
  notify?: View.Notify;
  canEdit?: boolean;
  busy?: boolean;
  onStartEdit?: () => void;
  onFocus?: () => void;
  onAskArchive?: () => void;
  onUnarchive?: () => void;
  confirmArchive?: boolean;
  onCancelArchive?: () => void;
  onConfirmArchive?: () => void;
  onOpenTask?: (id: string) => void;
}







export function PlanTaskRow(props: PlanTaskRowProps) {
  const card = props.card;
  return <li className="pb-plan-task">
    <button type="button" className="pb-plan-task__btn" onClick={function() { if (props.onOpen) props.onOpen(card.id!); }}>
      <StatusDot state={card.state} />
      <span className="pb-plan-task__title">{card.title}</span>
      <span className="pb-plan-task__id pb-mono">{shortId(card.id, 12)}</span>
      <Badge tone={stateTone(card.state)}>{stateLabel(card.state)}</Badge>
      {card.requiresAudit ? <Badge tone="violet">{'需审计'}</Badge> : null}
    </button>
  </li>;
}

export function PlanDetailPane(props: PlanDetailPaneProps) {
  const summary = props.summary;
  const detail = props.detail || {};
  const plan = detail.plan || null;
  const steps = detail.steps || [];
  const progress = detail.progress || { done: 0, total: 0, percent: 0 };
  const status = summary ? summary.status : (plan ? plan.status : '');
  const creator = (summary && summary.createdBy && summary.createdBy.sessionId) ? summary.createdBy
    : (plan && plan.createdBy && plan.createdBy.sessionId ? plan.createdBy : null);
  const isDraft = status === 'draft';
  const board = props.board;
  const unplanned: View.Card[] = [];
  if (board && board.columns) {
    Object.keys(board.columns).forEach(function(key) {
      (board!.columns![key] || []).forEach(function(card) {
        if (!card.planRef) unplanned.push(card);
      });
    });
  }
  return <div className="pb-plan-detail">
    <header className="pb-plan-detail__head">
      <div className="pb-plan-detail__head-text">
        <h3 className="pb-plan-detail__title">{summary ? summary.title : (plan ? plan.title : '')}</h3>
        <p className="pb-plan-detail__meta">
          <Badge tone={planStatusTone(status)}>{planStatusLabel(status)}</Badge>
          {summary && summary.currentVersion! > 0 ? <span>{'v' + summary.currentVersion}</span> : null}
          <span>{progress.done + '/' + progress.total + ' 已完成 · ' + percentOf(progress.percent) + '%'}</span>
          <span>{(summary ? summary.taskCount : 0) + ' 任务'}</span>
          {summary && summary.archivedFrom ? <span>{'归档自' + planStatusLabel(summary.archivedFrom)}</span> : null}
          {creator ? <button type="button" className="pb-session-link" title={'跳到创建者会话 ' + creator.sessionId} onClick={function() { openSessionById(creator!.sessionId!, props.notify); }}>{'创建者 · ' + shortId(creator.sessionId, 8)}</button> : null}
          {summary ? <span>{'更新于 ' + formatDateTime(summary.updatedAt)}</span> : null}
        </p>
      </div>
      <div className="pb-plan-detail__actions">
        {props.canEdit ? <Button size="sm" icon={IconEdit} disabled={props.busy} onClick={props.onStartEdit}>{'编辑计划'}</Button> : null}
        {planCanFocus(summary) ? <Button size="sm" icon={IconEye} disabled={props.busy} onClick={props.onFocus}>{'聚焦此计划'}</Button> : null}
        {planCanArchive(summary) ? <Button size="sm" variant="danger-ghost" disabled={props.busy} onClick={props.onAskArchive}>{'归档'}</Button> : null}
        {planCanUnarchive(summary) ? <Button size="sm" disabled={props.busy} onClick={props.onUnarchive}>{'恢复'}</Button> : null}
      </div>
    </header>
    {props.confirmArchive ? <div className="pb-plan-confirm" role="alertdialog" aria-label="确认归档计划">
      <p className="pb-plan-confirm__title">{'归档这个计划？'}</p>
      <p className="pb-plan-confirm__hint">{'归档后看板不再显示它，也不能领取它的任务；随时可以恢复。'}</p>
      <div className="pb-plan-confirm__actions">
        <Button size="sm" disabled={props.busy} onClick={props.onCancelArchive}>{'取消'}</Button>
        <Button size="sm" variant="danger" busy={props.busy} onClick={props.onConfirmArchive}>{'确认归档'}</Button>
      </div>
    </div> : null}
    {isDraft ? <div className="pb-plan-callout" role="note">
      <IconPlan size={14} />
      <span>{'草稿计划：任务数为 0，发布后才会按步骤创建任务。'}</span>
    </div> : null}
    <div className="pb-plan-detail__progress">
      <ProgressBar value={progress.percent} tone="success" label="计划完成度" />
    </div>
    {plan && plan.goal ? <p className="pb-prose pb-plan-goal">{plan.goal}</p> : null}
    {plan && ((plan.assumptions && plan.assumptions.length) || (plan.risks && plan.risks.length))
      ? <div className="pb-plan-notes">
        {plan.assumptions && plan.assumptions.length
          ? <div className="pb-plan-note">
            <span className="pb-plan-note__label">{'假设'}</span>
            <ul>{plan.assumptions.map(function(item, index) { return <li key={index}>{item}</li>; })}</ul>
          </div> : null}
        {plan.risks && plan.risks.length
          ? <div className="pb-plan-note pb-plan-note--warn">
            <span className="pb-plan-note__label">{'风险'}</span>
            <ul>{plan.risks.map(function(item, index) { return <li key={index}>{item}</li>; })}</ul>
          </div> : null}
      </div> : null}
    {steps.length
      ? <ol className="pb-steps">
        {steps.map(function(step, index) {
          const tasks = step.tasks || [];
          const visible = tasks.filter(function(card) { return card.state !== 'canceled'; });
          const done = visible.filter(function(card) { return card.state === 'done'; }).length;
          const cancelled = tasks.length - visible.length;
          const complete = visible.length > 0 && done === visible.length;
          return <li key={step.id || index} className="pb-step">
            <span className={cx('pb-step__index', complete ? 'pb-step__index--done' : null)}>{complete ? <IconCheck size={12} /> : String(index + 1)}</span>
            <div className="pb-step__body">
              <header className="pb-step__head">
                <h3 className="pb-step__title">{step.title}</h3>
                <span className="pb-step__count">{done + '/' + visible.length}</span>
              </header>
              <ProgressBar value={visible.length ? done / visible.length : 0} tone="accent" thin={true} label={step.title + ' 完成度'} />
              {visible.length
                ? <ul className="pb-plan__tasks">
                  {visible.map(function(card) {
                    return <PlanTaskRow key={card.id} card={card} onOpen={props.onOpenTask} />;
                  })}
                </ul>
                : <p className="pb-hint pb-plan-detail__empty">{isDraft ? '发布后任务会出现在这里' : '本阶段暂无任务'}</p>}
              {cancelled > 0 ? <p className="pb-hint">{'已取消 ' + cancelled + ' 个任务（不参与计划进度）'}</p> : null}
            </div>
          </li>;
        })}
      </ol>
      : <p className="pb-hint">{isDraft ? '草稿还没有步骤；发布前可以补充分阶段。' : '这个计划还没有步骤。'}</p>}
    {unplanned.length ? <Section title={'计划外任务 (' + unplanned.length + ')'} aside={<span className="pb-section__count">{'未纳入任何计划'}</span>}>
      <ul className="pb-plan__tasks">
        {unplanned.map(function(card) {
          return <PlanTaskRow key={card.id} card={card} onOpen={props.onOpenTask} />;
        })}
      </ul>
      <p className="pb-hint">{'这些任务没有 planRef，不属于任何计划。'}</p>
    </Section> : null}
  </div>;
}
