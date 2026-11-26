// Application facade: one write entry, one read capability and a separate
// lifecycle capability. Transport adapters depend on this facade only.
import { normalizeCommand } from './dto.js';
import { createReadApi } from './read-api.js';

export { READ_VIEWS } from './dto.js';

export function createApplication({ service, reader, onCommand, lifecycle }) {
  const readApi = createReadApi({ service, reader });

  return {
    readSource: readApi.readSource,
    read: readApi.read,

    async command(projectId, command, { agentSessionSource } = {}) {
      const dto = normalizeCommand(projectId, command);
      // Only a trusted ingress may name the session-binding source; it is never
      // read from the request envelope. The model binds it in the same commit.
      const result = await service.command(dto.projectId, dto,
        agentSessionSource === undefined ? undefined : { agentSessionSource });
      // Host bookkeeping (session rev, not a writer) observes the committed value.
      onCommand?.(dto, result);
      return result;
    },

    /** Trusted native owning workspace only: no cwd field in a public command. */
    async commandInWorkspace(workspacePath, command, { agentSessionSource } = {}) {
      const { projectId, result } = await service.commandInWorkspace(workspacePath, command, { agentSessionSource });
      onCommand?.({ ...command, projectId }, result);
      return { projectId, result };
    },

    capabilities: lifecycle?.(readApi.read) ?? Object.freeze({}),
  };
}
