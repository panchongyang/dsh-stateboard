import fs from 'node:fs';
import path from 'node:path';
import { fixedError, gitRead, gitRequired, objectBytes, pathEntry, rejectNestedRepository } from './fixed-git.js';
import { readDocument } from './read.js';
import { readFailure } from './external-observe.js';

const ATTRS = ['filter', 'text', 'eol', 'working-tree-encoding', 'ident'];
const absent = (value) => value === 'unspecified' || value === 'unset';

function attributes(repo, relPath, source) {
  const result = gitRequired(repo.root, ['check-attr', '-z', ...source, ...ATTRS, '--', relPath], 'unsupported-content-transform');
  const fields = result.text.split('\0');
  const out = {};
  for (let i = 0; i + 2 < fields.length; i += 3) out[fields[i + 1]] = fields[i + 2];
  return out;
}

export function gitConfig(repo, key) {
  const result = gitRead(repo.root, ['config', '--get', key]);
  if (!result.ok && result.status !== 1) throw fixedError('unsupported-content-transform', 'Git conversion configuration cannot be determined');
  return result.ok ? result.text.trim() : '';
}

function rejectTransform(attrs) {
  if (!absent(attrs.filter) || !absent(attrs['working-tree-encoding']) || !absent(attrs.ident)) {
    throw fixedError('unsupported-content-transform', 'filter, encoding and ident transforms are not supported');
  }
  if (!['unspecified', 'unset', 'set', 'auto'].includes(attrs.text) || !['unspecified', 'unset', 'lf', 'crlf'].includes(attrs.eol)) {
    throw fixedError('unsupported-content-transform', 'unknown text/eol attributes');
  }
}

export function checkedCommitAttributes(repo, relPath, commitOid) {
  rejectTransform(attributes(repo, relPath, ['--source=' + commitOid]));
}

export function checkedAttributes(repo, relPath, commitOid) {
  for (const source of [[], ['--cached'], ['--source=' + commitOid]]) {
    rejectTransform(attributes(repo, relPath, source));
  }
  return attributes(repo, relPath, []);
}

function normalizedBytes(repo, bytes, indexBytes, attrs) {
  const autocrlf = gitConfig(repo, 'core.autocrlf').toLowerCase();
  if (!['', 'false', 'true', 'input'].includes(autocrlf)) throw fixedError('unsupported-content-transform', 'unknown autocrlf setting');
  const text = attrs.text;
  if (text === 'unset') return bytes;
  const explicit = text === 'set' || (!absent(attrs.eol) && text === 'unspecified');
  const auto = text === 'auto' || (text === 'unspecified' && ['true', 'input'].includes(autocrlf));
  if (!explicit && !auto) return bytes;
  if (auto && (bytes.includes(0) || indexBytes.includes(Buffer.from('\r\n')))) return bytes;
  if (auto && (/\r(?!\n)/.test(bytes.toString('latin1')) || /[^\x09\x0a\x0d\x20-\xff]/.test(bytes.toString('latin1')))) {
    throw fixedError('unsupported-content-transform', 'ambiguous automatic text conversion');
  }
  return Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
}

export function assertCleanPath(repo, relPath, commitOid) {
  const absolute = path.join(repo.root, ...relPath.split('/'));
  rejectNestedRepository(repo.root, absolute);
  const attrs = checkedAttributes(repo, relPath, commitOid);
  const index = gitRequired(repo.root, ['ls-files', '--stage', '-z', '--', ':(literal)' + relPath], 'dirty-worktree').text.split('\0').filter(Boolean);
  const match = index.length === 1 && /^(100644|100755) ([0-9a-f]+) 0\t/.exec(index[0]);
  if (!match) throw fixedError('dirty-worktree', 'path is untracked, conflicted or not a regular indexed file');
  const head = gitRequired(repo.root, ['rev-parse', '--verify', 'HEAD^{commit}']).text.trim();
  let entry;
  try { entry = pathEntry(repo.root, head, relPath, repo.objectFormat); }
  catch (error) {
    if (error.code === 'fixed-path-missing') throw fixedError('dirty-worktree', 'path has staged changes');
    throw error;
  }
  if (entry.oid !== match[2] || entry.mode !== match[1]) throw fixedError('dirty-worktree', 'path has staged changes');
  const read = readDocument(repo.root, relPath, { includeBytes: true });
  if (!read.ok) {
    if (read.code === 'file-missing') throw fixedError('dirty-worktree', 'tracked workspace file is missing');
    throw readFailure(read);
  }
  const indexBytes = objectBytes(repo.root, match[2], 'blob', repo.objectFormat);
  if (indexBytes.subarray(0, 200).toString('utf8').startsWith('version https://git-lfs.github.com/spec/v1')) {
    throw fixedError('unsupported-content-transform', 'LFS pointers are not document content', { reason: 'lfs-pointer' });
  }
  const normalized = normalizedBytes(repo, read.bytes, indexBytes, attrs);
  if (!normalized.equals(indexBytes)) throw fixedError('dirty-worktree', 'path has unstaged changes');
  const filemode = gitConfig(repo, 'core.filemode');
  if (filemode === 'true' && Boolean(fs.statSync(absolute).mode & 0o111) !== (match[1] === '100755')) throw fixedError('dirty-worktree', 'file executable mode changed');
  // Recheck only after every cleanliness check: those reads must describe the
  // same HEAD as the immutable content selected by the caller, not a checkout.
  const finalHead = gitRequired(repo.root, ['rev-parse', '--verify', 'HEAD^{commit}']).text.trim();
  if (head !== commitOid || finalHead !== commitOid) throw fixedError('head-changed', 'HEAD changed while checking document cleanliness');
  return { workspaceContentHash: read.hash, eolTransformed: !read.bytes.equals(normalized) };
}
