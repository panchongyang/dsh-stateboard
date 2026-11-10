#!/usr/bin/env node
/**
 * Machine check for the module map in docs/ARCHITECTURE.md.
 *
 * The map is the block between `<!-- arch-map:start -->` and
 * `<!-- arch-map:end -->`: one repository-relative path per line, starting
 * with `lib/` or `src/`. A single `*` inside a path segment matches any name
 * in that directory (`src/client/views/*.js`, `lib/host/routes/*.js`), which
 * keeps peer-file groups out of the document without letting entries rot.
 *
 * The checker is deliberately tiny and dependency-free: it runs in CI, in the
 * pre-commit habit, and from test/ops/architecture-map.test.mjs, which imports the
 * same functions instead of shelling out.
 *
 * Usage:
 *   node scripts/check-architecture.mjs
 *   node scripts/check-architecture.mjs --json
 *
 * Exit codes: 0 = every entry exists, 1 = missing entries or a malformed map.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ARCH_MAP_START = '<!-- arch-map:start -->';
export const ARCH_MAP_END = '<!-- arch-map:end -->';
export const DEFAULT_DOC = 'docs/ARCHITECTURE.md';
export const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Read the arch-map block. Returns the entries in document order.
 * Throws when the markers are missing or an entry is not a single lib/src path.
 */
export function parseArchMap(text) {
  const start = text.indexOf(ARCH_MAP_START);
  const end = text.indexOf(ARCH_MAP_END);
  if (start === -1 || end === -1) {
    throw new Error('arch-map markers not found (' + ARCH_MAP_START + ' / ' + ARCH_MAP_END + ')');
  }
  if (end < start) throw new Error('arch-map end marker comes before the start marker');

  const body = text.slice(start + ARCH_MAP_START.length, end);
  const entries = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/\s/.test(line)) {
      throw new Error('arch-map entry must be one path per line: "' + line + '"');
    }
    if (!/^(lib|src)\//.test(line)) {
      throw new Error('arch-map entry must start with lib/ or src/: "' + line + '"');
    }
    entries.push(line);
  }
  if (!entries.length) throw new Error('arch-map block is empty');
  return entries;
}

/** Compile one path segment; `*` matches any run of non-separator characters. */
function segmentRegExp(segment) {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/\\\\]*');
  return new RegExp('^' + escaped + '$');
}

function readDir(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Expand one arch-map entry against the repository root.
 * Returns absolute paths for every match; an empty array means "missing".
 */
export function expandEntry(entry, root = DEFAULT_ROOT) {
  const segments = entry.split('/').filter(Boolean);
  let candidates = [root];
  for (const segment of segments) {
    const next = [];
    if (segment.includes('*')) {
      const pattern = segmentRegExp(segment);
      for (const base of candidates) {
        for (const dirent of readDir(base)) {
          if (pattern.test(dirent.name)) next.push(path.join(base, dirent.name));
        }
      }
    } else {
      for (const base of candidates) {
        const absolute = path.join(base, segment);
        if (fs.existsSync(absolute)) next.push(absolute);
      }
    }
    candidates = next;
    if (!candidates.length) return [];
  }
  return candidates;
}

/**
 * Check every entry of the arch-map against disk.
 * Returns { doc, entries, resolved, missing } where resolved maps each entry
 * to its repository-relative matches and missing lists entries with no match.
 */
export function checkArchMap({ root = DEFAULT_ROOT, doc = DEFAULT_DOC } = {}) {
  const docPath = path.join(root, doc);
  if (!fs.existsSync(docPath)) throw new Error('architecture doc not found: ' + doc);
  const entries = parseArchMap(fs.readFileSync(docPath, 'utf8'));

  const resolved = {};
  const missing = [];
  for (const entry of entries) {
    const matches = expandEntry(entry, root).map((absolute) =>
      path.relative(root, absolute).split(path.sep).join('/'));
    if (!matches.length) missing.push(entry);
    else resolved[entry] = matches;
  }
  return { doc, entries, resolved, missing };
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  const invoked = path.resolve(process.argv[1]);
  const self = fileURLToPath(import.meta.url);
  return process.platform === 'win32'
    ? invoked.toLowerCase() === self.toLowerCase()
    : invoked === self;
}

if (isEntryPoint()) {
  const asJson = process.argv.includes('--json');
  try {
    const result = checkArchMap();
    const expanded = Object.values(result.resolved).reduce((sum, matches) => sum + matches.length, 0);
    if (asJson) {
      console.log(JSON.stringify({
        ok: result.missing.length === 0,
        doc: result.doc,
        entries: result.entries.length,
        expanded,
        missing: result.missing,
      }, null, 2));
    } else if (result.missing.length) {
      console.error('[arch-map] ' + result.doc + ': ' + result.missing.length + ' entr(y/ies) missing on disk:');
      for (const entry of result.missing) console.error('  - ' + entry);
      console.error('[arch-map] fix the doc (or restore the file) — the module map is a contract.');
    } else {
      console.log('[arch-map] ' + result.doc + ': ' + result.entries.length + ' entries / '
        + expanded + ' paths resolved, 0 missing');
    }
    process.exit(result.missing.length ? 1 : 0);
  } catch (error) {
    console.error('[arch-map] ' + error.message);
    process.exit(1);
  }
}
