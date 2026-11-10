// Step/task field projections emit immutable model updates through onForm; no page reads or commands.
// Plan editor field-level components: one step card and one task card.
// Pure views: they render the form model and emit whole-form updates through
// onForm, so all mutation logic stays in plan-edit.js.

import React from 'react';
import type * as View from '../model/view-types.ts';
import { Badge, Button, IconButton, Switch } from './primitives.tsx';
import { cx, shortId } from '../utils/format.ts';
import { IconPlus, IconTrash } from './icons.tsx';
import {
  planEditAddTask, planEditPatchStep, planEditPatchTask,
  planEditRemoveStep, planEditRemoveTask,
} from '../model/plan-edit.ts';

export interface PlanEditStepProps {
  step: View.EditStep;
  stepsCount: number;
  index: number;
  onForm: (form: View.EditForm) => void;
  form: View.EditForm;
}
export interface PlanEditTaskProps {
  task: View.EditTask;
  onForm: (form: View.EditForm) => void;
  form: View.EditForm;
  stepKey: string | undefined;
}






/** One editable step: title input, remove button and its task editors. */
export function PlanEditStep(props: PlanEditStepProps) {
  const step = props.step;
  const tasks = Array.isArray(step.tasks) ? step.tasks : [];
  const removable = props.stepsCount > 1;
  return <li className="pb-plan-editor__step">
    <span className="pb-plan-editor__step-index" aria-hidden="true">{String(props.index + 1)}</span>
    <div className="pb-plan-editor__step-body">
      <div className="pb-plan-editor__step-head">
        <input
          type="text"
          className="pb-input pb-plan-editor__step-title"
          value={step.title}
          placeholder="步骤标题"
          aria-label={'步骤 ' + (props.index + 1) + ' 标题'}
          onChange={function(event) {
            props.onForm(planEditPatchStep(props.form, step.key!, { title: event.target.value }));
          }}
        />
        <span className="pb-plan-editor__step-count">{tasks.length + ' 任务'}</span>
        {removable
          ? <IconButton icon={IconTrash} label={'删除步骤 ' + (props.index + 1)} className="pb-plan-editor__remove" onClick={function() { props.onForm(planEditRemoveStep(props.form, step.key!)); }} />
          : null}
      </div>
      {tasks.length
        ? <ul className="pb-plan-editor__tasks">
          {tasks.map(function(task) {
            return <PlanEditTask key={task.key} task={task} stepKey={step.key} form={props.form} onForm={props.onForm} />;
          })}
        </ul>
        : <p className="pb-hint pb-plan-editor__empty">{'这一步还没有任务。'}</p>}
      <Button size="sm" variant="ghost" icon={IconPlus} onClick={function() { props.onForm(planEditAddTask(props.form, step.key!)); }}>{'添加任务'}</Button>
    </div>
  </li>;
}

/** One editable task: every field plan.revise accepts, plus the remove button. */
export function PlanEditTask(props: PlanEditTaskProps) {
  const task = props.task;
  const existing = Boolean(task.taskId);
  function patch(update: Partial<View.EditTask>) {
    props.onForm(planEditPatchTask(props.form, props.stepKey!, task.key!, update));
  }
  function field(name: keyof View.EditTask, label: string, value: string | undefined, placeholder: string) {
    const mono = name === 'deps' || name === 'labels';
    const id = 'pe-' + task.key + '-' + name;
    return <div className="pb-plan-editor__field">
      <label className="pb-plan-editor__label" htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        className={cx('pb-input', mono ? 'pb-input--mono' : null)}
        value={value == null ? '' : value}
        placeholder={placeholder}
        onChange={function(event) {
          const update: Record<string, string> = {};
          update[name] = event.target.value;
          patch(update);
        }}
      />
    </div>;
  }
  return <li className="pb-plan-editor__task">
    <div className="pb-plan-editor__task-top">
      <span className={cx('pb-plan-editor__task-id', 'pb-mono')}>{existing ? shortId(task.taskId, 14) : '新任务 · ' + task.key}</span>
      <Badge tone={existing ? 'muted' : 'accent'}>{existing ? '现有任务' : '新建'}</Badge>
      <IconButton icon={IconTrash} label="删除任务" className="pb-plan-editor__remove" onClick={function() { props.onForm(planEditRemoveTask(props.form, props.stepKey!, task.key!)); }} />
    </div>
    {field('title', '标题', task.title, '任务标题')}
    <div className="pb-plan-editor__field">
      <label className="pb-plan-editor__label" htmlFor={'pe-' + task.key + '-description'}>{'描述'}</label>
      <textarea
        id={'pe-' + task.key + '-description'}
        className="pb-textarea"
        rows={2}
        value={task.description == null ? '' : task.description}
        placeholder="任务要做什么（可选）"
        onChange={function(event) { patch({ description: event.target.value }); }}
      />
    </div>
    <div className="pb-plan-editor__grid">
      {field('priority', '优先级', task.priority, '100')}
      {field('weight', '权重', task.weight, '1')}
      {field('deps', '依赖 · 逗号分隔 taskId', task.deps, 'tsk_…, tsk_…')}
      {field('labels', '标签 · 逗号分隔', task.labels, 'ui, plan')}
    </div>
    <div className="pb-plan-editor__field">
      <label className="pb-plan-editor__label" htmlFor={'pe-' + task.key + '-acceptance'}>{'验收标准 · 每行一条'}</label>
      <textarea
        id={'pe-' + task.key + '-acceptance'}
        className="pb-textarea"
        rows={2}
        value={task.acceptance == null ? '' : task.acceptance}
        placeholder={existing ? '留空则沿用现有验收标准' : '新增任务至少需要一条验收标准'}
        onChange={function(event) { patch({ acceptance: event.target.value }); }}
      />
    </div>
    <div className="pb-plan-editor__task-foot">
      <Switch checked={Boolean(task.requiresAudit)} label="需要第三方审计" onClick={function() { patch({ requiresAudit: !task.requiresAudit }); }} />
      {existing ? <span className="pb-hint">{'任务正在执行或评审时，字段改动会随新版本生效。'}</span> : null}
    </div>
  </li>;
}
