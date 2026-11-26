// D6 迁移的具名模型操作：只做元数据转换并保留身份/历史。
// 目标文件、备份与源 blob 的取证由调用方在事务外完成；操作只收已核实的事实。
import { isDeepStrictEqual } from 'node:util';
import { BoardError } from '../../errors.js';
import { assertExternalRecord, isExternal } from '../../documents/external-model.js';
import { migrateInlineDocument } from '../document-transitions.js';

function fail(code, message, details = null) {
  const status = { 'forbidden-role': 403, 'not-found': 404, 'invalid-command': 400 }[code] || 409;
  return new BoardError(code, message, { status, details });
}

function requireMigration(request) {
  if (!['human', 'system'].includes(request?.actor?.kind)) throw fail('forbidden-role', 'migration requires a human/system actor');
  if (request.authorized !== true) throw fail('migration-authorization-required', 'explicit migration authorization is required');
}

function assertFields(args, allowed) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail('invalid-command', 'operation arguments must be an object');
  for (const key of Object.keys(args)) if (!allowed.includes(key)) throw fail('invalid-command', 'unsupported migration operation field: ' + key);
}

function mappingConflict(doc, args) {
  const migration = doc.migration;
  if (!migration || migration.sourceRev !== args.sourceRev || migration.sourceHash !== args.sourceHash
    || !isDeepStrictEqual(migration.target?.locator, args.locator)) {
    throw fail('migration-conflict', 'source already migrated with a different mapping');
  }
  return migration;
}

/** 重复提交同一映射不产生事件；新迁移从源记录的实际值派生不可变映射。 */
export function migrateInlineDocumentOp(work, args, request) {
  requireMigration(request);
  assertFields(args, ['sourceDocId', 'sourceRev', 'sourceHash', 'locator', 'target', 'history', 'backup']);
  const doc = (work.state.docs || {})[args.sourceDocId];
  if (!doc) throw fail('not-found', 'source document not found');
  // 已提交映射的重跑只认不可变 source/locator；不重新依赖备份或证明时刻。
  if (isExternal(doc)) return { events: [], result: { mapping: mappingConflict(doc, args) } };
  const backup = args.backup;
  if (!backup || Array.isArray(backup) || backup.restoreTested !== true || backup.projectId !== work.state.project.id
    || !Number.isSafeInteger(backup.seq) || backup.seq < 1 || backup.seq > work.rev
    || typeof backup.hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(backup.hash)
    || (backup.seq === work.rev && backup.hash !== work.state.lastHash)) {
    throw fail('migration-backup-required', 'verified backup of this project prefix is required');
  }
  assertFields(backup, ['projectId', 'seq', 'hash', 'restoreTested']);
  if (!Number.isInteger(args.sourceRev) || doc.rev !== args.sourceRev || doc.hash !== args.sourceHash) throw fail('stale-revision', 'source revision/hash changed');
  if (!args.target || args.target.contentHash !== doc.hash || args.target.size !== doc.size) throw fail('migration-conflict', 'target bytes differ from source');
  assertFields(args.target, ['contentHash', 'size']);
  for (const other of Object.values(work.state.docs || {})) {
    if (other.id !== doc.id && isExternal(other) && !other.unregistered && isDeepStrictEqual(other.locator, args.locator)) throw fail('migration-conflict', 'destination already registered');
  }
  const at = work.clock().toISOString();
  const migration = {
    v: 1, sourceDocId: doc.id, sourceRev: doc.rev, sourceHash: doc.hash,
    target: {
      locator: structuredClone(args.locator),
      contentIdentity: { domain: 'workspace-bytes', contentHash: args.target.contentHash, size: args.target.size },
    },
    history: structuredClone(args.history),
  };
  const record = migrateInlineDocument(doc, {
    id: doc.id, source: 'external', rev: doc.rev + 1, title: doc.title, kind: doc.kind,
    locator: structuredClone(args.locator),
    links: { taskIds: doc.links?.taskIds || [], planRefs: doc.links?.planRefs || [] },
    baseline: null, baselineInContext: false, unregistered: null, createdAt: doc.createdAt || at,
    updatedAt: at, ...(doc.createdBy ? { createdBy: structuredClone(doc.createdBy) } : {}), migration,
  });
  assertExternalRecord(record);
  return {
    events: [{
      type: 'doc/external-migrated', docId: doc.id, sourceDocId: doc.id,
      sourceRev: doc.rev, sourceHash: doc.hash, data: record, backup: structuredClone(args.backup),
    }],
    entityRev: record.rev, result: { mapping: migration },
  };
}

export const MIGRATION_DOCUMENT_OPERATIONS = Object.freeze({
  'document.convertInlineToExternal': migrateInlineDocumentOp,
});
