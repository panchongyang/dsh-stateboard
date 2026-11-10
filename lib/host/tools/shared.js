import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { BoardError } from '../../core/errors.js';
import { auditSummary, sanitizeField } from '../../core/digest.js';

// Shared host-tool plumbing: error hints, the agent actor, project resolution,
// the fail/run wrapper and the text renderers used by more than one domain.

export const NEXT = {
  'stale-revision': 'Re-read the task or board to get the current rev, then retry with expectedRev.',
  'illegal-transition': 'Read project_board view=brief for allowedOps, then choose a legal op.',
  'lease-held': 'Another session owns this task. Pick another ready task or wait for release.',
  'lease-expired': 'Read the task. With an open intent, the session that held the expired lease recovers with op=interrupt or op=reconcile and the old fencingToken (otherwise ask the human to interrupt); without one, claim it again. renew cannot revive an expired lease.',
  'fencing-stale': 'You are a stale writer. Re-read the task, then reconcile or re-claim.',
  'dependency-unmet': 'Finish the dependencies first, or block this task with a reason.',
  'plan-stage-dependency': 'Put tasks with prerequisites in different stages, or remove the dependency.',
  'acceptance-unmet': 'Attach evidence for every acceptance item before submitting.',
  'missing-evidence': 'Produce evidence (file/test/command/doc) and attach it with acceptanceId.',
  'evidence-drift': 'Evidence content changed or is unreadable. Reject for rework and re-submit fresh evidence, or ask a human to refresh/acknowledge drift; agents cannot waive it.',
  'verification-required': 'Submit only enters review. An authorized agent can verify ordinary tasks; an audit gate needs an independent agent with audit.report or a human.',
  'forbidden-role': 'Read task allowedOps and details.reason. Use an independent auditor for an audit gate, or ask a human for human-only operations.',
  'schema-migration-required': 'Stop writes and ask the maintainer to stop the host, back up the store and run the out-of-package schema v3 migration. Do not retry with old field names.',
  'project-inactive': 'The project is paused or archived. Ask the human to resume it.',
  'not-found': 'Read project_board first; the project or entity may not exist yet.',
  'read-only': 'Another process holds the project lock; wait or ask the human to close it.',
  'log-busy': 'This project log is already open in this process (likely a plugin reload). Stop writing and ask the human to restart dsh-web once.',
  'log-forked': 'Another writer appended to the project log. Stop writing immediately and report it to the human; do not retry in a loop.',
  'hash-chain-broken': 'The project log is corrupt. Stop writing and report it to the human.',
  'plan-not-found': 'Read project_board view=plans to get plan ids and revs.',
  'plan-title-taken': 'Choose another plan title; titles are unique across the project.',
  'plan-not-draft': 'publish needs a draft plan; check view=plans for status.',
  'plan-not-active': 'Only active plans accept adopt/release/focus.',
  'plan-archived': 'The plan is archived; a human must unarchive it.',
  'plan-has-live-work': 'Finish or release in_progress tasks before archiving.',
  'plan-task-in-use': 'The task belongs to another plan; release it first.',
  'plan-step-not-found': 'Read view=plan to get a valid stepId.',
  'plan-task-in-progress': 'Wait for the task to leave in_progress before adopt/release.',
  'intent-unresolved': 'Do not close an uncertain intent. Use op=interrupt with a note, then op=reconcile (resume/completed/discard).',
  'project-archived': 'The project is archived and read-only. Ask the human to unarchive it before any write.',
  'project-has-live-work': 'Finish, release, or reconcile live work before archiving the project.',
  'binding-required': 'This directory carries a project marker but is not bound on this machine. Ask the human to relocate, bind or fork it (scripts/identity.mjs); do not create a new project.',
  'board-data-missing': 'The project board data is not on this machine. Ask the human to import it (scripts/identity.mjs import); do not create a new project.',
  'identity-conflict': 'Bindings or markers disagree about which project owns this directory. Stop and report details to the human.',
  'invalid-project-marker': 'The .dsh-project.json marker is malformed. Report it to the human; do not edit or delete it yourself.',
  'bindings-unreadable': 'The local binding registry is unreadable. Stop and report it to the human.',
  'bindings-locked': 'The local binding registry is locked. Retry shortly; if it persists, report it to the human.',
  'invalid-external-doc': 'The external document record or locator is invalid. Re-read project_doc op=list_external and retry with a valid relPath and bindingId.',
  'missing-binding': 'That binding is not active for this project. Re-read project_board; ask the human to rebind or relocate if the workspace moved.',
  'external-doc-operation-required': 'This document is external (a registered workspace file). Use project_doc op=inspect/update_meta/relocate/confirm/unregister instead of get/put/link.',
  'file-missing': 'The registered file is not in the workspace. Fix the path with op=relocate or retire the registration with op=unregister; never recreate or overwrite the file for the board.',
  'root-unavailable': 'The binding root is not available on this machine. Ask the human to check the workspace path, relocate, or rebind.',
  'permission-denied': 'The file is not readable with the current permissions. Ask the human to fix access; do not copy it elsewhere.',
  'outside-root': 'The path resolves outside the binding root. Register a path inside the bound workspace.',
  'security-rejected': 'The path was rejected for security reasons (link/reparse point or invalid form). Use a plain file path inside the workspace.',
  'not-regular': 'The path is not a regular file. Register a file, not a directory or device.',
  oversize: 'The file is larger than the 16 MiB read limit. It can stay registered and listed, but it cannot be hashed or confirmed.',
  undecodable: 'The file is not valid UTF-8. It stays registered and can be doc evidence as current-only (unsupported-format); preview is unavailable.',
  'unsupported-format': 'The file type is not previewable. Registration, metadata and current-only doc evidence work; preview does not.',
  unstable: 'The file kept changing while being read. Retry when it is stable.',
  'dirty-worktree': 'The document path has uncommitted changes, so doc evidence is current-only. Commit the file if you want a pinned version; never auto-add or stash.',
  'unsupported-content-transform': 'The content uses Git transforms (filter/LFS/ident/working-tree-encoding or ambiguous EOL), so doc evidence is current-only. diff/textconv is allowed and never executed; no driver runs.',
  'unsupported-repository': 'The project has no usable Git source for this document, so doc evidence is current-only. No approval is needed; nested or unrelated repositories stay unsupported.',
  'fixed-object-missing': 'Restore the exact retained Git commit/blob from an authorized backup. Never substitute current workspace content.',
  'fixed-path-missing': 'That path does not exist at the fixed commit. Check the historical repository-relative path; do not substitute a current path.',
  'fixed-object-mismatch': 'Git object identity differs from the fixed reference. Stop and report the exact commit/path/blob identities.',
  'content-hash-mismatch': 'Git blob bytes do not match the recorded SHA-256. Re-read the exact fixed reference and investigate corruption or a wrong hash.',
  'invalid-fixed-reference': 'The fixed reference is malformed, or a fixed evidence row lacks its same-commit doc/content-fixed registration. Normal doc evidence needs only docId; reads use the complete version-1 fixed identity returned by project_doc op=get_fixed.',
  'git-unavailable': 'The bounded read-only Git invocation failed or timed out. Restore local Git access; no remote fetch or filter will be attempted.',
};

