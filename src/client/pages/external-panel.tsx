// External-document container owns inspect/write adapters and form modes; model guards fence stale registration/hash snapshots.
// External document detail. The default view answers three things: can it be
// read, does it need my confirmation, and what does it say. Everything else
// (read source, baseline hash, Git, ids, relocate / unregister) sits in a
// folded technical section. Display choices come from ../model/doc-view.js.
import React from 'react';
import type * as View from '../model/view-types.ts';
import { errorText } from '../model/labels.ts';
import { cx, shortId } from '../utils/format.ts';
import { confirmBlock, currentRecord, formatBytes, guardForm, isMarkdownPath, linkedPlanRefs, previewState, writeBlock } from '../model/external-docs.ts';
import { attentionNotice, confirmOffer, headerMeta, statusLine, technicalSections } from '../model/doc-view.ts';
import { targetErrorView } from '../model/external-payloads.ts';
import { Button, ErrorState, IconButton, LoadingState } from '../components/primitives.tsx';
import { IconArrowLeft, IconRefresh } from '../components/icons.tsx';
import { Markdown } from '../components/content.tsx';
import { useDocImages } from '../hooks/use-doc-images.ts';
import { useExternalInspect, useExternalWrite } from '../hooks/use-external-docs.ts';
import { ConfirmForm, MetaForm, RelocateForm, UnregisterForm } from './external-forms.tsx';

export interface HeaderProps {
  record: View.Doc;
  onBack?: () => void;
  loading?: boolean;
  onReinspect?: () => void;
}
export interface StatusRowProps {
  record: View.Doc;
  view?: View.DocView | null;
  listSchema?: View.ListSchema;
  onMode: (name: string, origin?: string) => void;
}
export interface NoticeProps {
  record: View.Doc;
  view?: View.DocView | null;
  listSchema?: View.ListSchema;
  loading?: boolean;
  onReinspect?: () => void;
  onMode: (name: string, origin?: string) => void;
}
export interface LinksProps {
  record: View.Doc;
  tasks?: View.Task[];
  onOpenTask?: (id: string) => void;
}
export interface PreviewBlockProps {
  projectId: string;
  view: View.DocView;
  record: View.Doc;
}
export interface TechDetailsProps {
  record: View.Doc;
  view?: View.DocView | null;
  listSchema?: View.ListSchema;
  onMode: (name: string, origin?: string) => void;
  form?: React.ReactNode;
}
export interface ModeFormProps {
  mode: View.FormMode;
  listSchema?: View.ListSchema;
  view: View.DocView;
  busy?: boolean;
  failure?: import('../model/types.ts').ExternalErrorView | null;
  onReinspect?: () => void;
  onClose?: () => void;
  tasks?: View.Task[];
  writer: View.ExternalWriter;
  bindingIds?: string[];
}
export interface ExternalDocPanelProps {
  projectId: string;
  docId: string;
  remember?: (docId: string, view: View.DocView) => void;
  notify?: View.Notify;
  onChanged?: () => void;
  row?: View.Doc | null;
  listSchema?: View.ListSchema;
  tasks?: View.Task[];
  bindingIds?: string[];
  onBack?: () => void;
  onOpenTask?: (id: string) => void;
}











const useState = React.useState;

// The technical section stays open or closed across documents for this page session.
const techMemory = { open: false };

function Header(props: HeaderProps) {
  const record = props.record;
  return <header className="pb-ext-head">
    <div className="pb-ext-head__row">
      <IconButton label="返回列表" icon={IconArrowLeft} className="pb-docs__back" onClick={props.onBack} />
      <h2 className="pb-ext-head__title">{record.title}</h2>
      <Button
        size="sm"
        variant="ghost"
        icon={IconRefresh}
        busy={props.loading}
        title="绕过缓存重新读取一次工作区文件；不会确认"
        onClick={props.onReinspect}
      >{'重新读取文件'}</Button>
    </div>
    <p className="pb-ext-head__meta">
      {headerMeta(record).map(function(part) {
        return <span key={part.key} className={part.mono ? 'pb-mono' : null}>{part.text}</span>;
      })}
    </p>
  </header>;
}

