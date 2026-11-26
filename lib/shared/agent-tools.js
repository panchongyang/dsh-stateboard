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

// The shared application allowlist covers every read of retained document facts.
// Workspace-body operations have different selectors from relation reads.
export const WORKSPACE_BODY_READ_VIEWS = Object.freeze({
  history: 'workspace_history',
  read_version: 'workspace_version',
  compare: 'workspace_compare',
});
export const RETAINED_DOC_OPS = Object.freeze(['capture', ...Object.keys(WORKSPACE_BODY_READ_VIEWS)]);
export const DOC_RELATION_READ_VIEW = 'doc_relations';
export const RETAINED_DOC_READ_VIEWS = Object.freeze({ ...WORKSPACE_BODY_READ_VIEWS, relations: DOC_RELATION_READ_VIEW });

// P3 workspace projection. The owning space is the only source: callers never
// pass a workspace root, a project id or an authorization scope. Every cursor is
// bound by core to (scopeKey, projectId, op); replaying it under another
// credential cannot silently continue the previous scan.
export const PROJECTION_DOC_OPS = Object.freeze(['discover', 'read_current', 'refresh_current']);
export const PROJECTION_DOC_FIELDS = Object.freeze({
  discover: Object.freeze(['cursor']),
  read_current: Object.freeze(['relPath', 'maxBytes']),
  refresh_current: Object.freeze(['relPath']),
});
export const PROJECTION_DEFAULT_MAX_BYTES = 262144;
export const PROJECTION_MAX_BYTES = 1024 * 1024;
export const PROJECTION_CURSOR_MAX_LENGTH = 512;
export const PROJECTION_RELPATH_MAX_LENGTH = 4096;
// A root/authorization change or a cursor from another root, credential, policy
// or scan generation is not resumed silently: the caller must restart discovery.
export const PROJECTION_RESTART_REQUIRED = 'restart-required';

export function metadataOperation(name, args) {
  return (name === 'project_session' && ['projects', 'open'].includes(args.op))
    || (name === 'project_board' && METADATA_VIEWS.includes(args.view));
}