export function cmdId() {
  return 'cmd_' + randomUUID();
}

export function actorOf(exec) {
  return {
    kind: 'agent',
    sessionId: exec.agent.id,
    agentId: exec.agent.id,
    callId: exec.callId,
    via: 'tool',
  };
}

export async function resolveHandle(runtime, exec, options = {}) {
  if (!exec.agent || !exec.agent.id) {
    throw new BoardError('forbidden-role', 'project tools require an owning agent session', { status: 403 });
  }
  const cwd = exec.agent.session?.header?.cwd;
  if (typeof cwd !== 'string' || cwd === '') {
    throw new BoardError('invalid-command', 'the session has no working directory', { status: 400 });
  }
  await runtime.ready;
  let handle = await runtime.service.openByWorkspace(cwd);
  if (!handle && options.create) {
    options.validateCreate?.();
    handle = await runtime.service.createProject({
      workspacePath: cwd,
      name: options.name || path.basename(cwd),
      actor: actorOf(exec),
    });
  }
  if (!handle) return null;
  handle.touch(exec.agent.id);
  runtime.sessionProjects.set(exec.agent.id, handle);
  return handle;
}

export function requireHandle(handle) {
  if (handle) return handle;
  throw new BoardError('not-found', 'No ProjectBoard project exists for this workspace yet. Call project_plan with op=publish first.', { status: 404 });
}

const ROLE_NEXT = {
  'auditor-required': 'Use a human or an authorized agent session. Audit gates require an independent agent with audit.report.',
  'not-independent': 'You participated in this task. Ask a different independent session-level agent, or a human, to audit it.',
  'worker-unknown': 'No implementation worker is known. Ask a human to verify; do not invent a worker identity.',
  'review-gate-locked': 'Agents cannot change a review task gate. Ask a human, or reject for rework.',
  'gate-locked': 'Agents cannot disable an audit gate. Ask a human.',
  'human-only': 'This operation requires a human. Ask the human to use the UI.',
  'unassign-human-only': 'Only a human may clear the assignee. Omit unassign to reject while preserving assignment.',
  'drift-human-only': 'Agents cannot refresh or acknowledge drift. Reject for rework or ask a human.',
};

