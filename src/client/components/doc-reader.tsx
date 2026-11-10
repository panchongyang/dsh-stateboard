// Document reader projects supplied body, status and linked tasks; editing emits callbacks and never reads or writes transport.
// Doc reader: linked tasks and the rendered Markdown preview/status of a doc.
import React from 'react';
import type * as View from '../model/view-types.ts';
import { docKindLabel } from '../model/labels.ts';
import { shortId } from '../utils/format.ts';
import { Button, ErrorState } from './primitives.tsx';
import { Markdown } from './content.tsx';

export interface DocReaderProps {
  tasks?: View.Task[];
  links?: View.Links;
  error?: string | null;
  draft: View.Draft;
  docId?: string | null;
  onOpenTask?: (id: string) => void;
  readOnly?: boolean;
  editingLinks?: boolean;
  onEditingLinks?: (editing: boolean) => void;
  onPickedTasks?: (ids: string[]) => void;
  pickedTasks?: string[];
  busy?: boolean;
  onSaveLinks?: () => void;
  baseRev?: number | null;
  dirty?: boolean;
  onReload?: () => void;
  preview?: boolean;
}






export function DocReader(props: DocReaderProps) {
  const tasks = props.tasks || [];
  const links = props.links || { taskIds: [], planRefs: [] };
  const error = props.error;
  const draft = props.draft;

  function taskLabel(id: string) {
    for (let i = 0; i < tasks.length; i += 1) if (tasks[i].id === id) return tasks[i].title;
    return shortId(id, 10);
  }

  return [
    props.docId ? <div key="links" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' }}>
      <span className="pb-hint">{'关联任务'}</span>
      {(links.taskIds || []).length === 0
        ? <span className="pb-hint">{'无'}</span>
        : (links.taskIds || []).map(function(id) {
          return <button key={id} type="button" title={id} onClick={function() { if (props.onOpenTask) props.onOpenTask(id); }} style={{
            padding: '2px 8px', borderRadius: '999px', border: '1px solid \u0076ar(--pb-border)',
            background: '\u0076ar(--pb-surface-2)', color: 'inherit', font: 'inherit',
            fontSize: '11px', cursor: 'pointer',
          }}>{taskLabel(id)}</button>;
        })}
      {props.readOnly ? null : <Button size="sm" variant="secondary" onClick={function() {
        if (props.editingLinks) { props.onEditingLinks!(false); return; }
        props.onPickedTasks!((links.taskIds || []).slice());
        props.onEditingLinks!(true);
      }}>{props.editingLinks ? '取消编辑' : '编辑关联'}</Button>}
    </div> : null,
    props.docId && props.editingLinks ? <div key="links-editor" style={{
      display: 'flex', flexDirection: 'column', gap: '6px', padding: '8px 10px',
      border: '1px solid \u0076ar(--pb-border)', borderRadius: '\u0076ar(--pb-r-md)', background: '\u0076ar(--pb-surface-2)',
    }}>
      {tasks.length === 0
        ? <p className="pb-hint">{'这个项目还没有任务，无法关联。'}</p>
        : <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', maxHeight: '180px', overflow: 'auto' }}>
          {tasks.map(function(item) {
            const checked = props.pickedTasks!.indexOf(item.id!) >= 0;
            return <label key={item.id} style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '12px' }}>
              <input type="checkbox" checked={checked} onChange={function() {
                props.onPickedTasks!(checked
                  ? props.pickedTasks!.filter(function(value) { return value !== item.id; })
                  : props.pickedTasks!.concat([item.id!]));
              }} />
              <span>{item.title}</span>
              <span className="pb-hint">{item.state}</span>
            </label>;
          })}
        </div>}
      <div style={{ display: 'flex', gap: '6px' }}>
        <Button size="sm" variant="primary" busy={props.busy} onClick={function() { props.onSaveLinks!(); }}>{'保存关联'}</Button>
        <Button size="sm" variant="secondary" onClick={function() { props.onEditingLinks!(false); }}>{'取消'}</Button>
      </div>
    </div> : null,
    <div key="status" className="pb-docs__status">
      {props.docId ? <span className="pb-mono">{props.docId}</span> : <span>{'新文档'}</span>}
      {props.baseRev != null ? <span>{'基础修订 ' + props.baseRev}</span> : null}
      {props.dirty ? <span className="pb-docs__dirty">{'未保存'}</span> : <span className="pb-hint">{'已保存'}</span>}
      <span className="pb-docs__count">{draft.body.length + ' 字符'}</span>
    </div>,
    error ? <ErrorState key="error" message={error} block={true} action={error.indexOf('stale-revision') >= 0 && props.docId
      ? <Button size="sm" onClick={function() { props.onReload!(); }}>{'重新载入'}</Button>
      : null} /> : null,
    props.preview ? <div key="preview" className="pb-docs__preview">
      <p className="pb-docs__preview-meta">
        {docKindLabel(draft.kind)}
        {props.baseRev != null ? ' · r' + props.baseRev : ''}
        {' · ' + draft.body.length + ' 字符'}
        {props.dirty ? ' · 有未保存改动' : ''}
      </p>
      <Markdown body={draft.body} empty="（空文档）" toc={true} scope="doc" />
    </div> : null,
  ];
}
