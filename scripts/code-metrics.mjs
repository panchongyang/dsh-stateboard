#!/usr/bin/env node
/**
 * code-metrics.mjs — read-only size and shape metrics for this repository.
 *
 * The tool only reads source files. The default, --json, --md and --csv modes
 * write nothing to disk; --html writes the generated report (by default
 * .evidence/code-metrics.html). No existing file is modified, no dependency is
 * added, and no threshold is enforced: this is an observation tool, not a gate.
 *
 * Usage:
 *   node scripts/code-metrics.mjs                  # human table, top rows
 *   node scripts/code-metrics.mjs --all            # every file row
 *   node scripts/code-metrics.mjs --json           # machine-readable report
 *   node scripts/code-metrics.mjs --md             # markdown tables
 *   node scripts/code-metrics.mjs --csv            # per-file CSV
 *   node scripts/code-metrics.mjs --html           # .evidence/code-metrics.html
 *   node scripts/code-metrics.mjs --html=out.html  # explicit output path
 *
 * Options:
 *   --ext=js,mjs         scanned extensions (default js,mjs,cjs,ts,tsx)
 *   --area=lib,test      only scan paths under these prefixes
 *   --top=20             rows in ranking tables (default 20)
 *   --sort=code          file order: code|lines|functions|decisions|comment|name
 *   --all                show every file in the console table
 *   --include-generated  include lib/client.js (build output) in the scan
 *
 * Metric definitions (heuristics, no parser dependency):
 *   lines       physical lines
 *   code        lines with code outside comments
 *   comment     comment-only lines (a block comment counts once per line)
 *   blank       whitespace-only lines
 *   functions   named/assigned definitions, class/object methods, and
 *               block-bodied anonymous callbacks (test cases, hooks, promise
 *               chains); one definition per line at most
 *   loc         function span from its declaration line to the closing brace
 *               (expression-bodied arrows count as one line)
 *   decisions   branch points: if/for/while/case/catch, &&, ||, ??, ternary ?;
 *               labelled "cx" (approximately cyclomatic complexity minus one)
 *   fan-in      number of scanned files that import this file
 *   duplicate   code lines (>= 12 chars, non-import) also found in another file
 *   depth       maximum brace nesting on code lines
 *
 * Known limits: this is a heuristic scanner, not a parser. Comments are
 * removed, string/template contents are blanked, and regex literals are
 * recognised with an expression-position heuristic; exotic regexes can still
 * confuse brace counting. Definitions whose parameters or `=>` body span lines
 * can be missed, and anonymous inline callbacks are only counted when assigned
 * to a name.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_EXT = ['js', 'mjs', 'cjs', 'ts', 'tsx'];
const SKIP_DIRS = new Set(['node_modules', 'coverage', 'dist']);
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'do', 'function', 'return', 'else',
  'try', 'finally', 'with', 'case', 'break', 'continue', 'new', 'delete',
  'typeof', 'instanceof', 'in', 'of', 'void', 'yield', 'await', 'throw',
  'super', 'this', 'class', 'extends', 'import', 'export', 'default', 'const',
  'let', 'var', 'async', 'static', 'get', 'set',
]);

// ---------------------------------------------------------------- arguments

function fail(message) {
  console.error('code-metrics: ' + message);
  console.error('run `node scripts/code-metrics.mjs --help` for usage');
  process.exit(2);
}

function printHelp() {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#![^\n]*\n/, '').replace(/^\/\*\*?\n?/, '').replace(/^ \* ?/gm, '').trim());
}

function parseArgs(argv) {
  const opts = {
    format: 'table',
    formatSet: false,
    htmlPath: '.evidence/code-metrics.html',
    ext: DEFAULT_EXT.slice(),
    extSet: false,
    areas: [],
    top: 20,
    sort: 'code',
    all: false,
    includeGenerated: false,
  };
  const setFormat = (next) => {
    if (opts.formatSet && opts.format !== next) fail('only one output format flag is allowed (--json / --md / --csv / --html)');
    opts.format = next;
    opts.formatSet = true;
  };
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    } else if (arg === '--json') {
      setFormat('json');
    } else if (arg === '--md') {
      setFormat('md');
    } else if (arg === '--csv') {
      setFormat('csv');
    } else if (arg === '--html') {
      setFormat('html');
    } else if (arg.startsWith('--html=')) {
      setFormat('html');
      opts.htmlPath = arg.slice('--html='.length);
      if (!opts.htmlPath) fail('--html needs a non-empty path');
    } else if (arg === '--all') {
      opts.all = true;
    } else if (arg === '--include-generated') {
      opts.includeGenerated = true;
    } else if (arg.startsWith('--ext=')) {
      const list = arg.slice('--ext='.length).split(',').map((item) => item.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
      if (!list.length) fail('--ext needs at least one extension');
      opts.ext = [...new Set(list)];
      opts.extSet = true;
    } else if (arg.startsWith('--area=')) {
      opts.areas = arg.slice('--area='.length).split(',').map((item) => item.trim().replaceAll('\\', '/').replace(/\/+$/, '')).filter(Boolean);
      if (!opts.areas.length) fail('--area needs at least one path prefix');
    } else if (arg.startsWith('--top=')) {
      const value = Number(arg.slice('--top='.length));
      if (!Number.isInteger(value) || value <= 0) fail('--top must be a positive integer');
      opts.top = value;
    } else if (arg.startsWith('--sort=')) {
      opts.sort = arg.slice('--sort='.length);
      if (!['code', 'lines', 'functions', 'decisions', 'comment', 'name'].includes(opts.sort)) {
        fail('--sort must be code|lines|functions|decisions|comment|name');
      }
    } else {
      fail('unknown argument: ' + arg);
    }
  }
  return opts;
}

// ----------------------------------------------------------------- scanning

function walk(dir, extensions, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = entry.name;
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, name);
    if (entry.isDirectory()) {
      if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
      walk(full, extensions, out);
    } else if (entry.isFile()) {
      const ext = path.extname(name).slice(1).toLowerCase();
      if (extensions.has(ext)) out.push(full);
    }
  }
  return out;
}

const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'case', 'do', 'else', 'yield', 'await', 'throw',
]);

/**
 * Single pass over the source that records, per line, whether it contains code
 * and/or a comment, and produces a copy where comments and string/template and
 * regex-literal contents are blanked. Regex literals are recognised with the
 * usual "can a regex start here" heuristic so their braces and quotes do not
 * disturb function spans.
 */
function scanSource(text) {
  const sanitized = [''];
  const flags = [{ code: false, comment: false }];
  let commentText = '';
  let state = 'code';
  let line = 0;
  let i = 0;
  let regexAllowed = true;
  let word = '';
  const ensure = (index) => {
    while (sanitized.length <= index) {
      sanitized.push('');
      flags.push({ code: false, comment: false });
    }
  };
  const flushWord = () => {
    if (word) {
      regexAllowed = REGEX_KEYWORDS.has(word);
      word = '';
    }
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\n') {
      if (state === 'line' || state === 'single' || state === 'double') state = 'code';
      if (state === 'template') flags[line].code = true;
      flushWord();
      line += 1;
      ensure(line);
      i += 1;
      continue;
    }
    if (state === 'line') {
      flags[line].comment = true;
      commentText += ch;
      i += 1;
      continue;
    }
    if (state === 'block') {
      flags[line].comment = true;
      if (ch === '*' && text[i + 1] === '/') {
        i += 2;
        state = 'code';
        continue;
      }
      commentText += ch;
      i += 1;
      continue;
    }
    if (state === 'single' || state === 'double') {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if ((state === 'single' && ch === "'") || (state === 'double' && ch === '"')) {
        state = 'code';
        regexAllowed = false;
      }
      i += 1;
      continue;
    }
    if (state === 'template') {
      flags[line].code = true;
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '`') {
        state = 'code';
        regexAllowed = false;
      }
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      flushWord();
      sanitized[line] += ch;
      i += 1;
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(ch)) {
      flags[line].code = true;
      sanitized[line] += ch;
      word += ch;
      i += 1;
      continue;
    }
    flushWord();
    if (ch === '/' && text[i + 1] === '/') {
      state = 'line';
      flags[line].comment = true;
      i += 2;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      state = 'block';
      flags[line].comment = true;
      i += 2;
      continue;
    }
    if (ch === '/' && regexAllowed) {
      flags[line].code = true;
      let inClass = false;
      i += 1;
      while (i < text.length) {
        const current = text[i];
        if (current === '\n') break;
        if (current === '\\') {
          i += 2;
          continue;
        }
        if (current === '[') inClass = true;
        else if (current === ']') inClass = false;
        else if (current === '/' && !inClass) {
          i += 1;
          break;
        }
        i += 1;
      }
      regexAllowed = false;
      continue;
    }
    if (ch === "'") {
      flags[line].code = true;
      state = 'single';
      regexAllowed = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      flags[line].code = true;
      state = 'double';
      regexAllowed = false;
      i += 1;
      continue;
    }
    if (ch === '`') {
      flags[line].code = true;
      state = 'template';
      regexAllowed = false;
      i += 1;
      continue;
    }
    flags[line].code = true;
    sanitized[line] += ch;
    if (ch === ')' || ch === ']') regexAllowed = false;
    else regexAllowed = true;
    i += 1;
  }
  return { sanitized, flags, commentText };
}

