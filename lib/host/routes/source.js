import { requireWebActor } from '../auth.js';

/**
 * The HTTP ingress capability. It exposes reads (delegated to the application
 * read port) and one write entry (the application command entry); it never
 * hands out an opened writer.
 */
export function webSource(application, projectId, authority) {
  const actor = requireWebActor(authority);
  return {
    projectId,
    read(view, params) { return application.read(projectId, view, params, actor); },
    command(command) { return application.command(projectId, { ...command, actor }); },
  };
}
