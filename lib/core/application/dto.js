// Unified internal request contract for every ingress (HTTP, DSH native, MCP).
// Ingresses decode their own protocol and authenticate their own credentials;
// downstream code receives only a normalized request plus the trusted actor.
import { BoardError } from '../errors.js';
import { RETAINED_DOC_READ_VIEWS } from '../../shared/agent-tools.js';

/** Read views the application port accepts. Values are raw projections, not MCP-redacted. */
export const READ_VIEWS = Object.freeze([
  'brief', 'board', 'task', 'plan', 'plans', 'docs', 'doc', 'events', 'health',
  'summary', 'task_detail', 'digest', 'doc_record',
  'list_external', 'inspect', 'get_fixed', 'doc_asset', ...Object.values(RETAINED_DOC_READ_VIEWS),
]);

export const PROTOCOLS = Object.freeze(['http', 'native', 'mcp', 'system']);

function invalid(message) {
  // A builder that returns instead of throwing makes every caller below pass
  // the invalid shape into the next layer; the rejection must stop here.
  throw new BoardError('invalid-command', message, { status: 400 });
}

export function assertProjectId(projectId) {
  if (typeof projectId !== 'string' || !/^prj_[0-9a-z]{1,124}$/.test(projectId)) invalid('projectId is required');
  return projectId;
}

function assertActor(actor) {
  if (!actor || typeof actor !== 'object' || Array.isArray(actor) || typeof actor.kind !== 'string' || actor.kind === '') {
    throw new BoardError('forbidden-role', 'a trusted actor from the ingress is required', { status: 403 });
  }
  return actor;
}

/**
 * A write request. The actor is always supplied by the authenticated ingress on
 * this call, never read from a request body or remembered on a shared service.
 */
export function normalizeCommand(projectId, command) {
  assertProjectId(projectId);
  if (!command || typeof command !== 'object' || Array.isArray(command)) invalid('command must be an object');
  if (typeof command.op !== 'string' || command.op === '') invalid('command op is required');
  if (typeof command.cmdId !== 'string' || command.cmdId === '') invalid('cmdId is required');
  const actor = assertActor(command.actor);
  return { ...command, projectId, actor };
}

/** A read request with no write capability attached to the returned value. */
export function normalizeRead(projectId, view, params = {}, actor = {}) {
  assertProjectId(projectId);
  if (!READ_VIEWS.includes(view)) invalid('unknown read view: ' + String(view));
  if (params === null || typeof params !== 'object' || Array.isArray(params)) invalid('read params must be an object');
  return { projectId, view, params, actor: actor ?? {} };
}