function StatusRow(props: StatusRowProps) {
  const line = statusLine(props.record, props.view);
  const offer = confirmOffer(props.view, props.listSchema);
  const blocked = props.view ? writeBlock(props.view, props.listSchema) : '';
  const tomb = Boolean(props.record.unregistered);
  return <div className="pb-ext-status">
    <p className="pb-ext-status__line" aria-label="状态">
      {line.parts.map(function(part) {
        return <span key={part.key} className={'pb-ext-status__part pb-ext-status__part--' + part.tone}>
          <span className={'pb-dot pb-dot--' + part.tone} aria-hidden="true" />
          <span className="pb-ext-status__label">{part.label}</span>
          {part.detail ? <span className="pb-ext-status__detail">{part.detail}</span> : null}
        </span>;
      })}
      {line.git ? <span className="pb-ext-status__git">{line.git.label}</span> : null}
    </p>
    {props.view && !tomb ? <div className="pb-ext-status__actions" role="group" aria-label="文档操作">
      {offer.show ? <Button size="sm" variant="primary" disabled={Boolean(offer.reason)} title={offer.reason} onClick={function() { props.onMode('confirm'); }}>{'确认当前内容'}</Button> : null}
      <Button size="sm" disabled={Boolean(blocked)} title={blocked || '改标题、类型、管理状态和关联；不改文件'} onClick={function() { props.onMode('meta'); }}>{'编辑信息'}</Button>
    </div> : null}
    {blocked && !tomb ? <p className="pb-hint pb-ext-status__blocked" role="status">{blocked}</p> : null}
  </div>;
}

function Notice(props: NoticeProps) {
  const notice = attentionNotice(props.record, props.view);
  if (!notice) return null;
  const blocked = props.view ? writeBlock(props.view, props.listSchema) : '';
  function has(name: string) { return notice!.actions.indexOf(name) >= 0; }
  return <div className={cx('pb-ext-notice', 'pb-ext-notice--' + notice.tone)} role="status">
    <strong>{notice.title}</strong>
    {notice.hint ? <span>{notice.hint}</span> : null}
    {notice.actions.length ? <div className="pb-ext-notice__actions">
      {has('reinspect') ? <Button size="sm" icon={IconRefresh} busy={props.loading} onClick={props.onReinspect}>{'重新读取文件'}</Button> : null}
      {has('relocate') ? <Button size="sm" disabled={Boolean(blocked)} title={blocked} onClick={function() { props.onMode('relocate'); }}>{'重定位…'}</Button> : null}
      {has('unregister') ? <Button size="sm" variant="danger-ghost" disabled={Boolean(blocked)} title={blocked} onClick={function() { props.onMode('unregister'); }}>{'解除登记…'}</Button> : null}
    </div> : null}
  </div>;
}

function Links(props: LinksProps) {
  const record = props.record;
  const taskIds = (record.links && record.links.taskIds) || [];
  const plans = linkedPlanRefs(record);
  if (!taskIds.length && !plans.length) return null;
  function label(id: string) {
    const tasks = props.tasks || [];
    for (let i = 0; i < tasks.length; i += 1) if (tasks[i].id === id) return tasks[i].title;
    return shortId(id, 10);
  }
  return <div className="pb-ext-links">
    {taskIds.length ? <span className="pb-ext-links__label">{'关联任务'}</span> : null}
    {taskIds.map(function(id) {
      return <button key={id} type="button" className="pb-ext-link" title={id} onClick={function() { if (props.onOpenTask) props.onOpenTask(id); }}>{label(id)}</button>;
    })}
    {plans.length ? <span className="pb-ext-links__label">{'计划'}</span> : null}
    {plans.map(function(text) { return <span key={text} className="pb-ext-links__plan pb-mono">{text}</span>; })}
  </div>;
}

