// Document container owns merged-list reads and guarded inline writes; external records route to the external panel, never the inline body API.
// Docs pane: one list of inline and external documents, plus the inline editor
// or the external panel. Inline reading renders from ./doc-reader.js; the
// external panel (./external-panel.js) never edits a body.
import React from 'react';
import type * as View from '../model/view-types.ts';
import { DOC_KIND_LABELS, docKindLabel, errorText } from '../model/labels.ts';
import { cx } from '../utils/format.ts';
import { docDirty } from '../utils/markdown.ts';
import { docLinkPayload, initialPreview } from '../model/payloads.ts';
import { downloadMarkdown, safeFileName } from '../utils/export.ts';
import { command as sendCommand, getDoc } from '../api/transport.ts';
import { usePageWrite } from '../hooks/page-navigation.ts';
import { findRow, knownBindingIds } from '../model/external-docs.ts';
import { Badge, Button, IconButton, Input, Select } from '../components/primitives.tsx';
import { IconArrowLeft, IconDocs, IconEye } from '../components/icons.tsx';
import { DocReader } from '../components/doc-reader.tsx';
import { DocsList, useDocRows, useExternalObservations, useInlineBodies } from './doc-list.tsx';
import { ExternalDocPanel } from './external-panel.tsx';
import { RegisterForm } from './external-forms.tsx';

export interface DocsPaneProps {
  projectId: string;
  initial?: Partial<View.Draft> & { docId?: string; baseRev?: number; preview?: boolean };
  notify?: View.Notify;
  tasks?: View.Task[];
  project?: View.ProjectView | null;
  onOpenTask?: (id: string) => void;
}
export interface DocsDetailProps {
  rows: View.Doc[];
  registering?: boolean;
  projectId: string;
  tasks?: View.Task[];
  externalSchema?: View.ListSchema;
  onRegistered: (value: View.RegisterResult) => void;
  onCancelRegister?: () => void;
  externalId?: string | null;
  notify?: View.Notify;
  remember?: (docId: string, view: View.DocView) => void;
  onChanged?: () => void;
  onOpenTask?: (id: string) => void;
  onBack: () => void;
  editor: DocEditorProps;
}
export interface DocEditorProps {
  draft: View.Draft;
  readOnly?: boolean;
  preview?: boolean;
  onBack: () => void;
  onDraft: (draft: View.Draft) => void;
  busy?: boolean;
  dirty?: boolean;
  onSave: () => void;
  onPreview: (preview: boolean) => void;
  docId?: string | null;
  baseRev?: number | null;
  error?: string | null;
  links?: View.Links;
  tasks?: View.Task[];
  editingLinks?: boolean;
  pickedTasks?: string[];
  onOpenTask?: (id: string) => void;
  onEditingLinks?: (editing: boolean) => void;
  onPickedTasks?: (ids: string[]) => void;
  onSaveLinks?: () => void;
  onReload?: () => void;
}















const useState = React.useState;
const useEffect = React.useEffect;

// Inline documents are archive-only; only a project whose owner explicitly
// re-enabled writes (inlineWritesDisabled === false) gets the editor at all.
function inlineWritesReadOnly(project: View.ProjectView | null | undefined) {
  return !project || project.inlineWritesDisabled !== false;
}

function confirmDiscard(dirty: boolean) {
  if (!dirty) return true;
  try {
    if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
    return window.confirm('当前文档有未保存的改动，确定放弃这些改动？');
  } catch (error) { return true; }
}

// Draft and saved snapshots start with separate objects but the same normalized fields.
function initialDraft(initial: Partial<View.Draft>): View.Draft {
  return { title: initial.title || '', kind: initial.kind || 'note', body: initial.body || '' };
}

