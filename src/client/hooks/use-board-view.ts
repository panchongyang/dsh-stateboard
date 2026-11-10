import React from 'react';
import { currentBoardLink, normalizeView, readView, replaceBoardLink, saveView } from '../model/storage.ts';

export function useBoardView(projectId: string) {
  const [initialLink] = React.useState(currentBoardLink);
  const [view, setView] = React.useState(() => initialLink.view || readView());
  const [focus, setFocus] = React.useState(initialLink.focus);
  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    function followLink() {
      const link = currentBoardLink();
      setView(link.view || readView());
      setFocus(link.focus);
    }
    window.addEventListener('popstate', followLink);
    window.addEventListener('hashchange', followLink);
    return () => {
      window.removeEventListener('popstate', followLink);
      window.removeEventListener('hashchange', followLink);
    };
  }, []);

  function applyView(next: string) {
    const value = normalizeView(next);
    setView(value);
    saveView(value);
    if (value !== 'flow') setFocus(null);
    replaceBoardLink(value, value === 'flow' ? focus : null, projectId);
  }
  function applyFocus(id: string | null) {
    setFocus(id);
    replaceBoardLink('flow', id, projectId);
  }
  function resetFocus(nextProjectId: string) {
    setFocus(null);
    if (currentBoardLink().view === 'flow') replaceBoardLink('flow', null, nextProjectId);
  }
  return { view, focus, applyView, applyFocus, resetFocus, linkedProjectId: initialLink.projectId };
}

/** Global shortcut: "/" or Ctrl/⌘+K focuses the task search (ignored while typing). */
export function useBoardSearchShortcut() {
  React.useEffect(() => {
    if (typeof document === 'undefined') return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement;
      const tagName = target && target.tagName;
      const typing = tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT' || (target && target.isContentEditable);
      const isSlash = event.key === '/' && !typing;
      const isCommandK = (event.metaKey || event.ctrlKey) && String(event.key).toLowerCase() === 'k';
      if (!isSlash && !isCommandK) return;
      const search = document.getElementById('pb-search') as HTMLInputElement;
      if (!search) return;
      event.preventDefault();
      search.focus();
      if (search.select) search.select();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);
}
