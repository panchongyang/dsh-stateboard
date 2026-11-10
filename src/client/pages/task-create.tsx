// Task-create container owns validation and guarded writes; mounted selection fencing prevents late success from replacing another editor.
// New-task drawer: the only UI entry that writes `task.create` (P6).
// Plan membership is deliberately absent: the contract only changes it through
// a plan revision (project_plan adopt / plan editor).
import React from 'react';
import type * as View from '../model/view-types.ts';
import { errorText, taskCreatedId } from '../model/labels.ts';
import { createTaskPayload } from '../model/payloads.ts';
import { command as sendCommand } from '../api/transport.ts';
import { PageNavigationContext, usePageWrite } from '../hooks/page-navigation.ts';
import { Drawer } from '../components/drawer.tsx';
import { Button, ErrorState, Input, Switch, Textarea } from '../components/primitives.tsx';

export interface NewTaskDrawerProps {
  projectId: string;
  notify?: View.Notify;
  readOnly?: boolean;
  onCreated?: (taskId: string) => void;
  onClose?: () => void;
}







const useState = React.useState;

export function NewTaskDrawer(props: NewTaskDrawerProps) {
  const command = usePageWrite(sendCommand);
  const scope = React.useContext(PageNavigationContext);
  const mounted = React.useRef(false);
  React.useEffect(function() {
    mounted.current = true;
    return function() { mounted.current = false; };
  }, []);
  const projectId = props.projectId;
  const notify = props.notify || function() { };
  const readOnly = props.readOnly === true;
  const [title, setTitle] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('');
  const [gate, setGate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function submit() {
    if (busy || readOnly) return;
    const parsed = createTaskPayload({
      title,
      acceptance,
      description,
      priority,
      requiresAudit: gate,
    });
    if (!parsed.ok) { setError(parsed.errors.join('；')); return; }
    setBusy(true);
    setError(null);
    command(projectId, parsed.body!)
      .then(function(result) {
        // The sent write may succeed after this editor was replaced. Only its
        // original mounted editor/selection may close a drawer or select a task.
        // Reads and pending/cancelled navigation do not replace that selection.
        if (!mounted.current || !scope || scope.navigation.snapshot().selectionVersion !== scope.selectionVersion) return;
        setBusy(false);
        notify('success', '任务已创建');
        if (props.onCreated) props.onCreated(taskCreatedId(result)!);
      })
      .catch(function(failure) {
        setBusy(false);
        setError(errorText(failure));
      });
  }

  function onAcceptanceKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); submit(); }
  }

  return <Drawer suspended={function() { return Boolean(scope && scope.navigation.snapshot().intent); }} titleId="pb-task-create-title" onClose={props.onClose} head={<div className="pb-drawer__title">
    <span className="pb-drawer__eyebrow">{'任务'}</span>
    <h2 className="pb-drawer__h2" id="pb-task-create-title">{'新建任务'}</h2>
  </div>}>
    <div className="pb-drawer__body">
      {readOnly ? <ErrorState message="项目当前是只读的（其他进程持有写锁），不能创建任务。" /> : null}
      <Input
        id="pb-create-title"
        label="标题"
        placeholder="一句话说明要做什么"
        value={title}
        onChange={function(event) { setTitle(event.target.value); }}
        invalid={error != null && String(title).trim() === ''}
      />
      <Textarea
        id="pb-create-acceptance"
        label="验收项"
        rows={5}
        placeholder="一行一条，创建后逐条勾选"
        value={acceptance}
        onChange={function(event) { setAcceptance(event.target.value); }}
        onKeyDown={onAcceptanceKeyDown}
        hint="至少一条；Ctrl/⌘+Enter 提交。验收项创建后只能追加，不能删除。"
      />
      <Textarea
        id="pb-create-description"
        label="描述"
        rows={3}
        placeholder="可选：背景、边界、怎么算做完"
        value={description}
        onChange={function(event) { setDescription(event.target.value); }}
      />
      <Input
        id="pb-create-priority"
        label="优先级"
        type="number"
        placeholder="默认 100"
        value={priority}
        onChange={function(event) { setPriority(event.target.value); }}
        hint="数字越小越优先；不填 = 100（未显式设定）。"
      />
      <Switch checked={gate} label="完成后需审计" onClick={function() { setGate(!gate); }} />
      <p className="pb-hint">{'新任务直接进入「就绪」队列；要放进计划，请用 project_plan adopt 或在计划编辑器里纳入。'}</p>
      {error ? <ErrorState message={error} /> : null}
    </div>
    <div className="pb-drawer__foot">
      <span className="pb-drawer__foot-hint">{readOnly ? '只读项目' : '创建后可立即领取'}</span>
      <div className="pb-drawer__foot-actions">
        <Button onClick={props.onClose}>{'取消'}</Button>
        <Button variant="primary" busy={busy} disabled={readOnly || String(title).trim() === ''} onClick={submit}>{busy ? '创建中…' : '创建任务'}</Button>
      </div>
    </div>
  </Drawer>;
}