export function DocsPane(props: DocsPaneProps) {
  const command = usePageWrite(sendCommand);
  const projectId = props.projectId;
  const initial = props.initial || {};
  const notify = props.notify || function() { };
  const list = useDocRows(projectId);
  const observations = useExternalObservations(projectId, list.rows, list.version);
  // Right-hand side: an inline doc (docId), an external doc (externalId) or
  // the register form (registering).
  const [externalId, setExternalId] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);
  const [docId, setDocId] = useState(initial.docId || null);
  const [draft, setDraft] = useState(initialDraft(initial));
  const [saved, setSaved] = useState(Object.assign(initialDraft(initial), { docId: initial.docId || null }));
  const [baseRev, setBaseRev] = useState(initial.baseRev == null ? null : initial.baseRev);
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState(initialPreview(initial));
  const [mobileOpen, setMobileOpen] = useState(Boolean(initial.docId));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [links, setLinks] = useState<View.Links>({ taskIds: [], planRefs: [] });
  const [editingLinks, setEditingLinks] = useState(false);
  const [pickedTasks, setPickedTasks] = useState<string[]>([]);
  const tasks = props.tasks || [];
  const bodies = useInlineBodies(projectId, list.rows, query);
  const inlineReadOnly = inlineWritesReadOnly(props.project);
  const dirty = docDirty(saved, draft, docId);
  useEffect(function() {
    if (!dirty) return undefined;
    if (typeof window === 'undefined' || !window.addEventListener) return undefined;
    function beforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = '';
      return '';
    }
    window.addEventListener('beforeunload', beforeUnload);
    return function() { window.removeEventListener('beforeunload', beforeUnload); };
  }, [dirty]);
  function openExternal(id: string) {
    setExternalId(id);
    setRegistering(false);
    setError(null);
    setMobileOpen(true);
  }
  function open(id: string) {
    if (docId && id !== docId && !confirmDiscard(dirty)) return;
    getDoc(projectId, id)
      .then(function(value) {
        const next = { title: value.doc.title, kind: value.doc.kind, body: value.body || '' };
        setExternalId(null);
        setRegistering(false);
        setDocId(value.doc.id);
        setDraft(next);
        setSaved({ title: next.title, kind: next.kind, body: next.body, docId: value.doc.id });
        setBaseRev(value.doc.rev);
        setLinks(value.doc.links || { taskIds: [], planRefs: [] });
        setEditingLinks(false);
        setPreview(true);
        setError(null);
        setMobileOpen(true);
      })
      .catch(function(reason) {
        // The inline route refuses external records; route to the external panel.
        if (reason && reason.code === 'external-doc-operation-required') openExternal(id);
        else setError(errorText(reason));
      });
  }
  function openRow(row: View.Doc) {
    if (row.source === 'external') {
      if (docId && !confirmDiscard(dirty)) return;
      openExternal(row.id!);
    } else open(row.id!);
  }
  // Opened from a task's asset chip: the pane mounts with an id but no body.
  useEffect(function() {
    if (initial.docId) open(initial.docId);
  }, [initial.docId]);
  function saveLinks() {
    if (inlineReadOnly) { notify('error', '内嵌文档是只读档案，关联不可编辑'); return; }
    if (!docId || busy) return;
    setBusy(true);
    setError(null);
    command(projectId, {
      op: 'doc.link',
      docId,
      links: docLinkPayload(links, pickedTasks),
    })
      .then(function() {
        setBusy(false);
        setEditingLinks(false);
        notify('success', '关联已保存');
        list.reload();
        open(docId!);
      })
      .catch(function(reason) {
        setBusy(false);
        setError(errorText(reason));
        notify('error', errorText(reason));
      });
  }
  function newDoc() {
    if (inlineReadOnly) { notify('error', '内嵌写入已禁用：请登记工作区文件为外置文档'); return; }
    if (!confirmDiscard(dirty)) return;
    setExternalId(null);
    setRegistering(false);
    setDocId(null);
    setDraft({ title: '', kind: 'note', body: '' });
    setSaved({ title: '', kind: 'note', body: '', docId: null });
    setBaseRev(null);
    setError(null);
    setPreview(false);
    setMobileOpen(true);
  }
  function startRegister() {
    if (!confirmDiscard(dirty)) return;
    setRegistering(true);
    setExternalId(null);
    setMobileOpen(true);
  }
  function save() {
    if (inlineReadOnly) { notify('error', '内嵌文档是只读档案，不能保存'); return; }
    if (busy || String(draft.title).trim() === '') return;
    const currentId = docId;
    setBusy(true);
    setError(null);
    command(projectId, {
      op: 'doc.put',
      docId: currentId || undefined,
      title: draft.title,
      kind: draft.kind,
      body: draft.body,
      baseRev: baseRev == null ? undefined : baseRev,
    })
      .then(function(value) {
        setBusy(false);
        notify('success', currentId ? '文档已保存' : '文档已创建');
        setSaved({ title: draft.title, kind: draft.kind, body: draft.body, docId: currentId });
        list.reload();
        const created = createdDocId(value);
        if (!currentId && created) open(created);
        else if (currentId) open(currentId);
      })
      .catch(function(reason) {
        setBusy(false);
        setError(errorText(reason));
        notify('error', errorText(reason));
      });
  }
  function registered(value: { doc?: View.Doc; result?: { docId?: string } }) {
    notify('success', '已登记外置文档');
    list.reload();
    const id = (value.doc && value.doc.id) || (value.result && value.result.docId);
    if (id) openExternal(id);
    else { setRegistering(false); setMobileOpen(false); }
  }
  const activeId = externalId || (registering ? null : docId);
  function backToList() { setMobileOpen(false); }
  const editor = {
    draft, docId, preview, baseRev, dirty, busy, error,
    readOnly: inlineReadOnly,
    links, tasks, editingLinks, pickedTasks,
    onDraft: setDraft, onPreview: setPreview, onSave: save, onBack: backToList,
    onReload: function() { open(docId!); },
    onEditingLinks: setEditingLinks, onPickedTasks: setPickedTasks, onSaveLinks: saveLinks, onOpenTask: props.onOpenTask,
  };
  return <div className={cx('pb-docs', mobileOpen ? 'pb-docs--editing' : null)}>
    <DocsList
      rows={list.rows}
      bodies={bodies}
      views={observations.views}
      externalSchema={list.externalSchema}
      activeId={activeId}
      query={query}
      error={list.error}
      readOnly={inlineReadOnly}
      onQuery={setQuery}
      onNew={newDoc}
      onRegister={startRegister}
      onRefresh={list.reload}
      onOpen={openRow}
    />
    <DocsDetail
      projectId={projectId}
      registering={registering}
      externalId={externalId}
      rows={list.rows}
      externalSchema={list.externalSchema}
      tasks={tasks}
      notify={notify}
      remember={observations.remember}
      onChanged={list.reload}
      onOpenTask={props.onOpenTask}
      onBack={backToList}
      onRegistered={registered}
      onCancelRegister={function() { setRegistering(false); setMobileOpen(false); }}
      editor={editor}
    />
  </div>;
}
function DocsDetail(props: DocsDetailProps) {
  const bindingIds = knownBindingIds(props.rows);
  if (props.registering) {
    return <RegisterForm
      projectId={props.projectId}
      tasks={props.tasks}
      bindingIds={bindingIds}
      listSchema={props.externalSchema}
      onRegistered={props.onRegistered}
      onCancel={props.onCancelRegister}
    />;
  }
  if (props.externalId) {
    return <ExternalDocPanel
      key={props.externalId}
      projectId={props.projectId}
      docId={props.externalId}
      row={findRow(props.rows, props.externalId)}
      tasks={props.tasks}
      bindingIds={bindingIds}
      listSchema={props.externalSchema}
      notify={props.notify}
      remember={props.remember}
      onChanged={props.onChanged}
      onOpenTask={props.onOpenTask}
      onBack={props.onBack}
    />;
  }
  return <DocEditor {...props.editor} />;
}

