/** Read-only repository documentation gate. No network, dependencies, or generated files. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Privacy applies to public product/governance docs, not synthetic test fixtures.
// All repository Markdown still participates in link checking.
const isPublicDocument = (file) => file.startsWith('docs/') || ['README.md', 'AGENTS.md'].includes(file);

/** Preserve line numbers while ignoring fenced examples for link/heading parsing. */
export function prose(text) {
  let fence = null;
  return text.split(/\r?\n/).map((line) => {
    const unquoted = line.replace(/^(?: {0,3}> ?)+/, '');
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(unquoted);
    if (match && !fence) { fence = match[1]; return ''; }
    if (fence) {
      if (new RegExp('^ {0,3}' + fence[0] + '{' + fence.length + ',}\\s*$').test(unquoted)) fence = null;
      return '';
    }
    return line;
  });
}

/** GitHub heading slug: punctuation disappears; existing/doubled hyphens survive. */
export function slug(text) {
  return text.replace(/(`+)([\s\S]*?)\1/g, (_, fence, code) => code.replace(/</g, '&lt;').replace(/>/g, '&gt;'))
    .replace(/<[^>]*>/g, '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .toLowerCase().replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, '').replace(/ /g, '-');
}

export function anchors(text) {
  const result = new Set();
  const used = new Set();
  const lines = prose(text);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const match of line.matchAll(/<(?:a|h[1-6])\b[^>]*\b(?:id|name)=["']([^"']+)["']/gi)) result.add(match[1]);
    const atx = /^ {0,3}#{1,6}\s+(.+?)(?:\s+#+\s*)?$/.exec(line);
    const setext = line.trim() && /^ {0,3}(?:=+|-+)\s*$/.test(lines[i + 1] || '');
    if (!atx && !setext) continue;
    const base = slug(atx ? atx[1] : line.trim());
    let id = base;
    let suffix = 0;
    while (used.has(id)) id = base + '-' + (++suffix);
    used.add(id);
    result.add(id);
  }
  return result;
}

function withoutCode(text) {
  // Mask, rather than remove, inline code so diagnostics retain source lines.
  return text.replace(/(`+)([\s\S]*?)\1(?!`)/g, (match) => match.replace(/[^\n]/g, ' '));
}

function destination(text, start) {
  let pos = start;
  while (/\s/.test(text[pos] || '') && pos < text.length) pos += 1;
  if (text[pos] === '<') {
    const end = text.indexOf('>', pos + 1);
    return end < 0 ? null : text.slice(pos + 1, end);
  }
  let url = '';
  let depth = 0;
  for (; pos < text.length; pos += 1) {
    const c = text[pos];
    if (c === '\\' && pos + 1 < text.length) { url += text[++pos]; continue; }
    if (c === ')' && depth === 0 || /\s/.test(c) && depth === 0) break;
    if (c === '(') depth += 1;
    if (c === ')') depth -= 1;
    url += c;
  }
  return url;
}

/** Inline/reference links and images (including multiline/nested labels), and HTML href/src. */
export function links(text) {
  const found = [];
  const lines = prose(text);
  const definitions = new Map();
  const normalize = (label) => label.trim().replace(/\s+/g, ' ').toLowerCase();
  for (let i = 0; i < lines.length; i += 1) {
    const def = /^ {0,3}\[([^\]]+)\]:\s*(.*)$/.exec(lines[i]);
    if (!def) continue;
    const raw = def[2] || (lines[i + 1] || '').trim();
    const url = destination(raw, 0);
    if (url === null) continue;
    definitions.set(normalize(def[1]), url);
    found.push({ url, line: i + 1 });
    lines[i] = '';
    if (!def[2]) lines[i + 1] = '';
  }
  const source = withoutCode(lines.join('\n'));
  const lineAt = (pos) => 1 + (source.slice(0, pos).match(/\n/g) || []).length;
  for (const match of source.matchAll(/\b(?:href|src)=["']([^"']+)["']/gi)) {
    found.push({ url: match[1], line: lineAt(match.index) });
  }
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] !== '[' || i && source[i - 1] === '\\') continue;
    let end = i + 1;
    let depth = 1;
    for (; end < source.length && depth; end += 1) {
      if (source[end] === '\\') { end += 1; continue; }
      if (source[end] === '[') depth += 1;
      if (source[end] === ']') depth -= 1;
    }
    if (depth) continue;
    const label = source.slice(i + 1, end - 1);
    if (source[end] === '(') {
      const url = destination(source, end + 1);
      if (url !== null) found.push({ url, line: lineAt(i) });
    } else {
      const reference = /^\[([^\]]*)\]/.exec(source.slice(end));
      const target = definitions.get(normalize(reference ? reference[1] || label : label));
      if (target !== undefined) found.push({ url: target, line: lineAt(i) });
    }
  }
  return found;
}
const leakPatterns = [
  // Legacy IDs were 16 hex; newId() is prefix + base36 timestamp + 12 hex (currently 20 body chars).
  ['real-id', /\b(?:prj_|tsk_)(?:[0-9a-z]{6,12}[0-9a-f]{12}|[0-9a-f]{16})\b/ig],
  ['session-id', /\bsession-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/ig],
  ['drive-path', /\b[A-Za-z]:[\\/][^\s"'`<>]*/g],
  ['home-path', /(?:\/home\/|\/Users\/)[^\s"'`<>]*/g],
  ['unc-path', /\\\\[A-Za-z0-9._-]+\\[^\s"'`<>]*/g],
  ['private-address', /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g],
];

export function leaks(text) {
  const found = [];
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    // Deliberate literal test/spec examples need a same-line, reasoned exemption.
    const exemption = /<!-- docs-check-allow: ([^>]+) -->/.exec(line);
    for (const [kind, regex] of leakPatterns) {
      for (const match of line.matchAll(regex)) {
        if (exemption && exemption[1].trim().length >= 12) continue;
        found.push({ line: i + 1, kind, value: match[0] });
      }
    }
  }
  return found;
}

/** Include untracked, nonignored candidates so the pre-commit gate checks new docs too. */
export function markdownFiles(root) {
  return [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\0'))]
    .filter((file) => /\.md$/i.test(file)).sort();
}

export function checkDocuments(root, files = markdownFiles(root)) {
  const errors = [];
  const counts = { markdown: files.length, links: 0, missing: 0, unreachable: 0, leaks: 0, archive: 0 };
  const texts = new Map();
  for (const file of files) {
    try { texts.set(file, fs.readFileSync(path.join(root, file), 'utf8')); } catch (error) {
      counts.missing += 1; errors.push(file + ': missing/unreadable Markdown: ' + error.code);
    }
  }
  const headings = new Map([...texts].map(([file, text]) => [file, anchors(text)]));
  const graph = new Map();
  for (const [file, text] of texts) {
    if (/^docs\/archive(?:\/|$)/i.test(file)) { counts.archive += 1; errors.push(file + ': archive file is tracked'); }
    graph.set(file, []);
    for (const leak of isPublicDocument(file) ? leaks(text) : []) {
      counts.leaks += 1;
      errors.push(`${file}:${leak.line}: leak ${leak.kind}: ${leak.value}`);
    }
    for (const link of links(text)) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(link.url)) continue;
      counts.links += 1;
      const hash = link.url.indexOf('#');
      const rawPath = (hash >= 0 ? link.url.slice(0, hash) : link.url).split('?')[0];
      const rawFragment = hash >= 0 ? link.url.slice(hash + 1) : '';
      const decode = (value) => { try { return decodeURIComponent(value); } catch { return value; } };
      const pathname = decode(rawPath);
      const fragment = decode(rawFragment);
      const target = pathname ? path.posix.normalize(path.posix.join(path.posix.dirname(file), pathname)) : file;
      const location = `${file}:${link.line}: ${link.url}`;
      if (/^docs\/archive(?:\/|$)/i.test(target)) {
        counts.archive += 1; errors.push(location + ' -> archive reference'); continue;
      }
      if (!fs.existsSync(path.join(root, target))) {
        counts.missing += 1; errors.push(location + ' -> missing path'); continue;
      }
      if (/\.md$/i.test(target)) {
        graph.get(file).push(target);
        if (!headings.has(target)) headings.set(target, anchors(fs.readFileSync(path.join(root, target), 'utf8')));
        if (fragment && !headings.get(target).has(fragment)) {
          counts.missing += 1; errors.push(location + ' -> missing anchor');
        }
      }
    }
  }
  const reached = new Set();
  const pending = ['docs/INDEX.md'];
  while (pending.length) {
    const file = pending.pop();
    if (reached.has(file)) continue;
    reached.add(file);
    pending.push(...(graph.get(file) || []));
  }
  for (const file of files) {
    if (file.startsWith('docs/') && !file.startsWith('docs/archive/') && !reached.has(file)) {
      counts.unreachable += 1; errors.push(file + ': unreachable from docs/INDEX.md');
    }
  }
  return { counts, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const { counts, errors } = checkDocuments(root);
    for (const error of errors) console.error(error);
    console.log('check-docs: ' + Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(' '));
    process.exitCode = errors.length ? 1 : 0;
  } catch (error) {
    console.error('check-docs: ' + error.message);
    process.exitCode = 1;
  }
}
