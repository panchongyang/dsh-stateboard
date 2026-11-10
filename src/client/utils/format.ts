// Formatting, motion and class-name helpers; pure.
// -------------------------------------------------------------- helpers

/** Best-effort clipboard write; returns true when the copy likely succeeded. */
export function copyText(text: unknown): boolean {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(String(text));
      return true;
    }
    if (typeof document === 'undefined') return false;
    const area = document.createElement('textarea');
    area.value = String(text);
    area.setAttribute('readonly', 'readonly');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand && document.execCommand('copy');
    document.body.removeChild(area);
    return !!ok;
  } catch (error) { return false; }
}

// The overload types the variadic call without changing the arguments-based implementation.
export function cx(...values: unknown[]): string;
export function cx(): string {
  const out = [];
  for (let i = 0; i < arguments.length; i += 1) {
    const value = arguments[i];
    if (value) out.push(value);
  }
  return out.join(' ');
}

export function clamp01(value: unknown): number {
  const number = Number(value);
  if (!isFinite(number)) return 0;
  if (number < 0) return 0;
  if (number > 1) return 1;
  return number;
}

export function percentOf(value: unknown): number {
  return Math.round(clamp01(value) * 100);
}

export function ratioPercent(done: number, total: number): number {
  if (!total) return 0;
  return percentOf(done / total);
}

export function shortId(value: unknown, length?: number): string {
  const text = String(value == null ? '' : value);
  const limit = length || 10;
  return text.length <= limit ? text : text.slice(0, limit) + '…';
}

export function formatDateTime(value: string | number | null | undefined | false): string {
  if (!value) return '—';
  const date = new Date(value);
  if (isNaN(date.getTime())) return String(value);
  try {
    return date.toLocaleString('zh-CN', { hour12: false });
  } catch (error) {
    return date.toISOString();
  }
}

export function formatClock(value?: Date | string | number | null | false): string {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (isNaN(date.getTime())) return '—';
  function pad(number: number): string { return number < 10 ? '0' + number : String(number); }
  return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

export function prefersReducedMotion(): boolean {
  try {
    return Boolean(globalThis.matchMedia && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (error) {
    return false;
  }
}

/** Pure: the three motion tiers (ms) plus the one data-change hint; reduced motion collapses every one to 0. */
export const MOTION: Record<string, number> = { fast: 120, base: 180, slow: 240, flash: 300 };
export function motionDurationMs(kind: string, reduced?: boolean): number {
  if (reduced === true) return 0;
  return Object.prototype.hasOwnProperty.call(MOTION, kind) ? MOTION[kind] : MOTION.base;
}
