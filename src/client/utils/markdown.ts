// Markdown block/inline parser; pure; rendering lives in components.
export interface InlineRun { type: string; text: string; href?: string }
// The parser emits only these block fields; optional fields belong to the named block kind.
export type MarkdownBlock =
  | { type: 'code'; text: string; lang: string; info: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'quote' | 'paragraph'; text: string }
  | { type: 'hr' }
  | { type: 'image'; alt: string; src: string }
  | { type: 'table'; align: string[]; header: string[]; rows: string[][] }
  | { type: 'list'; ordered: boolean; start: number; items: string[] };
export interface DocDraft { docId?: string | null; title?: string; kind?: string; body?: string }
interface ReadBlock { next: number; block: MarkdownBlock }

export function inlineRuns(text: unknown): InlineRun[] {
  const source = String(text == null ? '' : text);
  const pattern = /(\*\*[^*]+\*\*|\x60[^\x60]+\x60|\[[^\]]+\]\([^)]+\)|\*[^*]+\*)/g;
  const runs: InlineRun[] = [];
  let lastIndex = 0;
  let match;
  while ((match = pattern.exec(source))) {
    if (match.index > lastIndex) runs.push({ type: 'text', text: source.slice(lastIndex, match.index) });
    const token = match[0];
    if (token.indexOf('**') === 0) {
      runs.push({ type: 'strong', text: token.slice(2, -2) });
    } else if (token.charAt(0) === '\x60') {
      runs.push({ type: 'code', text: token.slice(1, -1) });
    } else if (token.charAt(0) === '[') {
      const close = token.indexOf('](');
      runs.push({ type: 'link', text: token.slice(1, close), href: token.slice(close + 2, -1) });
    } else {
      runs.push({ type: 'em', text: token.slice(1, -1) });
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < source.length) runs.push({ type: 'text', text: source.slice(lastIndex) });
  return runs;
}

/** Pure: split a GFM table row on unescaped pipes; outer pipes optional. */
export function splitTableRow(line: unknown): string[] {
  let text = String(line == null ? '' : line).trim();
  if (text.charAt(0) === '|') text = text.slice(1);
  if (text.charAt(text.length - 1) === '|') text = text.slice(0, -1);
  const cells = [];
  let cell = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === '\\' && text.charAt(i + 1) === '|') { cell += '|'; i += 1; continue; }
    if (ch === '|') { cells.push(cell.trim()); cell = ''; continue; }
    cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

/** Pure: alignment cells of a GFM table delimiter row, or null. */
export function tableAlign(line: unknown): string[] | null {
  const cells = splitTableRow(line);
  const align = [];
  for (let i = 0; i < cells.length; i += 1) {
    const raw = cells[i].replace(/\s+/g, '');
    if (!/^:?-+:?$/.test(raw)) return null;
    const left = raw.charAt(0) === ':';
    const right = raw.charAt(raw.length - 1) === ':';
    align.push(left && right ? 'center' : (right ? 'right' : 'left'));
  }
  return align;
}

export function isTableStart(lines: string[], index: number): boolean {
  if (index + 1 >= lines.length) return false;
  if (String(lines[index]).indexOf('|') < 0) return false;
  const align = tableAlign(lines[index + 1]);
  if (!align) return false;
  // GFM: the header row must have the same number of cells as the delimiter.
  return splitTableRow(String(lines[index])).length === align.length;
}

/** Pure: only http(s)/mailto links are clickable; the rest stay inert. */
export function linkTarget(href: unknown): { href: string; external: boolean } | null {
  const raw = String(href == null ? '' : href).trim();
  if (/^https?:\/\//i.test(raw)) return { href: raw, external: true };
  if (/^mailto:/i.test(raw)) return { href: raw, external: false };
  return null;
}

export function alignCell(align: string): { textAlign: string } | undefined {
  return align ? { textAlign: align } : undefined;
}

function readFenceBlock(lines: string[], index: number): ReadBlock {
  const fence = lines[index].match(/^\s{0,3}\x60{3,}\s*(.*)$/);
  // Called only after markdownBlocks has recognized an opening fence.
  const info = fence![1].trim();
  const code = [];
  index += 1;
  while (index < lines.length && !/^\s{0,3}\x60{3,}\s*$/.test(lines[index])) {
    code.push(lines[index]);
    index += 1;
  }
  return {
    next: index + 1,
    block: {
      type: 'code',
      lang: info === '' ? '' : info.split(/\s+/)[0],
      info,
      text: code.join('\n'),
    },
  };
}

function readTableBlock(lines: string[], index: number): ReadBlock {
  // isTableStart validated this delimiter before calling the reader.
  const align = tableAlign(lines[index + 1])!;
  let header = splitTableRow(lines[index]);
  let rows = [];
  index += 2;
  while (index < lines.length && !/^\s*$/.test(lines[index]) && String(lines[index]).indexOf('|') >= 0) {
    rows.push(splitTableRow(lines[index]));
    index += 1;
  }
  const width = align.length;
  while (header.length < width) header.push('');
  header = header.slice(0, width);
  rows = rows.map(function (row) {
    const cells = row.slice(0, width);
    while (cells.length < width) cells.push('');
    return cells;
  });
  return { next: index, block: { type: 'table', align, header, rows } };
}

function readListBlock(lines: string[], index: number): ReadBlock {
  const numbered = lines[index].match(/^\s{0,6}(\d+)[.)]\s+(.*)$/);
  const ordered = Boolean(numbered);
  const start = numbered ? Number(numbered[1]) : 1;
  const items = [];
  while (index < lines.length) {
    const nextBullet = lines[index].match(/^\s{0,6}([-*+])\s+(.*)$/);
    const nextNumbered = lines[index].match(/^\s{0,6}(\d+)[.)]\s+(.*)$/);
    if (ordered && nextNumbered) {
      items.push(nextNumbered[2]);
      index += 1;
    } else if (!ordered && nextBullet) {
      items.push(nextBullet[2]);
      index += 1;
    } else {
      break;
    }
  }
  return { next: index, block: { type: 'list', ordered, start, items } };
}

