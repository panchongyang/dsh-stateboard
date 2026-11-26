// Authorized, uncached read-only source seam. Never resolves a historical binding
// to its old machine path: a copied space always observes its own physical root.
import fs from 'node:fs';
import path from 'node:path';
import { documentReadStatus } from '../domain/document-read-error.js';
import { BoardError } from '../errors.js';
import { legacyBindingId } from '../identity/registry.js';
import { spaceMainBindingId } from '../identity/bindings.js';
import { validateRelPath, locateDocument, classifyFsError } from './locate.js';
import { readDocument } from './read.js';

const EXCLUDED = new Set(['.git', '.projectboard', '.dsh', '.ssh', '.gnupg', 'node_modules', 'vendor', 'dist', 'build', 'coverage', '.evidence', 'private', 'secrets']);
const fail = (code, detail) => new BoardError(code, 'Workspace source unavailable: ' + code, { status: code === 'reserved-path' ? 403 : documentReadStatus(code), details: detail ? { reason: detail } : null });
const identity = s => `${s.dev}:${s.ino}`;
export function isReservedWorkspacePath(relPath) {
  return relPath.split(/[\\/]/).some(segment => {
    const name = segment.toLowerCase();
    return EXCLUDED.has(name) || /^\.env($|\.)/.test(name) || /\.(pem|key|p12|pfx)$/.test(name)
      || /^(id_rsa|id_ed25519|credentials)/.test(name);
  });
}
function checkHome(home, project) {
  try {
    if (!home || typeof home.check !== 'function' || typeof home.readMeta !== 'function' || !path.isAbsolute(home.root || '') || home.check() !== true) throw fail('space-home-unavailable');
    if (!project || typeof project.id !== 'string' || home.readMeta()?.projectId !== project.id) throw fail('missing-binding', 'project-not-in-space');
    return project;
  } catch (error) {
    if (error instanceof BoardError) throw error;
    throw fail('space-home-unavailable', error?.code || 'invalid-space-medium');
  }
}
/** Binding/path authorization only; missing current files do not deny history. */
export function assertWorkspaceSourceLocator(spaceHome, project, locator) {
  const row = checkHome(spaceHome, project);
  const lexical = validateRelPath(locator?.relPath);
  if (!lexical.ok) throw fail(lexical.code, lexical.detail);
  if (isReservedWorkspacePath(locator.relPath)) throw fail('reserved-path');
  const ids = new Set([legacyBindingId(row.id, spaceHome.root)]);
  // The log already stores the original canonical main root. Reproduce its
  // lexical identity WITHOUT realpath/stat of that former machine's directory.
  if (typeof row.workspacePath === 'string' && path.isAbsolute(row.workspacePath)) {
    ids.add(spaceMainBindingId(row.id, row.workspacePath));
  }
  if (typeof locator?.bindingId !== 'string' || !ids.has(locator.bindingId)) throw fail('missing-binding', 'binding-not-owned-by-space');
  return locator;
}
function inspected(spaceHome, project, locator) {
  assertWorkspaceSourceLocator(spaceHome, project, locator);
  const located = locateDocument(spaceHome.root, locator.relPath);
  if (!located.ok) throw fail(located.code, located.detail);
  if (isReservedWorkspacePath(path.relative(located.root, located.absolute))) throw fail('reserved-path');
  let stat;
  try { stat = fs.lstatSync(located.absolute, { bigint: true }); } catch (error) { const classified = classifyFsError(error); throw fail(classified.code, classified.detail); }
  if (!stat.isFile()) throw fail('not-regular');
  if (stat.nlink > 1n) throw fail('security-rejected', 'multiple-hard-links');
  if (stat.nlink !== 1n || stat.ino <= 0n) throw fail('security-rejected', 'ambiguous-file-identity');
  return { located, stat };
}
/** Physical identity, not lowercased locator text, determines duplicate records. */
export function workspaceLocatorKey(spaceHome, project, locator) {
  const { stat } = inspected(spaceHome, project, locator);
  let root;
  try { root = fs.lstatSync(spaceHome.root, { bigint: true }); } catch (error) { throw fail('space-home-unavailable', error?.code); }
  checkHome(spaceHome, project);
  return `${identity(root)}/${identity(stat)}`;
}
/** Complete stable raw bytes; BOM, CRLF and empty bytes remain unchanged. */
export function observeWorkspaceSource(spaceHome, project, doc, { allowUnretained = false } = {}) {
  if (doc?.source !== 'external' || doc.unregistered) throw fail('invalid-external-doc');
  const before = inspected(spaceHome, project, doc.locator);
  const read = readDocument(spaceHome.root, doc.locator.relPath, { includeBytes: true });
  if (!read.ok && !(allowUnretained && read.code === 'undecodable' && typeof read.hash === 'string')) throw fail(read.code, read.detail);
  const retainable = read.previewable && Buffer.isBuffer(read.bytes);
  if (!retainable && !allowUnretained) throw fail('unsupported-format', read.detail);
  const after = inspected(spaceHome, project, doc.locator);
  if (identity(before.stat) !== identity(after.stat) || before.stat.size !== after.stat.size
    || before.stat.mtimeNs !== after.stat.mtimeNs || before.stat.ctimeNs !== after.stat.ctimeNs) throw fail('unstable', 'source-changed-during-observation');
  checkHome(spaceHome, project);
  return { bytes: retainable ? read.bytes : null, contentHash: read.hash, size: read.size };
}
