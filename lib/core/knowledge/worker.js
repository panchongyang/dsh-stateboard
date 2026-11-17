import { parentPort, workerData } from 'node:worker_threads';
import { readKnowledgeSnapshot } from './snapshot.js';
import { openKnowledgeIndex } from './sqlite-index.js';
import { searchKnowledge } from './search.js';
import { readKnowledge } from './read.js';

const SAFE_ERRORS = new Set(['invalid-command', 'not-found', 'read-unstable', 'project-unreadable',
  'knowledge-resource-limit', 'knowledge-reference-invalid', 'knowledge-cursor-stale', 'knowledge-response-limit']);

// 用途：完整读取、Git 观测与同步 SQLite 只在专用 worker 内运行，不占用写入线程。
async function run(query) {
  const snapshot = readKnowledgeSnapshot(query);
  if (query.operation === 'read') return readKnowledge(snapshot, query.args);
  const index = await openKnowledgeIndex(query.rootDir, query.projectId, query.options);
  try {
    return searchKnowledge(index, snapshot, query.args, query.options);
  } catch (error) {
    if (SAFE_ERRORS.has(error.code)) throw error;
    // 索引损坏、不可写、事务失败只降低检索能力，不回写权威来源。
    index.invalidate?.();
    return searchKnowledge({ engine: 'scan', reason: 'index-unavailable' }, snapshot, query.args, query.options);
  } finally { index.close?.(); }
}

try { parentPort.postMessage({ result: await run(workerData) }); }
catch (error) {
  const known = SAFE_ERRORS.has(error.code);
  parentPort.postMessage({ error: { code: known ? error.code : 'project-unreadable',
    message: known ? error.message : 'Project knowledge sources are unavailable', status: known ? error.status : 503 } });
}
