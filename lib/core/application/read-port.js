// Read port: the only way an ingress reads project state.
//
// It delegates to the read owner's unified reader.query(projectId, view,
// params, actor). There is no fallback chain: if the reader has no query port
// the read fails closed instead of opening a writer or a second read path.
// summary/doc_record arrive as raw envelopes from the reader; adapters unwrap
// them instead of recomputing (recomputing drifts readOnly/status/fields).
import { BoardError } from '../errors.js';

export function createReadPort({ reader }) {
  if (!reader || typeof reader.query !== 'function') {
    throw new BoardError('read-port-unavailable', 'the project reader does not expose the unified query port', { status: 503 });
  }
  return {
    source: 'reader.query',
    query(projectId, view, params = {}, actor = {}) {
      return reader.query(projectId, view, params, actor);
    },
  };
}

/**
 * The web read surface lists every registered project with its full display
 * row. The narrow cursor page belongs to the metadata credential
 * (reader.listProjects); reusing it here silently truncates the board to 30
 * rows and drops workspacePath/counts/readOnly/lastAt.
 */
export async function listProjects({ service, reader }, _params = {}) {
  if (typeof service.listProjectsAsync === 'function') {
    return { projects: await service.listProjectsAsync(), nextCursor: null };
  }
  if (reader && typeof reader.listProjects === 'function') return reader.listProjects({});
  return { projects: [], nextCursor: null };
}
