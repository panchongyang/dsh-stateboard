// Chart spec parsing, layout and SVG path; pure.
export interface ChartItem { label: string; value: number }
export interface ChartSpec { type: string; title: string; unit: string; items: ChartItem[] }
export interface ChartShape { kind: string; index: number; x: number; y: number; width?: number; height?: number }
export interface ChartLayout { width: number; height: number; kind: string; padL?: number; padT?: number; plotH?: number; slot?: number; zero?: number; ticks?: { value: number; y: number }[]; shapes?: ChartShape[]; labels?: { index: number; x: number; y: number; text: string }[]; cx?: number; cy?: number; radius?: number; inner?: number; slices?: { index: number; start: number; end: number; share: number }[] }
export type ChartResult = { ok: true; spec: ChartSpec; error?: never } | { ok: false; error: string; spec?: never };

export const CHART_TYPES = ['bar', 'line', 'pie', 'donut'];
export const CHART_COLORS = ['\u0076ar(--pb-accent)', '\u0076ar(--pb-violet)', '\u0076ar(--pb-success)', '\u0076ar(--pb-warn)', '\u0076ar(--pb-danger)', '\u0076ar(--pb-text-3)'];

/** Pure: read `key=value` / `key="quoted value"` pairs from a fence info string. */
export function chartOptions(info: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const pattern = /([A-Za-z]+)=("[^"]*"|\S*)/g;
  const text = String(info == null ? '' : info);
  let match;
  while ((match = pattern.exec(text))) {
    let value = match[2];
    if (value.charAt(0) === '"') value = value.slice(1, -1);
    out[match[1].toLowerCase()] = value;
  }
  return out;
}

/** Pure: parse a ```chart block into {ok, spec} or {ok:false, error}. */
export function parseChartSpec(info: unknown, text: unknown): ChartResult {
  const options = chartOptions(info);
  const type = String(options.type || 'bar').toLowerCase();
  if (CHART_TYPES.indexOf(type) < 0) return { ok: false, error: '未知图表类型「' + type + '」' };
  const rows = String(text == null ? '' : text).split('\n');
  const items = [];
  for (let i = 0; i < rows.length; i += 1) {
    const line = rows[i].trim();
    if (line === '' || line.charAt(0) === '#') continue;
    const match = /^(.*?)\s+(-?\d+(?:\.\d+)?)$/.exec(line);
    if (!match) return { ok: false, error: '第 ' + (i + 1) + ' 行应为「标签 数值」' };
    items.push({ label: match[1].trim() || '（未命名）', value: Number(match[2]) });
  }
  if (items.length === 0) return { ok: false, error: '没有数据行' };
  if (items.length > 24) return { ok: false, error: '数据行超过 24 条' };
  if (type === 'pie' || type === 'donut') {
    let total = 0;
    for (let j = 0; j < items.length; j += 1) {
      if (items[j].value < 0) return { ok: false, error: '饼图不接受负数' };
      total += items[j].value;
    }
    if (!(total > 0)) return { ok: false, error: '饼图数值合计必须大于 0' };
  }
  return { ok: true, spec: { type, title: String(options.title || ''), unit: String(options.unit || ''), items } };
}

export function chartScale(min: number, max: number, size: number): { lo: number; hi: number; at: (value: number) => number } {
  const lo = Math.min(0, min);
  let hi = Math.max(0, max);
  if (hi === lo) hi = lo + 1;
  return {
    lo,
    hi,
    at: function (value) { return size - ((value - lo) / (hi - lo)) * size; },
  };
}

export function trimLabel(label: unknown): string {
  const text = String(label);
  return text.length > 8 ? text.slice(0, 7) + '…' : text;
}

export function formatChartValue(value: number, unit?: string): string {
  return String(Math.round(value * 100) / 100) + (unit || '');
}

/** Pure: geometry for the supported chart types, shared by SVG and tests. */
export function chartLayout(spec: ChartSpec): ChartLayout {
  const width = 640;
  const padL = 34;
  const padR = 12;
  const padT = 10;
  const plotH = 190;
  const padB = 28;
  const height = padT + plotH + padB;
  const values = spec.items.map(function (item) { return item.value; });
  const scale = chartScale(Math.min.apply(null, values), Math.max.apply(null, values), plotH);
  if (spec.type === 'bar' || spec.type === 'line') {
    const slot = (width - padL - padR) / spec.items.length;
    const zero = padT + scale.at(0);
    const ticks = [];
    for (let t = 0; t <= 4; t += 1) {
      const tickValue = scale.lo + ((scale.hi - scale.lo) * t) / 4;
      ticks.push({ value: tickValue, y: padT + scale.at(tickValue) });
    }
    const shapes: ChartShape[] = [];
    const labels = [];
    for (let i = 0; i < spec.items.length; i += 1) {
      const item = spec.items[i];
      const centerX = padL + slot * (i + 0.5);
      if (spec.type === 'bar') {
        const barW = Math.min(46, slot * 0.62);
        const valueY = padT + scale.at(item.value);
        shapes.push({ kind: 'bar', index: i, x: centerX - barW / 2, y: Math.min(valueY, zero), width: barW, height: Math.max(1, Math.abs(zero - valueY)) });
      } else {
        shapes.push({ kind: 'point', index: i, x: centerX, y: padT + scale.at(item.value) });
      }
      labels.push({ index: i, x: centerX, y: height - 8, text: trimLabel(item.label) });
    }
    return { width, height, kind: spec.type, padL, padT, plotH, slot, zero, ticks, shapes, labels };
  }
  const cx = 178;
  const cy = padT + plotH / 2;
  const radius = Math.min(plotH / 2, 92);
  const inner = spec.type === 'donut' ? radius * 0.55 : 0;
  const total = values.reduce(function (sum, value) { return sum + value; }, 0);
  let angle = -Math.PI / 2;
  const slices = [];
  for (let k = 0; k < spec.items.length; k += 1) {
    const sweep = (spec.items[k].value / total) * Math.PI * 2;
    slices.push({ index: k, start: angle, end: angle + sweep, share: spec.items[k].value / total });
    angle += sweep;
  }
  return { width, height, kind: spec.type, cx, cy, radius, inner, slices };
}

export function slicePath(cx: number, cy: number, radius: number, inner: number, start: number, end: number): string {
  const large = end - start > Math.PI ? 1 : 0;
  const x1 = cx + radius * Math.cos(start);
  const y1 = cy + radius * Math.sin(start);
  const x2 = cx + radius * Math.cos(end);
  const y2 = cy + radius * Math.sin(end);
  if (inner <= 0) {
    return 'M ' + cx + ' ' + cy + ' L ' + x1 + ' ' + y1 + ' A ' + radius + ' ' + radius + ' 0 ' + large + ' 1 ' + x2 + ' ' + y2 + ' Z';
  }
  const ix2 = cx + inner * Math.cos(end);
  const iy2 = cy + inner * Math.sin(end);
  const ix1 = cx + inner * Math.cos(start);
  const iy1 = cy + inner * Math.sin(start);
  return 'M ' + x1 + ' ' + y1 + ' A ' + radius + ' ' + radius + ' 0 ' + large + ' 1 ' + x2 + ' ' + y2
    + ' L ' + ix2 + ' ' + iy2 + ' A ' + inner + ' ' + inner + ' 0 ' + large + ' 0 ' + ix1 + ' ' + iy1 + ' Z';
}
