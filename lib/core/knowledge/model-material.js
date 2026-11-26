// Worker-local, ephemeral source text for an opting-in model presentation.
import { modelRecordFields, RESTRICTION_CUE } from './records.js';

const MAX_ROWS = 24;
const MAX_CHARS = 32 * 1024;
const prefix = (text, chars) => [...text.slice(0, chars * 2)].slice(0, chars).join('');
const size = text => [...text].length;

function utf8Prefix(text, maxBytes) {
  let end = 0, left = maxBytes;
  for (const char of text) {
    left -= Buffer.byteLength(char);
    if (left < 0) break;
    end += char.length;
  }
  return text.slice(0, end);
}

// Keep whole paragraphs or lines where possible. Only clip within one when
// that passage alone is too long. Never insert ellipses into an original span.
function passage(text, at, limit) {
  const paragraph = text.lastIndexOf('\n\n', at - 1);
  const windowsStart = [paragraph < 0 ? 0 : paragraph + 2, text.lastIndexOf('\n', at - 1) + 1];
  for (const start of windowsStart) {
    const sample = prefix(text.slice(start), limit);
    if (start + sample.length <= at) continue;
    const end = sample.lastIndexOf('\n\n');
    if (end > at - start) return sample.slice(0, end);
    const lastLine = sample.lastIndexOf('\n');
    if (lastLine > at - start && sample.length + start < text.length) return sample.slice(0, lastLine);
    return sample;
  }
  let start = Math.max(0, at - Math.floor(limit / 4));
  if (/^[\uDC00-\uDFFF]/u.test(text[start] ?? '')) start--;
  return prefix(text.slice(start), limit);
}

function keywordOffset(text, needles) {
  if (!needles.length) return -1;
  const lower = text.toLowerCase();
  for (const word of needles) {
    // Use the original UTF-16 offset even when case folding expands a character.
    const at = lower.indexOf(word);
    if (at >= 0) return lower.length === text.length ? at : (text.match(new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu'))?.index ?? -1);
  }
  return -1;
}

function excerpt(text, needles, limit, recordFields) {
  if (text.length <= limit || (text.length <= limit * 2 && size(text) <= limit)) return text;
  const at = keywordOffset(text, needles);
  const first = passage(text, Math.max(0, at), limit);
  const caution = text.match(RESTRICTION_CUE);
  if (!caution || first.includes(caution[0]) || limit < 64) return first;
  if (!recordFields) {
    // For a document return one contiguous authorized span, never an amalgam
    // that looks like a verbatim passage. Favor a nearby qualification too.
    const qualified = passage(text, at < 0 ? caution.index : Math.min(at, caution.index), limit);
    return qualified.includes(caution[0]) && (at < 0 || keywordOffset(qualified, needles) >= 0) ? qualified : first;
  }
  // Public record fields are already discrete excerpts, not one authored body.
  const match = passage(text, Math.max(0, at), Math.floor(limit * 0.7));
  const rest = passage(text, caution.index, limit - size(match) - 2);
  return rest.trim() && !match.includes(rest) ? match + '\n\n' + rest : first;
}

export function createModelMaterial() {
  const direct = new Map(), related = new Map(), protectedRefs = new Set();
  return {
    protect(ref) { if (ref) protectedRefs.add(ref); },
    add(source, { target = false, needles = [], page, maxBytes } = {}) {
      const { ref, availability, provenance, kind, sourcePart } = source;
      const rows = target ? related : direct;
      // kb1 body metadata may carry the legacy flag because String.prototype.fixed
      // is truthy. Distinguish actual Git bodies by their part (and availability).
      if (!ref || (target && (protectedRefs.has(ref) || protectedRefs.has(source.sourceRef)))
        || rows.size >= MAX_ROWS || rows.has(ref)) return;
      if (sourcePart === 'fixed' || (kind !== 'content' && provenance === 'legacy-git')) {
        rows.set(ref, { text: '', archive: true });
        return;
      }
      if (availability !== 'available') return;
      const rawPage = page && kind === 'content';
      // Do not reinterpret a partial JSON record or fetch fields outside its page.
      if (page && !rawPage && (page.range.offset !== 0 || page.range.truncated)) return;
      let text = rawPage ? page.content : kind === 'content' ? source.text
        : [...new Set(modelRecordFields(source).filter(field => typeof field === 'string' && field.trim()))].join('\n\n');
      if (typeof text !== 'string' || !text.trim()) return;
      const original = text;
      if (maxBytes !== undefined) text = utf8Prefix(text, maxBytes);
      const recordFields = kind !== 'content' && !rawPage;
      const cut = rawPage ? prefix(text, MAX_CHARS) : excerpt(text, needles, MAX_CHARS, recordFields);
      if (cut.trim()) rows.set(ref, { text: cut, needles, rawPage, recordFields, partial: cut !== original || !!page?.range.truncated });
    },
    finish() {
      const selected = [...direct, ...[...related].filter(([ref]) => !direct.has(ref))].slice(0, MAX_ROWS);
      const lengths = selected.map(([, row]) => size(row.text)).sort((a, b) => a - b);
      // Share the whole budget among actual rows; short sources yield their
      // unused share to longer ones instead of imposing a fixed snippet size.
      let available = MAX_CHARS, share = available;
      for (const [index, length] of lengths.entries()) {
        share = Math.floor(available / (lengths.length - index));
        if (length >= share) break;
        available -= length;
      }
      return selected.map(([ref, row]) => {
        if (row.archive) return { ref, text: '', archive: true };
        const text = row.rawPage ? prefix(row.text, share) : excerpt(row.text, row.needles, share, row.recordFields);
        return { ref, text, partial: row.partial || text !== row.text };
      });
    },
  };
}
