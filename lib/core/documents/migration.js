// Explicit offline orchestration; no store discovery or workspace file writes.
import { randomUUID } from 'node:crypto';
import { inventoryInlineDocuments } from './migration-inventory.js';
import { BoardError } from '../errors.js';
import { migrationBlobReader } from './migration-blob.js';

export async function migrateInlineDocuments(handle, { mappings, authorized, backup, actor = { kind: 'human', via: 'doc-migration' } }) {
  if (authorized !== true || !['human', 'system'].includes(actor?.kind)) throw new BoardError('migration-authorization-required', 'human/system authorization is required before migration inventory', { status: 403 });
  if (!Array.isArray(mappings) || !mappings.length) throw new TypeError('nonempty mappings array required');
  if (mappings.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) throw new TypeError('mapping entries must be objects');
  const report = inventoryInlineDocuments({ state: handle.state, commits: handle.store.commits,
    readBlob: migrationBlobReader(handle.store), destinations: mappings.map((row) => ({ docId: row.sourceDocId, locator: row.locator })) });
  const problems = [...report.conflicts];
  const seen = new Map();
  for (const row of mappings) {
    const previous = seen.get(row.sourceDocId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(row)) problems.push({ code: 'source-mapping-conflict', sourceDocId: row.sourceDocId });
    seen.set(row.sourceDocId, row);
  }
  if (problems.length) return { schemaVersion: 1, mappings: [], problems };
  const resolved = [];
  for (const row of mappings) {
    try {
      const result = await handle.command({ op: 'doc.external.migrate', cmdId: 'migration_' + randomUUID(), actor,
        authorized, backup, sourceDocId: row.sourceDocId, sourceRev: row.sourceRev, sourceHash: row.sourceHash, locator: row.locator });
      resolved.push(result.mapping);
    } catch (error) {
      problems.push({ sourceDocId: row.sourceDocId, code: error.code || 'migration-error', message: error.message, details: error.details || null });
      if (handle.readOnly || ['log-forked', 'log-busy'].includes(error.code)) break;
    }
  }
  return { schemaVersion: 1, mappings: resolved, problems };
}
