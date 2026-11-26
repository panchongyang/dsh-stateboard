// MCP and future adapters read detached project data without opening a writer.
import { createKnowledgeReader } from './knowledge/reader.js';
import { queryProject } from './reader/query.js';
import { createWorkerRunner } from './reader/worker-run.js';
import { createCompatibilityReads } from './reader/compat.js';

/**
 * The read port owns its replay workers and knowledge capability. Every
 * capability keeps its own close/cancel/boundary; the service still owns
 * project-list work. `taskHints` is an injected pure value provider: this
 * module does not import business or application layers.
 */
export function createProjectReader(service, { taskHints = null } = {}) {
  let closed = false;
  const knowledge = createKnowledgeReader(service);
  const queryRunner = createWorkerRunner();
  const compat = createCompatibilityReads({ service, isClosed: () => closed });
  const { close: closeCompat, ...compatReads } = compat;

  return {
    ...compatReads,
    searchKnowledge: knowledge.search,
    readKnowledge: knowledge.read,

    /**
     * Unified read port for every trusted entry (HTTP, native tools, MCP adapter).
     * Returns raw value DTOs; protocol-specific redaction stays in the adapter.
     */
    query(projectId, view, params = {}, actor = {}) {
      return queryProject({
        service,
        runner: queryRunner,
        isClosed: () => closed,
        taskHints,
      }, projectId, view, params, actor);
    },

    async close() {
      closed = true;
      await Promise.all([knowledge.close(), queryRunner.close(), closeCompat()]);
    },
  };
}
