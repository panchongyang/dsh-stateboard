// 装配 I/O 能力；命令只能调用自己的端口，不能取得 store、service 或事务提交方法。
import { migrationBlobReader } from '../documents/migration-blob.js';
import { BoardError } from '../errors.js';
import { createEvidencePort } from './command-evidence.js';
import { createDocumentPort } from './command-documents.js';
import { createWorkspacePort } from './command-workspace.js';

/** 取证库只见工作副本及只读的绑定、历史和 blob。物理写入器不越过此处。 */
export function createCommandPorts({ work, service, store, preview = false }) {
  const readBlob = hash => store.readBlob(hash);
  const readMigrationBlob = hash => migrationBlobReader(store)(hash);
  const facts = {
    id: work.id, state: work.state, workspacePath: work.workspacePath, clock: work.clock, newId: work.newId,
    fileEvidenceRoot: service.spaceHome?.root, spaceHome: service.spaceHome,
    service: { bindings: () => service.bindings(), reloadBindings: () => service.reloadBindings() },
    store: { readBlob, readMigrationBlob, get dir() { return store.dir; }, get commits() { return store.commits; } },
  };
  const documents = createDocumentPort(facts, service, { preview, assertWriter: () => {
    if (store.readOnly || (typeof store.ownsLockFile === 'function' && !store.ownsLockFile())) {
      throw new BoardError('read-only', 'The workspace object writer no longer holds the project lock', { status: 503 });
    }
  } });
  return Object.freeze({ evidence: createEvidencePort(facts, documents), documents,
    workspace: createWorkspacePort(service, work.id), blobs: Object.freeze({ write: body => store.writeBlob(body) }),
    privilegedInlineWrites: service.privilegedInlineWrites === true,
  });
}
