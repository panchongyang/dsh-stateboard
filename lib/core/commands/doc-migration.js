// D6 写路径：只把操作者已导出的精确字节采纳为元数据，绝不创建/替换工作区文件或正文 blob。
// 命令负责授权、源/目标取证与竞态复核；模型操作只发布身份保留的迁移记录。
import { isDeepStrictEqual } from 'node:util';
import { BoardError } from '../errors.js';
import { exportInlineContent } from '../documents/migration-inventory.js';
import { isExternal } from '../documents/external-model.js';
import { readFailure } from '../domain/document-read-error.js';

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

function sourceRevisions(read, doc) {
  const report = read.documents.inventory();
  const rows = report.revisions.filter((row) => row.docId === doc.id);
  const problems = report.missing.filter((row) => {
    const ref = row.ref || row.evidence?.ref;
    return (ref === doc.id || ref?.startsWith(doc.id + '@')) && !row.code.startsWith('missing-linked-');
  });
  if (problems.length) fail('migration-unrecoverable', 'original inline history cannot be restored', { problems });
  if (!rows.length || rows.some((row) => row.blob.status !== 'available')) fail('migration-unrecoverable', 'source history missing');
  return rows;
}

function checkTargets(read, docId, locator) {
  const bindingRoots = read.documents.bindingRoots();
  const report = read.documents.inventory({ destinations: [{ docId, locator }], bindingRoots });
  if (report.conflicts.length) fail('migration-conflict', 'destination conflicts', { conflicts: report.conflicts });
  const { read: observed } = read.documents.readLocator(locator, { previewBytes: 1 });
  if (!observed.ok) throw readFailure(observed);
  return observed;
}

function checkedHistory(read, rows) {
  for (const row of rows) {
    if (exportInlineContent(read.documents.readMigrationBlob, row.hash).status !== 'available') {
      fail('migration-source-changed', 'source blob changed during migration', { ref: row.ref, hash: row.hash });
    }
  }
  return rows.map((row) => ({
    sourceRev: row.rev, sourceHash: row.hash, size: row.size,
    archive: { domain: 'inline-utf8', hash: row.hash, readOnly: true, gitManaged: false },
  }));
}

export function docMigrate(read, cmd) {
  authorized(cmd);
  const doc = (read.state.docs || {})[cmd.sourceDocId];
  if (!doc) fail('not-found', 'source document not found');
  if (isExternal(doc)) {
    const m = doc.migration;
    if (!m || m.sourceRev !== cmd.sourceRev || m.sourceHash !== cmd.sourceHash || !isDeepStrictEqual(m.target.locator, cmd.locator)) {
      fail('migration-conflict', 'source already migrated with a different mapping');
    }
    // 同一映射的重复提交与 cmdId 无关，不产生事件、不做任何外围 I/O。
    return { operations: [], result: { mapping: m } };
  }
  if (doc.rev !== cmd.sourceRev || doc.hash !== cmd.sourceHash) fail('stale-revision', 'source revision/hash changed');
  read.documents.refreshBindings();
  const rows = sourceRevisions(read, doc);
  const backup = read.documents.checkMigrationBackup(cmd.backup);
  const first = checkTargets(read, doc.id, cmd.locator);
  if (first.hash !== doc.hash || first.size !== doc.size) {
    fail('migration-conflict', 'target bytes differ from source; no file was modified', { sourceHash: doc.hash, targetHash: first.hash });
  }
  const history = checkedHistory(read, rows);
  const second = checkTargets(read, doc.id, cmd.locator);
  if (second.hash !== first.hash || second.size !== first.size) fail('migration-source-changed', 'exported file changed during migration');
  checkedHistory(read, rows); // close the source-blob race after target verification
  return {
    operations: [{
      kind: 'document.convertInlineToExternal',
      args: {
        sourceDocId: doc.id, sourceRev: doc.rev, sourceHash: doc.hash,
        locator: structuredClone(cmd.locator), target: { contentHash: first.hash, size: first.size },
        history, backup,
      },
    }],
  };
}

export function docInlinePolicy(read, cmd) {
  authorizedPolicy(cmd);
  return {
    operations: [{
      kind: 'project.setInlineWritePolicy',
      args: { disabled: cmd.disabled, expectedProjectRev: cmd.expected?.projectRev },
    }],
  };
}

export const DOC_MIGRATION_HANDLERS = { 'doc.external.migrate': docMigrate, 'doc.inline_policy': docInlinePolicy };
