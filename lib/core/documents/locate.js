// Workspace document locator: lexical rules first, realpath containment second.
//
// The lexer is the real gate. A locator is always a relative path, so no input
// can name a host path outside the binding root even before the filesystem is
// consulted. Containment then decides on the real path of *both* ends, because
// a lexical check alone accepts a junction that points anywhere.
//
// Evidence keeps its own, deliberately looser rule (absolute refs inside the
// workspace are accepted there). Do not route evidence through this module:
// widening it here would widen evidence authorization silently.

import fs from 'node:fs';
import path from 'node:path';
import { isInside } from '../util.js';

export const DOC_PATH_CODES = Object.freeze({
  security: 'security-rejected',
  outside: 'outside-root',
  missing: 'file-missing',
  permission: 'permission-denied',
  root: 'root-unavailable',
});

const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const DRIVE_PREFIX = /^[a-z]:/i;
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

function security(detail) {
  return { ok: false, availability: 'security_rejected', code: DOC_PATH_CODES.security, detail };
}

/** Lexical gate: returns segments, or a classified rejection. */
export function validateRelPath(relPath) {
  if (typeof relPath !== 'string' || relPath === '') return security('empty-path');
  if (CONTROL_CHAR.test(relPath)) return security('control-character');
  if (relPath.includes('\\')) return security('backslash');
  if (relPath.startsWith('/')) return security('absolute-path');
  if (DRIVE_PREFIX.test(relPath)) return security('drive-prefix');
  const segments = relPath.split('/');
  for (const segment of segments) {
    if (segment === '') return security('empty-segment');
    if (segment === '.' || segment === '..') return security('dot-segment');
    if (segment.includes(':')) return security('ads-stream');
    if (/[ .]$/.test(segment)) return security('trailing-space-or-dot');
    if (DEVICE_NAME.test(segment)) return security('device-name');
  }
  return { ok: true, segments };
}

/** Classify a filesystem error into the contract's availability language. */
export function classifyFsError(err) {
  const code = err && err.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return { ok: false, availability: 'missing', code: DOC_PATH_CODES.missing, detail: code };
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return { ok: false, availability: 'permission_denied', code: DOC_PATH_CODES.permission, detail: code };
  }
  if (code === 'ELOOP') {
    return { ok: false, availability: 'security_rejected', code: DOC_PATH_CODES.security, detail: 'symlink-loop' };
  }
  if (code === 'EISDIR') {
    return { ok: false, availability: 'not_regular', code: 'not-regular', detail: code };
  }
  return { ok: false, availability: 'unstable', code: 'unstable', detail: code || 'unknown-fs-error' };
}

/**
 * Refuse a path whose components include a link (symlink or junction).
 *
 * A link that leaves the root is a containment failure and says so; a link that
 * stays inside is still refused, because the binding promises "this root holds
 * this document" and a link can be re-pointed later without touching the
 * document. Node cannot see every Windows reparse tag, so this check covers
 * symlink/junction and the reader additionally proves object identity after the
 * read (see read.js verifyIdentity).
 *
 * Returns null when every component is a plain directory/file.
 */
export function rejectLinkComponent(io, realRoot, segments) {
  let current = realRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = io.lstatSync(current);
    } catch (err) {
      return classifyFsError(err);
    }
    if (!stat.isSymbolicLink()) continue;
    let target;
    try {
      target = io.realpathSync(current);
    } catch (err) {
      return classifyFsError(err);
    }
    if (!isInside(realRoot, target)) {
      return { ok: false, availability: 'outside_root', code: DOC_PATH_CODES.outside, detail: 'link-escape' };
    }
    return { ok: false, availability: 'security_rejected', code: DOC_PATH_CODES.security, detail: 'link-component' };
  }
  return null;
}

/**
 * Resolve a locator inside one binding root.
 *
 * Returns `{ ok: true, absolute, root, declared, segments }` where `absolute`
 * is the real path, or a classified rejection. Root failure is separated from
 * path failure on purpose: a missing workspace is not a missing document.
 */
export function locateDocument(root, relPath, io = fs) {
  const lexical = validateRelPath(relPath);
  if (!lexical.ok) return lexical;
  let realRoot;
  try {
    realRoot = io.realpathSync(root);
  } catch (err) {
    const code = err && err.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { ok: false, availability: 'root_unavailable', code: DOC_PATH_CODES.root };
    }
    return classifyFsError(err);
  }
  const declared = path.resolve(root, ...lexical.segments);
  if (!isInside(root, declared)) {
    return { ok: false, availability: 'outside_root', code: DOC_PATH_CODES.outside, detail: 'lexical' };
  }
  let real;
  try {
    real = io.realpathSync(declared);
  } catch (err) {
    return classifyFsError(err);
  }
  if (!isInside(realRoot, real)) {
    return { ok: false, availability: 'outside_root', code: DOC_PATH_CODES.outside, detail: 'realpath' };
  }
  const linked = rejectLinkComponent(io, realRoot, lexical.segments);
  if (linked) return linked;
  return { ok: true, absolute: real, root: realRoot, declared, segments: lexical.segments };
}
