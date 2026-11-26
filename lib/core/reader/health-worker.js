// Full evidence audits run here, against captured values only. No store is
// opened, no lock taken, no handle/service constructed, and no health result is
// cached across revisions.
import path from 'node:path';
import { parentPort, workerData as data } from 'node:worker_threads';
import { readMigrationBlob } from '../documents/migration-blob.js';
import { fullHealth } from '../health.js';
import { readPort } from './execute.js';

try {
  const blobs = Array.isArray(data.blobs) ? new Map(data.blobs) : null;
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
  const health = fullHealth(port, { includeEvidenceWarnings: true });
  parentPort.postMessage({ result: { health: { ...health, evidenceAudit: {
    status: 'complete', rev: data.rev, snapshotAt: new Date(data.now).toISOString(),
    completedAt: new Date().toISOString(), cached: false,
  } } } });
} catch (error) {
  parentPort.postMessage({ error: { code: 'audit-failed', message: error instanceof Error ? error.message : String(error), status: 503 } });
}
