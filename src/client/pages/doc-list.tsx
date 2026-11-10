// Document-list container owns merged reads, serial observations and inline-only body search; row/group projections share the same filtering model.
// Docs list: inline and external rows, plus the data hooks feeding it.
import React from 'react';
import type * as View from '../model/view-types.ts';
import { errorText } from '../model/labels.ts';
import { cx } from '../utils/format.ts';
import { matchDocText } from '../utils/markdown.ts';
import { getDoc, getDocs, inspectExternalDoc, listExternalDocs } from '../api/transport.ts';
import { PENDING_LIST_SCHEMA, inspectTargets, managementView, mergeDocRows, nextListSchema, observationKey, rowHaystack, schemaBlock } from '../model/external-docs.ts';
import { DOC_FILTERS, filterCounts, filterMatches, groupDocRows, rowSignal, rowSubline, shortDate } from '../model/doc-view.ts';
import { Button, Chip, IconButton } from '../components/primitives.tsx';
import { IconCheck, IconChevron, IconPlus, IconRefresh, IconSearch } from '../components/icons.tsx';

export interface RowSignalProps {
  signal: import('../model/types.ts').RowSignal;
}
export interface DocListItemProps {
  row: View.Doc;
  view?: View.DocView;
  active?: boolean;
  onOpen: (row: View.Doc) => void;
  snippet?: string;
}
export interface DocGroupProps {
  group: View.DocGroup;
  collapsed?: boolean;
  onToggle: (key: string) => void;
  views: Record<string, View.DocView>;
  activeId?: string | null;
  onOpen: (row: View.Doc) => void;
}
export interface FilterChipsProps {
  counts: Record<string, number>;
  filter?: string;
  onFilter: (filter: string) => void;
}
export interface DocsListProps {
  rows?: View.Doc[];
  views?: Record<string, View.DocView>;
  bodies?: Record<string, string>;
  query?: string;
  externalSchema?: View.ListSchema;
  readOnly?: boolean;
  onRegister: () => void;
  onNew: () => void;
  onRefresh: () => void;
  onQuery: (value: string) => void;
  error?: string | null;
  activeId?: string | null;
  onOpen: (row: View.Doc) => void;
}









const useState = React.useState;
const useEffect = React.useEffect;

