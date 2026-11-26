// Read capability: the only value-producing read surface of the application.
// It never returns a writer, handle, lease or command closure.
import { normalizeRead } from './dto.js';
import { createReadPort, listProjects } from './read-port.js';
import { taskDetailFromView } from './task-detail.js';

export function createReadApi({ service, reader }) {
  const port = createReadPort({ reader });

  async function read(projectId, view, params = {}, actor = {}) {
    if (view === 'projects') return listProjects({ service, reader }, params ?? {});
    const dto = normalizeRead(projectId, view, params, actor);
    switch (dto.view) {
      case 'doc_record': {
        const value = await port.query(dto.projectId, 'doc_record', dto.params, dto.actor);
        return value.doc ?? null;
      }
      case 'task_detail': {
        // task_detail is a projection over the same task read: keep the caller's
        // cancellation context instead of opening a second, uncancellable read.
        const taskView = await port.query(dto.projectId, 'task', {
          taskId: dto.params.taskId,
          sessionId: dto.params.sessionId,
          ...(dto.params.signal !== undefined ? { signal: dto.params.signal } : {}),
        }, dto.actor);
        return taskDetailFromView(taskView, dto.params);
      }
      case 'health': {
        const value = await port.query(dto.projectId, 'health', dto.params, dto.actor);
        return value.health;
      }
      case 'summary':
        // The reader returns the raw summary envelope; unwrap nothing, recompute nothing.
        return port.query(dto.projectId, 'summary', dto.params, dto.actor);
      case 'digest': {
        const value = await port.query(dto.projectId, 'digest', dto.params, dto.actor);
        return value.digest;
      }
      default:
        // The value DTO keeps its protocol envelope (projectId/view/projectRev);
        // adapters must not swallow real protocol fields.
        return port.query(dto.projectId, dto.view, dto.params, dto.actor);
    }
  }

  return { readSource: port.source, read };
}
