// Worker-only adapter. Never opens/replays a project store, acquires a lock,
// recovers leases, or writes a registry. Audit the captured state against fresh
// external observations using the same safety implementation as sync health.
import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData as data } from 'node:worker_threads';
import { ProjectHandle } from './handle.js';
import { ProjectService } from './service.js';
import { readMigrationBlob } from './documents/migration-blob.js';

try {
  const service = new ProjectService({ rootDir: data.rootDir, clock: () => new Date(data.now) });
  service.metas = new Map(data.metas);
  service.reloadBindings();
  const blobs = data.blobs === null ? null : new Map(data.blobs);
  const store = {
    readBlob(hash) {
      if (!/^[0-9a-f]{64}$/.test(hash || '')) return null;
      if (blobs) return blobs.get(hash) ?? null;
      if (!data.blobsDir) return null;
      try { return fs.readFileSync(path.join(data.blobsDir, hash), 'utf8'); }
      catch { return null; }
    },
    readMigrationBlob(hash) {
      return blobs ? this.readBlob(hash) : data.blobsDir ? readMigrationBlob(data.blobsDir, hash) : null;
    },
  };
  const handle = new ProjectHandle(service, data.meta, store, {
    state: data.state, timeline: [], lastSeq: data.rev, lastHash: null,
    cmdIds: new Set(), readOnly: data.readOnly,
  });
  handle.leases = new Map(data.leases);
  // Unlike compatibility sync health, unknown/unavailable evidence is surfaced
  // as a warning too: inability to observe must not assert a healthy match.
  parentPort.postMessage({ health: handle.health({ includeEvidenceWarnings: true }) });
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