function readSource(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n?/g, '\n');
}

// --------------------------------------------------------------- functions

function findClosingBrace(lines, startLine, startColumn) {
  let depth = 0;
  for (let l = startLine; l < lines.length; l++) {
    const text = lines[l];
    for (let c = l === startLine ? startColumn : 0; c < text.length; c++) {
      if (text[c] === '{') depth += 1;
      else if (text[c] === '}') {
        depth -= 1;
        if (depth === 0) return l;
      }
    }
  }
  return -1;
}

function matchFunction(trimmed, rawTrimmed) {
  let m;
  if ((m = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)\s*\(/.exec(trimmed))) {
    return { name: m[1], kind: 'function', async: /^(?:export\s+)?(?:default\s+)?async\s+function\b/.test(trimmed) };
  }
  if ((m = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s+)?(?:function\b|\([^()]*\)\s*=>|[A-Za-z0-9_$]+\s*=>)/.exec(trimmed))) {
    return { name: m[1], kind: 'arrow', async: /=\s*async\b/.test(trimmed) };
  }
  if ((m = /^([A-Za-z0-9_$]+)\s*:\s*(?:async\s+)?(?:function\b|\*?\s*\([^()]*\)\s*=>|[A-Za-z0-9_$]+\s*=>)/.exec(trimmed))) {
    return { name: m[1], kind: 'property', async: /:\s*async\b/.test(trimmed) };
  }
  if ((m = /^(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z0-9_$]+)\s*\([^()]*\)\s*\{\s*$/.exec(trimmed))) {
    return { name: m[1], kind: 'method', async: /^(?:static\s+)?async\b/.test(trimmed) };
  }
  // Test titles live in a string, which the sanitized line has blanked, so
  // read the title from the raw line while keeping the structural match clean.
  const testCase = /^(?:test|it|describe|before|after|beforeEach|afterEach)\s*\(\s*(['"`])(.*?)\1\s*,\s*(?:async\s+)?(?:function\b|\*?\s*\([^()]*\)\s*=>|[A-Za-z0-9_$]+\s*=>)/.exec(rawTrimmed);
  if (testCase) return { name: testCase[2].slice(0, 60), kind: 'test', async: /async\s+(?:function|\(|[A-Za-z0-9_$]+\s*=>)/.test(rawTrimmed) };
  const callback = /(?:^|[^\w$])(?:async\s+)?(?:function\s*\*?\s*)?(?:\([^()]*\)|[A-Za-z0-9_$]+)\s*=>\s*\{\s*$/.exec(trimmed);
  if (callback) {
    const callee = /([A-Za-z0-9_$.]+)\s*\(\s*(?:async\s+)?(?:function\b|\([^()]*\)\s*=>|[A-Za-z0-9_$]+\s*=>)/.exec(trimmed);
    return { name: callee ? callee[1] + '()' : '<arrow>', kind: 'callback', async: /async\s+(?:function|\(|[A-Za-z0-9_$]+\s*=>)/.test(trimmed) };
  }
  if (/(?:^|[^\w$])function\s*\*?\s*\([^()]*\)\s*\{\s*$/.test(trimmed)) {
    const callee = /([A-Za-z0-9_$.]+)\s*\(\s*(?:async\s+)?function\s*\*?\s*\([^()]*\)\s*\{\s*$/.exec(trimmed);
    return { name: callee ? callee[1] + '()' : '<function>', kind: 'callback', async: /\basync\s+function\b/.test(trimmed) };
  }
  return null;
}

function detectFunctions(lines, rawLines) {
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const source = lines[i];
    const trimmed = source.trim();
    if (!trimmed) continue;
    const rawTrimmed = rawLines && rawLines[i] ? rawLines[i].trim() : trimmed;
    const match = matchFunction(trimmed, rawTrimmed);
    if (!match) continue;
    if (match.kind !== 'test' && match.kind !== 'callback' && KEYWORDS.has(match.name)) continue;
    if (match.kind === 'callback' && KEYWORDS.has(match.name)) continue;
    const brace = source.lastIndexOf('{');
    let end = i;
    let closed = true;
    if (brace >= 0) {
      end = findClosingBrace(lines, i, brace);
      if (end < 0) {
        end = lines.length - 1;
        closed = false;
      }
    } else if (match.kind !== 'arrow' && match.kind !== 'property') {
      continue;
    }
    const span = lines.slice(i, end + 1).join('\n');
    found.push({
      name: match.name,
      kind: match.kind,
      line: i + 1,
      loc: end - i + 1,
      decisions: countBranches(span),
      async: match.async,
      exported: /^\s*export\b/.test(source),
      closed,
    });
  }
  return found;
}

function countBranches(text) {
  const words = text.match(/\b(?:if|for|while|case|catch)\b/g);
  const logical = text.match(/&&|\|\|/g);
  const nullish = text.match(/\?\?/g);
  const ternary = text.match(/(?<![?$])\?(?![.?:])/g);
  return (words ? words.length : 0) + (logical ? logical.length : 0) + (nullish ? nullish.length : 0) + (ternary ? ternary.length : 0);
}

function maxBraceDepth(lines) {
  let depth = 0;
  let max = 0;
  for (const line of lines) {
    for (const ch of line) {
      if (ch === '{') {
        depth += 1;
        if (depth > max) max = depth;
      } else if (ch === '}') {
        depth = Math.max(0, depth - 1);
      }
    }
  }
  return max;
}

function collectImports(codeText) {
  const specs = new Set();
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of codeText.matchAll(pattern)) specs.add(match[1]);
  }
  return [...specs].sort();
}

function countExports(lines) {
  let count = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^export\b/.test(trimmed)) count += 1;
    else if (/^module\.exports\s*=/.test(trimmed) || /^exports\.[A-Za-z0-9_$]+\s*=/.test(trimmed)) count += 1;
  }
  return count;
}

function areaOf(relative) {
  const parts = relative.split('/');
  if ((parts[0] === 'lib' || parts[0] === 'src') && parts.length > 2) return parts[0] + '/' + parts[1];
  return parts[0];
}

function stripExtension(relative) {
  return relative.replace(/\.(?:[cm]?[jt]sx?)$/i, '');
}

function duplicateKey(line) {
  const text = line.trim().replace(/\s+/g, ' ');
  if (text.length < 12) return null;
  if (/^(?:import|export\s+\{|export\s+\*)/.test(text)) return null;
  if (/^[{}()[\],;:.]+$/.test(text)) return null;
  if (/^(?:'use strict'|"use strict");?$/.test(text)) return null;
  return text;
}

// ------------------------------------------------------------------ measure

function analyzeFile(absolute, relative) {
  const raw = readSource(absolute);
  const { sanitized, flags, commentText } = scanSource(raw);
  const rawLines = raw.split('\n');
  const lineCount = raw.length === 0 ? 0 : rawLines.length - (raw.endsWith('\n') ? 1 : 0);
  if (lineCount > 0 && rawLines[0].startsWith('#!')) {
    flags[0].code = false;
    flags[0].comment = true;
  }
  let code = 0;
  let comment = 0;
  let blank = 0;
  let mixed = 0;
  let maxLine = 0;
  let longLines = 0;
  const lineKeys = [];
  for (let i = 0; i < lineCount; i++) {
    const rawLine = rawLines[i];
    const length = rawLine.length;
    if (length > maxLine) maxLine = length;
    if (length > 160) longLines += 1;
    if (!rawLine.trim()) {
      blank += 1;
      continue;
    }
    if (flags[i].code) {
      code += 1;
      if (flags[i].comment) mixed += 1;
      const key = duplicateKey(rawLine);
      if (key) lineKeys.push(key);
    } else if (flags[i].comment) {
      comment += 1;
    } else {
      blank += 1;
    }
  }
  const lines = sanitized.slice(0, lineCount);
  const functions = detectFunctions(lines, rawLines.slice(0, lineCount));
  let functionLocSum = 0;
  let maxFunctionLoc = 0;
  let asyncFunctions = 0;
  for (const fn of functions) {
    functionLocSum += fn.loc;
    if (fn.loc > maxFunctionLoc) maxFunctionLoc = fn.loc;
    if (fn.async) asyncFunctions += 1;
  }
  const classes = lines.filter((line) => /^\s*(?:export\s+)?(?:default\s+)?class\s+[A-Za-z0-9_$]+/.test(line)).length;
  const codeText = rawLines.slice(0, lineCount).filter((line, index) => flags[index].code).join('\n');
  const imports = collectImports(codeText);
  const todos = (commentText.match(/\b(?:TODO|FIXME|HACK|XXX)\b/g) || []).length;
  return {
    file: relative,
    area: areaOf(relative),
    ext: path.extname(relative).slice(1).toLowerCase(),
    generated: false,
    lines: lineCount,
    code,
    comment,
    blank,
    mixed,
    commentDensity: code + comment > 0 ? (comment / (code + comment)) * 100 : 0,
    functions,
    functionCount: functions.length,
    asyncFunctions,
    classes,
    functionLocSum,
    avgFunctionLoc: functions.length ? functionLocSum / functions.length : 0,
    maxFunctionLoc,
    decisions: countBranches(lines.join('\n')),
    maxDepth: maxBraceDepth(lines),
    imports,
    internalImports: 0,
    externalImports: 0,
    unresolvedImports: 0,
    exports: countExports(lines),
    fanIn: 0,
    duplicateLines: 0,
    duplicatePercent: 0,
    todos,
    maxLine,
    longLines,
    _lineKeys: lineKeys,
  };
}

// ------------------------------------------------------------------- report

function sum(list, pick) {
  let total = 0;
  for (const item of list) total += pick(item);
  return total;
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentileShare(sorted, fraction) {
  if (!sorted.length) return { files: 0, percent: 0, share: 0, code: 0 };
  const count = Math.max(1, Math.ceil(sorted.length * fraction));
  const code = sum(sorted.slice(0, count), (file) => file.code);
  const total = sum(sorted, (file) => file.code);
  return {
    files: count,
    percent: (count / sorted.length) * 100,
    share: total > 0 ? (code / total) * 100 : 0,
    code,
  };
}

function buildReport(analyses, opts, context) {
  // Internal dependency edges and fan-in.
  const byModule = new Map();
  for (const file of analyses) byModule.set(stripExtension(file.file), file);
  const externalCount = new Map();
  for (const file of analyses) {
    const targets = new Set();
    const externals = new Set();
    for (const spec of file.imports) {
      if (spec.startsWith('.')) {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file.file), spec));
        const id = stripExtension(resolved);
        const target = byModule.get(id) || byModule.get(id + '/index');
        if (target) targets.add(target);
        else file.unresolvedImports += 1;
      } else if (!path.isAbsolute(spec)) {
        externals.add(spec);
      }
    }
    file.internalImports = targets.size;
    file.externalImports = externals.size;
    for (const target of targets) target.fanIn += 1;
    for (const spec of externals) externalCount.set(spec, (externalCount.get(spec) || 0) + 1);
  }

  // Cross-file duplicate code lines.
  const owners = new Map();
  for (const file of analyses) {
    for (const key of file._lineKeys) {
      const set = owners.get(key) || new Set();
      set.add(file.file);
      owners.set(key, set);
    }
  }
  for (const file of analyses) {
    let duplicates = 0;
    for (const key of file._lineKeys) {
      const set = owners.get(key);
      if (set && set.size > 1) duplicates += 1;
    }
    file.duplicateLines = duplicates;
    file.duplicatePercent = file.code > 0 ? (duplicates / file.code) * 100 : 0;
    delete file._lineKeys;
  }
  const duplicateLines = sum(analyses, (file) => file.duplicateLines);
  const clusters = [...owners.entries()]
    .filter(([, set]) => set.size > 1)
    .map(([text, set]) => ({ text, files: [...set].sort(), count: set.size }))
    .sort((a, b) => b.count - a.count || b.text.length - a.text.length)
    .slice(0, 10);

  // Aggregates.
  const totals = {
    files: analyses.length,
    lines: sum(analyses, (file) => file.lines),
    code: sum(analyses, (file) => file.code),
    comment: sum(analyses, (file) => file.comment),
    blank: sum(analyses, (file) => file.blank),
    mixed: sum(analyses, (file) => file.mixed),
    functions: sum(analyses, (file) => file.functionCount),
    asyncFunctions: sum(analyses, (file) => file.asyncFunctions),
    classes: sum(analyses, (file) => file.classes),
    avgFunctionLoc: 0,
    maxFunctionLoc: Math.max(0, ...analyses.map((file) => file.maxFunctionLoc)),
    decisions: sum(analyses, (file) => file.decisions),
    internalImports: sum(analyses, (file) => file.internalImports),
    externalImports: sum(analyses, (file) => file.externalImports),
    unresolvedImports: sum(analyses, (file) => file.unresolvedImports),
    exports: sum(analyses, (file) => file.exports),
    fanInMax: Math.max(0, ...analyses.map((file) => file.fanIn)),
    todos: sum(analyses, (file) => file.todos),
    longLines: sum(analyses, (file) => file.longLines),
    maxLine: Math.max(0, ...analyses.map((file) => file.maxLine)),
    duplicateLines,
    duplicatePercent: 0,
    testCode: 0,
    testShare: 0,
    commentDensity: 0,
  };
  const functionLocSum = sum(analyses, (file) => file.functionLocSum);
  totals.avgFunctionLoc = totals.functions > 0 ? functionLocSum / totals.functions : 0;
  totals.commentDensity = totals.code + totals.comment > 0 ? (totals.comment / (totals.code + totals.comment)) * 100 : 0;
  totals.duplicatePercent = totals.code > 0 ? (totals.duplicateLines / totals.code) * 100 : 0;
  totals.testCode = sum(analyses.filter((file) => file.area === 'test'), (file) => file.code);
  totals.testShare = totals.code > 0 ? (totals.testCode / totals.code) * 100 : 0;

  const byCode = [...analyses].sort((a, b) => b.code - a.code || a.file.localeCompare(b.file));
  const byAreaMap = new Map();
  for (const file of analyses) {
    const entry = byAreaMap.get(file.area) || { area: file.area, files: 0, code: 0, lines: 0, comment: 0, functions: 0, decisions: 0, functionLocSum: 0 };
    entry.files += 1;
    entry.code += file.code;
    entry.lines += file.lines;
    entry.comment += file.comment;
    entry.functions += file.functionCount;
    entry.decisions += file.decisions;
    entry.functionLocSum += file.functionLocSum;
    byAreaMap.set(file.area, entry);
  }
  const byArea = [...byAreaMap.values()]
    .map((entry) => ({
      area: entry.area,
      files: entry.files,
      lines: entry.lines,
      code: entry.code,
      comment: entry.comment,
      functions: entry.functions,
      decisions: entry.decisions,
      share: totals.code > 0 ? (entry.code / totals.code) * 100 : 0,
      avgFunctionLoc: entry.functions > 0 ? entry.functionLocSum / entry.functions : 0,
      commentDensity: entry.code + entry.comment > 0 ? (entry.comment / (entry.code + entry.comment)) * 100 : 0,
    }))
    .sort((a, b) => b.code - a.code || a.area.localeCompare(b.area));

  const byExtensionMap = new Map();
  for (const file of analyses) byExtensionMap.set(file.ext, (byExtensionMap.get(file.ext) || 0) + file.code);
  const byExtension = [...byExtensionMap.entries()]
    .map(([ext, code]) => ({ ext, code, files: analyses.filter((file) => file.ext === ext).length }))
    .sort((a, b) => b.code - a.code);

  const bucketDefs = [
    ['<50', 0, 49],
    ['50-99', 50, 99],
    ['100-199', 100, 199],
    ['200-299', 200, 299],
    ['300-449', 300, 449],
    ['450-799', 450, 799],
    ['800+', 800, Infinity],
  ];
  const distribution = bucketDefs.map(([label, min, max]) => ({
    label,
    files: analyses.filter((file) => file.code >= min && file.code <= max).length,
    code: sum(analyses.filter((file) => file.code >= min && file.code <= max), (file) => file.code),
  }));

  const pareto = percentileShare(byCode, 0.1);
  const topFunctions = analyses
    .flatMap((file) => file.functions.map((fn) => ({
      file: file.file,
      area: file.area,
      name: fn.name,
      line: fn.line,
      loc: fn.loc,
      decisions: fn.decisions,
      kind: fn.kind,
      async: fn.async,
    })))
    .sort((a, b) => b.loc - a.loc || b.decisions - a.decisions || a.file.localeCompare(b.file))
    .slice(0, opts.top);
  const topFiles = byCode.slice(0, opts.top).map((file) => ({
    file: file.file,
    area: file.area,
    code: file.code,
    lines: file.lines,
    functionCount: file.functionCount,
    decisions: file.decisions,
  }));
  const topComplexity = [...analyses]
    .sort((a, b) => b.decisions - a.decisions || b.code - a.code)
    .slice(0, opts.top)
    .map((file) => ({ file: file.file, decisions: file.decisions, code: file.code, functionCount: file.functionCount }));
  const topFanIn = analyses
    .filter((file) => file.fanIn > 0)
    .sort((a, b) => b.fanIn - a.fanIn || b.code - a.code)
    .slice(0, opts.top)
    .map((file) => ({ file: file.file, area: file.area, fanIn: file.fanIn, code: file.code }));
  const externalImports = [...externalCount.entries()]
    .map(([spec, count]) => ({ spec, count }))
    .sort((a, b) => b.count - a.count || a.spec.localeCompare(b.spec))
    .slice(0, opts.top);

  const allFunctions = topFunctions.length ? analyses.flatMap((file) => file.functions.map((fn) => ({ ...fn, file: file.file }))) : [];
  const longestFunction = allFunctions.sort((a, b) => b.loc - a.loc || b.decisions - a.decisions)[0] || null;
  const largestFile = byCode[0] || null;
  const facts = {
    largestFile: largestFile ? { file: largestFile.file, code: largestFile.code, functions: largestFile.functionCount } : null,
    largestFunction: longestFunction ? { name: longestFunction.name, file: longestFunction.file, line: longestFunction.line, loc: longestFunction.loc, decisions: longestFunction.decisions } : null,
    pareto: { files: pareto.files, percent: pareto.percent, share: pareto.share },
    commentDensity: totals.commentDensity,
    commentLines: totals.comment,
    codeLines: totals.code,
    testCode: totals.testCode,
    testShare: totals.testShare,
    functionlessFiles: analyses.filter((file) => file.functionCount === 0).length,
    mostImported: topFanIn[0] || null,
    duplication: { lines: totals.duplicateLines, percent: totals.duplicatePercent },
    functionsPer100: totals.code > 0 ? (totals.functions / totals.code) * 100 : 0,
  };

  const sortFile = {
    code: (a, b) => b.code - a.code || a.file.localeCompare(b.file),
    lines: (a, b) => b.lines - a.lines || a.file.localeCompare(b.file),
    functions: (a, b) => b.functionCount - a.functionCount || a.file.localeCompare(b.file),
    decisions: (a, b) => b.decisions - a.decisions || a.file.localeCompare(b.file),
    comment: (a, b) => b.comment - a.comment || a.file.localeCompare(b.file),
    name: (a, b) => a.file.localeCompare(b.file),
  }[opts.sort];

  const report = {
    tool: 'code-metrics',
    version: 1,
    readOnly: true,
    project: path.basename(root),
    generatedAt: new Date().toISOString(),
    scope: {
      extensions: opts.ext,
      areas: opts.areas,
      files: analyses.length,
      generatedExcluded: context.generatedExcluded,
      skippedDirs: ['node_modules', 'coverage', 'dist', '.*'],
    },
    totals,
    byArea,
    byExtension,
    distribution,
    pareto,
    facts,
    files: [...analyses].sort(sortFile),
    topFiles,
    topFunctions,
    topComplexity,
    topFanIn,
    externalImports,
    duplication: { lines: totals.duplicateLines, percent: totals.duplicatePercent, clusters },
    notes: [
      'Heuristic scanner: comments are stripped, string/template contents are blanked, and regex literals use an expression-position heuristic; exotic regexes can still confuse brace counting.',
      'Functions are counted when block-bodied, or when an arrow/function expression is assigned to a name (one-line expression arrows count as one line); anonymous non-block callbacks are not counted.',
      'Branch points approximate cyclomatic complexity; every function also has a base path of one.',
      'Duplicate lines are exact matches after whitespace normalization; semantic clones are not detected.',
      'No thresholds, scores or pass/fail: this tool only reports facts.',
    ],
  };
  return report;
}

// ---------------------------------------------------------------- renderers

const fmt = (value) => Number(value).toLocaleString('en-US');
const pct = (value) => (Number(value) || 0).toFixed(1) + '%';

function shortPath(relative, max = 58) {
  if (relative.length <= max) return relative;
  return relative.slice(0, max - 23) + '…' + relative.slice(-22);
}

function formatTable(headers, rows, right = []) {
  const widths = headers.map((header, index) => {
    let width = header.length;
    for (const row of rows) width = Math.max(width, String(row[index]).length);
    return width;
  });
  const renderRow = (row) => row.map((cell, index) => {
    const text = String(cell);
    return right.includes(index) ? text.padStart(widths[index]) : text.padEnd(widths[index]);
  }).join('  ');
  const lines = [renderRow(headers), widths.map((width) => '-'.repeat(width)).join('  ')];
  for (const row of rows) lines.push(renderRow(row));
  return lines;
}

function renderConsole(report, opts) {
  const totals = report.totals;
  const lines = [];
  lines.push(`code-metrics · ${report.project}`);
  lines.push(`generated ${report.generatedAt}`);
  lines.push(`scope ${totals.files} files · ext ${report.scope.extensions.join(',')} · areas ${report.scope.areas.length ? report.scope.areas.join(',') : 'all'}`);
  if (report.scope.generatedExcluded.length) lines.push(`excluded ${report.scope.generatedExcluded.join(', ')} (generated; use --include-generated)`);
  lines.push('read-only: no source file is written; no threshold is enforced');
  lines.push('');
  lines.push('TOTALS');
  const summaryRows = [
    ['files', fmt(totals.files)],
    ['lines', `${fmt(totals.lines)}  (code ${fmt(totals.code)} · comment ${fmt(totals.comment)} · blank ${fmt(totals.blank)})`],
    ['comment density', pct(totals.commentDensity)],
    ['functions', `${fmt(totals.functions)}  (async ${fmt(totals.asyncFunctions)} · classes ${fmt(totals.classes)})`],
    ['function loc', `avg ${totals.avgFunctionLoc.toFixed(1)} · max ${fmt(totals.maxFunctionLoc)}`],
    ['branch points', fmt(totals.decisions)],
    ['imports', `internal ${fmt(totals.internalImports)} · external ${fmt(totals.externalImports)}${totals.unresolvedImports ? ` · unresolved ${fmt(totals.unresolvedImports)}` : ''}`],
    ['exports', fmt(totals.exports)],
    ['fan-in max', fmt(totals.fanInMax)],
    ['cross-file duplicates', `${fmt(totals.duplicateLines)} lines (${pct(totals.duplicatePercent)})`],
    ['test code', `${fmt(totals.testCode)} lines (${pct(totals.testShare)} of code)`],
    ['todo markers', fmt(totals.todos)],
  ];
  for (const [key, value] of summaryRows) lines.push('  ' + key.padEnd(22) + value);
  if (report.facts.largestFile) lines.push('  ' + 'largest file'.padEnd(22) + `${report.facts.largestFile.file} (${fmt(report.facts.largestFile.code)} code)`);
  if (report.facts.largestFunction) {
    const fn = report.facts.largestFunction;
    lines.push('  ' + 'longest function'.padEnd(22) + `${fn.name} @ ${fn.file}:${fn.line} (${fn.loc} loc)`);
  }
  lines.push('');

  const limit = opts.all ? report.files.length : Math.min(opts.top, report.files.length);
  lines.push(`FILES (${limit} of ${report.files.length}${opts.all ? '' : ', --all for every row'})`);
  const fileRows = report.files.slice(0, limit).map((file) => [
    shortPath(file.file),
    file.lines,
    file.code,
    file.comment,
    file.blank,
    file.functionCount,
    file.functionCount ? file.avgFunctionLoc.toFixed(1) : '-',
    file.maxFunctionLoc,
    file.decisions,
    file.internalImports,
    file.externalImports,
    file.exports,
    file.fanIn,
    file.duplicateLines,
  ]);
  lines.push(...formatTable(
    ['file', 'lines', 'code', 'cmt', 'blank', 'fn', 'avg', 'max', 'cx', 'imp', 'ext', 'exp', 'fan', 'dup'],
    fileRows,
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  ));
  lines.push('');

  lines.push('BY AREA');
  lines.push(...formatTable(
    ['area', 'files', 'code', 'share', 'fn', 'avgFn', 'cmt%', 'cx'],
    report.byArea.map((area) => [area.area, area.files, area.code, pct(area.share), area.functions, area.avgFunctionLoc.toFixed(1), pct(area.commentDensity), area.decisions]),
    [1, 2, 3, 4, 5, 6, 7],
  ));
  lines.push('');

  lines.push('SIZE DISTRIBUTION (code lines per file)');
  const maxBucket = Math.max(1, ...report.distribution.map((bucket) => bucket.files));
  for (const bucket of report.distribution) {
    const bar = '#'.repeat(Math.round((bucket.files / maxBucket) * 28));
    lines.push('  ' + bucket.label.padEnd(9) + String(bucket.files).padStart(4) + '  ' + bar);
  }
  lines.push('');

  lines.push(`TOP FUNCTIONS BY LENGTH (top ${Math.min(opts.top, report.topFunctions.length)})`);
  lines.push(...formatTable(
    ['loc', 'cx', 'where', 'name'],
    report.topFunctions.map((fn) => [fn.loc, fn.decisions, shortPath(fn.file, 44) + ':' + fn.line, fn.name]),
    [0, 1],
  ));
  lines.push('');

  lines.push(`TOP FILES BY BRANCH POINTS (top ${Math.min(opts.top, report.topComplexity.length)})`);
  lines.push(...formatTable(
    ['cx', 'code', 'file'],
    report.topComplexity.map((file) => [file.decisions, file.code, shortPath(file.file)]),
    [0, 1],
  ));
  lines.push('');

  lines.push(`FAN-IN (top ${Math.min(opts.top, report.topFanIn.length)})`);
  if (!report.topFanIn.length) lines.push('  none');
  else lines.push(...formatTable(['importers', 'file'], report.topFanIn.map((file) => [file.fanIn, shortPath(file.file)]), [0]));
  lines.push('');

  lines.push(`EXTERNAL IMPORTS (top ${Math.min(opts.top, report.externalImports.length)})`);
  if (!report.externalImports.length) lines.push('  none');
  else lines.push(...formatTable(['count', 'specifier'], report.externalImports.map((entry) => [entry.count, entry.spec]), [0]));
  lines.push('');

  lines.push('CROSS-FILE DUPLICATE LINES');
  lines.push(`  ${fmt(report.duplication.lines)} occurrences (${pct(report.duplication.percent)} of code lines)`);
  for (const cluster of report.duplication.clusters.slice(0, 5)) {
    lines.push(`  ${cluster.count} files  ${cluster.text.length > 88 ? cluster.text.slice(0, 87) + '…' : cluster.text}`);
    lines.push('           ' + cluster.files.slice(0, 3).map((file) => shortPath(file, 36)).join(' · ') + (cluster.files.length > 3 ? ' …' : ''));
  }
  lines.push('');

  lines.push('NOTES');
  for (const note of report.notes) lines.push('  - ' + note);
  lines.push('');
  lines.push('hint: --json · --md · --csv · --html[=path] · --top=N · --area=lib,test · --ext=js,mjs');
  return lines.join('\n');
}

function renderMarkdown(report, opts) {
  const totals = report.totals;
  const lines = [];
  lines.push(`# code metrics — ${report.project}`);
  lines.push('');
  lines.push(`Generated ${report.generatedAt} · ${totals.files} files · extensions ${report.scope.extensions.join(', ')} · read-only`);
  lines.push('');
  lines.push('## Totals');
  lines.push('');
  lines.push('| metric | value |');
  lines.push('| --- | --- |');
  lines.push(`| lines | ${fmt(totals.lines)} |`);
  lines.push(`| code | ${fmt(totals.code)} |`);
  lines.push(`| comment | ${fmt(totals.comment)} (${pct(totals.commentDensity)} density) |`);
  lines.push(`| blank | ${fmt(totals.blank)} |`);
  lines.push(`| functions | ${fmt(totals.functions)} (async ${fmt(totals.asyncFunctions)}, classes ${fmt(totals.classes)}) |`);
  lines.push(`| function loc | avg ${totals.avgFunctionLoc.toFixed(1)}, max ${fmt(totals.maxFunctionLoc)} |`);
  lines.push(`| branch points | ${fmt(totals.decisions)} |`);
  lines.push(`| imports | internal ${fmt(totals.internalImports)}, external ${fmt(totals.externalImports)} |`);
  lines.push(`| cross-file duplicates | ${fmt(totals.duplicateLines)} (${pct(totals.duplicatePercent)}) |`);
  lines.push(`| test code | ${fmt(totals.testCode)} (${pct(totals.testShare)}) |`);
  lines.push('');
  lines.push(`## Files (top ${Math.min(opts.top, report.files.length)} by ${opts.sort})`);
  lines.push('');
  lines.push('| file | code | comment | blank | fn | avg fn | max fn | cx | fan-in | dup |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const file of report.files.slice(0, opts.top)) {
    lines.push(`| ${file.file} | ${file.code} | ${file.comment} | ${file.blank} | ${file.functionCount} | ${file.functionCount ? file.avgFunctionLoc.toFixed(1) : '-'} | ${file.maxFunctionLoc} | ${file.decisions} | ${file.fanIn} | ${file.duplicateLines} |`);
  }
  lines.push('');
  lines.push('## By area');
  lines.push('');
  lines.push('| area | files | code | share | fn | avg fn | comment % |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const area of report.byArea) {
    lines.push(`| ${area.area} | ${area.files} | ${area.code} | ${pct(area.share)} | ${area.functions} | ${area.avgFunctionLoc.toFixed(1)} | ${pct(area.commentDensity)} |`);
  }
  lines.push('');
  lines.push('## Longest functions');
  lines.push('');
  lines.push('| loc | cx | where | name |');
  lines.push('| ---: | ---: | --- | --- |');
  for (const fn of report.topFunctions) lines.push(`| ${fn.loc} | ${fn.decisions} | ${fn.file}:${fn.line} | ${fn.name} |`);
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  for (const note of report.notes) lines.push('- ' + note);
  return lines.join('\n');
}

function csvCell(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}

function renderCsv(report) {
  const headers = [
    'file', 'area', 'ext', 'lines', 'code', 'comment', 'blank', 'comment_density',
    'functions', 'async_functions', 'classes', 'avg_function_loc', 'max_function_loc',
    'decisions', 'max_depth', 'internal_imports', 'external_imports', 'exports',
    'fan_in', 'duplicate_lines', 'duplicate_percent', 'todos', 'max_line', 'long_lines',
  ];
  const rows = [headers.join(',')];
  for (const file of report.files) {
    rows.push([
      file.file, file.area, file.ext, file.lines, file.code, file.comment, file.blank,
      file.commentDensity.toFixed(1), file.functionCount, file.asyncFunctions, file.classes,
      file.avgFunctionLoc.toFixed(1), file.maxFunctionLoc, file.decisions, file.maxDepth,
      file.internalImports, file.externalImports, file.exports, file.fanIn,
      file.duplicateLines, file.duplicatePercent.toFixed(1), file.todos, file.maxLine, file.longLines,
    ].map(csvCell).join(','));
  }
  return rows.join('\n');
}

// ------------------------------------------------------------- HTML report

const HTML_CSS = `
:root {
  --bg: #0b0f14;
  --panel: #121820;
  --panel2: #0f141b;
  --line: #243041;
  --text: #e6edf3;
  --muted: #93a1b3;
  --accent: #58a6ff;
  --radius: 14px;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: radial-gradient(1200px 600px at 15% -10%, #16233a 0, var(--bg) 55%) no-repeat, var(--bg);
  color: var(--text);
  font: 14px/1.55 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
}
header { padding: 36px clamp(18px, 4vw, 48px) 12px; }
h1 { font-size: clamp(22px, 3vw, 32px); margin: 0 0 6px; letter-spacing: -.02em; }
.sub { color: var(--muted); font-size: 13px; }
.badges { margin-top: 10px; }
.badge { display: inline-block; padding: 2px 8px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); font-size: 11px; margin: 0 6px 6px 0; }
main { padding: 12px clamp(18px, 4vw, 48px) 48px; display: grid; gap: 16px; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.kpi { background: linear-gradient(180deg, var(--panel), var(--panel2)); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px; }
.kpi .v { font-size: 24px; font-weight: 650; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
.kpi .l { color: var(--muted); font-size: 12px; margin-top: 2px; }
.kpi .s { color: var(--muted); font-size: 11px; opacity: .8; margin-top: 6px; }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 18px; min-width: 0; }
.card.wide { grid-column: 1 / -1; }
h2 { font-size: 14px; margin: 0 0 12px; font-weight: 600; color: #c9d4e2; display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
h2 small { font-weight: 400; color: var(--muted); font-size: 11px; }
.bars { display: flex; flex-direction: column; gap: 8px; }
.bar-row { display: grid; grid-template-columns: minmax(120px, 32%) 1fr auto; gap: 10px; align-items: center; font-size: 12px; }
.bar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #c9d4e2; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.bar-track { height: 8px; background: #1b2533; border-radius: 99px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 99px; background: var(--accent); }
.bar-value { color: var(--muted); font-variant-numeric: tabular-nums; text-align: right; min-width: 44px; }
.composition { display: flex; height: 14px; border-radius: 99px; overflow: hidden; background: #1b2533; }
.comp-seg { height: 100%; }
.legend { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 12px; font-size: 12px; color: var(--muted); }
.legend i { display: inline-block; width: 9px; height: 9px; border-radius: 3px; margin-right: 6px; }
.hist { display: flex; align-items: flex-end; gap: 6px; height: 150px; margin-top: 6px; }
.hist-col { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; gap: 6px; min-width: 0; }
.hist-bar { width: 100%; border-radius: 6px 6px 3px 3px; background: linear-gradient(180deg, #58a6ff, #1f6feb); min-height: 2px; }
.hist-n { font-size: 11px; font-variant-numeric: tabular-nums; }
.hist-l { font-size: 10px; color: var(--muted); white-space: nowrap; }
svg { width: 100%; height: auto; display: block; }
table { border-collapse: collapse; width: 100%; font-size: 12px; font-variant-numeric: tabular-nums; }
th, td { padding: 7px 10px; border-bottom: 1px solid #1c2635; text-align: right; white-space: nowrap; }
th { position: sticky; top: 0; background: var(--panel); z-index: 1; color: #aab8c9; font-weight: 600; cursor: pointer; user-select: none; }
th:first-child, td:first-child { text-align: left; }
th:hover, th.sorted { color: var(--accent); }
td.file { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; max-width: 380px; overflow: hidden; text-overflow: ellipsis; }
.table-wrap { max-height: 560px; overflow: auto; border: 1px solid var(--line); border-radius: 10px; margin-top: 12px; }
input[type=search] { width: 100%; max-width: 360px; background: #0d131b; border: 1px solid var(--line); border-radius: 9px; color: var(--text); padding: 8px 12px; font: inherit; font-size: 12px; outline: none; }
input[type=search]:focus { border-color: var(--accent); }
.tag { display: inline-block; padding: 1px 7px; border-radius: 999px; background: #1b2533; color: var(--muted); font-size: 10px; white-space: nowrap; }
ul.insights { margin: 0; padding-left: 18px; color: #c9d4e2; }
ul.insights li { margin: 4px 0; }
.dup-summary { color: #c9d4e2; margin: 0 0 8px; }
.dup-item { display: grid; grid-template-columns: 70px minmax(0, 1fr); gap: 4px 10px; padding: 8px 0; border-bottom: 1px solid #1c2635; }
.dup-item code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; color: #d5dfeb; overflow-wrap: anywhere; }
.dup-files { grid-column: 2; color: var(--muted); font-size: 11px; }
.empty { color: var(--muted); font-size: 12px; }
footer { color: var(--muted); font-size: 11px; padding: 0 clamp(18px, 4vw, 48px) 40px; max-width: 1100px; }
footer code { color: #c9d4e2; }
@media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
`;

const HTML_JS = `
(function () {
  'use strict';
  var data = JSON.parse(document.getElementById('report-data').textContent);
  var T = data.totals;
  var fmt = function (n) { return Number(n).toLocaleString('en-US'); };
  var pct = function (n) { return (Number(n) || 0).toFixed(1) + '%'; };
  var PALETTE = ['#58a6ff', '#3fb950', '#d29922', '#f778ba', '#a371f7', '#ff7b72', '#39c5cf', '#e3b341', '#7ee787', '#ffa657'];
  var colorOf = {};
  data.byArea.forEach(function (area, index) { colorOf[area.area] = PALETTE[index % PALETTE.length]; });
  function byId(id) { return document.getElementById(id); }
  function node(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
  }
  function renderBars(host, rows) {
    host.textContent = '';
    if (!rows.length) { host.appendChild(node('div', 'empty', '无数据')); return; }
    var max = 1;
    rows.forEach(function (row) { if (row.value > max) max = row.value; });
    rows.forEach(function (row) {
      var line = node('div', 'bar-row');
      if (row.title) line.title = row.title;
      var label = node('div', 'bar-label', row.label);
      label.title = row.title || row.label;
      var track = node('div', 'bar-track');
      var fill = node('div', 'bar-fill');
      fill.style.width = Math.max(0.6, (row.value / max) * 100) + '%';
      if (row.color) fill.style.background = row.color;
      track.appendChild(fill);
      line.appendChild(label);
      line.appendChild(track);
      line.appendChild(node('div', 'bar-value', row.display !== undefined ? row.display : fmt(row.value)));
      host.appendChild(line);
    });
  }
  function kpi(value, label, sub) {
    var card = node('div', 'kpi');
    card.appendChild(node('div', 'v', value));
    card.appendChild(node('div', 'l', label));
    if (sub) card.appendChild(node('div', 's', sub));
    byId('kpis').appendChild(card);
  }
  kpi(fmt(T.files), '扫描文件', data.scope.extensions.join(' · '));
  kpi(fmt(T.code), '代码行', '总行 ' + fmt(T.lines));
  kpi(fmt(T.functions), '函数', 'async ' + fmt(T.asyncFunctions) + ' · 类 ' + fmt(T.classes));
  kpi(T.avgFunctionLoc.toFixed(1), '函数均长', '最长 ' + fmt(T.maxFunctionLoc) + ' 行');
  kpi(pct(T.commentDensity), '注释密度', '注释 ' + fmt(T.comment) + ' 行');
  kpi(fmt(T.decisions), '分支点 (cx)', '每函数 ' + (T.functions ? (T.decisions / T.functions).toFixed(1) : '0'));
  kpi(pct(data.pareto.share), 'Top ' + data.pareto.files + ' 文件占比', pct(data.pareto.percent) + ' 的文件');
  kpi(pct(T.duplicatePercent), '跨文件重复行', fmt(T.duplicateLines) + ' 行');

  (function composition() {
    var host = byId('composition');
    var total = T.code + T.comment + T.blank || 1;
    var bar = node('div', 'composition');
    var parts = [['代码', T.code, '#58a6ff'], ['注释', T.comment, '#3fb950'], ['空行', T.blank, '#3d4b5f']];
    parts.forEach(function (part) {
      var seg = node('div', 'comp-seg');
      seg.style.width = (part[1] / total) * 100 + '%';
      seg.style.background = part[2];
      seg.title = part[0] + ' ' + fmt(part[1]) + ' (' + pct(part[1] / total * 100) + ')';
      bar.appendChild(seg);
    });
    host.appendChild(bar);
    var legend = node('div', 'legend');
    parts.forEach(function (part) {
      var item = node('span');
      var dot = node('i');
      dot.style.background = part[2];
      item.appendChild(dot);
      item.appendChild(document.createTextNode(part[0] + ' ' + fmt(part[1]) + ' · ' + pct(part[1] / total * 100)));
      legend.appendChild(item);
    });
    host.appendChild(legend);
  })();

  (function histogram() {
    var host = byId('histogram');
    var rows = data.distribution;
    var max = 1;
    rows.forEach(function (row) { if (row.files > max) max = row.files; });
    rows.forEach(function (row) {
      var col = node('div', 'hist-col');
      var bar = node('div', 'hist-bar');
      bar.style.height = Math.max(2, (row.files / max) * 100) + 'px';
      bar.title = row.label + ' 行代码 · ' + row.files + ' 文件';
      col.appendChild(node('div', 'hist-n', fmt(row.files)));
      col.appendChild(bar);
      col.appendChild(node('div', 'hist-l', row.label));
      host.appendChild(col);
    });
  })();

  renderBars(byId('top-files'), data.topFiles.slice(0, 15).map(function (file) {
    return {
      label: file.file,
      value: file.code,
      display: fmt(file.code),
      color: colorOf[file.area] || '#58a6ff',
      title: file.file + ' · ' + fmt(file.code) + ' 代码行 · ' + file.functionCount + ' 函数 · ' + file.decisions + ' 分支点'
    };
  }));

  renderBars(byId('areas'), data.byArea.map(function (area) {
    return {
      label: area.area,
      value: area.code,
      display: fmt(area.code) + ' · ' + pct(area.share),
      color: colorOf[area.area],
      title: area.area + ' · ' + area.files + ' 文件 · ' + fmt(area.code) + ' 代码行'
    };
  }));

  renderBars(byId('top-functions'), data.topFunctions.map(function (fn) {
    return {
      label: fn.name,
      value: fn.loc,
      display: fn.loc + ' 行',
      color: colorOf[fn.area] || '#58a6ff',
      title: fn.name + ' @ ' + fn.file + ':' + fn.line + ' · ' + fn.loc + ' 行 · ' + fn.decisions + ' 分支点'
    };
  }));

  renderBars(byId('fanin'), data.topFanIn.map(function (file) {
    return {
      label: file.file,
      value: file.fanIn,
      display: fmt(file.fanIn),
      color: colorOf[file.area] || '#58a6ff',
      title: file.file + ' 被 ' + file.fanIn + ' 个文件导入'
    };
  }));

  renderBars(byId('externals'), data.externalImports.map(function (entry) {
    return { label: entry.spec, value: entry.count, display: fmt(entry.count), color: '#a371f7', title: entry.spec + ' · ' + entry.count + ' 个文件引用' };
  }));

  (function scatter() {
    var host = byId('scatter');
    var NS = 'http://www.w3.org/2000/svg';
    var W = 680, H = 340, L = 56, R = 20, TP = 18, B = 44;
    var maxX = 1, maxY = 1;
    data.files.forEach(function (file) {
      if (file.code > maxX) maxX = file.code;
      if (file.functionCount > maxY) maxY = file.functionCount;
    });
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', '代码行与函数数量散点图');
    function svgNode(tag, attrs) {
      var el = document.createElementNS(NS, tag);
      Object.keys(attrs).forEach(function (key) { el.setAttribute(key, attrs[key]); });
      return el;
    }
    for (var i = 0; i <= 4; i += 1) {
      var y = H - B - (H - TP - B) * i / 4;
      svg.appendChild(svgNode('line', { x1: L, y1: y, x2: W - R, y2: y, stroke: '#1f2a3a', 'stroke-width': 1 }));
      var ty = svgNode('text', { x: L - 8, y: y + 4, 'text-anchor': 'end', fill: '#7d8b9e', 'font-size': 10 });
      ty.textContent = fmt(Math.round(maxY * i / 4));
      svg.appendChild(ty);
      var x = L + (W - L - R) * i / 4;
      svg.appendChild(svgNode('line', { x1: x, y1: TP, x2: x, y2: H - B, stroke: '#1a2331', 'stroke-width': 1 }));
      var tx = svgNode('text', { x: x, y: H - B + 18, 'text-anchor': 'middle', fill: '#7d8b9e', 'font-size': 10 });
      tx.textContent = fmt(Math.round(maxX * i / 4));
      svg.appendChild(tx);
    }
    data.files.forEach(function (file) {
      var dot = svgNode('circle', {
        cx: L + (file.code / maxX) * (W - L - R),
        cy: H - B - (file.functionCount / maxY) * (H - TP - B),
        r: 3 + Math.min(7, file.decisions / 30),
        fill: colorOf[file.area] || '#58a6ff',
        'fill-opacity': 0.6
      });
      var title = svgNode('title', {});
      title.textContent = file.file + '\\n' + fmt(file.code) + ' 代码行 · ' + file.functionCount + ' 函数 · ' + file.decisions + ' 分支点';
      dot.appendChild(title);
      svg.appendChild(dot);
    });
    var lx = svgNode('text', { x: (L + W - R) / 2, y: H - 6, 'text-anchor': 'middle', fill: '#8b98a9', 'font-size': 11 });
    lx.textContent = '代码行';
    svg.appendChild(lx);
    var cy = (TP + H - B) / 2;
    var ly = svgNode('text', { x: 14, y: cy, 'text-anchor': 'middle', fill: '#8b98a9', 'font-size': 11, transform: 'rotate(-90 14 ' + cy + ')' });
    ly.textContent = '函数数量';
    svg.appendChild(ly);
    host.appendChild(svg);
    var legend = node('div', 'legend');
    data.byArea.slice(0, 6).forEach(function (area) {
      var item = node('span');
      var dot = node('i');
      dot.style.background = colorOf[area.area];
      item.appendChild(dot);
      item.appendChild(document.createTextNode(area.area));
      legend.appendChild(item);
    });
    host.appendChild(legend);
  })();

  (function duplicates() {
    var host = byId('duplicates');
    var dup = data.duplication;
    host.appendChild(node('p', 'dup-summary', '跨文件完全相同的代码行：' + fmt(dup.lines) + ' 行，占代码行 ' + pct(dup.percent) + '（忽略缩进与空白，长度 ≥ 12，排除 import/export 清单）。'));
    if (!dup.clusters.length) { host.appendChild(node('p', 'empty', '没有发现跨文件重复行。')); return; }
    dup.clusters.forEach(function (cluster) {
      var item = node('div', 'dup-item');
      item.appendChild(node('span', 'tag', cluster.files.length + ' 文件'));
      item.appendChild(node('code', null, cluster.text));
      item.appendChild(node('div', 'dup-files', cluster.files.join('  ·  ')));
      host.appendChild(item);
    });
  })();

  var COLS = [
    { key: 'file', label: '文件' },
    { key: 'area', label: '区域' },
    { key: 'lines', label: '总行' },
    { key: 'code', label: '代码' },
    { key: 'comment', label: '注释' },
    { key: 'blank', label: '空行' },
    { key: 'functionCount', label: '函数' },
    { key: 'avgFunctionLoc', label: '均长' },
    { key: 'maxFunctionLoc', label: '最长' },
    { key: 'decisions', label: '分支' },
    { key: 'internalImports', label: '内导' },
    { key: 'externalImports', label: '外导' },
    { key: 'exports', label: '导出' },
    { key: 'fanIn', label: 'fanIn' },
    { key: 'duplicateLines', label: '重复' },
    { key: 'todos', label: 'TODO' },
    { key: 'maxLine', label: '最长行' }
  ];
  var thead = byId('thead');
  var tbody = byId('tbody');
  var filter = byId('filter');
  var count = byId('table-count');
  var sortKey = 'code';
  var sortDir = -1;
  function paintHeaders() {
    thead.textContent = '';
    COLS.forEach(function (col) {
      var th = node('th', null, col.label + (sortKey === col.key ? (sortDir < 0 ? ' ↓' : ' ↑') : ''));
      if (sortKey === col.key) th.className = 'sorted';
      th.title = '点击按 ' + col.label + ' 排序';
      th.addEventListener('click', function () {
        if (sortKey === col.key) sortDir = -sortDir;
        else {
          sortKey = col.key;
          sortDir = col.key === 'file' || col.key === 'area' ? 1 : -1;
        }
        paintHeaders();
        renderRows();
      });
      thead.appendChild(th);
    });
  }
  function cellValue(file, key) {
    if (key === 'avgFunctionLoc') return file.functionCount ? file.avgFunctionLoc.toFixed(1) : '-';
    return file[key];
  }
  function renderRows() {
    var query = filter.value.trim().toLowerCase();
    var rows = data.files.filter(function (file) { return file.file.toLowerCase().indexOf(query) >= 0; });
    rows.sort(function (a, b) {
      var x = a[sortKey], y = b[sortKey];
      if (typeof x === 'string' || typeof y === 'string') return sortDir * String(x).localeCompare(String(y));
      if (x === y) return 0;
      return sortDir * (x < y ? -1 : 1);
    });
    tbody.textContent = '';
    var fragment = document.createDocumentFragment();
    rows.forEach(function (file) {
      var tr = document.createElement('tr');
      COLS.forEach(function (col) {
        var td = document.createElement('td');
        if (col.key === 'file') {
          td.className = 'file';
          td.textContent = file.file;
          td.title = file.file;
        } else if (col.key === 'area') {
          td.textContent = file.area;
        } else if (col.key === 'avgFunctionLoc') {
          td.textContent = cellValue(file, col.key);
        } else {
          td.textContent = fmt(cellValue(file, col.key));
        }
        tr.appendChild(td);
      });
      fragment.appendChild(tr);
    });
    tbody.appendChild(fragment);
    count.textContent = '显示 ' + fmt(rows.length) + ' / ' + fmt(data.files.length) + ' 个文件';
  }
  filter.addEventListener('input', renderRows);
  paintHeaders();
  renderRows();

  (function facts() {
    var f = data.facts;
    var host = byId('facts');
    var items = [];
    if (f.largestFile) items.push('最大文件：' + f.largestFile.file + '（' + fmt(f.largestFile.code) + ' 行代码，' + f.largestFile.functions + ' 个函数）');
    if (f.largestFunction) items.push('最长函数：' + f.largestFunction.name + '（' + f.largestFunction.file + ':' + f.largestFunction.line + '，' + f.largestFunction.loc + ' 行）');
    items.push('代码集中度：Top ' + f.pareto.files + ' 文件（' + pct(f.pareto.percent) + '）占 ' + pct(f.pareto.share) + ' 的代码行');
    items.push('注释密度：' + pct(f.commentDensity) + '（注释 ' + fmt(f.commentLines) + ' 行 / 代码+注释 ' + fmt(f.codeLines + f.commentLines) + ' 行）');
    items.push('测试占比：test 目录 ' + fmt(f.testCode) + ' 行，占全部代码 ' + pct(f.testShare));
    items.push('无函数文件：' + fmt(f.functionlessFiles) + ' 个');
    if (f.mostImported) items.push('被引用最多：' + f.mostImported.file + '（' + f.mostImported.fanIn + ' 个文件导入）');
    items.push('跨文件重复行：' + fmt(f.duplication.lines) + ' 行，占 ' + pct(f.duplication.percent));
    items.push('函数密度：每 100 行代码 ' + f.functionsPer100.toFixed(2) + ' 个函数');
    items.forEach(function (text) { host.appendChild(node('li', null, text)); });
  })();
})();
`;

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function renderHtml(report) {
  const json = JSON.stringify(report).replace(/</g, '\\u003c');
  const title = escapeHtml('代码规模 · ' + report.project);
  const generated = escapeHtml(report.generatedAt);
  const extensions = escapeHtml(report.scope.extensions.join(' · '));
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${HTML_CSS}</style>
</head>
<body>
<header>
  <h1>${title}</h1>
  <div class="sub">生成于 ${generated} · ${report.totals.files} 个文件 · ${extensions}</div>
  <div class="badges">
    <span class="badge">只读分析</span>
    <span class="badge">${fmt(report.totals.code)} 行代码</span>
    <span class="badge">${fmt(report.totals.functions)} 个函数</span>
    <span class="badge">无阈值 · 无评分</span>
  </div>
</header>
<main>
  <section class="kpis" id="kpis"></section>
  <section class="grid">
    <div class="card"><h2>代码构成 <small>code / comment / blank</small></h2><div id="composition"></div></div>
    <div class="card"><h2>文件规模分布 <small>代码行 / 文件</small></h2><div id="histogram" class="hist"></div></div>
    <div class="card wide"><h2>最大的文件 <small>按代码行</small></h2><div id="top-files" class="bars"></div></div>
    <div class="card"><h2>按区域 <small>代码行</small></h2><div id="areas" class="bars"></div></div>
    <div class="card"><h2>规模 × 函数数量 <small>点大小 = 分支点</small></h2><div id="scatter"></div></div>
    <div class="card wide"><h2>最长的函数 <small>行数</small></h2><div id="top-functions" class="bars"></div></div>
    <div class="card"><h2>被引用最多 <small>fan-in</small></h2><div id="fanin" class="bars"></div></div>
    <div class="card"><h2>外部依赖 <small>import 次数</small></h2><div id="externals" class="bars"></div></div>
    <div class="card wide"><h2>跨文件重复行 <small>完全相同（忽略缩进/空格）且长度 ≥ 12</small></h2><div id="duplicates"></div></div>
  </section>
  <section class="card">
    <h2>全部文件 <small id="table-count"></small></h2>
    <input id="filter" type="search" placeholder="筛选路径…" autocomplete="off">
    <div class="table-wrap"><table><thead><tr id="thead"></tr></thead><tbody id="tbody"></tbody></table></div>
  </section>
  <section class="card"><h2>观察 <small>自动生成的事实，不含评价</small></h2><ul class="insights" id="facts"></ul></section>
</main>
<footer>
  <p>指标口径：代码行 = 注释外的非空行；注释 = 纯注释行；函数 = 块体函数 / 方法 / 具名箭头函数 / 带块体的匿名回调；分支点 = if / for / while / case / catch / &amp;&amp; / || / ?? / 三元；fan-in = 导入该文件的文件数；重复行 = 跨文件完全相同的代码行（忽略缩进与空白）。</p>
  <p>只读工具：本报告由 <code>node scripts/code-metrics.mjs --html</code> 生成，不修改任何源码，也不做阈值判定。启发式扫描，非 AST 解析。</p>
</footer>
<script type="application/json" id="report-data">${json}</script>
<script>${HTML_JS}</script>
</body>
</html>`;
}

// -------------------------------------------------------------------- main

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const extensions = new Set(opts.ext);
  const found = walk(root, extensions, []).sort();
  const generatedExcluded = [];
  const clientSrcExists = fs.existsSync(path.join(root, 'src/client/index.ts'));
  const files = found.filter((absolute) => {
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (!opts.areas.length) return true;
    return opts.areas.some((area) => relative === area || relative.startsWith(area + '/'));
  }).filter((absolute) => {
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (relative === 'lib/client.js' && clientSrcExists && !opts.includeGenerated) {
      generatedExcluded.push(relative);
      return false;
    }
    return true;
  });

  const analyses = files.map((absolute) => analyzeFile(absolute, path.relative(root, absolute).split(path.sep).join('/')));
  const report = buildReport(analyses, opts, { generatedExcluded });

  if (opts.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else if (opts.format === 'md') {
    console.log(renderMarkdown(report, opts));
  } else if (opts.format === 'csv') {
    console.log(renderCsv(report));
  } else if (opts.format === 'html') {
    let target = opts.htmlPath;
    if (/[\\/]$/.test(target)) target += 'code-metrics.html';
    const absolute = path.resolve(root, target);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, renderHtml(report), 'utf8');
    console.log(absolute);
  } else {
    console.log(renderConsole(report, opts));
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();

export { analyzeFile, buildReport, detectFunctions, parseArgs, scanSource };
