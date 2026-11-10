// Bounded, classified workspace document reader.
//
// Contract: docs/WORKSPACE-DOCUMENTS-CONTRACT.md §3. Four things this module is
// deliberate about:
//
//   * the byte cap is proven from the open handle, never from an earlier stat
//     that an external editor invalidates immediately;
//   * "the path still names the object I read" is proven by stat identity
//     (dev+ino) after the read, not by a realpath string: replacing a file at
//     the same path keeps the string and swaps the object;
//   * every failure — open, fstat, read, decode, format — is classified and
//     returned, never thrown at the caller with a half-closed handle;
//   * callers may only tighten the caps. Invalid options throw: a silent
//     fallback would turn a security limit into a suggestion.
//
// Nothing here writes: a read takes no lock and produces no event.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isInside } from '../util.js';
import { classifyFsError, locateDocument, rejectLinkComponent } from './locate.js';

export const MAX_DOC_BYTES = 16 * 1024 * 1024;
export const MAX_PREVIEW_BYTES = 256 * 1024;
export const MAX_ATTEMPTS = 2;

// First version previews UTF-8 text only. Everything else stays registrable:
// the read still succeeds and reports a hash, it just has no body to show.
const PREVIEWABLE_EXT = new Set(['.md', '.markdown', '.mdown', '.txt', '.text', '']);

// Contract §2/§6.2: the availability an observation reports and the error code a
// command returns are one fact under two spellings. Keeping the table here stops
// later tasks from inventing a third spelling per endpoint.
export const AVAILABILITY_CODES = Object.freeze({
  readable: null,
  missing: 'file-missing',
  root_unavailable: 'root-unavailable',
  missing_binding: 'missing-binding',
  permission_denied: 'permission-denied',
  outside_root: 'outside-root',
  not_regular: 'not-regular',
  oversize: 'oversize',
  unsupported_format: 'unsupported-format',
  undecodable: 'undecodable',
  unstable: 'unstable',
  security_rejected: 'security-rejected',
});

/** Streaming SHA-256 over raw file bytes. Shared with evidence hashing. */
export function hashFileStream(file, io = fs) {
  const hash = crypto.createHash('sha256');
  const fd = io.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const read = io.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    io.closeSync(fd);
  }
  return hash.digest('hex');
}

function fail(availability, code, detail) {
  return detail === undefined
    ? { ok: false, availability, code }
    : { ok: false, availability, code, detail };
}

function oversize(size, maxBytes) {
  return fail('oversize', 'oversize', { size, maxBytes });
}

/** True when the two stats describe the same, unchanged object. */
function sameFile(before, after) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

/** Read at most maxBytes + 1 bytes, so the cap is proven from the handle. */
function readBounded(io, fd, expected, maxBytes) {
  const capacity = Math.max(1, Math.min(expected, maxBytes) + 1);
  const buffer = Buffer.allocUnsafe(capacity);
  let total = 0;
  while (total < buffer.length) {
    const read = io.readSync(fd, buffer, total, buffer.length - total, null);
    if (read <= 0) break;
    total += read;
  }
  return buffer.subarray(0, total);
}

/** Run one filesystem call and classify a throw instead of letting it escape. */
function guard(work) {
  try {
    return { ok: true, value: work() };
  } catch (err) {
    return { ok: false, failure: classifyFsError(err) };
  }
}

/**
 * Preview text cut at a character boundary, never in the middle of a code point.
 * `totalBytes` counts the display text after any BOM strip; the raw file size is
 * reported separately as `size`, and a truncated preview never claims to be the
 * whole document.
 */
export function previewOf(text, limit) {
  const totalBytes = Buffer.byteLength(text, 'utf8');
  if (totalBytes <= limit) return { text, truncated: false, totalBytes };
  let used = 0;
  let cut = 0;
  for (const char of text) {
    const width = Buffer.byteLength(char, 'utf8');
    if (used + width > limit) break;
    used += width;
    cut += char.length;
  }
  return { text: text.slice(0, cut), truncated: true, totalBytes };
}

function previewableExtension(segments) {
  const name = segments[segments.length - 1];
  return PREVIEWABLE_EXT.has(path.extname(name).toLowerCase());
}

/** UTF-8 / UTF-16 byte order marks. UTF-16 is never decoded by this version. */
function bomEncoding(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  return null;
}

/**
 * A NUL byte inside a supposedly textual document is binary content wearing a
 * text extension. BOM-less UTF-16LE ASCII lands here too, which is the point:
 * its interleaved zero bytes are the tell.
 */
function containsNul(bytes) {
  return bytes.indexOf(0) !== -1;
}

function readOnlyResult(hash, size, detail) {
  return {
    ok: true,
    availability: 'unsupported_format',
    previewable: false,
    reason: 'unsupported-format',
    detail,
    hash,
    size,
    bomStripped: false,
    text: null,
    preview: null,
  };
}

/** Turn the bytes of a verified read into the result the contract describes. */
function interpret(bytes, located, settings) {
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const size = bytes.length;
  const encoding = bomEncoding(bytes);
  if (!previewableExtension(located.segments)) return readOnlyResult(hash, size, 'extension');
  if (encoding === 'utf-16le' || encoding === 'utf-16be') return readOnlyResult(hash, size, encoding);
  if (containsNul(bytes)) return readOnlyResult(hash, size, 'nul-byte');
  let text;
  try {
    // fatal: invalid UTF-8 is a classified failure, never replacement characters.
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, availability: 'undecodable', code: 'undecodable', hash, size };
  }
  return {
    ok: true,
    availability: 'readable',
    previewable: true,
    reason: null,
    detail: null,
    hash,
    size,
    bomStripped: encoding === 'utf-8',
    text,
    preview: previewOf(text, settings.previewBytes),
  };
}