function PreviewBlock(props: PreviewBlockProps) {
  const preview = previewState(props.view);
  const markdown = preview.kind === 'text' && isMarkdownPath(props.record.locator && props.record.locator.relPath);
  const [raw, setRaw] = useState(false);
  const showRaw = raw || preview.truncated;
  const imageUrl = useDocImages(props.projectId, props.record.id!, markdown && !showRaw && preview.kind === 'text' ? preview.text || '' : '');
  if (preview.kind !== 'text') {
    return <section className="pb-ext-body" aria-label="正文">
      <div className="pb-ext-nopreview" role="status">{preview.notice}</div>
    </section>;
  }
  return <section className="pb-ext-body" aria-label="正文">
    {preview.truncated ? <div className="pb-ext-notice pb-ext-notice--warn" role="status">{preview.notice}</div> : null}
    {markdown && !preview.truncated ? <div className="pb-ext-body__tools">
      <Button size="sm" variant="ghost" onClick={function() { setRaw(!raw); }}>{raw ? '按 Markdown 渲染' : '查看原文'}</Button>
    </div> : null}
    {showRaw
      ? <pre className="pb-ext-preview pb-mono" tabIndex={0}>{preview.text}</pre>
      : <div className="pb-ext-preview pb-ext-preview--md">
        <Markdown imageUrl={imageUrl} body={preview.text} empty="（空文件）" scope="ext" />
      </div>}
    <p className="pb-hint pb-ext-body__foot">
      {preview.truncated
        ? '以上只是前 ' + formatBytes(preview.shownBytes) + '，全文 ' + formatBytes(preview.totalBytes) + '。'
        : '完整预览 · ' + formatBytes(preview.totalBytes)}
    </p>
  </section>;
}

function TechDetails(props: TechDetailsProps) {
  const sections = technicalSections(props.record, props.view);
  const blocked = props.view ? writeBlock(props.view, props.listSchema) : '尚未读取，无法修改登记';
  const tomb = Boolean(props.record.unregistered);
  return <details className="pb-ext-tech" open={techMemory.open} onToggle={function(event) { techMemory.open = Boolean(event.currentTarget && event.currentTarget.open); }}>
    <summary className="pb-ext-tech__summary">{'技术详情与登记管理'}</summary>
    <div className="pb-ext-tech__body">
      {sections.map(function(section) {
        return <div key={section.key} className="pb-ext-tech__section" aria-label={section.title}>
          <h3 className="pb-ext-block__title">{section.title}</h3>
          {section.rows.length ? <dl className="pb-ext-kv">
            {section.rows.map(function(row) {
              return [<dt key={row.label + ':t'}>{row.label}</dt>, <dd key={row.label + ':d'} className={row.mono ? 'pb-mono' : null} title={row.title || ''}>{row.value}</dd>];
            })}
          </dl> : null}
          {section.note ? <p className="pb-hint">{section.note}</p> : null}
        </div>;
      })}
      {tomb ? null : <div className="pb-ext-tech__actions" role="group" aria-label="登记管理">
        <Button size="sm" disabled={Boolean(blocked)} title={blocked} onClick={function() { props.onMode('relocate', 'tech'); }}>{'重定位…'}</Button>
        <Button size="sm" variant="danger-ghost" disabled={Boolean(blocked)} title={blocked} onClick={function() { props.onMode('unregister', 'tech'); }}>{'解除登记…'}</Button>
        <span className="pb-hint">{blocked || '重定位和解除登记只改看板里的记录，不移动、不删除工作区文件。'}</span>
      </div>}
      {props.form || null}
    </div>
  </details>;
}

