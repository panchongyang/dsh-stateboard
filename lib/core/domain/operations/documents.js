// 文档域的具名模型操作总表。引擎按 kind 分派，命令只提交 kind+args。
import { INLINE_DOCUMENT_OPERATIONS } from './documents-inline.js';
import { EXTERNAL_DOCUMENT_OPERATIONS } from './documents-external.js';
import { MIGRATION_DOCUMENT_OPERATIONS } from './documents-migration.js';
import { RETAINED_DOCUMENT_OPERATIONS } from './documents-workspace.js';
import { DOCUMENT_RELATION_OPERATIONS } from './documents-relations.js';

export const DOCUMENT_OPERATIONS = Object.freeze({
  ...INLINE_DOCUMENT_OPERATIONS,
  ...EXTERNAL_DOCUMENT_OPERATIONS,
  ...MIGRATION_DOCUMENT_OPERATIONS,
  ...RETAINED_DOCUMENT_OPERATIONS,
  ...DOCUMENT_RELATION_OPERATIONS,
});
