// Read-only precondition check. The operator creates and restore-tests the backup.
import fs from 'node:fs';
import path from 'node:path';
import { BoardError } from '../errors.js';
import { readJsonLines, sha256 } from '../util.js';
import { validateCommit } from '../store/format.js';
import { readMigrationBlob } from './migration-blob.js';

function backupError(reason, details = {}) {
  return new BoardError('migration-backup-required', 'verified consistent project backup required: ' + reason, { status: 409, details: { reason, ...details } });
}

/** Verify backup log is an intact source prefix and contains every source blob. */
export function checkMigrationBackup(handle, backup) {
  try { return checkedBackup(handle, backup); } catch (error) {
    if (error.code === 'migration-backup-required') throw error;
    throw backupError('backup-unreadable-or-invalid', { cause: error.code || error.message });
  }
}

function checkedBackup(handle, backup) {
  if (!backup || backup.restoreTested !== true || typeof backup.directory !== 'string' || !path.isAbsolute(backup.directory)) throw backupError('absolute-directory-and-restore-test-required');
  const dir = fs.realpathSync(backup.directory);
  if (handle.store.dir && dir.toLowerCase() === fs.realpathSync(handle.store.dir).toLowerCase()) throw backupError('backup-is-live-store');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  if ((meta.projectId || meta.project?.id) !== handle.id) throw backupError('project-mismatch');
  const { lines, tailUnterminated } = readJsonLines(path.join(dir, 'commits.jsonl'), { validate: validateCommit });
  if (!lines.length || tailUnterminated) throw backupError('incomplete-backup-log');
  for (const commit of lines) {
    if (handle.store.commits[commit.seq - 1]?.hash !== commit.hash) throw backupError('not-source-prefix', { seq: commit.seq });
  }
  const tail = handle.store.commits.slice(lines.length);
  if (tail.some((commit) => commit.events.some((event) => event.type !== 'doc/external-migrated'))) throw backupError('source-advanced-since-backup');
  const hashes = new Set();
  for (const commit of lines) {
    for (const event of commit.events) {
      if (['doc/created', 'doc/updated'].includes(event.type)) hashes.add(event.data.hash);
    }
  }
  for (const hash of hashes) {
    const body = readMigrationBlob(path.join(dir, 'blobs'), hash);
    if (body === null || sha256(body) !== hash) throw backupError('backup-blob-mismatch', { hash });
  }
  return { projectId: handle.id, seq: lines.at(-1).seq, hash: lines.at(-1).hash, restoreTested: true };
}
