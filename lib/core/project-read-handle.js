import fs from 'node:fs';
import path from 'node:path';
import { ProjectService } from './service.js';
import { ProjectHandle } from './handle.js';
import { readMigrationBlob } from './documents/migration-blob.js';

// 用途：为已捕获/验证的投影创建只读领域适配；不 init/open service，不持 writer 锁。
export function createReadHandle({ projectId, rootDir, dir, now, live }, snapshot) {
  const { meta, state, timeline = [], commits = [], leases = [], blobs } = snapshot;
  const service = new ProjectService({ rootDir, clock: () => new Date(now) });
  service.metas.set(projectId, meta);
  const memoryBlobs = blobs ? new Map(blobs) : null;
  const blobsDir = path.join(dir, 'blobs');
  const readBlob = hash => {
    if (memoryBlobs) return memoryBlobs.get(hash) ?? null;
    const directory = fs.lstatSync(blobsDir, { throwIfNoEntry: false });
    return directory?.isDirectory() ? readMigrationBlob(blobsDir, hash) : null;
  };
  const store = { commits, readBlob, readMigrationBlob: readBlob };
  const handle = new ProjectHandle(service, meta, store, {
    state, timeline, lastSeq: state.lastSeq, lastHash: state.lastHash, cmdIds: new Set(), readOnly: !live,
  });
  handle.leases = new Map(leases);
  return handle;
}