/** Inline list from /docs and external list from /docs/external, merged. */
export function useDocRows(projectId: string) {
  const [rows, setRows] = useState<View.Doc[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [externalSchema, setExternalSchema] = useState<View.ListSchema>(PENDING_LIST_SCHEMA);
  function reload() {
    return Promise.all([
      getDocs(projectId).then(function(value) { return { ok: true, docs: value.docs || [] }; }, function(reason) { return { ok: false, reason }; }),
      listExternalDocs(projectId).then(function(value) { return { ok: true, docs: value.docs || [], schemaVersion: value.schemaVersion }; }, function(reason) { return { ok: false, reason }; }),
    ]).then(function(results: { ok: boolean; docs?: View.Doc[]; reason?: unknown; schemaVersion?: unknown }[]) {
      const failed = results.filter(function(item) { return !item.ok; });
      setError(failed.length ? errorText(failed[0].reason) : null);
      setExternalSchema(function(previous) { return nextListSchema(previous, results[1]); });
      setRows(mergeDocRows(results[0].ok ? results[0].docs! : [], results[1].ok ? results[1].docs! : []));
      setVersion(function(value) { return value + 1; });
    });
  }
  useEffect(function() { reload(); }, [projectId]);
  return { rows, error, reload, version, externalSchema };
}

/**
 * Background inspect (cached, no preview) of every live external row, one at a
 * time. Only reads: nothing here confirms or writes.
 */
export function useExternalObservations(projectId: string, rows: View.Doc[], version: number) {
  const [views, setViews] = useState<Record<string, View.DocView>>({});
  const targets = inspectTargets(rows);
  const key = observationKey(rows, version);
  useEffect(function() {
    let alive = true;
    targets.reduce<Promise<void | null>>(function(chain, row) {
      return chain.then(function() {
        if (!alive) return null;
        return inspectExternalDoc(projectId, row.id!, { preview: false })
          .then(function(view) { if (alive) setViews(function(prev) { return Object.assign({}, prev, { [row.id!]: view }); }); })
          .catch(function() { /* the row keeps "未观测"; the panel shows the error */ });
      });
    }, Promise.resolve());
    return function() { alive = false; };
  }, [projectId, key]);
  function remember(docId: string, view: View.DocView) {
    setViews(function(prev) { return Object.assign({}, prev, { [docId]: view }); });
  }
  return { views, remember };
}

/** Body search for inline docs only: external bodies are never fetched through /docs/:docId. */
export function useInlineBodies(projectId: string, rows: View.Doc[], query: string) {
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const rowsKey = rows.map(function(row) { return row.id + ':' + row.rev; }).join(',');
  useEffect(function() { setBodies({}); }, [rowsKey]);
  useEffect(function() {
    if (!String(query || '').trim()) return undefined;
    const missing = rows.filter(function(row) { return row.source !== 'external' && bodies[row.id!] === undefined; });
    if (!missing.length) return undefined;
    let alive = true;
    Promise.all(missing.map(function(row) {
      return getDoc(projectId, row.id!)
        .then(function(value) { return { id: row.id, body: value.body || '' }; })
        .catch(function() { return { id: row.id, body: '' }; });
    })).then(function(list) {
      if (!alive) return;
      setBodies(function(previous) {
        const next = Object.assign({}, previous);
        list.forEach(function(item) { next[item.id!] = item.body; });
        return next;
      });
    });
    return function() { alive = false; };
  }, [query, rowsKey, bodies, projectId]);
  return bodies;
}

function filterRows(rows: View.Doc[], bodies: Record<string, string>, query: string | undefined) {
  const queryText = String(query || '').trim();
  return rows.map(function(row) {
    if (!queryText) return { row, snippet: '' };
    const metaHit = rowHaystack(row).indexOf(queryText.toLowerCase()) >= 0;
    const body = bodies[row.id!];
    const matched = typeof body === 'string' ? matchDocText(body, queryText) : { hit: false, snippet: '' };
    if (!metaHit && !matched.hit) return null;
    return { row, snippet: metaHit ? '' : matched.snippet };
  }).filter(function(entry) { return entry !== null; });
}

function RowSignal(props: RowSignalProps) {
  const signal = props.signal;
  if (signal.key === 'matched') {
    return <span className="pb-doc-item__signal pb-doc-item__signal--success" title={signal.srText} aria-hidden="true">
      <IconCheck size={12} />
    </span>;
  }
  if (!signal.label) return null;
  return <span className={'pb-doc-item__signal pb-doc-item__signal--' + signal.tone} aria-hidden="true">
    <span className={'pb-dot pb-dot--' + signal.tone} />
    {signal.label}
  </span>;
}

function DocListItem(props: DocListItemProps) {
  const row = props.row;
  const signal = rowSignal(row, props.view);
  const status = row.source === 'external' && row.status && row.status !== 'draft' ? managementView(row.status).label : '';
  return <button type="button" className={cx('pb-doc-item', props.active ? 'pb-doc-item--active' : null, row.unregistered ? 'pb-doc-item--tomb' : null)} onClick={function() { props.onOpen(row); }} aria-current={props.active ? 'true' : undefined} title={row.locator ? row.locator.relPath : ''}>
    <span className="pb-doc-item__head">
      <span className="pb-doc-item__title">{row.title}</span>
      <span className="pb-doc-item__date">{shortDate(row.updatedAt)}</span>
    </span>
    {props.snippet ? <span className="pb-doc-item__snippet">{props.snippet}</span> : null}
    <span className="pb-doc-item__sub">
      <span className={cx('pb-doc-item__file', row.source === 'external' ? 'pb-mono' : null)}>{rowSubline(row)}</span>
      {status ? <span className="pb-doc-item__status">{status}</span> : null}
      <RowSignal signal={signal} />
    </span>
    {signal.srText ? <span className="pb-sr-label">{'，' + signal.srText}</span> : null}
  </button>;
}

function DocGroup(props: DocGroupProps) {
  const group = props.group;
  const open = !props.collapsed;
  return <li className="pb-docs__group">
    <button type="button" className="pb-docs__group-head" aria-expanded={open ? 'true' : 'false'} onClick={function() { props.onToggle(group.key); }}>
      <span className={cx('pb-docs__group-chevron', open ? 'pb-docs__group-chevron--open' : null)}>
        <IconChevron size={12} />
      </span>
      <span className="pb-docs__group-label" title={group.label}>{group.label}</span>
      <span className="pb-docs__group-count">{String(group.entries.length)}</span>
    </button>
    {open ? <ul className="pb-docs__group-items">
      {group.entries.map(function(entry) {
        return <li key={entry.row.id}>
          <DocListItem row={entry.row} snippet={entry.snippet} view={props.views[entry.row.id!]} active={props.activeId === entry.row.id} onOpen={props.onOpen} />
        </li>;
      })}
    </ul> : null}
  </li>;
}

function FilterChips(props: FilterChipsProps) {
  return <div className="pb-filter-chips pb-docs__filters" role="group" aria-label="按状态筛选">
    {DOC_FILTERS.map(function(filter) {
      const count = props.counts[filter.key] || 0;
      return <Chip key={filter.key} active={props.filter === filter.key} onClick={function() { props.onFilter(filter.key); }}>
        {filter.label}
        <span className={cx('pb-docs__filter-count', count === 0 ? 'pb-docs__filter-count--zero' : null)}>{String(count)}</span>
      </Chip>;
    })}
  </div>;
}

/** Search and status filter first, then regroup by folder; a group keeps only matching rows. */
function visibleGroups(rows: View.Doc[], bodies: Record<string, string>, query: string | undefined, filter: string, views: Record<string, View.DocView>) {
  const entries = filterRows(rows, bodies, query).filter(function(entry) {
    return filterMatches(filter, rowSignal(entry.row, views[entry.row.id!]));
  });
  const byId: Record<string, View.DocEntry> = {};
  entries.forEach(function(entry) { byId[entry.row.id!] = entry; });
  return groupDocRows(entries.map(function(entry) { return entry.row; })).map(function(group) {
    return { key: group.key, label: group.label, entries: group.rows.map(function(row) { return byId[row.id!]; }) };
  });
}

export function DocsList(props: DocsListProps) {
  const rows = props.rows || [];
  const views = props.views || {};
  const [filter, setFilter] = useState('all');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const groups = visibleGroups(rows, props.bodies || {}, props.query, filter, views);
  const blocked = schemaBlock(props.externalSchema);
  const readOnly = Boolean(props.readOnly);
  const readOnlyHint = '内嵌文档只作只读档案：这里不再提供新建与编辑入口，请登记工作区文件为外置文档';
  function toggle(key: string) { setCollapsed(function(prev) { return Object.assign({}, prev, { [key]: !prev[key] }); }); }
  return <aside className="pb-docs__list" aria-label="文档列表">
    <div className="pb-docs__list-head">
      <Button
        size="sm"
        variant="primary"
        icon={IconPlus}
        disabled={Boolean(blocked)}
        title={blocked}
        onClick={function() { props.onRegister(); }}
      >{'登记外置'}</Button>
      {readOnly ? null : <Button size="sm" variant="secondary" onClick={function() { props.onNew(); }}>{'新建内嵌'}</Button>}
      <IconButton label="刷新文档列表" icon={IconRefresh} onClick={function() { props.onRefresh(); }} />
    </div>
    {readOnly ? <p className="pb-hint pb-docs__readonly">{readOnlyHint}</p> : null}
    <div className="pb-search pb-search--compact">
      <IconSearch size={13} />
      <input
        type="search"
        className="pb-search__input"
        placeholder="搜索文档"
        value={props.query}
        onChange={function(event) { props.onQuery(event.target.value); }}
        aria-label="搜索文档"
      />
    </div>
    <FilterChips filter={filter} counts={filterCounts(rows, views)} onFilter={setFilter} />
    {blocked ? <p className="pb-hint pb-docs__list-error" role="alert">{blocked}</p> : null}
    {props.error ? <p className="pb-hint pb-docs__list-error" role="alert">{'列表加载不完整：' + props.error}</p> : null}
    {groups.length === 0
      ? <p className="pb-hint pb-docs__empty">{rows.length ? '没有匹配的文档。' : '还没有文档。'}</p>
      : <ul className="pb-docs__items">
        {groups.map(function(group) {
          return <DocGroup
            key={group.key}
            group={group}
            collapsed={Boolean(collapsed[group.key])}
            views={views}
            activeId={props.activeId}
            onOpen={props.onOpen}
            onToggle={toggle}
          />;
        })}
      </ul>}
  </aside>;
}
