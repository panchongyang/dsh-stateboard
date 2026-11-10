// External-document action forms build model payloads; RegisterForm owns a guarded registration write while other forms emit callbacks.
// Forms for the external document actions. Each builds its body through
// external-payloads.js and hands it to the caller; none writes by itself except
// RegisterForm, which has no document to belong to yet.
import React from 'react';
import type * as View from '../model/view-types.ts';
import { DOC_KIND_LABELS, docKindLabel } from '../model/labels.ts';
import { MANAGEMENT_LABELS, MANAGEMENT_NEXT, ackMatches, formatBytes, previewState, schemaBlock, shortHash } from '../model/external-docs.ts';
import { confirmPayload, metaPayload, registerPayload, relocatePayload, targetErrorView, unregisterPayload } from '../model/external-payloads.ts';
import { registerExternalDoc as sendRegister } from '../api/transport.ts';
import { usePageWrite } from '../hooks/page-navigation.ts';
import { Button, Chip, ErrorState, Input, Select } from '../components/primitives.tsx';

export interface FailureProps {
  failure?: import('../model/types.ts').ExternalErrorView | null;
  onReinspect?: () => void;
}
export interface FormFrameProps {
  title?: string;
  disabled?: boolean;
  onSubmit: () => void;
  intro?: string;
  children?: React.ReactNode;
  problem?: string;
  failure?: import('../model/types.ts').ExternalErrorView | null;
  onReinspect?: () => void;
  danger?: boolean;
  busy?: boolean;
  submitLabel?: string;
  onCancel?: () => void;
}
export interface TaskPickerProps {
  tasks?: View.Task[];
  picked: string[];
  onChange: (ids: string[]) => void;
}
export interface BindingHintProps {
  ids?: string[];
  onPick: (id: string) => void;
}
export interface RegisterFormProps {
  listSchema?: View.ListSchema;
  projectId: string;
  onRegistered: (value: View.RegisterResult) => void;
  onCancel?: () => void;
  bindingIds?: string[];
  tasks?: View.Task[];
}
export interface MetaFormProps {
  view: View.DocView;
  guard?: View.FormGuard;
  onSubmit: (body: View.ExternalBody) => void;
  busy?: boolean;
  failure?: import('../model/types.ts').ExternalErrorView | null;
  onReinspect?: () => void;
  onCancel?: () => void;
  tasks?: View.Task[];
}
export interface RelocateFormProps {
  view: View.DocView;
  guard?: View.FormGuard;
  onSubmit: (body: View.ExternalBody) => void;
  busy?: boolean;
  failure?: import('../model/types.ts').ExternalErrorView | null;
  onReinspect?: () => void;
  onCancel?: () => void;
  bindingIds?: string[];
}
export interface ConfirmFormProps {
  view: View.DocView;
  guard?: View.FormGuard;
  onSubmit: (body: View.ExternalBody) => void;
  busy?: boolean;
  failure?: import('../model/types.ts').ExternalErrorView | null;
  blocked?: string;
  onReinspect?: () => void;
  onCancel?: () => void;
}
export interface UnregisterFormProps {
  view: View.DocView;
  guard?: View.FormGuard;
  onSubmit: (body: View.ExternalBody) => void;
  busy?: boolean;
  failure?: import('../model/types.ts').ExternalErrorView | null;
  onReinspect?: () => void;
  onCancel?: () => void;
}







const useState = React.useState;

const KIND_OPTIONS = Object.keys(DOC_KIND_LABELS).map(function(kind) { return { value: kind, label: docKindLabel(kind) }; });

function Failure(props: FailureProps) {
  const failure = props.failure;
  if (!failure) return null;
  return <ErrorState block={true} message={failure.message} detail={failure.code ? '[' + failure.code + ']' : undefined} action={failure.action === 'reinspect' && props.onReinspect
    ? <Button size="sm" onClick={props.onReinspect}>{'重新读取'}</Button>
    : null} />;
}

