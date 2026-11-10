/**
 * Exporting a project doc as a plain .md file.
 *
 * The browser gets exactly what the editor holds — no re-serialisation — so the
 * downloaded text is byte-identical to the document body.
 */

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Pure: a filesystem-safe file name (Windows rules) for a document title. */
export function safeFileName(title: unknown, fallback?: unknown): string {
  let base = String(title == null ? '' : title)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .slice(0, 80)
    .trim();
  if (base === '') {
    base = String(fallback == null ? '' : fallback)
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
      .trim()
      .slice(0, 80);
  }
  if (base === '') base = 'document';
  if (RESERVED.test(base)) base = '_' + base;
  return base + '.md';
}

/** Browser-only: hand the body to the download machinery. Returns false outside a DOM. */
export function downloadMarkdown(fileName: string, body: unknown): boolean {
  if (typeof document === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') return false;
  const blob = new Blob([String(body == null ? '' : body)], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  return true;
}