export function interpretDocumentBytes(bytes, relPath) {
  return interpret(bytes, { segments: relPath.split('/') }, { previewBytes: MAX_PREVIEW_BYTES });
}

/**
 * Prove the locator still names the object the handle read.
 *
 * Order matters: root first (a moved binding invalidates everything below it),
 * then the real path string, then the object identity the string cannot show,
 * then the link components that made the string trustworthy in the first place.
 */
function verifyIdentity(io, located, handleStat) {
  let realRoot;
  try {
    realRoot = io.realpathSync(located.root);
  } catch {
    return fail('root_unavailable', 'root-unavailable', 'root-gone-after-read');
  }
  if (realRoot !== located.root) return fail('unstable', 'unstable', 'root-changed');
  let real;
  try {
    real = io.realpathSync(located.declared);
  } catch {
    return fail('unstable', 'unstable', 'path-gone-after-read');
  }
  if (real !== located.absolute) return fail('unstable', 'unstable', 'path-replaced');
  if (!isInside(realRoot, real)) return fail('outside_root', 'outside-root', 'after-read');
  let atPath;
  try {
    atPath = io.statSync(real);
  } catch {
    return fail('unstable', 'unstable', 'path-gone-after-read');
  }
  if (atPath.dev !== handleStat.dev || atPath.ino !== handleStat.ino) {
    return fail('unstable', 'unstable', 'path-replaced');
  }
  return rejectLinkComponent(io, realRoot, located.segments);
}

function readHandle(io, fd, located, settings) {
  const before = guard(() => io.fstatSync(fd));
  if (!before.ok) return before.failure;
  if (!before.value.isFile()) return fail('not_regular', 'not-regular');
  if (before.value.size > settings.maxBytes) return oversize(before.value.size, settings.maxBytes);
  const read = guard(() => readBounded(io, fd, before.value.size, settings.maxBytes));
  if (!read.ok) return read.failure;
  if (read.value.length > settings.maxBytes) return oversize(read.value.length, settings.maxBytes);
  const after = guard(() => io.fstatSync(fd));
  if (!after.ok) return after.failure;
  // A short/long read or a moved timestamp means the bytes we hold are not one
  // immutable snapshot; retrying is the only way to hand back something honest.
  if (!sameFile(before.value, after.value) || read.value.length !== after.value.size) {
    return fail('unstable', 'unstable', 'changed-during-read');
  }
  const identity = verifyIdentity(io, located, after.value);
  if (identity) return identity;
  const result = interpret(read.value, located, settings);
  if (settings.includeBytes && result.ok) result.bytes = read.value;
  return result;
}

/**
 * A path that vanished may mean the binding root itself went away; that is a
 * different fact from "this document was deleted", and the user acts differently.
 */
function classifyOpen(io, located, err) {
  const failure = classifyFsError(err);
  if (failure.availability !== 'missing') return failure;
  try {
    io.realpathSync(located.root);
  } catch {
    return fail('root_unavailable', 'root-unavailable', err && err.code);
  }
  return failure;
}

function readOnce(root, relPath, settings) {
  const { io } = settings;
  const located = locateDocument(root, relPath, io);
  if (!located.ok) return located;
  let fd;
  try {
    fd = io.openSync(located.absolute, 'r');
  } catch (err) {
    return classifyOpen(io, located, err);
  }
  try {
    return readHandle(io, fd, located, settings);
  } finally {
    try {
      io.closeSync(fd);
    } catch {
      // The handle is already gone; the read result is what matters.
    }
  }
}

/** Caps may only be tightened; anything else is a programming error, not a mode. */
function boundedInt(name, value, fallback, hard) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > hard) {
    throw new RangeError(name + ' must be an integer between 1 and ' + hard + ', got ' + String(value));
  }
  return value;
}

function settingsOf(options) {
  return {
    io: options.io || fs,
    includeBytes: options.includeBytes === true,
    maxBytes: boundedInt('maxBytes', options.maxBytes, MAX_DOC_BYTES, MAX_DOC_BYTES),
    previewBytes: boundedInt('previewBytes', options.previewBytes, MAX_PREVIEW_BYTES, MAX_PREVIEW_BYTES),
    attempts: boundedInt('attempts', options.attempts, MAX_ATTEMPTS, MAX_ATTEMPTS),
  };
}

/**
 * Read one document out of a binding root.
 *
 * Success: `{ ok: true, availability: 'readable' | 'unsupported_format',
 * previewable, hash, size, bomStripped, text, preview }`. Failure:
 * `{ ok: false, availability, code, detail? }` using the contract's names.
 *
 * Invalid options throw RangeError — the return shape stays exactly one of the
 * two above, never null.
 *
 * `io` exists for fault injection in tests (same seam the store uses); callers
 * outside tests should not pass it.
 */
export function readDocument(root, relPath, options = {}) {
  const settings = settingsOf(options);
  let last = fail('unstable', 'unstable', 'no-attempt');
  for (let attempt = 0; attempt < settings.attempts; attempt++) {
    const result = readOnce(root, relPath, settings);
    if (result.ok || result.availability !== 'unstable') return result;
    last = result;
  }
  return last;
}
