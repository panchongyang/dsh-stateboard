// Owns CSS text import and idempotent style injection; no page state or host services.
import css from './styles.css';
import flowCss from './flow-view.css';

export const CSS = css + '\n' + flowCss;

export function ensureStyles(): void {
  if (typeof document === 'undefined' || !document.head) return;
  const tagId = 'dsh-project-board/ui.css';
  if (document.querySelector('style[data-plugin-css="' + tagId + '"]')) return;
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-project-board';
  tag.dataset.pluginCss = tagId;
  tag.textContent = CSS;
  document.head.appendChild(tag);
}
