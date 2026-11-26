import { createHostReader } from './reader.js';
import { createApplication } from '../core/application/index.js';
import { createLifecycleApi } from '../core/runtime/lifecycle-api.js';

/** One application facade per plugin runtime, shared by every ingress. */
export function applicationFor(runtime) {
  if (runtime.application) return runtime.application;
  runtime.reader ??= createHostReader(runtime.service);
  runtime.application = createApplication({
    service: runtime.service,
    reader: runtime.reader,
    lifecycle: read => createLifecycleApi({ service: runtime.service, read }),
    // Value-only host bookkeeping: a tracked session keeps the committed rev so
    // Prompt/tests do not see a pre-command revision. Reads never call this.
    onCommand(dto, result) {
      const sessionId = dto.actor?.sessionId;
      if (!sessionId || !Number.isInteger(result?.projectRev)) return;
      const current = runtime.sessionProjects?.get(sessionId);
      if (current && current.projectId === dto.projectId) current.rev = result.projectRev;
      runtime.sessionProjectRefs?.get(sessionId)?.add(dto.projectId);
    },
  });
  return runtime.application;
}
