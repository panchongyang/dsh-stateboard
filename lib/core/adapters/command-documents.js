// 文档命令可获得新鲜观测、备份和迁移盘点，但不能取得服务或追加日志。
import { bindingById, mainBinding, readLocator } from '../documents/external-observe.js';
import { retainedDocumentPort } from './retained-documents.js';
import { checkMigrationBackup } from '../documents/migration-backup.js';
import { inventoryInlineDocuments } from '../documents/migration-inventory.js';

/** 限定在本项目和其受信绑定上的文档能力。只有实际使用它的命令才做 I/O。 */
export function createDocumentPort(facts, service, options = {}) {
  const roots = () => Object.fromEntries(service.bindings().activeFor(facts.id).map(b => [b.bindingId, b.root]));
  return Object.freeze({
    ...retainedDocumentPort(facts, service, options),
    refreshBindings: () => { service.refreshFromDisk({ strict: true }); },
    mainBinding: () => structuredClone(mainBinding(facts)),
    bindingById: id => structuredClone(bindingById(facts, id)),
    readLocator: (locator, options) => readLocator(facts, locator, options),
    bindingRoots: roots,
    readMigrationBlob: hash => facts.store.readMigrationBlob(hash),
    checkMigrationBackup: backup => checkMigrationBackup(facts, backup),
    inventory: (options = {}) => inventoryInlineDocuments({ state: facts.state,
      commits: options.destinations ? [] : facts.store.commits,
      readBlob: hash => facts.store.readMigrationBlob(hash),
      destinations: options.destinations, bindingRoots: options.bindingRoots ?? (options.destinations ? roots() : {}),
    }),
  });
}
