// Shared controls and status projections; local focus/animation state never owns page data or commands.
import React from 'react';
import type * as View from '../model/view-types.ts';
import { cx, percentOf, prefersReducedMotion, motionDurationMs } from '../utils/format.ts';
import { stateTone } from '../model/labels.ts';
import { IconChevron, IconClose, IconInbox, IconWarning } from './icons.tsx';

// Dynamic createElement registry: props.icon, props.icon || IconInbox. Tags/icons are chosen from runtime data or props; static structures use JSX.

export interface ButtonProps {
  variant?: string;
  size?: string;
  type?: string;
  className?: string;
  title?: string;
  disabled?: boolean;
  busy?: boolean;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  style?: React.CSSProperties;
  icon?: React.ComponentType<{ size?: number }>;
  children?: React.ReactNode;
}
export interface IconButtonProps {
  className?: string;
  title?: string;
  label?: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  icon: React.ComponentType<{ size?: number }>;
  size?: number;
  children?: React.ReactNode;
}
export interface BadgeProps {
  tone?: string;
  mono?: boolean;
  className?: string;
  dot?: boolean;
  children?: React.ReactNode;
}
export interface StatusDotProps {
  tone?: string;
  state?: string;
  pulse?: boolean;
}
export interface ChipProps {
  active?: boolean;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  title?: string;
  children?: React.ReactNode;
}
export interface ProgressBarProps {
  value?: number;
  tone?: string;
  thin?: boolean;
  label?: string;
  title?: string;
}
export interface StatTileProps {
  value?: string | number;
  tone?: string;
  wide?: boolean;
  unit?: string;
  label?: string;
  hint?: string;
  progress?: number;
}
export interface EmptyStateProps {
  icon?: React.ComponentType<{ size?: number }>;
  title?: string;
  hint?: string;
  action?: React.ReactNode;
}
export interface LoadingStateProps {
  label?: string;
}
export interface ErrorStateProps {
  block?: boolean;
  message?: string;
  detail?: string;
  action?: React.ReactNode;
}
export interface SectionProps {
  className?: string;
  op?: string;
  id?: string;
  title?: string;
  aside?: React.ReactNode;
  children?: React.ReactNode;
}
export interface SwitchProps {
  checked?: boolean;
  disabled?: boolean;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  title?: string;
  label?: string;
}
export interface InputProps {
  id?: string;
  className?: string;
  label?: string;
  optional?: boolean;
  mono?: boolean;
  invalid?: boolean;
  type?: string;
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onFocus?: (event: React.SyntheticEvent<HTMLInputElement>) => void;
  spellCheck?: boolean;
  hint?: string;
}
export interface TextareaProps {
  id?: string;
  className?: string;
  label?: string;
  mono?: boolean;
  value?: string;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  onChange?: (event: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  hint?: string;
}
export interface SelectProps {
  id?: string;
  compact?: boolean;
  className?: string;
  label?: string;
  value?: string;
  disabled?: boolean;
  onChange?: (event: React.ChangeEvent<HTMLSelectElement>) => void;
  ariaLabel?: string;
  options?: { value?: string | number; label?: string }[];
  hint?: string;
}
export interface TabsProps {
  items?: View.Tab[];
  value?: string;
  onChange?: (id: string) => void;
}
export interface ToastHostProps {
  toasts?: View.Toast[];
  onDismiss?: (id: string) => void;
}




const useState = React.useState;
const useEffect = React.useEffect;
const useRef = React.useRef;

// ------------------------------------------------------------- primitives

export function Button(props: ButtonProps) {
  const variant = props.variant || 'secondary';
  const size = props.size || 'md';
  return <button
    type={props.type || 'button'}
    className={cx('pb-btn', 'pb-btn--' + variant, 'pb-btn--' + size, props.className)}
    title={props.title || ''}
    disabled={props.disabled === true || props.busy === true}
    aria-busy={props.busy ? 'true' : undefined}
    onClick={(props.disabled === true || props.busy === true) ? undefined : props.onClick}
    style={props.style}
  >
    {props.icon ? React.createElement(props.icon, { size: size === 'sm' ? 13 : 15 }) : null}
    {props.children == null ? null : <span className="pb-btn__label">{props.children}</span>}
  </button>;
}

export function IconButton(props: IconButtonProps) {
  return <button
    type="button"
    className={cx('pb-btn', 'pb-btn--ghost', 'pb-btn--icon', props.className)}
    title={props.title || props.label || ''}
    aria-label={props.label || props.title || ''}
    aria-pressed={props.pressed == null ? undefined : (props.pressed ? 'true' : 'false')}
    disabled={props.disabled === true}
    onClick={props.disabled === true ? undefined : props.onClick}
  >{React.createElement(props.icon, { size: props.size || 16 })}</button>;
}

export function Badge(props: BadgeProps) {
  return <span className={cx('pb-badge', 'pb-badge--' + (props.tone || 'neutral'), props.mono ? 'pb-badge--mono' : null, props.className)}>
    {props.dot ? <span className={'pb-dot pb-dot--' + (props.tone || 'muted')} aria-hidden="true" /> : null}
    <span>{props.children}</span>
  </span>;
}

export function StatusDot(props: StatusDotProps) {
  return <span className={cx('pb-dot', 'pb-dot--' + (props.tone || stateTone(props.state)), props.pulse ? 'pb-dot--pulse' : null)} aria-hidden="true" />;
}

export function Chip(props: ChipProps) {
  return <button type="button" className={cx('pb-chip', props.active ? 'pb-chip--active' : null)} aria-pressed={props.active ? 'true' : 'false'} onClick={props.onClick} title={props.title || ''}>{props.children}</button>;
}

export function ProgressBar(props: ProgressBarProps) {
  const percent = percentOf(props.value);
  return <div
    className={cx('pb-progress', 'pb-progress--' + (props.tone || 'accent'), props.thin ? 'pb-progress--thin' : null)}
    role="progressbar"
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={percent}
    aria-label={props.label || '进度'}
    title={props.title || (percent + '%')}
  >
    <div className="pb-progress__fill" style={{ width: percent + '%' }} />
  </div>;
}

export function StatTile(props: StatTileProps) {
  const previous = useRef(props.value);
  const flashTimer = useRef<number | null>(null);
  const [flash, setFlash] = useState(false);
  useEffect(function() {
    if (previous.current === props.value) return undefined;
    previous.current = props.value;
    if (prefersReducedMotion()) return undefined;
    setFlash(true);
    flashTimer.current = setTimeout(function() { setFlash(false); }, motionDurationMs('flash'));
    return function() { if (flashTimer.current) clearTimeout(flashTimer.current); };
  }, [props.value]);
  return <div className={cx('pb-stat', 'pb-stat--' + (props.tone || 'neutral'), props.wide ? 'pb-stat--wide' : null, flash ? 'pb-stat--flash' : null)}>
    <div className="pb-stat__row">
      <span className="pb-stat__value">{String(props.value == null ? 0 : props.value)}</span>
      {props.unit ? <span className="pb-stat__unit">{props.unit}</span> : null}
    </div>
    <span className="pb-stat__label">{props.label}</span>
    {props.hint ? <span className="pb-stat__hint">{props.hint}</span> : null}
    {props.progress == null ? null : <ProgressBar value={props.progress} tone={props.tone === 'neutral' ? 'accent' : props.tone} thin={true} label={props.label} />}
  </div>;
}

export function EmptyState(props: EmptyStateProps) {
  return <div className="pb-empty">
    <span className="pb-empty__icon">{React.createElement(props.icon || IconInbox, { size: 20 })}</span>
    <p className="pb-empty__title">{props.title || '暂无内容'}</p>
    {props.hint ? <p className="pb-empty__hint">{props.hint}</p> : null}
    {props.action ? <div className="pb-empty__action">{props.action}</div> : null}
  </div>;
}

export function LoadingState(props: LoadingStateProps) {
  return <div className="pb-loading" aria-busy="true" aria-label={props.label || '加载中'}>
    <span className="pb-skeleton pb-skeleton--lg" />
    <span className="pb-skeleton" />
    <span className="pb-skeleton pb-skeleton--sm" />
  </div>;
}

export function ErrorState(props: ErrorStateProps) {
  return <div className={cx('pb-error', props.block ? 'pb-error--block' : null)} role="alert">
    <span className="pb-error__icon">
      <IconWarning size={15} />
    </span>
    <div className="pb-error__body">
      <span className="pb-error__text">{props.message}</span>
      {props.detail ? <span className="pb-error__detail">{props.detail}</span> : null}
    </div>
    {props.action ? <div className="pb-error__action">{props.action}</div> : null}
  </div>;
}

export function Section(props: SectionProps) {
  return <section className={cx('pb-section', props.className)} data-op-section={props.op || undefined} aria-labelledby={props.id ? props.id + '-title' : undefined}>
    <header className="pb-section__head">
      <h2 className="pb-section__title" id={props.id ? props.id + '-title' : undefined}>{props.title}</h2>
      {props.aside ? <div className="pb-section__aside">{props.aside}</div> : null}
    </header>
    <div className="pb-section__body">{props.children}</div>
  </section>;
}

export function Switch(props: SwitchProps) {
  return <button
    type="button"
    role="switch"
    aria-checked={props.checked ? 'true' : 'false'}
    className={cx('pb-switch', props.checked ? 'pb-switch--on' : null)}
    disabled={props.disabled === true}
    onClick={props.disabled === true ? undefined : props.onClick}
    title={props.title || ''}
  >
    <span className="pb-switch__track">
      <span className="pb-switch__thumb" />
    </span>
    {props.label ? <span className="pb-switch__label">{props.label}</span> : null}
  </button>;
}

export function Input(props: InputProps) {
  const id = props.id;
  return <div className={cx('pb-field', props.className)}>
    {props.label ? <label className="pb-field__label" htmlFor={id}>
      {props.label}
      {props.optional ? <span className="pb-field__opt">{'可选'}</span> : null}
    </label> : null}
    <input
      id={id}
      className={cx('pb-input', props.mono ? 'pb-input--mono' : null, props.invalid ? 'pb-input--invalid' : null)}
      type={props.type || 'text'}
      value={props.value == null ? '' : props.value}
      placeholder={props.placeholder || ''}
      disabled={props.disabled === true}
      onChange={props.onChange}
      onKeyDown={props.onKeyDown}
      onFocus={props.onFocus}
      spellCheck={props.spellCheck === true}
      autoComplete="off"
      aria-invalid={props.invalid ? 'true' : undefined}
      aria-describedby={props.hint ? id + '-hint' : undefined}
    />
    {props.hint ? <span className="pb-field__hint" id={id + '-hint'}>{props.hint}</span> : null}
  </div>;
}

export function Textarea(props: TextareaProps) {
  const id = props.id;
  return <div className={cx('pb-field', props.className)}>
    {props.label ? <label className="pb-field__label" htmlFor={id}>{props.label}</label> : null}
    <textarea
      id={id}
      className={cx('pb-textarea', props.mono ? 'pb-textarea--mono' : null)}
      value={props.value == null ? '' : props.value}
      placeholder={props.placeholder || ''}
      rows={props.rows || 8}
      disabled={props.disabled === true}
      onChange={props.onChange}
      onKeyDown={props.onKeyDown}
      spellCheck={false}
    />
    {props.hint ? <span className="pb-field__hint">{props.hint}</span> : null}
  </div>;
}

export function Select(props: SelectProps) {
  const id = props.id;
  return <div className={cx('pb-field', props.compact ? 'pb-field--inline' : null, props.className)}>
    {props.label ? <label className="pb-field__label" htmlFor={id}>{props.label}</label> : null}
    <div className="pb-select-wrap">
      <select
        id={id}
        className="pb-select"
        value={props.value == null ? '' : props.value}
        disabled={props.disabled === true}
        onChange={props.onChange}
        aria-label={props.label ? undefined : (props.ariaLabel || '选择')}
      >
        {(props.options || []).map(function(option) {
          return <option key={String(option.value)} value={option.value}>{option.label}</option>;
        })}
      </select>
      <IconChevron size={12} />
    </div>
    {props.hint ? <span className="pb-field__hint">{props.hint}</span> : null}
  </div>;
}

export function Tabs(props: TabsProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const items = props.items || [];
  function move(delta: number) {
    let index = 0;
    for (let i = 0; i < items.length; i += 1) if (items[i].id === props.value) index = i;
    const next = (index + delta + items.length) % items.length;
    props.onChange!(items[next].id);
    const node = containerRef.current;
    if (node) {
      const buttons = node.querySelectorAll<HTMLButtonElement>('[role="tab"]');
      if (buttons[next] && (buttons[next].focus as unknown)) buttons[next].focus();
    }
  }
  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowRight') { event.preventDefault(); move(1); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
    else if (event.key === 'Home') { event.preventDefault(); props.onChange!(items[0].id); }
    else if (event.key === 'End') { event.preventDefault(); props.onChange!(items[items.length - 1].id); }
  }
  return <div className="pb-tabs" role="tablist" aria-label="项目板视图" ref={containerRef} onKeyDown={onKeyDown}>
    {items.map(function(item) {
      const active = item.id === props.value;
      return <button
        key={item.id}
        type="button"
        role="tab"
        aria-selected={active ? 'true' : 'false'}
        tabIndex={active ? 0 : -1}
        className={cx('pb-tab', active ? 'pb-tab--active' : null)}
        onClick={function() { props.onChange!(item.id); }}
      >{item.label}</button>;
    })}
  </div>;
}

export function ToastHost(props: ToastHostProps) {
  const toasts = props.toasts || [];
  return <div className="pb-toasts" role="status" aria-live="polite">
    {toasts.map(function(toast) {
      return <div key={toast.id} className={cx('pb-toast', 'pb-toast--' + (toast.tone || 'info'), toast.leaving ? 'pb-toast--leaving' : null)}>
        <span className="pb-toast__dot" aria-hidden="true" />
        <span className="pb-toast__text">{toast.text}</span>
        <button type="button" className="pb-toast__close" aria-label="关闭提示" onClick={function() { if (props.onDismiss) props.onDismiss(toast.id); }}>
          <IconClose size={12} />
        </button>
      </div>;
    })}
  </div>;
}
