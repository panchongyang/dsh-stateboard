import { BoardError } from '../errors.js';
import { exportInlineContent } from './migration-inventory.js';
import { migrationBlobReader } from './migration-blob.js';

/** Explicit compatibility archive, not workspace/Git content or a mutable doc. */
export function readInlineArchive(handle, docId, sourceRev) {
  const doc = handle.state.docs[docId];
  const row = doc?.migration?.history.find((entry) => entry.sourceRev === sourceRev);
  if (!row) throw new BoardError('not-found', 'migrated inline revision not found', { status: 404 });
  const content = exportInlineContent(migrationBlobReader(handle.store), row.sourceHash);
  if (content.status !== 'available') throw new BoardError('migration-unrecoverable', 'original archive unavailable: ' + content.status, { status: 409, details: { docId, sourceRev, hash: row.sourceHash } });
  return { schemaVersion: 1, source: 'inline-archive', docId, sourceRev, readOnly: true, gitManaged: false, ...content };
}
