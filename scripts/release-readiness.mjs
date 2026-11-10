// Pure, I/O-free release-readiness evaluation for a packed npm tarball.
// scripts/check-release-purity.mjs remains the only CLI/entry: it lists and
// reads the archive, then calls evaluateReadiness() here. Keeping this module
// pure makes the checks cheap to test with synthetic entries and text.

import path from 'node:path';

export const SCHEMA_VERSION = 1;

const LICENSE_ENTRY = /^package\/(?:LICENSE(?:\.[^/]+)?|COPYING)$/i;
const DEVELOPER_ENTRY = /^package\/(?:scripts|tests?|evidence|\.evidence|bin)(?:\/|$)/;
const LICENSE_PLACEHOLDER = /^(?:TODO|TBD|FIXME|UNLICENSED|SEE LICENSE.*)$/i;
const INTEGER_KEY = /^(?:0|[1-9][0-9]*)$/;
const NODE_IMPORT_CONDITIONS = ['node', 'import', 'default'];

export function findLicenseEntries(entries) {
  return entries.filter((entry) => LICENSE_ENTRY.test(entry));
}

export const LINK_CAPABILITY = {
  parser: 'markdown-inline-subset',
  supported: [
    'inline links and images',
    'angle-bracket and bare destinations, including one level of balanced parentheses',
    'fenced code blocks and single-backtick spans excluded',
    'single-line reference definitions and full/collapsed/shortcut reference links',
    'CommonMark label whitespace folding and first-definition-wins',
    'relative . / .. normalization and ?query/#fragment stripping',
  ],
  notSupported: [
    'raw HTML <a>/<img> links',
    'nested link-in-image or image-in-link targets',
    'multi-line reference definitions (reported as unsupported)',
    'full CommonMark (multi-backtick spans, escaped brackets, etc.)',
    'heading/fragment target validation',
    'network reachability of external links',
    'legal or full SPDX license auditing',
  ],
  onUnsupported: 'reported as a blocking check, never silently skipped',
};

// ------------------------------------------------------------- link parsing