function ModeForm(props: ModeFormProps) {
  const mode = props.mode;
  const guard = { listSchema: props.listSchema, baseRev: mode.metaRev, baseHash: mode.name === 'confirm' ? mode.hash : undefined };
  const common = { view: props.view, guard, busy: props.busy, failure: props.failure, onReinspect: props.onReinspect, onCancel: props.onClose };
  const tasks = props.tasks;
  if (mode.name === 'meta') {
    return <MetaForm {...Object.assign({ tasks, onSubmit: function(body: View.ExternalBody) { props.writer.patch(body, props.onClose); } }, common)} />;
  }
  if (mode.name === 'relocate') {
    return <RelocateForm {...Object.assign({ bindingIds: props.bindingIds, onSubmit: function(body: View.ExternalBody) { props.writer.act('relocate', body, '已重定位', props.onClose, targetErrorView); } }, common)} />;
  }
  if (mode.name === 'confirm') {
    return <ConfirmForm {...Object.assign({ blocked: confirmBlock(props.view, props.listSchema), onSubmit: function(body: View.ExternalBody) { props.writer.act('confirm', body, '已确认当前版本', props.onClose); } }, common)} />;
  }
  if (mode.name === 'unregister') {
    return <UnregisterForm {...Object.assign({ onSubmit: function(body: View.ExternalBody) { props.writer.act('unregister', body, '已解除登记，工作区文件未改动', props.onClose); } }, common)} />;
  }
  return null;
}

export function ExternalDocPanel(props: ExternalDocPanelProps) {
  const inspect = useExternalInspect(props.projectId, props.docId, props.remember);
  const [mode, setMode] = useState<(View.FormMode & { origin?: string }) | null>(null);
  const writer = useExternalWrite({
    projectId: props.projectId, docId: props.docId, notify: props.notify, onChanged: props.onChanged, reload: inspect.reload,
  });
  const view = inspect.view;
  let record = currentRecord(props.row, view);
  if (!record.id) record = { id: props.docId, title: props.docId, kind: 'note', status: 'draft', links: {} };
  const closedReason = mode ? guardForm(mode, view, props.listSchema) : '';
  const activeMode = mode && !closedReason ? mode : null;
  function close() { setMode(null); writer.clear(); }
  function reinspect() { close(); inspect.reload(true); }
  function openMode(name: string, origin?: string) {
    if (!view) return;
    writer.clear();
    if (origin === 'tech') techMemory.open = true;
    setMode({ name, origin: origin || 'top', metaRev: view.metaRev, hash: (view.observation && view.observation.contentHash) || null });
  }
  const form = view && activeMode ? <ModeForm
    mode={activeMode}
    view={view}
    listSchema={props.listSchema}
    tasks={props.tasks}
    bindingIds={props.bindingIds}
    writer={writer}
    busy={writer.busy}
    failure={writer.failure}
    onReinspect={reinspect}
    onClose={close}
  /> : null;
  const shared = {
    record, view, listSchema: props.listSchema, loading: inspect.loading, onMode: openMode,
    onReinspect: function() { inspect.reload(true); },
  };
  return <section className="pb-docs__editor pb-ext" aria-label="外置文档">
    <Header record={record} loading={inspect.loading} onBack={props.onBack} onReinspect={shared.onReinspect} />
    {inspect.error ? <ErrorState block={true} message={'读取失败：' + errorText(inspect.error)} action={<Button size="sm" onClick={shared.onReinspect}>{'重试'}</Button>} /> : null}
    {view || record.unregistered ? <StatusRow {...shared} /> : (inspect.loading ? <LoadingState label="正在读取" /> : null)}
    <Notice {...shared} />
    {closedReason ? <div className="pb-ext-notice pb-ext-notice--warn" role="alert">
      <span>{closedReason}</span>
      <div className="pb-ext-form__actions">
        <Button size="sm" variant="ghost" onClick={close}>{'知道了'}</Button>
      </div>
    </div> : null}
    {form && activeMode!.origin !== 'tech' ? form : null}
    <Links record={record} tasks={props.tasks} onOpenTask={props.onOpenTask} />
    {view ? <PreviewBlock projectId={props.projectId} view={view} record={record} /> : null}
    <TechDetails {...Object.assign({ form: form && activeMode!.origin === 'tech' ? form : null }, shared)} />
  </section>;
}
