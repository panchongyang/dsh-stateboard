// D6 write path: metadata-only adoption of operator-exported, exact bytes.
// It never creates/replaces workspace files or body blobs.
import { isDeepStrictEqual } from 'node:util';
import { BoardError } from '../errors.js';
import { exportInlineContent, inventoryInlineDocuments } from '../documents/migration-inventory.js';
import { assertExternalRecord, isExternal } from '../documents/external-model.js';
import { readFailure, readLocator } from '../documents/external-observe.js';
import { checkMigrationBackup } from '../documents/migration-backup.js';
import { migrationBlobReader } from '../documents/migration-blob.js';

function fail(code, message, details) {
  const status = { 'forbidden-role': 403, 'not-found': 404, 'invalid-command': 400 }[code] || 409;
  throw new BoardError(code, message, { status, details });
}

function authorized(cmd) {
  if (!['human', 'system'].includes(cmd.actor?.kind)) fail('forbidden-role', 'migration requires a human/system actor');
  if (cmd.authorized !== true) fail('migration-authorization-required', 'explicit migration authorization is required');
}

// The inline-write policy is the project-level escape hatch from the global
// default (which is "disabled"). Only a human may flip it, and only with an
// explicit projectRev; the change lands as project/updated so the audience,
// the actor and the new value stay auditable.
function authorizedPolicy(cmd) {
  if (cmd.actor?.kind !== 'human') fail('forbidden-role', 'doc.inline_policy is human-only');
  if (cmd.authorized !== true) fail('migration-authorization-required', 'explicit policy authorization is required');
}

function sourceRevisions(handle, doc) {
  const report = inventoryInlineDocuments({ state: handle.state, commits: handle.store.commits, readBlob: migrationBlobReader(handle.store) });
  const rows = report.revisions.filter((row) => row.docId === doc.id);
  const problems = report.missing.filter((row) => {
    const ref = row.ref || row.evidence?.ref;
    return (ref === doc.id || ref?.startsWith(doc.id + '@')) && !row.code.startsWith('missing-linked-');
  });
  if (problems.length) fail('migration-unrecoverable', 'original inline history cannot be restored', { problems });
  if (!rows.length || rows.some((row) => row.blob.status !== 'available')) fail('migration-unrecoverable', 'source history missing');
  return rows;
}

function checkTargets(handle, docId, locator) {
  const bindingRoots = Object.fromEntries((handle.service?.bindings().activeFor(handle.id) || []).map((binding) => [binding.bindingId, binding.root]));
  const report = inventoryInlineDocuments({ state: handle.state, readBlob: migrationBlobReader(handle.store), destinations: [{ docId, locator }], bindingRoots });
  if (report.conflicts.length) fail('migration-conflict', 'destination conflicts', { conflicts: report.conflicts });
  const { read } = readLocator(handle, locator, { previewBytes: 1 });
  if (!read.ok) throw readFailure(read);
  return read;
}

function checkedHistory(handle, rows) {
  for (const row of rows) {
    if (exportInlineContent(migrationBlobReader(handle.store), row.hash).status !== 'available') fail('migration-source-changed', 'source blob changed during migration', { ref: row.ref, hash: row.hash });
  }
  return rows.map((row) => ({ sourceRev: row.rev, sourceHash: row.hash, size: row.size,
    archive: { domain: 'inline-utf8', hash: row.hash, readOnly: true, gitManaged: false } }));
}

export function docMigrate(handle, cmd) {
  authorized(cmd);
  const doc = handle.state.docs[cmd.sourceDocId];
  if (!doc) fail('not-found', 'source document not found');
  if (isExternal(doc)) {
    const m = doc.migration;
    if (!m || m.sourceRev !== cmd.sourceRev || m.sourceHash !== cmd.sourceHash || !isDeepStrictEqual(m.target.locator, cmd.locator)) fail('migration-conflict', 'source already migrated with a different mapping');
    return { events: [], result: { mapping: m } }; // independent of cmdId, no I/O or rev
  }
  if (doc.rev !== cmd.sourceRev || doc.hash !== cmd.sourceHash) fail('stale-revision', 'source revision/hash changed');
  handle.service?.refreshFromDisk?.({ strict: true });
  const rows = sourceRevisions(handle, doc);
  const backup = checkMigrationBackup(handle, cmd.backup);
  const first = checkTargets(handle, doc.id, cmd.locator);
  if (first.hash !== doc.hash || first.size !== doc.size) fail('migration-conflict', 'target bytes differ from source; no file was modified', { sourceHash: doc.hash, targetHash: first.hash });
  const history = checkedHistory(handle, rows);
  const second = checkTargets(handle, doc.id, cmd.locator);
  if (second.hash !== first.hash || second.size !== first.size) fail('migration-source-changed', 'exported file changed during migration');
  checkedHistory(handle, rows); // close the source-blob race after target verification
  const at = handle.clock().toISOString();
  const migration = { v: 1, sourceDocId: doc.id, sourceRev: doc.rev, sourceHash: doc.hash,
    target: { locator: structuredClone(cmd.locator), contentIdentity: { domain: 'workspace-bytes', contentHash: first.hash, size: first.size } }, history };
  const next = { id: doc.id, source: 'external', rev: doc.rev + 1, title: doc.title, kind: doc.kind,
    status: 'draft', locator: structuredClone(cmd.locator), links: { taskIds: doc.links?.taskIds || [], planRefs: doc.links?.planRefs || [] },
    baseline: null, baselineInContext: false, unregistered: null, createdAt: doc.createdAt || at,
    updatedAt: at, ...(doc.createdBy ? { createdBy: doc.createdBy } : {}), migration };
  assertExternalRecord(next);
  return { events: [{ type: 'doc/external-migrated', docId: doc.id, sourceDocId: doc.id,
    sourceRev: doc.rev, sourceHash: doc.hash, data: next, backup }], entityRev: next.rev, result: { mapping: migration } };
}

export function docInlinePolicy(handle, cmd) {
  authorizedPolicy(cmd);
  if (!Number.isInteger(cmd.expected?.projectRev) || cmd.expected.projectRev !== handle.rev) fail('stale-revision', 'expected.projectRev is required');
  if (typeof cmd.disabled !== 'boolean') fail('invalid-command', 'disabled must be boolean');
  if ((handle.state.project.inlineWritesDisabled !== false) === cmd.disabled) return { events: [] };
  return { events: [{ type: 'project/updated', data: { ...handle.state.project, inlineWritesDisabled: cmd.disabled } }] };
}

export const DOC_MIGRATION_HANDLERS = { 'doc.external.migrate': docMigrate, 'doc.inline_policy': docInlinePolicy };
