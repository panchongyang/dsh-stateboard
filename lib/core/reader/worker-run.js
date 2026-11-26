// Bounded worker runner for the read port. Workers are terminated as soon as a
// result, error, deadline, abort or close settles the call, so no read retains a
// writer, handle or file descriptor after it answers.
import { Worker } from 'node:worker_threads';
import { BoardError } from '../errors.js';

export const READ_TIMEOUT_MS = 30_000;
const MAX_ACTIVE = 2;

function unavailable(code, message) {
  return new BoardError(code, message, { status: 503 });
}

export function createWorkerRunner({ maxActive = MAX_ACTIVE, timeoutMs = READ_TIMEOUT_MS } = {}) {
  const jobs = new Set();
  let active = 0;

  function run(url, workerData, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(unavailable('read-cancelled', 'Project read was cancelled'));
    if (active >= maxActive) return Promise.reject(unavailable('read-busy', 'Project reads are busy; retry later'));
    const worker = new Worker(url, {
      workerData,
      env: { ...process.env, PATH: process.env.PATH || process.env.Path || '' },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    active += 1;
    return new Promise((resolve, reject) => {
      let stopping;
      const finish = (error, value) => {
        if (stopping) return stopping;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        stopping = worker.terminate().catch(() => {
          error ??= unavailable('project-unreadable', 'Project read worker could not stop');
        }).then(() => {
          active -= 1;
          jobs.delete(cancel);
          if (error) reject(error); else resolve(value);
        });
        return stopping;
      };
      const cancel = () => finish(unavailable('closed', 'Project reader is closed'));
      const abort = () => finish(unavailable('read-cancelled', 'Project read was cancelled'));
      const timer = setTimeout(() => finish(unavailable('read-expired', 'Project read exceeded its deadline')), timeoutMs);
      jobs.add(cancel);
      signal?.addEventListener('abort', abort, { once: true });
      worker.once('message', (message) => {
        if (message && message.error) {
          const { code, message: text, status } = message.error;
          finish(new BoardError(code, text, { status }));
        } else finish(null, message?.result);
      });
      worker.once('error', () => finish(unavailable('project-unreadable', 'Project read worker failed')));
      worker.once('exit', () => finish(unavailable('project-unreadable', 'Project read worker exited without a result')));
    });
  }

  async function close() {
    await Promise.all([...jobs].map((cancel) => cancel()));
  }

  return { run, close, jobs };
}
