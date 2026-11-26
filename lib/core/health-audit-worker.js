// Worker-only adapter. Never opens/replays a project store, acquires a lock,
// recovers leases, or writes a registry. Audit the captured state against fresh
// external observations through a plain read port (no ProjectHandle/Service).
import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData as data } from 'node:worker_threads';
import { readMigrationBlob } from './documents/migration-blob.js';
import { fullHealth } from './health.js';
import { readPort } from './reader/execute.js';

try {
  const blobs = data.blobs === null || data.blobs === undefined ? null : new Map(data.blobs);
  const blobsDir = data.blobsDir ? path.join(data.blobsDir) : null;
  const readBlob = (hash) => {
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return null;
    if (blobs) return blobs.get(hash) ?? null;
    return blobsDir ? readMigrationBlob(blobsDir, hash) : null;
  };
  const port = readPort({
    projectId: data.projectId, state: data.state, rev: data.rev, now: data.now,
    leases: data.leases, meta: data.meta, bindings: data.bindings, readBlob, readOnly: data.readOnly,
  });
  parentPort.postMessage({ health: fullHealth(port, { includeEvidenceWarnings: true }) });
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
