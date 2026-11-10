#!/usr/bin/env node
/**
 * Maintainability audit for ProjectBoard.
 *
 * Zero dependencies. Measures the things a human editor actually feels:
 * file size, function size, and the allowed dependency directions between
 * layers. Reports a table plus a JSON summary; --check exits non-zero when a
 * hard rule is violated (used by CI and `npm run check`).
 *
 * Usage:
 *   node scripts/maintainability-audit.mjs
 *   node scripts/maintainability-audit.mjs --check
 *   node scripts/maintainability-audit.mjs --json
 *
 * Thresholds are deliberately in one place (LIMITS) so a later task can tune
 * them without touching the checks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const strict = args.includes('--check');
const asJson = args.includes('--json');

const LIMITS = {
  fileLoc: 450,
  functionLoc: 80,
  // React components are allowed more room than an ordinary function: they are
  // a declarative tree, not a procedure. Anything above this still counts as a
  // violation (the 474-line TaskDrawer is exactly the case this catches).
  componentLoc: 200,
  // The generated browser bundle is a build artifact; it is excluded when the
  // split source tree exists, otherwise it is measured as ordinary source.
  generated: ['lib/client.js'],
};

const LAYERS = [
  { dir: 'lib/shared', mayImport: [], label: 'shared (pure contract)' },
  { dir: 'lib/core', mayImport: ['lib/shared', 'lib/core'], label: 'core' },
  { dir: 'lib/host', mayImport: ['lib/shared', 'lib/core', 'lib/host'], label: 'host' },
  { dir: 'src/client', mayImport: ['lib/shared'], label: 'client' },
];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    // Typed client sources must stay in the same size/dependency audit as JS.
    else if (/\.(?:[cm]?js|tsx?)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const clientSrcExists = fs.existsSync(path.join(root, 'src', 'client', 'index.ts'));
const files = [
  ...walk(path.join(root, 'lib')),
  ...walk(path.join(root, 'src', 'client')),
]
  .filter((file) => !(clientSrcExists && /[\\/]lib[\\/]client\.js$/.test(file)))
  .sort();

function read(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

function measure(file) {
  const text = read(file);
  const lines = text.split('\n');
  let code = 0;
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (inBlock) {
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (!line) continue;
    if (line.startsWith('//')) continue;
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlock = true;
      continue;
    }
    code++;
  }

  const functions = [];
  const decl = [
    /^(\s*)(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)(?:<[^>]+>)?\s*\(/,
    /^(\s*)(?:async\s+)?([A-Za-z0-9_$]+)\s*\([^()]*\)\s*\{\s*$/,
    /^(\s*)(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>\s*\{\s*$/,
    /^(\s*)(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s+)?function\s*\(/,
  ];
  const keywords = new Set(['if', 'for', 'while', 'switch', 'catch', 'do', 'function', 'return', 'constructor']);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || !line.trimEnd().endsWith('{')) continue;
    for (const re of decl) {
      const m = re.exec(line);
      if (!m) continue;
      const indent = m[1].length;
      const name = m[2];
      if (keywords.has(name)) break;
      const close = ' '.repeat(indent) + '}';
      let end = i;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j] === close || lines[j] === close + ';') { end = j; break; }
      }
      // Nested callbacks can close at the same indent only at a real boundary;
      // an unclosed span means the heuristic mis-read a template literal.
      functions.push({ name, line: i + 1, loc: end - i + 1, indent });
      break;
    }
  }

  const imports = [...text.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const requires = [...text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  return {
    file: path.relative(root, file).replaceAll('\\', '/'),
    loc: lines.length - (text.endsWith('\n') ? 1 : 0),
    code,
    functions,
    imports: [...new Set([...imports, ...requires])],
  };
}

const measured = files.map(measure);
const byFile = new Map(measured.map((m) => [m.file, m]));

const violations = [];
const fileViolations = measured.filter((m) => m.loc > LIMITS.fileLoc);
for (const m of fileViolations) {
  violations.push({ rule: 'file-too-large', file: m.file, value: m.loc, limit: LIMITS.fileLoc });
}

for (const m of measured) {
  for (const fn of m.functions) {
    const limit = /^[A-Z]/.test(fn.name) ? LIMITS.componentLoc : LIMITS.functionLoc;
    if (fn.loc > limit) {
      violations.push({ rule: 'function-too-long', file: m.file, name: fn.name, value: fn.loc, limit });
    }
  }
}

// ---------------------------------------------------------- layer direction

function layerOf(relative) {
  const normalized = relative.replaceAll('\\', '/');
  return LAYERS.find((layer) => normalized === layer.dir || normalized.startsWith(layer.dir + '/'));
}

function resolveImport(fromRelative, spec) {
  if (!spec.startsWith('.')) return null;
  const fromDir = path.posix.dirname(fromRelative);
  const resolved = path.posix.normalize(path.posix.join(fromDir, spec));
  return resolved.replace(/\.(?:m?js|tsx?)$/, '');
}

const layerViolations = [];
for (const m of measured) {
  const layer = layerOf(m.file);
  if (!layer) continue;
  for (const spec of m.imports) {
    if (spec.startsWith('node:') && layer.dir !== 'lib/core' && layer.dir !== 'lib/host') {
      layerViolations.push({ from: m.file, import: spec, reason: layer.label + ' must not touch node builtins' });
      continue;
    }
    if (spec === 'react') {
      if (layer.dir !== 'src/client') layerViolations.push({ from: m.file, import: spec, reason: 'only the client half renders' });
      continue;
    }
    const resolved = resolveImport(m.file, spec);
    if (!resolved) continue;
    const target = layerOf(resolved);
    if (!target) continue;
    if (target.dir === layer.dir) continue;
    if (!layer.mayImport.includes(target.dir)) {
      layerViolations.push({ from: m.file, import: spec, reason: layer.label + ' must not import ' + target.label });
    }
  }
}

// ------------------------------------------------------------------- cycles

const graph = new Map();
for (const m of measured) {
  const deps = [];
  for (const spec of m.imports) {
    const resolved = resolveImport(m.file, spec);
    if (!resolved) continue;
    for (const candidate of byFile.keys()) {
      if (candidate.replace(/\.(?:m?js|tsx?)$/, '') === resolved) deps.push(candidate);
    }
  }
  graph.set(m.file, deps);
}
const cycles = [];
const state = new Map();
const stack = [];
function visit(node) {
  const mark = state.get(node);
  if (mark === 1) {
    const start = stack.indexOf(node);
    cycles.push(stack.slice(start).concat(node));
    return;
  }
  if (mark === 2) return;
  state.set(node, 1);
  stack.push(node);
  for (const dep of graph.get(node) || []) visit(dep);
  stack.pop();
  state.set(node, 2);
}
for (const node of graph.keys()) visit(node);

// ------------------------------------------------------------------ report

const totals = {
  files: measured.length,
  loc: measured.reduce((sum, m) => sum + m.loc, 0),
  functions: measured.reduce((sum, m) => sum + m.functions.length, 0),
  maxFileLoc: Math.max(0, ...measured.map((m) => m.loc)),
  maxFunctionLoc: Math.max(0, ...measured.flatMap((m) => m.functions.map((f) => f.loc))),
};

const summary = {
  generatedAt: new Date().toISOString(),
  limits: LIMITS,
  totals,
  biggestFiles: [...measured].sort((a, b) => b.loc - a.loc).slice(0, 10).map((m) => ({ file: m.file, loc: m.loc })),
  longestFunctions: measured
    .flatMap((m) => m.functions.map((f) => ({ file: m.file, name: f.name, line: f.line, loc: f.loc })))
    .sort((a, b) => b.loc - a.loc)
    .slice(0, 10),
  violations,
  layerViolations,
  cycles,
  ok: violations.length === 0 && layerViolations.length === 0 && cycles.length === 0,
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log('# maintainability audit');
  console.log('');
  console.log('files=%d loc=%d functions=%d maxFile=%d maxFunction=%d', totals.files, totals.loc, totals.functions, totals.maxFileLoc, totals.maxFunctionLoc);
  console.log('');
  console.log('## biggest files');
  for (const entry of summary.biggestFiles) console.log('  %s  %s', String(entry.loc).padStart(5), entry.file);
  console.log('');
  console.log('## longest functions');
  for (const entry of summary.longestFunctions) console.log('  %s  %s:%d  %s', String(entry.loc).padStart(5), entry.file, entry.line, entry.name);
  console.log('');
  console.log('## violations');
  if (!violations.length) console.log('  none');
  for (const v of violations) console.log('  %s  %s  %d > %d', v.rule, v.file + (v.name ? ':' + v.name : ''), v.value, v.limit);
  console.log('');
  console.log('## layer violations');
  if (!layerViolations.length) console.log('  none');
  for (const v of layerViolations) console.log('  %s  %s  (%s)', v.from, v.import, v.reason);
  console.log('');
  console.log('## cycles');
  if (!cycles.length) console.log('  none');
  for (const cycle of cycles) console.log('  ' + cycle.join(' -> '));
  console.log('');
  console.log(summary.ok ? 'OK: within limits' : 'FAIL: limits exceeded');
}

process.exit(strict && !summary.ok ? 1 : 0);