function DocEditor(props: DocEditorProps) {
  const draft = props.draft;
  const readOnly = Boolean(props.readOnly);
  const preview = readOnly ? true : props.preview;
  return <section className="pb-docs__editor" aria-label="文档编辑器">
    {readOnly ? <p className="pb-hint pb-docs__readonly" role="status">{'内嵌文档只作为只读档案：正文、类型与关联都不能在这里修改。新内容请写成工作区文件，再用「登记外置」纳入看板。'}</p> : null}
    <div className="pb-docs__toolbar">
      <IconButton label="返回列表" icon={IconArrowLeft} className="pb-docs__back" onClick={function() { props.onBack(); }} />
      {preview
        ? <span className="pb-docs__title-static">{draft.title || '（无标题）'}</span>
        : <Input id="pb-doc-title" className="pb-docs__title" placeholder="文档标题" value={draft.title} onChange={function(event) { props.onDraft(Object.assign({}, draft, { title: event.target.value })); }} />}
      {preview
        ? <Badge tone="neutral">{docKindLabel(draft.kind)}</Badge>
        : <Select
          id="pb-doc-kind"
          compact={true}
          ariaLabel="文档类型"
          value={draft.kind}
          onChange={function(event) { props.onDraft(Object.assign({}, draft, { kind: event.target.value })); }}
          options={Object.keys(DOC_KIND_LABELS).map(function(kind) { return { value: kind, label: docKindLabel(kind) }; })}
        />}
      {preview ? null : <Button variant="primary" size="sm" disabled={props.busy || String(draft.title).trim() === '' || !props.dirty} onClick={function() { props.onSave(); }}>{props.busy ? '保存中…' : '保存'}</Button>}
      {readOnly ? null : <Button size="sm" variant={preview ? 'secondary' : 'ghost'} icon={preview ? IconDocs : IconEye} onClick={function() { props.onPreview(!preview); }}>{preview ? '编辑' : '读视图'}</Button>}
      <Button size="sm" variant="ghost" disabled={String(draft.body || '').trim() === ''} onClick={function() {
        downloadMarkdown(safeFileName(draft.title, props.docId || 'document'), draft.body);
      }}>{'导出 .md'}</Button>
    </div>
    <DocReader
      docId={props.docId}
      draft={draft}
      preview={preview}
      readOnly={readOnly}
      baseRev={props.baseRev}
      dirty={props.dirty}
      error={props.error}
      links={props.links}
      tasks={props.tasks}
      editingLinks={props.editingLinks}
      pickedTasks={props.pickedTasks}
      busy={props.busy}
      onOpenTask={props.onOpenTask}
      onEditingLinks={props.onEditingLinks}
      onPickedTasks={props.onPickedTasks}
      onSaveLinks={props.onSaveLinks}
      onReload={props.onReload}
    />
    {preview ? null : <textarea
      className="pb-textarea pb-docs__body"
      value={draft.body}
      placeholder="Markdown 正文：标题、列表、代码块、引用"
      spellCheck={false}
      onChange={function(event) { props.onDraft(Object.assign({}, draft, { body: event.target.value })); }}
      onKeyDown={function(event) {
        if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 's') {
          event.preventDefault();
          props.onSave();
        }
      }}
    />}
  </section>;
}

// Preserve the command response scan order: the latest document event wins.
function createdDocId(value: import('../model/types.ts').CommandResult & { result?: { events?: { data?: { id?: string; docId?: string } }[] } }) {
  const events = (value.result && value.result.events) || [];
  let created = null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const data = events[i] && events[i].data;
    if (data && (data.id || data.docId)) { created = data.id || data.docId; break; }
  }
  return created;
}
