// Both transports publish the same business catalogue. Credentials only select
// a principal and an authorization scope; they never select another handler.
export const AGENT_CONTEXT_TTL_MS = 24 * 60 * 60 * 1000;
export const AGENT_CONTEXT_PARAMETER = Object.freeze({
  type: 'string',
  description: 'Opaque project context from project_session op=open. Reuse it for this logical agent; keep it private. Native DSH may omit it to use its owning session.',
});
export const METADATA_VIEWS = Object.freeze(['tasks', 'task_overview', 'work_context']);
export const TASK_DETAIL_SECTIONS = Object.freeze(['description', 'acceptance', 'evidence', 'audit', 'timeline', 'operations', 'documents', 'intent']);
export const TASK_DETAIL_DEFAULT_BYTES = 8192;
export const TASK_DETAIL_MAX_BYTES = 24576;

export function metadataOperation(name, args) {
  return (name === 'project_session' && ['projects', 'open'].includes(args.op))
    || (name === 'project_board' && METADATA_VIEWS.includes(args.view));
}