export function fail(error) {
  if (error instanceof BoardError) {
    const next = (typeof error.details?.next === 'string' && error.details.next) || (error.code === 'forbidden-role' && ROLE_NEXT[error.details?.reason]) || NEXT[error.code] || 'Read project_board and retry.';
    const wrapped = new Error(JSON.stringify({
      ok: false,
      code: error.code,
      message: error.message,
      status: error.status,
      details: error.details ?? null,
      next,
    }));
    wrapped.code = error.code;
    return wrapped;
  }
  return error;
}

export async function run(fn) {
  try {
    return await fn();
  } catch (error) {
    throw fail(error);
  }
}

export function textBlock(text) {
  return [{ type: 'text', text }];
}

export function shortJson(value, limit = 4000) {
  const text = JSON.stringify(value);
  return text.length > limit ? text.slice(0, limit) + '…' : text;
}

function cardLine(card) {
  const a = card.acceptance || { met: 0, total: 0 };
  const owner = card.owner ? ' owner=' + String(card.owner.sessionId).slice(0, 14) + ' token=' + card.owner.fencingToken : '';
  const blocked = card.blocked ? ' blocked=' + card.blocked.code : '';
  const labels = Array.isArray(card.labels) && card.labels.length > 0 ? ' labels=' + card.labels.join(',') : '';
  const gate = auditSummary(card);
  return '  ' + card.id + ' rev ' + card.rev + ' acc ' + a.met + '/' + a.total + ' "' + card.title + '"' + owner + labels + gate + blocked;
}

export function boardSummary(value) {
  if (!value || !value.project) return value?.hint || 'No project for this workspace.';
  const c = value.counts || {};
  const lines = [
    'Project ' + value.project.name + ' rev ' + value.rev + ' (' + value.project.phase + ')',
    'ready ' + (c.ready || 0) + ' · in progress ' + (c.inProgress || 0) + ' · review ' + (c.review || 0) + ' · done ' + (c.done || 0) + ' · blocked ' + (c.blocked || 0) + ' · interrupted ' + (c.interrupted || 0),
  ];
  const groups = [['ready', 'Ready'], ['in_progress', 'In progress'], ['review', 'Review'], ['backlog', 'Backlog'], ['done', 'Done']];
  for (const entry of groups) {
    const cards = (value.columns && value.columns[entry[0]]) || [];
    lines.push(entry[1] + ' (' + cards.length + ')');
    for (const card of cards.slice(0, 30)) lines.push(cardLine(card));
  }
  const attention = value.attention || { blocked: [], interrupted: [] };
  for (const key of ['blocked', 'interrupted']) {
    const cards = attention[key] || [];
    if (cards.length === 0) continue;
    lines.push(key + ' (' + cards.length + ')');
    for (const card of cards.slice(0, 20)) lines.push(cardLine(card));
  }
  return lines.join('\n');
}

export function taskSummary(value) {
  if (!value) return 'No task.';
  // project_board returns the task view directly; project_task returns { task: view }.
  const view = value.task && value.task.task ? value.task : value;
  const t = view.task;
  if (!t) return 'No task.';
  const lease = view.lease || value.lease || null;
  const allowedOps = view.allowedOps || value.allowedOps || [];
  const lines = ['Task ' + t.id + ' "' + t.title + '" — ' + t.state + ' rev ' + t.rev];
  if (t.planRef) lines.push('plan: ' + t.planRef.planId + ' v' + t.planRef.version + ' / ' + t.planRef.stepId);
  if (Array.isArray(t.deps) && t.deps.length > 0) lines.push('deps: ' + t.deps.join(', '));
  lines.push('lease: ' + (lease
    ? 'token ' + lease.token + ' session ' + lease.sessionId + ' until ' + lease.expiresAt
    : 'none'));
  lines.push('acceptance:');
  for (const item of t.acceptance || []) {
    lines.push('  - ' + item.id + ' "' + item.text + '" ' + (item.met ? 'met' : 'unmet') + (item.requiredKinds && item.requiredKinds.length ? ' requiredKinds=' + item.requiredKinds.join(',') : ''));
  }
  const gate = Boolean(t.requiresAudit || (Array.isArray(t.labels) && t.labels.includes('gate:audit')));
  if (Array.isArray(t.labels) && t.labels.length > 0) lines.push('labels: ' + t.labels.join(','));
  // Only the exceptional case is printed: "off" is the default and was pure
  // repetition on every task render (CONTRACT §3.4.2).
  if (gate) lines.push('audit=1: human or independent agent acceptance required');
  if (t.lastAudit) {
    lines.push('lastAudit:' + auditSummary(t));
    lines.push('  report: ' + sanitizeField(t.lastAudit.report, 500));
    lines.push('  evidence: ' + shortJson(t.lastAudit.evidence || {}, 300));
    for (const item of (t.lastAudit.checklist || []).slice(0, 50)) lines.push('  [' + (item.ok ? 'x' : ' ') + '] ' + sanitizeField(item.item, 200) + (item.note ? ' — ' + sanitizeField(item.note, 200) : ''));
    for (const warning of (t.lastAudit.warnings || []).slice(0, 20)) lines.push('  warning: ' + sanitizeField(typeof warning === 'string' ? warning : warning.code + ' ' + warning.message, 300));
  }
  lines.push('evidence: ' + ((t.evidence || []).length));
  const warnings = value && value.result && Array.isArray(value.result.warnings) ? value.result.warnings : [];
  if (warnings.length > 0) {
    lines.push('warnings (' + warnings.length + '):');
    for (const warning of warnings.slice(0, 5)) {
      lines.push('  ' + warning.severity + ' ' + warning.code + ' ' + warning.message);
    }
    if (warnings.length > 5) lines.push('  … ' + (warnings.length - 5) + ' more');
  }
  const allowed = allowedOps.filter((op) => op.enabled).map((op) => op.op);
  lines.push('allowed: ' + (allowed.length ? allowed.join(', ') : 'none'));
  const timeline = Array.isArray(view.timeline) ? view.timeline.slice(-5) : [];
  if (timeline.length > 0) {
    lines.push('timeline (last ' + timeline.length + '):');
    for (const event of timeline) {
      lines.push('  ' + event.seq + ' ' + event.at + ' ' + event.type + ' ' + eventTag(event));
    }
  }
  return lines.join('\n');
}

