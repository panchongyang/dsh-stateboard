import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { JsonlStore } from './store.js';
import { projectListError, projectSummary } from './project-list-reader.js';

const rows = workerData.map(({ id, dir }) => {
  let store;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    if (meta?.projectId !== id || !meta.project) throw new Error('project metadata missing or invalid');
    store = new JsonlStore(dir, meta, { lock: false });
    const data = store.open();
    return projectSummary(id, data.state, data.lastSeq);
  } catch (error) {
    return projectListError(id, error);
  } finally {
    try { store.close(); } catch { /* lock-free reader, never repair */ }
  }
});
parentPort.postMessage(rows);
