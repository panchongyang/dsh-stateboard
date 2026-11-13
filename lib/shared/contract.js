/**
 * Cross-half contract: the one place that defines task states, command ops,
 * evidence/doc kinds and API paths.
 *
 * Every value here is part of the external contract (docs/CONTRACT.md). The client
 * half cannot import this file yet (it is still a hand-written UMD bundle, no
 * build step); `test/contract-parity.test.mjs` keeps its literal copies honest.
 * Once the client source is split (M2), `src/client` imports this module
 * directly and the parity test shrinks to the tool/HTTP surface.
 */

export const TASK_STATES = [
  'backlog',
  'ready',
  'in_progress',
  'review',
  'done',
  'blocked',
  'canceled',
  'interrupted',
];

/** States that still need attention (not terminal). */
export const ACTIVE_STATES = [
  'backlog',
  'ready',
  'in_progress',
  'review',
  'blocked',
  'interrupted',
];

export const TERMINAL_STATES = ['done', 'canceled'];

/**
 * Accepted command ops, in dispatch-table order. Keep this list in sync with
 * `ProjectHandle._execute`; `contract-parity.test.mjs` compares them.
 */
export const COMMAND_OPS = [
  'project.update',
  'project.relocate',
  'plan.create',
  'plan.publish',
  'plan.revise',
  'plan.adopt',
  'plan.release',
  'plan.rename',
  'plan.archive',
  'plan.unarchive',
  'plan.focus',
  'task.create',
  'task.update',
  'task.gate',
  'task.ready',
  'task.claim',
  'task.begin',
  'task.renew',
  'task.submit',
  'task.verify',
  'task.reject',
  'task.block',
  'task.interrupt',
  'task.unblock',
  'task.release',
  'task.reconcile',
  'task.cancel',
  'task.reopen',
  'doc.put',
  'doc.link',
  'doc.external.register',
  'doc.external.update_meta',
  'doc.external.relocate',
  'doc.external.rebind',
  'doc.external.confirm',
  'doc.external.unregister',
  'doc.external.migrate',
  'doc.inline_policy',
  'session.checkpoint',
  'session.handoff',
  'override',
];

/** Task tool sub-ops, derived so a new command cannot silently miss the tool. */
export const TASK_OPS = COMMAND_OPS.filter((op) => op.startsWith('task.')).map((op) => op.slice(5));

export const EVIDENCE_KINDS = ['file', 'command', 'doc', 'url', 'note', 'test'];

export const DOC_KINDS = ['spec', 'design', 'decision', 'note', 'runbook'];

const freezeFields = (fields) => Object.freeze(fields);

/**
 * Strict write-surface fields for external documents (CONTRACT §6.1). The tool
 * and the HTTP routes share this table: a write may only carry these fields
 * plus the HTTP envelope (`cmdId`, `schemaVersion`). Anything else is rejected
 * before a command runs, so a misspelled field cannot silently fall back to a
 * default (e.g. `bindingID` must not register against the main binding).
 */
export const DOC_EXTERNAL_WRITE_FIELDS = Object.freeze({
  register: freezeFields(['title', 'kind', 'bindingId', 'relPath', 'links']),
  update_meta: freezeFields(['docId', 'expectedMetaRev', 'title', 'kind', 'links', 'status', 'reason']),
  relocate: freezeFields(['docId', 'expectedMetaRev', 'bindingId', 'relPath']),
  confirm: freezeFields(['docId', 'expectedMetaRev', 'expectedContentHash']),
  unregister: freezeFields(['docId', 'expectedMetaRev', 'reason']),
});

/** Envelope fields accepted by the external HTTP routes on top of the command fields. */
export const DOC_EXTERNAL_HTTP_ENVELOPE = freezeFields(['cmdId', 'schemaVersion']);

export const TOOL_NAMES = ['project_board', 'project_plan', 'project_task', 'project_doc', 'project_session'];

/** Route templates as registered by lib/host/routes.js and called by the UI. */
export const API_PATHS = {
  projects: '/projects',
  board: '/projects/:id/board',
  task: '/projects/:id/tasks/:taskId',
  plans: '/projects/:id/plans',
  plan: '/projects/:id/plans/current',
  planDetail: '/projects/:id/plans/:planId',
  docs: '/projects/:id/docs',
  doc: '/projects/:id/docs/:docId',
  docsExternal: '/projects/:id/docs/external',
  docsExternalDoc: '/projects/:id/docs/external/:docId',
  health: '/projects/:id/health',
  commands: '/projects/:id/commands',
};

/** Page bounds shared by project read projections and the MCP tool schemas. */
export const PROJECT_READ_PAGE_DEFAULT = 30;
export const PROJECT_READ_PAGE_MAX = 100;

export const PROJECT_READ_ID_PATTERNS = Object.freeze({
  project: '^prj_[0-9a-z]{1,124}$',
  task: '^tsk_[0-9a-z]{1,124}$',
});

export const MCP_READ_TOOLS = Object.freeze({
  listProjects: 'list_projects',
  listTasks: 'list_tasks',
  getTask: 'get_task',
  getWorkContext: 'get_work_context',
});

/** Board-owned usage guidance for native and MCP agent entry points. */
export const PROJECT_WORK_TRIGGER = 'Check ProjectBoard first when a task is named, when resuming known project work, or when handing off an existing task. Skip this for casual questions.';
export const PLAN_STAGE_WORK_GUIDANCE = 'Prefer implementing and submitting the current stage before reviewing its tasks together. Verify each task with the existing audit rules. If the stage is waiting, resolve prerequisites or review an already submitted task to unblock it.';

export const MCP_WRITE_TOOLS = Object.freeze({
  openSession: 'open_work_session',
  create: 'create_task',
  update: 'update_task',
  ready: 'ready_task',
  claim: 'claim_task',
  begin: 'begin_task',
  submit: 'submit_task',
  verify: 'verify_task',
  reject: 'reject_task',
  release: 'release_task',
  interrupt: 'interrupt_task',
  gate: 'gate_task',
  renew: 'renew_task',
  block: 'block_task',
  unblock: 'unblock_task',
  reconcile: 'reconcile_task',
  cancel: 'cancel_task',
  plan: 'manage_plan',
  document: 'manage_document',
  checkpoint: 'checkpoint_work_session',
  handoff: 'handoff_work_session',
  projectView: 'get_project_view',
});
