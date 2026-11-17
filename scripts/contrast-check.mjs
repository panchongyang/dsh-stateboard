#!/usr/bin/env node
/**
 * Contrast audit for the ProjectBoard semantic tokens.
 *
 * Enumerates the text/background pairs that actually occur in the stylesheet and
 * asserts WCAG AA (>= 4.5:1). Run: node scripts/contrast-check.mjs [--json]
 * Design contract: docs/modules/client/design.md (semantic color tokens and contrast).
 */
const LIGHT = {
  canvas: '#f9fafb', surface: '#ffffff', surface2: '#f9fafb',
  text: '#0f1115', text2: '#61666b', text3: '#6b7280',
  accent: '#2f5bc7', warn: '#b45309', success: '#15803d', violet: '#6d28d9',
  danger: '#b91c1c',
};
const DARK = {
  canvas: '#0f1115', surface: '#232324', surface2: '#1b1b1c',
  text: '#f9fafb', text2: '#cfd3d6', text3: '#9ca3af',
  accent: '#7aaaff', warn: '#fbbf24', success: '#4ed17e', violet: '#b3a1ff',
  danger: '#f87171',
};
const PAIRS = [
  ['text', 'surface'], ['text', 'canvas'], ['text2', 'surface'], ['text2', 'surface2'],
  ['text3', 'surface'], ['text3', 'canvas'], ['text3', 'surface2'],
  ['accent', 'surface'], ['accent', 'surface2'], ['warn', 'surface'], ['warn', 'surface2'],
  ['success', 'surface'], ['violet', 'surface'], ['danger', 'surface'],
];
function lin(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function lum(hex) {
  const h = hex.replace('#', '');
  return 0.2126 * lin(parseInt(h.slice(0, 2), 16)) + 0.7152 * lin(parseInt(h.slice(2, 4), 16)) + 0.0722 * lin(parseInt(h.slice(4, 6), 16));
}
function ratio(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}
let failed = 0;
const rows = [];
for (const [name, tokens] of [['light', LIGHT], ['dark', DARK]]) {
  for (const [fg, bg] of PAIRS) {
    const r = ratio(tokens[fg], tokens[bg]);
    const ok = r >= 4.5;
    if (!ok) failed += 1;
    rows.push({ theme: name, pair: fg + '/' + bg, ratio: Number(r.toFixed(2)), ok });
  }
}
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ failed, rows }, null, 2));
} else {
  for (const row of rows) console.log((row.ok ? 'PASS ' : 'FAIL ') + row.theme.padEnd(5) + row.pair.padEnd(22) + row.ratio.toFixed(2));
  console.log('--- ' + (rows.length - failed) + '/' + rows.length + ' pairs >= 4.5:1');
}
process.exit(failed === 0 ? 0 : 1);