function FormFrame(props: FormFrameProps) {
  return <form className="pb-ext-form" aria-label={props.title} onSubmit={function(event) { event.preventDefault(); if (!props.disabled) props.onSubmit(); }}>
    <h3 className="pb-ext-form__title">{props.title}</h3>
    {props.intro ? <p className="pb-hint">{props.intro}</p> : null}
    {props.children}
    {props.problem ? <p className="pb-ext-form__problem" role="alert">{props.problem}</p> : null}
    <Failure failure={props.failure} onReinspect={props.onReinspect} />
    <div className="pb-ext-form__actions">
      <Button type="submit" size="sm" variant={props.danger ? 'danger' : 'primary'} busy={props.busy} disabled={props.disabled}>{props.submitLabel}</Button>
      <Button size="sm" variant="ghost" onClick={props.onCancel}>{'取消'}</Button>
    </div>
  </form>;
}

export function TaskPicker(props: TaskPickerProps) {
  const tasks = props.tasks || [];
  if (tasks.length === 0) return <p className="pb-hint">{'这个项目还没有任务，无法关联。'}</p>;
  return <fieldset className="pb-ext-form__tasks">
    <legend className="pb-field__label">{'关联任务'}</legend>
    {tasks.map(function(item) {
      const checked = props.picked.indexOf(item.id!) >= 0;
      return <label key={item.id} className="pb-ext-form__task">
        <input type="checkbox" checked={checked} onChange={function() {
          props.onChange(checked ? props.picked.filter(function(id) { return id !== item.id; }) : props.picked.concat([item.id!]));
        }} />
        <span>{item.title}</span>
        <span className="pb-hint">{item.state}</span>
      </label>;
    })}
  </fieldset>;
}

function BindingHint(props: BindingHintProps) {
  const ids = props.ids || [];
  if (!ids.length) return <p className="pb-hint">{'留空使用主工作区；本项目没有其他已用绑定。'}</p>;
  return <div className="pb-ext-form__chips">
    <span className="pb-hint">{'已用过的绑定（点击填入）：'}</span>
    {ids.map(function(id) { return <Chip key={id} onClick={function() { props.onPick(id); }} title={id}>{shortHash(id)}</Chip>; })}
  </div>;
}

export function RegisterForm(props: RegisterFormProps) {
  const registerExternalDoc = usePageWrite(sendRegister);
  const [draft, setDraft] = useState({ title: '', kind: 'note', bindingId: '', relPath: '', taskIds: [] as string[] });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<import('../model/types.ts').ExternalErrorView | null>(null);
  const [problem, setProblem] = useState('');
  function set(patch: Partial<View.ExternalInput>) { setDraft(Object.assign({}, draft, patch)); setProblem(''); }
  function submit() {
    const built = registerPayload(draft, { listSchema: props.listSchema });
    if (built.error) { setProblem(built.error); return; }
    setBusy(true);
    setFailure(null);
    registerExternalDoc(props.projectId, built.body!).then(function(value) {
      setBusy(false);
      props.onRegistered(value);
    }, function(error) {
      setBusy(false);
      setFailure(targetErrorView(error));
    });
  }
  return <section className="pb-docs__editor pb-ext" aria-label="登记外置文档">
    <div className="pb-docs__toolbar">
      <Button size="sm" variant="ghost" className="pb-docs__back" onClick={props.onCancel}>{'返回列表'}</Button>
    </div>
    <FormFrame
      title="登记外置文档"
      submitLabel="登记"
      busy={busy}
      problem={problem || schemaBlock(props.listSchema)}
      failure={failure}
      disabled={Boolean(schemaBlock(props.listSchema))}
      intro="登记只记录“哪个绑定的哪个相对路径”以及标题、关联；不会复制、创建、移动或修改工作区里的文件，登记本身也不是确认。目标此刻必须是绑定根目录内一个存在的文件。"
      onSubmit={submit}
      onCancel={props.onCancel}
    >
      <Input id="pb-ext-title" label="标题" value={draft.title} onChange={function(e) { set({ title: e.target.value }); }} />
      <Select id="pb-ext-kind" label="类型" value={draft.kind} options={KIND_OPTIONS} onChange={function(e) { set({ kind: e.target.value }); }} />
      <Input
        id="pb-ext-binding"
        label="工作区绑定 bindingId"
        optional={true}
        mono={true}
        value={draft.bindingId}
        onChange={function(e) { set({ bindingId: e.target.value }); }}
        hint="留空 = 本项目的主工作区。文档始终从登记的绑定读取，不会随会话所在目录变化。"
      />
      <BindingHint ids={props.bindingIds} onPick={function(id) { set({ bindingId: id }); }} />
      <Input
        id="pb-ext-path"
        label="相对路径"
        mono={true}
        value={draft.relPath}
        placeholder="docs/design.md"
        onChange={function(e) { set({ relPath: e.target.value }); }}
        hint="相对于绑定根目录，用 / 分隔，不要绝对路径或 .."
      />
      <TaskPicker tasks={props.tasks} picked={draft.taskIds} onChange={function(ids) { set({ taskIds: ids }); }} />
    </FormFrame>
  </section>;
}

