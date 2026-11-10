// D6 provenance is metadata, never a claim that retained inline bytes are in Git.
import { isDeepStrictEqual } from 'node:util';
import { validateRelPath } from './locate.js';

const HEX = /^[0-9a-f]{64}$/;
export const MIGRATED_EVENT = 'doc/external-migrated';

export function migrationProblem(doc) {
  const m = doc?.migration;
  if (m === undefined) return null;
  if (!m || m.v !== 1 || m.sourceDocId !== doc.id) return 'migration source identity invalid';
  if (!Number.isInteger(m.sourceRev) || m.sourceRev < 1 || !HEX.test(m.sourceHash || '')) return 'migration source revision/hash invalid';
  if (!m.target || !m.target.locator?.bindingId || !validateRelPath(m.target.locator.relPath).ok) return 'migration target locator invalid';
  const content = m.target.contentIdentity;
  if (content?.domain !== 'workspace-bytes' || content.contentHash !== m.sourceHash || !Number.isSafeInteger(content.size) || content.size < 0) return 'migration target content identity invalid';
  if (!Array.isArray(m.history) || !m.history.length) return 'migration history missing';
  const seen = new Set();
  for (const row of m.history) {
    if (!Number.isInteger(row.sourceRev) || row.sourceRev < 1 || row.sourceRev > m.sourceRev || seen.has(row.sourceRev)) return 'migration history revision invalid';
    seen.add(row.sourceRev);
    if (!HEX.test(row.sourceHash || '') || !Number.isSafeInteger(row.size) || row.size < 0) return 'migration history content invalid';
    if (row.archive?.domain !== 'inline-utf8' || row.archive.hash !== row.sourceHash || row.archive.readOnly !== true || row.archive.gitManaged !== false) return 'migration archive provenance invalid';
  }
  const head = m.history.find((row) => row.sourceRev === m.sourceRev);
  if (!head || head.sourceHash !== m.sourceHash || head.size !== content.size) return 'migration source absent from history';
  return null;
}

export function migrationTransitionProblem(existing, doc, event) {
  const problem = migrationProblem(doc);
  if (problem || !doc.migration) return problem || 'migration mapping missing';
  const m = doc.migration;
  if (event.sourceDocId !== m.sourceDocId || event.sourceRev !== m.sourceRev || event.sourceHash !== m.sourceHash) return 'event source does not match migration';
  if (existing?.source === 'external') return isDeepStrictEqual(existing.migration, m) ? null : 'conflicting migration replay';
  if (!existing || existing.rev !== m.sourceRev || existing.hash !== m.sourceHash || existing.size !== m.target.contentIdentity.size) return 'migration source changed';
  if (doc.rev !== existing.rev + 1 || !isDeepStrictEqual(doc.locator, m.target.locator)) return 'migration target/rev mismatch';
  const normalizedLinks = { taskIds: existing.links?.taskIds || [], planRefs: existing.links?.planRefs || [] };
  if (!isDeepStrictEqual(doc.links, normalizedLinks) || doc.title !== existing.title || doc.kind !== existing.kind) return 'migration must preserve source metadata';
  return null;
}

export function historicalMigrationProblem(doc, revisions) {
  const expected = [...revisions.values()].filter((row) => row.id === doc.id);
  const history = doc.migration.history;
  if (history.length !== expected.length) return 'migration history is not exhaustive';
  for (const source of expected) {
    const row = history.find((entry) => entry.sourceRev === source.rev);
    if (!row || row.sourceHash !== source.hash || row.size !== source.size) return 'migration history does not match original revision';
  }
  return null;
}
