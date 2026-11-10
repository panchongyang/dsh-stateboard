import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BoardError } from '../errors.js';
import { assertReadOnlyGitArgs, resolveGitExecutable } from '../git-exec.js';
import { MAX_DOC_BYTES } from './read.js';
import { validateRelPath } from './locate.js';

export function fixedError(code, message, details = null) {
  const status = { 'fixed-object-missing': 404, 'fixed-path-missing': 404, 'unsupported-repository': 422, 'unsupported-content-transform': 422, 'invalid-fixed-reference': 400, 'unsupported-format': 400, oversize: 413, 'git-unavailable': 503 }[code] || 409;
  return new BoardError(code, message, { status, details });
}

export function gitRead(root, args, maxBuffer = 1024 * 1024) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_PROTOCOL_FROM_USER: '0', GCM_INTERACTIVE: 'never' });
  const result = spawnSync(resolveGitExecutable([root]), ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', ...assertReadOnlyGitArgs(args)], {
    cwd: root, env, timeout: 3000, maxBuffer, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.signal) throw fixedError('git-unavailable', 'bounded Git read failed', { reason: result.error?.code || result.signal });
  return { ok: result.status === 0, status: result.status, bytes: result.stdout || Buffer.alloc(0), text: (result.stdout || '').toString('utf8') };
}

export function gitRequired(root, args, code = 'fixed-object-missing', maxBuffer) {
  const result = gitRead(root, args, maxBuffer);
  if (!result.ok) throw fixedError(code, 'Git read failed: ' + args[0]);
  return result;
}

export function repositoryAt(root) {
  try { fs.realpathSync(root); }
  catch { throw new BoardError('root-unavailable', 'approved binding root is unavailable', { status: 503 }); }
  // A failed rev-parse here means "the binding root is not a usable repository";
  // tag it so the auto shell can report not-a-repo instead of guessing.
  const top = gitRead(root, ['rev-parse', '--show-toplevel']);
  if (!top.ok) throw fixedError('unsupported-repository', 'Git read failed: rev-parse', { reason: 'not-a-repo' });
  const format = gitRead(root, ['rev-parse', '--show-object-format']);
  if (!format.ok) throw fixedError('unsupported-repository', 'Git read failed: rev-parse', { reason: 'not-a-repo' });
  const objectFormat = format.text.trim();
  if (!['sha1', 'sha256'].includes(objectFormat)) throw fixedError('unsupported-repository', 'unsupported Git object format', { reason: 'unsupported-format' });
  return { root: fs.realpathSync(top.text.trim()), objectFormat };
}

export function objectBytes(root, oid, type, objectFormat) {
  const actualType = gitRequired(root, ['cat-file', '-t', oid]).text.trim();
  if (actualType !== type) throw fixedError('fixed-object-mismatch', 'Git object is not a ' + type);
  const size = Number(gitRequired(root, ['cat-file', '-s', oid]).text.trim());
  if (!Number.isSafeInteger(size) || size < 0) throw fixedError('fixed-object-mismatch', 'invalid Git object size');
  if (size > MAX_DOC_BYTES) throw fixedError('oversize', 'Git object exceeds 16 MiB');
  const bytes = gitRequired(root, ['cat-file', type, oid], 'fixed-object-missing', MAX_DOC_BYTES + 1024).bytes;
  const actualOid = crypto.createHash(objectFormat).update(Buffer.from(type + ' ' + bytes.length + '\0')).update(bytes).digest('hex');
  if (bytes.length !== size || actualOid !== oid) throw fixedError('fixed-object-mismatch', 'Git object identity mismatch');
  return bytes;
}

export function commitTree(root, commitOid, objectFormat) {
  const commit = objectBytes(root, commitOid, 'commit', objectFormat).toString('utf8');
  const resolved = gitRequired(root, ['rev-parse', '--verify', '--end-of-options', commitOid + '^{commit}']).text.trim();
  if (resolved !== commitOid) throw fixedError('fixed-object-mismatch', 'expected a full commit object identity');
  const tree = /^tree ([0-9a-f]+)\n/.exec(commit)?.[1];
  if (!tree) throw fixedError('fixed-object-mismatch', 'commit has no tree');
  return tree;
}

function treeEntry(bytes, name, width) {
  for (let offset = 0; offset < bytes.length;) {
    const space = bytes.indexOf(32, offset);
    const nul = bytes.indexOf(0, space + 1);
    if (space < offset || nul < space || nul + 1 + width > bytes.length) throw fixedError('fixed-object-mismatch', 'invalid Git tree');
    const mode = bytes.subarray(offset, space).toString('ascii');
    const filename = bytes.subarray(space + 1, nul);
    const oid = bytes.subarray(nul + 1, nul + 1 + width).toString('hex');
    if (filename.equals(Buffer.from(name))) return { mode, oid };
    offset = nul + 1 + width;
  }
  return null;
}

export function pathEntry(root, commitOid, relPath, objectFormat) {
  if (!validateRelPath(relPath).ok) throw fixedError('invalid-fixed-reference', 'invalid repository-relative path');
  const segments = relPath.split('/');
  let treeOid = commitTree(root, commitOid, objectFormat);
  for (let i = 0; i < segments.length; i++) {
    const entry = treeEntry(objectBytes(root, treeOid, 'tree', objectFormat), segments[i], objectFormat === 'sha1' ? 20 : 32);
    if (!entry) throw fixedError('fixed-path-missing', 'path is absent at the fixed commit', { pathAtCommit: relPath });
    if (entry.mode === '160000') throw fixedError('unsupported-repository', 'submodule content is not an approved repository', { reason: 'unsupported-format' });
    if (i === segments.length - 1) {
      if (!['100644', '100755'].includes(entry.mode)) throw fixedError('fixed-object-mismatch', 'fixed path is not an ordinary blob');
      return entry;
    }
    if (entry.mode !== '40000') throw fixedError('fixed-path-missing', 'path component is not a tree');
    treeOid = entry.oid;
  }
}

export function readGitContent(repo, commitOid, pathAtCommit) {
  const entry = pathEntry(repo.root, commitOid, pathAtCommit, repo.objectFormat);
  const bytes = objectBytes(repo.root, entry.oid, 'blob', repo.objectFormat);
  if (bytes.subarray(0, 200).toString('utf8').startsWith('version https://git-lfs.github.com/spec/v1')) {
    throw fixedError('unsupported-content-transform', 'LFS pointers are not document content', { reason: 'lfs-pointer' });
  }
  return { ...entry, bytes, blobContentHash: crypto.createHash('sha256').update(bytes).digest('hex') };
}

export function rejectNestedRepository(repoRoot, absolute) {
  let current = path.dirname(absolute);
  while (current !== repoRoot) {
    if (fs.existsSync(path.join(current, '.git'))) throw fixedError('unsupported-repository', 'nested repositories are not supported', { reason: 'nested-repository' });
    const parent = path.dirname(current);
    if (parent === current) throw fixedError('unsupported-repository', 'path is outside the approved repository', { reason: 'not-a-repo' });
    current = parent;
  }
}