// The panel only opens these forms after writeBlock accepts the inspected record.
// The payload helpers require that guarded doc/locator surface, not every partial list view.
export function MetaForm(props: MetaFormProps) {
  const doc = props.view.doc!;
  const links = doc.links || {};
  const [draft, setDraft] = useState({ title: doc.title, kind: doc.kind, status: doc.status, reason: '', taskIds: (links.taskIds || []).slice() });
  const [problem, setProblem] = useState('');
  function set(patch: Partial<View.ExternalInput>) { setDraft(Object.assign({}, draft, patch)); setProblem(''); }
  const statuses = [doc.status!].concat(MANAGEMENT_NEXT[doc.status!] || []).map(function(value) { return { value, label: MANAGEMENT_LABELS[value!] || value }; });
  const changing = draft.status !== doc.status;
  function submit() {
    const built = metaPayload(props.view as Parameters<typeof metaPayload>[0], draft, props.guard);
    if (built.error) { setProblem(built.error); return; }
    props.onSubmit(built.body!);
  }
  return <FormFrame
    title="更新登记信息"
    submitLabel="保存"
    busy={props.busy}
    problem={problem}
    failure={props.failure}
    onReinspect={props.onReinspect}
    onSubmit={submit}
    onCancel={props.onCancel}
    intro="只改登记记录（标题、类型、关联、管理状态），不碰工作区文件，也不改变确认基线。"
  >
    <Input id="pb-ext-m-title" label="标题" value={draft.title} onChange={function(e) { set({ title: e.target.value }); }} />
    <Select id="pb-ext-m-kind" label="类型" value={draft.kind} options={KIND_OPTIONS} onChange={function(e) { set({ kind: e.target.value }); }} />
    <Select
      id="pb-ext-m-status"
      label="管理状态"
      value={draft.status}
      options={statuses}
      onChange={function(e) { set({ status: e.target.value }); }}
      hint={draft.status === 'archived' ? '归档只改管理状态，不会删除或移动工作区文件。' : '读取、刷新和内容变化不会自动改变管理状态。'}
    />
    {changing ? <Input id="pb-ext-m-reason" label={doc.status === 'archived' ? '重新打开的原因' : '原因'} optional={doc.status !== 'archived'} value={draft.reason} onChange={function(e) { set({ reason: e.target.value }); }} /> : null}
    <TaskPicker tasks={props.tasks} picked={draft.taskIds} onChange={function(ids) { set({ taskIds: ids }); }} />
  </FormFrame>;
}

