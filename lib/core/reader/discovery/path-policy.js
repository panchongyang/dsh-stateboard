// Shared read-only projection path gate. Authorization belongs to the caller;
// cached observations and cursor possession never bypass this physical check.
import fs from 'node:fs';
import path from 'node:path';
import { BoardError } from '../../errors.js';
import { classifyFsError, locateDocument, validateRelPath } from '../../documents/locate.js';
import { isReservedWorkspacePath } from '../../documents/workspace-source.js';

// Preserve the shared locator's lexical/link/containment checks, using the OS
// canonicalizer instead of JS realpath's repeated ancestor traversal on NTFS.
const nativePathIo = Object.create(fs);
nativePathIo.realpathSync = (...args) => fs.realpathSync.native(...args);

export function projectionFailure(code, reason) {
  const status = code === 'file-missing' ? 404 : code === 'root-unavailable' ? 503
    : code === 'oversize' ? 413 : ['invalid-path', 'not-regular', 'unsupported-format', 'undecodable'].includes(code) ? 400
      : ['restart-required', 'unstable'].includes(code) ? 409 : 403;
  return new BoardError(code, 'Workspace projection unavailable: ' + code, { status, details: reason ? { reason } : null });
}
export function throwProjectionFs(error) {
  const classified = classifyFsError(error);
  throw projectionFailure(classified.code, classified.detail);
}
export function projectionRoot(root) {
  try {
    const stat = fs.lstatSync(root, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw projectionFailure('security-rejected', 'root-not-plain-directory');
    fs.accessSync(root, fs.constants.R_OK | fs.constants.X_OK);
    const real = fs.realpathSync.native(root);
    return { real, identity: `${real}:${stat.dev}:${stat.ino}` };
  } catch (error) {
    if (error instanceof BoardError) throw error;
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw projectionFailure('root-unavailable');
    throwProjectionFs(error);
  }
}
export function normalizeProjectionDeny(prefixes = []) {
  if (!Array.isArray(prefixes) || prefixes.length > 256) throw projectionFailure('invalid-path', 'invalid-deny-prefixes');
  return prefixes.map(prefix => {
    const value = typeof prefix === 'string' ? prefix.replace(/\/$/, '') : prefix;
    const checked = validateRelPath(value);
    if (!checked.ok) throw projectionFailure(checked.code, checked.detail);
    return checked.segments.join('/');
  });
}
export function checkProjectionLexical(relPath, denyPrefixes = []) {
  const lexical = validateRelPath(relPath);
  if (!lexical.ok) throw projectionFailure(lexical.code, lexical.detail);
  const normalized = lexical.segments.join('/');
  if (isReservedWorkspacePath(normalized)) throw projectionFailure('reserved-path');
  // A deny may only narrow access. Case-folding here denies aliases too, without
  // ever merging source identities on case-sensitive filesystems.
  const folded = normalized.toLowerCase();
  if (denyPrefixes.some(prefix => folded === prefix.toLowerCase() || folded.startsWith(prefix.toLowerCase() + '/'))) throw projectionFailure('policy-denied');
  return normalized;
}
// canonical=false is restricted to scanner-owned, actual directory-entry paths;
// user-supplied paths use native canonicalization to close Windows alias gaps.
export function inspectProjectionPath(root, relPath, { denyPrefixes = [], directory = false, canonical = true } = {}) {
  const normalized = checkProjectionLexical(relPath, denyPrefixes);
  const located = locateDocument(root, normalized, nativePathIo);
  if (!located.ok) throw projectionFailure(located.code, located.detail);
  if (isReservedWorkspacePath(path.relative(located.root, located.absolute))) throw projectionFailure('reserved-path');
  try {
    const physicalRelPath = path.relative(canonical ? fs.realpathSync.native(root) : located.root, canonical ? fs.realpathSync.native(located.absolute) : located.absolute).split(path.sep).join('/');
    checkProjectionLexical(physicalRelPath, denyPrefixes);
    const stat = fs.lstatSync(located.absolute, { bigint: true });
    if (stat.isSymbolicLink()) throw projectionFailure('security-rejected', 'link-component');
    if (directory ? !stat.isDirectory() : !stat.isFile()) throw projectionFailure('not-regular');
    if (!directory && (stat.nlink !== 1n || stat.ino <= 0n)) throw projectionFailure('security-rejected', 'ambiguous-file-identity');
    fs.accessSync(located.absolute, fs.constants.R_OK | (directory ? fs.constants.X_OK : 0));
    // access(R_OK) alone does not prove Windows ACL read permission. Opening a
    // handle proves it without reading/hash work on the metadata reuse path.
    if (!directory) {
      const fd = fs.openSync(located.absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        const handle = fs.fstatSync(fd, { bigint: true });
        if (handle.dev !== stat.dev || handle.ino !== stat.ino || handle.nlink !== 1n) throw projectionFailure('unstable', 'path-replaced');
      } finally { fs.closeSync(fd); }
    }
    return { relPath: normalized, physicalRelPath, located, stat, signature: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` };
  } catch (error) {
    if (error instanceof BoardError) throw error;
    throwProjectionFs(error);
  }
}