/**
 * Pure: a deliberately small block-level markdown parser. No raw HTML is
 * ever interpreted; the renderer maps these blocks to React elements.
 */
export function markdownBlocks(body: unknown): MarkdownBlock[] {
  const lines = String(body == null ? '' : body).replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (/^\s*$/.test(line)) { index += 1; continue; }
    // Fenced blocks accept an arbitrary info string (```chart type=bar …):
    // the chart/flow DSLs need attributes, and a fence line that no branch
    // above claims must never reach the paragraph branch (it would spin).
    if (/^\s{0,3}\x60{3,}/.test(line)) {
      const fenced = readFenceBlock(lines, index);
      blocks.push(fenced.block);
      index = fenced.next;
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,4})\s+(.*)$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
      index += 1;
      continue;
    }
    if (/^\s{0,3}>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s{0,3}>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s{0,3}>\s?/, ''));
        index += 1;
      }
      blocks.push({ type: 'quote', text: quote.join('\n') });
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: 'hr' });
      index += 1;
      continue;
    }
    if (isTableStart(lines, index)) {
      const table = readTableBlock(lines, index);
      blocks.push(table.block);
      index = table.next;
      continue;
    }
    const bullet = line.match(/^\s{0,6}([-*+])\s+(.*)$/);
    const numbered = line.match(/^\s{0,6}(\d+)[.)]\s+(.*)$/);
    if (bullet || numbered) {
      const list = readListBlock(lines, index);
      blocks.push(list.block);
      index = list.next;
      continue;
    }
    const image = line.match(/^\s{0,3}!\[([^\]]*)\]\(([^)\s]+)\)\s*$/);
    if (image) {
      blocks.push({ type: 'image', alt: image[1], src: image[2] });
      index += 1;
      continue;
    }
    const paragraph = [];
    while (index < lines.length && !/^\s*$/.test(lines[index])
      && !/^\s{0,3}#{1,4}\s+/.test(lines[index])
      && !/^\s{0,3}\x60{3,}/.test(lines[index])
      && !/^\s{0,3}>\s?/.test(lines[index])
      && !/^\s{0,6}([-*+])\s+/.test(lines[index])
      && !/^\s{0,6}\d+[.)]\s+/.test(lines[index])
      && !/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(lines[index])
      && !/^\s{0,3}!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.test(lines[index])
      && !isTableStart(lines, index)) {
      paragraph.push(lines[index]);
      index += 1;
    }
    // Safety net: a line that every branch above declined must still be
    // consumed once, or the outer while-loop never advances (page freeze).
    if (paragraph.length === 0) {
      paragraph.push(line);
      index += 1;
    }
    blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
  }
  return blocks;
}

/** A draft is dirty when its identity, title, kind or body differs from the saved copy. */
export function docDirty(saved: DocDraft, draft: DocDraft, currentId: string | null): boolean {
  const savedCopy = saved || {};
  const next = draft || {};
  const savedId = savedCopy.docId ? savedCopy.docId : null;
  if ((currentId || null) !== savedId) return true;
  return String(next.title || '') !== String(savedCopy.title || '')
    || String(next.kind || 'note') !== String(savedCopy.kind || 'note')
    || String(next.body || '') !== String(savedCopy.body || '');
}

/** Heading outline for a document (and for the TOC buttons). */
export function docHeadings(blocks: MarkdownBlock[]): { index: number; level: number; text: string }[] {
  const out: { index: number; level: number; text: string }[] = [];
  (blocks || []).forEach(function (block, index) {
    if (block && block.type === 'heading') out.push({ index, level: block.level, text: block.text });
  });
  return out;
}

/** Case-insensitive AND match over body text; returns a snippet around the first hit. */
export function matchDocText(text: unknown, query: unknown): { hit: boolean; snippet: string } {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(function (term) { return term !== ''; });
  const body = String(text == null ? '' : text);
  if (!terms.length) return { hit: true, snippet: '' };
  const lower = body.toLowerCase();
  let first = -1;
  for (let i = 0; i < terms.length; i += 1) {
    const at = lower.indexOf(terms[i]);
    if (at < 0) return { hit: false, snippet: '' };
    if (first < 0 || at < first) first = at;
  }
  const start = Math.max(0, first - 24);
  const end = Math.min(body.length, start + 96);
  const snippet = body.slice(start, end).replace(/\s+/g, ' ').trim();
  return { hit: true, snippet: (start > 0 ? '…' : '') + snippet + (end < body.length ? '…' : '') };
}
