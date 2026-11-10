// Host slot projections receive open/session adapters as props; registration and host singleton wiring stay in index.
// Slot components: tool card, sidebar glyph, session-header entry.
import React from 'react';
import type * as View from '../model/view-types.ts';
import { Badge, Button, IconButton } from './primitives.tsx';
import { IconBoard } from './icons.tsx';

export interface PanelIconProps {
  size?: number;
}
export interface ToolCardProps {
  block?: View.ToolBlock;
  openPanel?: () => void;
}
export interface QuickEntryProps {
  sessionId?: string;
  useSessions?: <T>(selector: (state: import('../model/types.ts').SessionSnapshot) => T) => T;
  onOpen?: (cwd: string) => void;
}




/** Sidebar variant of the kanban glyph: same proportions, 20-unit grid. */
export function PanelIcon(props: PanelIconProps) {
  const size = props.size || 20;
  const line = function(d: string) {
    return <path d={d} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />;
  };
  return <svg
    width={size}
    height={size}
    viewBox="0 0 20 20"
    fill="none"
    aria-hidden="true"
    focusable="false"
  >
    {line('M4.375 4.375v11.875')}
    {line('M10 4.375v6.25')}
    {line('M15.625 4.375v9.375')}
  </svg>;
}

export function ToolCard(props: ToolCardProps) {
  const block = props.block || {};
  const blocks = Array.isArray(block.content) ? block.content : [];
  const text = blocks.filter(function(part) { return part && part.type === 'text'; }).map(function(part) { return part.text; }).join('\n');
  const running = block.kind !== 'tool-result';
  return <div className="pb-toolcard">
    <div className="pb-toolcard__head">
      <span className="pb-toolcard__mark">
        <PanelIcon size={15} />
      </span>
      <span className="pb-toolcard__title">{'项目板'}</span>
      {running ? <Badge tone="accent">{'运行中'}</Badge> : <Badge tone="success">{'完成'}</Badge>}
      <div className="pb-toolcard__spacer" />
      <Button size="sm" variant="secondary" onClick={props.openPanel || function() { }}>{'打开看板'}</Button>
    </div>
    <div className="pb-toolcard__body">
      {running
        ? <div className="pb-skeleton pb-skeleton--sm" />
        : <pre className="pb-toolcard__pre">{text || '暂无摘要。'}</pre>}
    </div>
  </div>;
}

/** Session-header entry: open the board for this session's workspace. */
export function QuickEntry(props: QuickEntryProps) {
  const sessionId = props.sessionId;
  const useSessions = props.useSessions;
  const read = typeof useSessions === 'function'
    ? useSessions
    : function<T>(selector: (state: View.SessionSnapshot | null) => T) { return selector(null); };
  const cwd = read(function(state: View.SessionSnapshot | null) {
    const entry = state && state.byId ? state.byId[sessionId!] : null;
    return entry && typeof entry.cwd === 'string' ? entry.cwd : undefined;
  });
  const label = cwd ? '打开本工作区的项目板' : '打开项目板';
  const onOpen = props.onOpen || function() { };
  return <span className="pb-jump" style={{ display: 'inline-flex', alignItems: 'center' }}>
    <IconButton label={label} title={label} icon={IconBoard} onClick={function() { onOpen(cwd || ''); }} />
  </span>;
}
