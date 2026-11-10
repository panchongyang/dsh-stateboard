// Modal frame owns focus, body scroll and exit animation; the page supplies live navigation suspension, not a hook dependency.
import React from 'react';
import type * as View from '../model/view-types.ts';
import { cx, motionDurationMs, prefersReducedMotion } from '../utils/format.ts';
import { IconClose } from './icons.tsx';

export interface DrawerProps {
  suspended?: boolean | (() => boolean);
  onClose?: () => void;
  wide?: boolean;
  titleId?: string;
  head?: React.ReactNode;
  children?: React.ReactNode;
}



const useState = React.useState;
const useEffect = React.useEffect;
const useRef = React.useRef;
const useCallback = React.useCallback;

export function Drawer(props: DrawerProps) {
  // Document handlers outlive renders; read the latest prop, and let pages pass
  // a getter so synchronous navigation intents fence even pre-render callbacks.
  const suspensionRef = useRef(props.suspended);
  suspensionRef.current = props.suspended;
  function suspended() {
    const value = suspensionRef.current;
    return Boolean(typeof value === 'function' ? value() : value);
  }
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const exitTimer = useRef<number | null>(null);
  const requestClose = useCallback(function() {
    if (closingRef.current || suspended()) return;
    closingRef.current = true;
    const delay = motionDurationMs('base', prefersReducedMotion());
    if (delay === 0) { if (props.onClose) props.onClose(); return; }
    setClosing(true);
    exitTimer.current = setTimeout(function() { if (props.onClose) props.onClose(); }, delay);
  }, [props.onClose]);
  useEffect(function() {
    return function() { if (exitTimer.current) clearTimeout(exitTimer.current); };
  }, []);
  useEffect(function() {
    if (typeof document === 'undefined') return undefined;
    const previous = document.activeElement as HTMLElement;
    if (closeRef.current && closeRef.current.focus) closeRef.current.focus();
    const body = document.body;
    const previousOverflow = body ? body.style.overflow : '';
    if (body) body.style.overflow = 'hidden';
    function onKeyDown(event: KeyboardEvent) {
      if (suspended()) return;
      if (event.key === 'Escape') {
        event.stopPropagation();
        requestClose();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const nodes = panelRef.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])');
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return function() {
      document.removeEventListener('keydown', onKeyDown, true);
      if (body) body.style.overflow = previousOverflow;
      if (previous && previous.focus && previous.isConnected !== false) {
        try { previous.focus(); } catch (error) { /* ignore */ }
      }
    };
  }, []);
  return <div className={cx('pb-drawer-layer', closing ? 'pb-drawer-layer--closing' : null)}>
    <div className="pb-scrim" onClick={requestClose} aria-hidden="true" />
    <div className={cx('pb-drawer', props.wide ? 'pb-drawer--wide' : null)} role="dialog" aria-modal={suspended() ? undefined : 'true'} aria-labelledby={props.titleId || undefined} ref={panelRef}>
      <header className="pb-drawer__head">
        <div className="pb-drawer__heading">{props.head}</div>
        <button
          type="button"
          ref={closeRef}
          className="pb-btn pb-btn--ghost pb-btn--icon"
          aria-label="关闭"
          title="关闭 (Esc)"
          onClick={requestClose}
        >
          <IconClose size={16} />
        </button>
      </header>
      {props.children}
    </div>
  </div>;
}