export function maskMarkdownCode(text) {
  const fenced = String(text).replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm,
    (block) => block.replace(/[^\n]/g, ' '));
  return fenced.replace(/`[^`\n]*`/g, (span) => span.replace(/[^\n]/g, ' '));
}

function stripAngle(destination) {
  return destination.startsWith('<') && destination.endsWith('>') ? destination.slice(1, -1) : destination;
}

function normalizeLabel(label) {
  return String(label).trim().replace(/\s+/g, ' ').toLowerCase();
}

export function collectReferenceDefinitions(masked) {
  const defs = new Map();
  const re = /^ {0,3}\[([^\]\n]+)\]:[ \t]*(<[^>\n]*>|[^\s]+)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*$/gm;
  const out = masked.replace(re, (line, label, destination) => {
    const key = normalizeLabel(label);
    if (!defs.has(key)) defs.set(key, stripAngle(destination));
    return line.replace(/[^\n]/g, ' ');
  });
  return { defs, masked: out };
}

const INLINE_LINK = /(!?)\[([^\]\n]*)\]\(\s*(<[^>\n]*>|(?:[^()\s]|\([^()\n]*\))+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)/g;

function lineAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

function inlineOccurrences(masked) {
  const out = [];
  for (const match of masked.matchAll(INLINE_LINK)) {
    const destination = stripAngle(match[3]);
    out.push({
      index: match.index, line: lineAt(masked, match.index), image: match[1] === '!',
      text: match[2], raw: match[0], destination, angle: match[3].startsWith('<'), via: 'inline',
    });
  }
  return out;
}

function referenceOccurrences(masked, defs) {
  const out = [];
  const re = /(!?)\[([^\]\n]*)\]\[([^\]\n]*)\]|(!?)\[([^\]\n]*)\](?!\()/g;
  for (const match of masked.matchAll(re)) {
    const image = (match[1] ?? match[4]) === '!';
    const text = match[2] ?? match[5];
    const via = match[3] === undefined ? 'shortcut' : 'reference';
    const label = normalizeLabel(via === 'reference' && match[3] ? match[3] : text);
    if (!defs.has(label)) continue;
    out.push({
      index: match.index, line: lineAt(masked, match.index), image, text, raw: match[0],
      destination: defs.get(label), angle: false, via,
    });
  }
  return out;
}

function detectUnsupported(masked, occurrences) {
  const problems = [];
  const markup = masked.match(/<[^>]*(?:href|src)\s*=[^>]*>/gi) || [];
  if (markup.length) problems.push({ kind: 'raw-html-link', count: markup.length, sample: markup[0].slice(0, 120) });
  const multiline = masked.match(/^ {0,3}\[[^\]\n]+\]:[ \t]*$/gm) || [];
  if (multiline.length) problems.push({ kind: 'multiline-reference-definition', count: multiline.length, sample: multiline[0].trim() });
  const closers = (masked.match(/\]\(/g) || []).length;
  const inline = occurrences.filter((item) => item.via === 'inline').length;
  if (closers > inline) {
    problems.push({ kind: 'unparsed-inline-link', count: closers - inline, sample: 'nested or non-inline destination syntax' });
  }
  return problems;
}

export function parseReadmeLinks(text) {
  const masked = maskMarkdownCode(String(text));
  const { defs, masked: withoutDefinitions } = collectReferenceDefinitions(masked);
  const occurrences = [...inlineOccurrences(withoutDefinitions), ...referenceOccurrences(withoutDefinitions, defs)];
  occurrences.sort((a, b) => a.index - b.index);
  return { occurrences, unsupported: detectUnsupported(withoutDefinitions, occurrences), capability: LINK_CAPABILITY };
}

// ---------------------------------------------------------- link resolution

function normalizeTarget(destination) {
  const raw = destination.replace(/[?#].*$/, '');
  if (!raw) return { target: '', reason: 'empty' };
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return { target: raw, reason: 'invalid-escape' };
  }
  if (decoded.includes('\\')) return { target: decoded, reason: 'backslash-path' };
  if (decoded.startsWith('/')) return { target: decoded, reason: 'absolute-path' };
  const parts = [];
  for (const part of decoded.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return { target: decoded, reason: 'path-escape' };
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return { target: parts.join('/'), reason: null };
}

function targetExists(entries, target) {
  if (!target) return true;
  const prefix = 'package/' + target;
  return entries.some((entry) => entry === prefix || entry.startsWith(prefix + '/'));
}

function classifyOccurrence(item, entries) {
  const destination = item.destination;
  if (/^[a-z][a-z0-9+.-]*:/i.test(destination) || destination.startsWith('//')) {
    return { ...item, category: 'external', relative: false, target: null, exists: null, reason: null };
  }
  if (destination.startsWith('#')) {
    return { ...item, category: 'anchor', relative: false, target: null, exists: null, reason: null };
  }
  const { target, reason } = normalizeTarget(destination);
  if (reason === 'empty') {
    return { ...item, category: 'other', relative: false, target, exists: null, reason: null };
  }
  return { ...item, category: 'relative', relative: true, target, exists: reason ? false : targetExists(entries, target), reason };
}

function summarize(occurrences) {
  const relative = occurrences.filter((item) => item.relative);
  const missing = relative.filter((item) => item.exists === false);
  const unique = (items) => [...new Set(items.map((item) => item.target))].sort();
  return {
    occurrencesTotal: occurrences.length,
    relativeOccurrences: relative.length,
    relativeMissing: missing.length,
    relativeUniqueTargets: unique(relative).length,
    relativeUniqueMissing: unique(missing).length,
    rawUniqueDestinations: new Set(relative.map((item) => item.destination)).size,
    rawUniqueMissingDestinations: new Set(missing.map((item) => item.destination)).size,
    angleOccurrences: relative.filter((item) => item.angle).length,
    angleMissing: relative.filter((item) => item.angle && item.exists === false).length,
    plainOccurrences: relative.filter((item) => !item.angle).length,
    plainMissing: relative.filter((item) => !item.angle && item.exists === false).length,
    externalOrAnchorOccurrences: occurrences.length - relative.length,
    uniqueMissingTargets: unique(missing),
  };
}

export function resolveReadmeLinks(text, entries) {
  const parsed = parseReadmeLinks(text);
  const occurrences = parsed.occurrences.map((item) => classifyOccurrence(item, entries));
  return { ...parsed, occurrences, summary: summarize(occurrences) };
}

// ------------------------------------------------------------- metadata bits

function validName(value) {
  return typeof value === 'string' && value.length <= 214 && /^[a-z0-9][a-z0-9._~-]*$/.test(value);
}

function validVersion(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

function validLicense(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validRepository(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  return !!value && typeof value === 'object' && typeof value.url === 'string' && value.url.trim().length > 0;
}

function validHomepage(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function validAuthor(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  return !!value && typeof value === 'object' && typeof value.name === 'string' && value.name.trim().length > 0;
}

function packageEntryForTarget(target) {
  if (typeof target !== 'string') return null;
  const normalized = target.startsWith('./') ? target.slice(2) : target;
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some((part) => part === '..' || part === '.')) return null;
  return 'package/' + normalized;
}

function packageTargetExists(entries, target) {
  const entry = packageEntryForTarget(target);
  return !!entry && entries.includes(entry);
}

function resolveLinkTarget(entry, link) {
  if (!link || link.startsWith('/') || /^[a-z]:[\\/]/i.test(link)) return null;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entry), link));
  if (!resolved.startsWith('package/') || resolved.split('/').includes('..')) return null;
  return resolved;
}

function entryStatus(entries, entryTypes, entry, depth = 0) {
  if (!entryTypes) return { ok: true };
  const info = entryTypes[entry];
  if (!info) return { ok: false, reason: 'no tar entry metadata' };
  if (info.type === 'file') return { ok: true };
  if (info.type === 'symlink' && depth < 6) {
    const target = resolveLinkTarget(entry, info.linkTarget);
    if (!target) return { ok: false, reason: 'unsafe symlink target' };
    return entryStatus(entries, entryTypes, target, depth + 1);
  }
  return { ok: false, reason: info.type === 'symlink' ? 'symlink depth exceeded' : 'not a regular file (' + info.type + ')' };
}

function collectExportLeaves(value, label, out) {
  if (typeof value === 'string') {
    out.push({ label, target: value });
    return;
  }
  if (value === null) {
    out.push({ label, blocked: true });
    return;
  }
  if (Array.isArray(value)) {
    if (!value.length) out.push({ label, invalid: 'empty array' });
    else value.forEach((item, index) => collectExportLeaves(item, label + '[' + index + ']', out));
    return;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) {
      out.push({ label, invalid: 'empty object' });
      return;
    }
    if (keys.some((key) => INTEGER_KEY.test(key))) {
      out.push({ label, invalid: 'integer condition key' });
      return;
    }
    if (keys.some((key) => key.startsWith('.'))) {
      out.push({ label, invalid: 'nested subpath key' });
      return;
    }
    for (const key of keys) collectExportLeaves(value[key], label + '.' + key, out);
    return;
  }
  out.push({ label, invalid: 'invalid target type ' + (value === undefined ? 'undefined' : typeof value) });
}

// Conservative Node-import condition resolver: only node/import/default in
// object order, null blocks, arrays fall back. Anything else is rejected
// rather than guessed. It deliberately does not implement the full resolver.
function resolveConditional(value, label) {
  if (typeof value === 'string') return { target: value, label };
  if (value === null) return { blocked: true, label };
  if (Array.isArray(value)) {
    if (!value.length) return { invalid: 'empty array', label };
    let blocked = null;
    for (let index = 0; index < value.length; index++) {
      const result = resolveConditional(value[index], label + '[' + index + ']');
      if (result.target !== undefined) return result;
      if (result.invalid) return result;
      if (result.blocked) blocked = result;
    }
    return blocked || { unmatched: true, label };
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) return { invalid: 'empty condition object', label };
    if (keys.some((key) => INTEGER_KEY.test(key))) return { invalid: 'integer condition key', label };
    if (keys.some((key) => key.startsWith('.'))) return { invalid: 'nested subpath key', label };
    // Only node/import/default are in this stage's declared subset. Reject any
    // other condition key before choosing a branch, even when default would hit
    // first or later; guessing Node's extended condition set is out of scope.
    const unsupported = keys.find((key) => !NODE_IMPORT_CONDITIONS.includes(key));
    if (unsupported !== undefined) return { invalid: 'unsupported condition key: ' + unsupported, label };
    return resolveConditional(value[keys[0]], label + '.' + keys[0]);
  }
  return { invalid: 'invalid target type ' + (value === undefined ? 'undefined' : typeof value), label };
}

function analyzeExports(exportsField) {
  if (exportsField === undefined) return { error: 'package.json exports is missing' };
  if (typeof exportsField === 'string' || exportsField === null || Array.isArray(exportsField)) return { subpaths: { '.': exportsField } };
  if (typeof exportsField !== 'object') return { error: 'exports must be a string, object, array or null' };
  const keys = Object.keys(exportsField);
  if (!keys.length) return { error: 'exports object is empty' };
  const subpathKeys = keys.filter((key) => key.startsWith('.'));
  if (subpathKeys.length && subpathKeys.length !== keys.length) return { error: 'exports mixes subpath keys with condition keys' };
  if (!subpathKeys.length) return { subpaths: { '.': exportsField } };
  for (const key of subpathKeys) {
    if (key.includes('*')) return { error: 'wildcard exports subpath is unsupported: ' + key };
    if (key !== '.' && !key.startsWith('./')) return { error: 'invalid exports subpath key: ' + key };
  }
  return { subpaths: exportsField };
}

function usableExportTarget(target, entries, entryTypes) {
  if (typeof target !== 'string' || !target.startsWith('./')) return false;
  if (target.includes('%') || target.includes('*') || target.includes('\\')) return false;
  const normalized = target.slice(2);
  if (!normalized || normalized.split('/').some((part) => part === '..' || part === '.' || part === 'node_modules')) return false;
  const entry = 'package/' + normalized;
  return entries.includes(entry) && entryStatus(entries, entryTypes, entry).ok;
}

function describeExportResult(result, label, entries, entryTypes) {
  if (result.missing) return label + ' is missing';
  if (result.blocked) return label + ' is blocked by a null condition';
  if (result.invalid) return label + ' is invalid: ' + result.invalid;
  if (result.unmatched) return label + ' has no node/import/default condition';
  if (!usableExportTarget(result.target, entries, entryTypes)) return label + ' target is not a usable package file: ' + result.target;
  return null;
}

// ---------------------------------------------------------------- evaluator

function evaluateEntryChecks(entries, entryTypes) {
  const checks = [];
  const add = (id, ok, message, detail) => checks.push({ id, category: 'technical', status: ok ? 'pass' : 'fail', message, ...(detail ? { detail } : {}) });
  const required = ['package/package.json', 'package/README.md'];
  const missing = required.filter((entry) => !entries.includes(entry));
  add('required-entries', missing.length === 0,
    missing.length ? 'Missing required package entries: ' + missing.join(', ') : 'Required package entries present',
    missing.length ? { missing } : undefined);
  const badTypes = required.filter((entry) => entries.includes(entry) && !entryStatus(entries, entryTypes, entry).ok);
  add('required-entry-types', badTypes.length === 0,
    badTypes.length ? 'Required entries are not regular files: ' + badTypes.join(', ') : 'Required entries are regular files',
    badTypes.length ? { entries: badTypes } : undefined);
  const developer = entries.filter((entry) => DEVELOPER_ENTRY.test(entry));
  add('no-developer-content', developer.length === 0,
    developer.length ? 'Developer/evidence content must not ship: ' + developer.slice(0, 5).join(', ') : 'No scripts/tests/evidence/bin entries',
    developer.length ? { entries: developer } : undefined);
  const binEntries = entries.filter((entry) => /^package\/bin(?:\/|$)/.test(entry));
  add('no-bin-directory', binEntries.length === 0,
    binEntries.length ? 'bin/ content must not ship: ' + binEntries.join(', ') : 'No package/bin entries',
    binEntries.length ? { entries: binEntries } : undefined);
  return checks;
}

function evaluateLicenseChecks(licenseFiles, entries, entryTypes) {
  const checks = [];
  const add = (id, ok, message, detail) => checks.push({ id, category: 'technical', status: ok ? 'pass' : 'fail', message, ...(detail ? { detail } : {}) });
  if (!licenseFiles || !licenseFiles.length) {
    add('license-file', false, 'No LICENSE / LICENSE.* / COPYING entry in the package');
    return checks;
  }
  const problems = [];
  for (const file of licenseFiles) {
    const status = entryStatus(entries, entryTypes, file.entry);
    if (!status.ok) {
      problems.push(file.entry + ': ' + status.reason);
      continue;
    }
    const text = typeof file.content === 'string' ? file.content.trim() : '';
    if (!text) problems.push(file.entry + ': empty or unreadable');
    else if (LICENSE_PLACEHOLDER.test(text)) problems.push(file.entry + ': placeholder content');
  }
  add('license-file', problems.length === 0,
    problems.length ? 'License file is not a usable regular file: ' + problems.join('; ') : 'License file is a non-empty regular file: ' + licenseFiles.map((file) => file.entry).join(', '),
    problems.length ? { problems } : { entries: licenseFiles.map((file) => file.entry) });
  return checks;
}

function evaluateMetadataChecks(pkg) {
  const checks = [];
  const add = (id, ok, message) => checks.push({ id, category: 'technical', status: ok ? 'pass' : 'fail', message });
  add('metadata-name', validName(pkg.name), 'package name is ' + JSON.stringify(pkg.name ?? null));
  add('metadata-version', validVersion(pkg.version), 'package version is ' + JSON.stringify(pkg.version ?? null));
  add('metadata-license', validLicense(pkg.license), 'public license field is ' + JSON.stringify(pkg.license ?? null));
  add('metadata-repository', validRepository(pkg.repository), 'repository field is ' + JSON.stringify(pkg.repository ?? null));
  add('metadata-homepage', validHomepage(pkg.homepage), 'homepage field is ' + JSON.stringify(pkg.homepage ?? null));
  add('metadata-author', validAuthor(pkg.author), 'author field is ' + JSON.stringify(pkg.author ?? null));
  add('no-bin-registration', pkg.bin === undefined, pkg.bin === undefined ? 'package.json has no bin registration' : 'package.json registers a bin entry');
  return checks;
}

function evaluateExports(pkg, entries, entryTypes) {
  const checks = [];
  const add = (id, ok, message, detail) => checks.push({ id, category: 'technical', status: ok ? 'pass' : 'fail', message, ...(detail ? { detail } : {}) });
  const analysis = analyzeExports(pkg.exports);
  if (analysis.error) {
    add('entry-exports', false, analysis.error);
    add('entry-client', false, 'client entry cannot be analyzed');
    return checks;
  }
  const problems = [];
  const leaves = [];
  for (const [subpath, value] of Object.entries(analysis.subpaths)) {
    const subLeaves = [];
    collectExportLeaves(value, subpath, subLeaves);
    for (const leaf of subLeaves) leaves.push({ ...leaf, subpath });
  }
  for (const leaf of leaves) {
    if (leaf.invalid) {
      problems.push(leaf.label + ': ' + leaf.invalid);
      continue;
    }
    if (leaf.blocked) continue;
    const target = leaf.target;
    if (!target.startsWith('./')) {
      problems.push(leaf.label + ': target must start with ./: ' + target);
      continue;
    }
    if (target.includes('%') || target.includes('*')) {
      problems.push(leaf.label + ': encoded or wildcard target is unsupported: ' + target);
      continue;
    }
    const normalized = target.slice(2);
    if (!normalized || normalized.includes('\\') || normalized.split('/').some((part) => part === '..' || part === '.' || part === 'node_modules')) {
      problems.push(leaf.label + ': unsafe target ' + target);
      continue;
    }
    const entry = 'package/' + normalized;
    if (!entries.includes(entry)) {
      problems.push(leaf.label + ': missing ' + entry);
      continue;
    }
    const status = entryStatus(entries, entryTypes, entry);
    if (!status.ok) problems.push(leaf.label + ': ' + status.reason + ' (' + entry + ')');
  }
  const rootValue = analysis.subpaths['.'];
  const clientValue = analysis.subpaths['./client'];
  const rootResult = rootValue === undefined ? { missing: true } : resolveConditional(rootValue, '.');
  const clientResult = clientValue === undefined ? { missing: true } : resolveConditional(clientValue, './client');
  const rootOk = !!rootResult.target && usableExportTarget(rootResult.target, entries, entryTypes);
  const clientOk = !!clientResult.target && usableExportTarget(clientResult.target, entries, entryTypes);
  const rootReason = describeExportResult(rootResult, 'Root exports["."]', entries, entryTypes);
  const clientReason = describeExportResult(clientResult, 'Client entry exports["./client"]', entries, entryTypes);
  const exportMessage = [rootReason, problems.length ? problems.join('; ') : null].filter(Boolean).join('; ')
    || 'Root and subpath exports resolve inside the package';
  add('entry-exports', rootOk && problems.length === 0, exportMessage, problems.length ? { problems } : undefined);
  add('entry-client', clientOk, clientReason || 'Client entry exports["./client"] resolves');
  return checks;
}

function evaluatePackageTargetChecks(pkg, entries, entryTypes) {
  const checks = [];
  const add = (id, ok, message, detail) => checks.push({ id, category: 'technical', status: ok ? 'pass' : 'fail', message, ...(detail ? { detail } : {}) });
  const main = typeof pkg.main === 'string' ? pkg.main : null;
  const mainEntry = packageEntryForTarget(main);
  const mainStatus = mainEntry ? entryStatus(entries, entryTypes, mainEntry) : { ok: false, reason: 'missing' };
  add('entry-main', !!main && !!mainEntry && entries.includes(mainEntry) && mainStatus.ok,
    main ? 'main target ' + main + (entries.includes(mainEntry) && mainStatus.ok ? ' is a regular file in the package' : ' is missing or not a regular file')
      : 'package.json main is missing');
  checks.push(...evaluateExports(pkg, entries, entryTypes));
  return checks;
}

function evaluateReadmeChecks(readmeText, readmeError, entries) {
  const checks = [];
  const add = (id, ok, message, detail) => checks.push({ id, category: 'technical', status: ok ? 'pass' : 'fail', message, ...(detail ? { detail } : {}) });
  if (readmeError) {
    add('readme-relative-links', false, 'README.md could not be read from the tarball: ' + readmeError);
    return { checks, summary: null };
  }
  if (readmeText === null || readmeText === undefined) {
    add('readme-relative-links', false, 'README.md is missing from the tarball');
    return { checks, summary: null };
  }
  const links = resolveReadmeLinks(readmeText, entries);
  const issues = links.occurrences.filter((item) => item.relative && (item.exists === false || item.reason));
  add('readme-relative-links', issues.length === 0,
    issues.length ? issues.length + ' relative README target(s) are missing or unsafe' : 'All relative README targets resolve inside the package',
    { counts: links.summary, issues: issues.slice(0, 50).map((item) => ({ line: item.line, destination: item.destination, target: item.target, reason: item.reason })) });
  add('readme-supported-syntax', links.unsupported.length === 0,
    links.unsupported.length ? 'Unsupported README link syntax found; refusing to skip it silently' : 'README link syntax is within the supported subset',
    links.unsupported.length ? { unsupported: links.unsupported } : undefined);
  return { checks, summary: links.summary };
}

export function evaluateReadiness({
  entries = [], packageJson = null, packageJsonError = null, readmeText = null,
  readmeError = null, legacyMatches = 0, archiveError = null, tarball = null,
  entryTypes = null, licenseFiles = [],
} = {}) {
  const checks = [];
  checks.push({
    id: 'archive-safety', category: 'technical', status: archiveError ? 'fail' : 'pass',
    message: archiveError || 'Archive entries pass path/duplicate/developer-tree safety checks',
  });
  checks.push({
    id: 'package-json', category: 'technical', status: packageJson && !packageJsonError ? 'pass' : 'fail',
    message: packageJsonError || (packageJson ? 'package.json parsed' : 'package.json is missing'),
  });
  checks.push(...evaluateEntryChecks(entries, entryTypes));
  checks.push(...evaluateMetadataChecks(packageJson || {}));
  checks.push(...evaluatePackageTargetChecks(packageJson || {}, entries, entryTypes));
  checks.push(...evaluateLicenseChecks(licenseFiles, entries, entryTypes));
  checks.push({
    id: 'legacy-gate-names', category: 'technical', status: legacyMatches === 0 ? 'pass' : 'fail',
    message: legacyMatches ? 'Packed text contains ' + legacyMatches + ' legacy gate name occurrence(s)' : 'No legacy gate names in packed text',
  });
  const readme = evaluateReadmeChecks(readmeText, readmeError, entries);
  checks.push(...readme.checks);
  if (packageJson) {
    checks.push({
      id: 'private-field', category: 'manual-gate', status: packageJson.private === true ? 'manual' : 'pass',
      message: packageJson.private === true
        ? 'package.json private:true — removal needs an explicit human release decision'
        : 'package.json is not private',
      ...(packageJson.private === true ? { detail: { private: true } } : {}),
    });
  }
  const blockers = checks.filter((check) => check.category === 'technical' && check.status === 'fail');
  const manualGates = checks.filter((check) => check.category === 'manual-gate' && check.status === 'manual');
  return {
    schemaVersion: SCHEMA_VERSION,
    mode: 'readiness',
    ready: blockers.length === 0 && manualGates.length === 0,
    tarball,
    checks,
    blockers,
    manualGates,
    counts: {
      checks: checks.length,
      pass: checks.filter((check) => check.status === 'pass').length,
      fail: blockers.length,
      manual: manualGates.length,
    },
    readmeLinks: readme.summary,
    capability: LINK_CAPABILITY,
  };
}

export function readinessFailure(message, tarball = null) {
  const check = { id: 'readiness-error', category: 'technical', status: 'fail', message };
  return {
    schemaVersion: SCHEMA_VERSION,
    mode: 'readiness',
    ready: false,
    tarball,
    checks: [check],
    blockers: [check],
    manualGates: [],
    counts: { checks: 1, pass: 0, fail: 1, manual: 0 },
    readmeLinks: null,
    capability: LINK_CAPABILITY,
  };
}
