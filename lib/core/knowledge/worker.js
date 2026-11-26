import { parentPort, workerData } from 'node:worker_threads';
import { readKnowledgeSnapshot } from './snapshot.js';
import { openKnowledgeIndex } from './sqlite-index.js';
import { searchKnowledge } from './search.js';
import { readKnowledge } from './read.js';
import { createModelMaterial } from './model-material.js';
import { canonicalJSON, sha256 } from '../util.js';
import { KNOWLEDGE_CHUNK_VERSION, KNOWLEDGE_WORKSPACE_READER_VERSION } from '../../shared/knowledge.js';

const SAFE_ERRORS = new Set(['invalid-command', 'not-found', 'read-unstable', 'project-unreadable',
  'knowledge-resource-limit', 'knowledge-reference-invalid', 'knowledge-cursor-stale', 'knowledge-response-limit', 'space-home-unavailable']);

// 用途：完整读取、Git 观测与同步 SQLite 只在专用 worker 内运行，不占用写入线程。
async function run(query) {
  const snapshot = readKnowledgeSnapshot(query);
  try {
    // A failed index attempt must not retain rows for a subsequent scan page.
    const collect = operation => {
      const material = query.collectModelMaterial === true ? createModelMaterial() : undefined;
      const result = operation(material);
      return material ? { result, modelMaterial: material.finish() } : { result };
    };
    if (query.operation === 'read') return collect(material => readKnowledge(snapshot, query.args, material));
    const scope = snapshot.workspace && sha256(canonicalJSON({ projectId: query.projectId,
      workspace: snapshot.workspace.workspaceContext, scope: snapshot.workspace.scopeKey, medium: snapshot.workspace.mediumKey,
      reader: KNOWLEDGE_WORKSPACE_READER_VERSION, chunker: KNOWLEDGE_CHUNK_VERSION }));
    // Volatile grants must not create an unbounded file per credential or restart.
    // Collisions rebuild inside a transaction; exact scope is always checked before any indexed read.
    const namespace = scope && sha256('workspace-knowledge-slot:' + (parseInt(scope.slice(0, 2), 16) % 4));
    const index = await openKnowledgeIndex(query.rootDir, query.projectId, { ...query.options, namespace, scope });
    try { return collect(material => searchKnowledge(index, snapshot, query.args, query.options, material)); }
    catch (error) {
      if (SAFE_ERRORS.has(error.code)) throw error;
      if (!/busy|locked|disk is full|database or disk is full|out of memory/i.test(error.message)) index.invalidate?.();
      return collect(material => searchKnowledge({ engine: 'scan', reason: 'index-unavailable' }, snapshot, query.args, query.options, material));
    } finally { index.close?.(); }
  } finally { snapshot.workspaceReader?.close(); }
}

try { parentPort.postMessage(await run(workerData)); }
catch (error) {
  const known = SAFE_ERRORS.has(error.code);
  parentPort.postMessage({ error: { code: known ? error.code : 'project-unreadable',
    message: known ? error.message : 'Project knowledge sources are unavailable', status: known ? error.status : 503 } });
}