export function planSummary(value) {
  if (!value || !value.plan) return 'No plan.';
  const steps = value.steps || [];
  const lines = ['Plan "' + value.plan.title + '" v' + value.plan.version + ' (' + value.plan.status + ') · progress ' + Math.round((value.progress?.percent || 0) * 100) + '%'];
  for (const step of steps) {
    lines.push('Step ' + step.id + ' "' + step.title + '"');
    for (const task of step.tasks || []) {
      lines.push('  ' + task.id + ' rev ' + task.rev + ' ' + task.state + ' "' + task.title + '"');
    }
  }
  if (steps.length === 0 && value.plan.steps) {
    for (const step of value.plan.steps) lines.push('Step ' + step.id + ' "' + step.title + '": ' + (step.taskIds || []).join(', '));
  }
  return lines.join('\n');
}

export function plansSummary(value) {
  const plans = value?.plans || [];
  if (plans.length === 0) return 'No plans.';
  const lines = ['Plans (' + plans.length + ') focus=' + (value.focusPlanId || 'none')];
  for (const plan of plans) {
    lines.push('- ' + plan.id + ' ' + plan.status + ' v' + plan.currentVersion + (plan.focus ? ' *' : '') + ' "' + plan.title + '" tasks=' + plan.taskCount + ' progress=' + Math.round((plan.progress?.percent || 0) * 100) + '%');
  }
  return lines.join('\n');
}

export function docSummary(value) {
  if (!value || !value.doc) return 'No document.';
  const doc = value.doc;
  if (doc.source === 'external') {
    const locator = doc.locator ? doc.locator.relPath : '?';
    const status = doc.unregistered ? 'unregistered' : doc.status;
    return 'Doc "' + doc.title + '" rev ' + doc.rev + ' (external ' + doc.kind + ', ' + status + ', ' + locator + ')';
  }
  return 'Doc "' + doc.title + '" rev ' + doc.rev + ' (' + doc.kind + ', ' + doc.size + ' bytes)';
}

export function docsSummary(value) {
  const docs = value?.docs || [];
  if (docs.length === 0) return 'No documents.';
  return docs.map((doc) => '- ' + doc.id + ' "' + doc.title + '" rev ' + doc.rev + (doc.source === 'external' ? ' (external)' : '')).join('\n');
}

/** Compact actor + cmd tag: `agent:1a2b3c 9f8e7d` (session and cmdId tails only). */
function eventTag(event) {
  const actor = (event && event.actor) || {};
  const kind = String(actor.kind || 'system');
  const session = actor.sessionId ? ':' + String(actor.sessionId).slice(-6) : '';
  const cmdId = event && event.cmdId ? ' ' + String(event.cmdId).slice(-6) : '';
  return kind + session + cmdId;
}

export function eventsSummary(value) {
  const events = value?.events || [];
  return events.map((event) => event.seq + ' ' + event.at + ' ' + event.type + (event.taskId ? ' ' + event.taskId : '') + ' ' + eventTag(event)).join('\n') || 'No events.';
}

export function healthSummary(value) {
  const health = value?.health || value;
  return shortJson(health, 4000);
}

export const output = (render) => ({
  schema: { type: 'object', additionalProperties: true },
  render,
});
