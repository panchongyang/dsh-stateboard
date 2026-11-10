// Explicit full audits only. No settled-result cache: files and Git can change
// without a board revision. The prompt must never schedule work through here.
import { Worker } from 'node:worker_threads';
import { BoardError } from './errors.js';

const MAX_ACTIVE = 2;
const MAX_QUEUED = 16;
const flights = new WeakMap();
const queue = [];
let active = 0;
const failure = (code, message) => new BoardError(code, message, { status: 503 });

function pump() {
  while (active < MAX_ACTIVE && queue.length) {
    const job = queue.shift();
    if (job.settled) continue;
    if (job.handle.closed || job.handle.rev !== job.rev) {
      job.finish(failure('audit-stale', 'project closed or changed before audit started'));
      continue;
    }
    active += 1;
    job.running = true;
    try {
      const h = job.handle;
      job.worker = new Worker(new URL('./health-audit-worker.js', import.meta.url), {
        // Windows main-thread env lookup is case-insensitive, worker lookup is
        // not. Preserve the system PATH under the spelling Git resolution uses.
        env: { ...process.env, PATH: process.env.PATH || process.env.Path || '' },
        workerData: {
          state: h.state, rev: h.rev, meta: h.meta, readOnly: h.readOnly,
          now: h._nowMs(), leases: [...h.leases],
          rootDir: h.service.rootDir, metas: [...h.service.metas],
          blobs: h.store.blobs instanceof Map ? [...h.store.blobs] : null,
          blobsDir: h.store.blobsDir || null,
        },
      });
      job.worker.once('message', (message) => {
        if (h.closed || h.rev !== job.rev || Date.now() - job.startedAt > job.maxAgeMs) {
          job.finish(failure('audit-stale', 'audit snapshot closed, changed or expired; request a fresh audit'));
        } else if (message.error) {
          job.finish(failure('audit-failed', message.error));
        } else {
          job.finish(null, { ...message.health, evidenceAudit: {
            status: 'complete', rev: job.rev, snapshotAt: new Date(job.startedAt).toISOString(),
            completedAt: new Date().toISOString(), cached: false,
          } });
        }
      });
      job.worker.once('error', (error) => job.finish(failure('audit-failed', error.message)));
      job.worker.once('exit', (code) => {
        if (!job.settled) job.finish(failure('audit-failed', 'audit worker exited without result: ' + code));
      });
    } catch (error) { job.finish(error); }
  }
}

export function isolatedHealth(handle, { maxAgeMs = 30_000 } = {}) {
  handle._ensureOpen();
  const existing = flights.get(handle);
  if (existing) {
    if (existing.rev === handle.rev) return existing.promise;
    existing.finish(failure('audit-stale', 'project changed during audit'));
  }
  if (queue.length >= MAX_QUEUED) return Promise.reject(failure('audit-busy', 'full audit queue is bounded; retry later'));
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || maxAgeMs > 120_000) {
    return Promise.reject(failure('invalid-command', 'audit maxAgeMs must be between 0 and 120000'));
  }
  const job = { handle, rev: handle.rev, startedAt: Date.now(), maxAgeMs, settled: false, running: false };
  job.promise = new Promise((resolve, reject) => {
    job.finish = (error, result) => {
      if (job.settled) return;
      job.settled = true;
      clearTimeout(job.timer);
      const at = queue.indexOf(job);
      if (at !== -1) queue.splice(at, 1);
      if (flights.get(handle) === job) flights.delete(handle);
      if (error) reject(error); else resolve(result);
      // Keep the concurrency slot until termination actually finishes. A worker
      // in spawnSync may take time to stop; don't pile up replacements meanwhile.
      if (job.running) {
        const stopped = job.worker ? job.worker.terminate() : Promise.resolve();
        Promise.resolve(stopped).catch(() => {}).finally(() => { active -= 1; pump(); });
      } else pump();
    };
  });
  job.timer = setTimeout(() => job.finish(failure('audit-expired', 'full audit expired; no healthy result retained')), maxAgeMs);
  flights.set(handle, job);
  queue.push(job);
  pump();
  return job.promise;
}

export function cancelHealth(handle) {
  const job = flights.get(handle);
  if (job) job.finish(failure('closed', 'project closed during audit'));
}