export function RelocateForm(props: RelocateFormProps) {
  const locator = props.view.doc!.locator!;
  const [draft, setDraft] = useState({ bindingId: locator.bindingId, relPath: locator.relPath });
  const [problem, setProblem] = useState('');
  function set(patch: Partial<View.ExternalInput>) { setDraft(Object.assign({}, draft, patch)); setProblem(''); }
  function submit() {
    const built = relocatePayload(props.view as Parameters<typeof relocatePayload>[0], draft, props.guard);
    if (built.error) { setProblem(built.error); return; }
    props.onSubmit(built.body!);
  }
  return <FormFrame
    title="重定位"
    submitLabel="重定位"
    busy={props.busy}
    problem={problem}
    failure={props.failure}
    onReinspect={props.onReinspect}
    onSubmit={submit}
    onCancel={props.onCancel}
    intro="把这条登记指向另一个绑定或路径。只改登记，不移动文件；保留的旧基线仅供审计，在新位置重新确认之前，确认情况显示为“无法比较”。"
  >
    <Input id="pb-ext-r-binding" label="工作区绑定 bindingId" mono={true} value={draft.bindingId} onChange={function(e) { set({ bindingId: e.target.value }); }} />
    <BindingHint ids={props.bindingIds} onPick={function(id) { set({ bindingId: id }); }} />
    <Input id="pb-ext-r-path" label="相对路径" mono={true} value={draft.relPath} onChange={function(e) { set({ relPath: e.target.value }); }} />
  </FormFrame>;
}

export function ConfirmForm(props: ConfirmFormProps) {
  const view = props.view;
  const [ackedHash, setAckedHash] = useState<string | null | undefined>(null);
  const [problem, setProblem] = useState('');
  const preview = previewState(view);
  const observation = view.observation || {};
  function submit() {
    const built = confirmPayload(view, ackMatches(ackedHash, view), props.guard);
    if (built.error) { setProblem(built.error); return; }
    props.onSubmit(built.body!);
  }
  return <FormFrame
    title="确认当前内容"
    submitLabel="确认这个版本"
    busy={props.busy}
    problem={problem}
    failure={props.failure}
    disabled={Boolean(props.blocked)}
    onReinspect={props.onReinspect}
    onSubmit={submit}
    onCancel={props.onCancel}
    intro="确认会让服务端重新完整读取文件，并校验它与下面的 hash 一致；内容已变化则拒绝。观察、预览和刷新从不确认。"
  >
    <dl className="pb-ext-kv">
      <dt>{'完整内容 hash'}</dt>
      <dd className="pb-mono" title={observation.contentHash || ''}>{observation.contentHash || '无'}</dd>
      <dt>{'大小'}</dt>
      <dd>{formatBytes((observation as typeof observation & { size?: number }).size)}</dd>
      <dt>{'登记版本'}</dt>
      <dd>{'metaRev ' + view.metaRev}</dd>
    </dl>
    {props.blocked ? <p className="pb-hint">{props.blocked}</p> : null}
    {preview.truncated ? <label className="pb-ext-form__task">
      <input type="checkbox" checked={ackMatches(ackedHash, view)} onChange={function() { setAckedHash(ackMatches(ackedHash, view) ? null : observation.contentHash); setProblem(''); }} />
      <span>{'我知道预览只显示了部分正文，确认针对的是完整文件的 hash'}</span>
    </label> : null}
  </FormFrame>;
}

export function UnregisterForm(props: UnregisterFormProps) {
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState('');
  function submit() {
    const built = unregisterPayload(props.view, reason, props.guard);
    if (built.error) { setProblem(built.error); return; }
    props.onSubmit(built.body!);
  }
  return <FormFrame
    title="解除登记"
    submitLabel="解除登记"
    danger={true}
    busy={props.busy}
    problem={problem}
    failure={props.failure}
    onReinspect={props.onReinspect}
    onSubmit={submit}
    onCancel={props.onCancel}
    intro="解除登记会留下墓碑：登记记录、关联和历史都保留，之后不能再修改。不会删除、移动或改写工作区里的文件。"
  >
    <Input id="pb-ext-u-reason" label="原因" optional={true} value={reason} onChange={function(e) { setReason(e.target.value); setProblem(''); }} />
  </FormFrame>;
}
