import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { BoardError } from '../core/errors.js';
import { canonicalJSON, sha256 } from '../core/util.js';
import { EVIDENCE_KINDS, MCP_WRITE_TOOLS, PROJECT_READ_ID_PATTERNS } from '../shared/contract.js';

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const AGENT_ID = 'codex:mcp';
const WRITE_TOKEN_ENV = 'PROJECT_BOARD_MCP_WRITE_TOKEN';
const SECRET = /^[0-9a-f]{64}$/;
const FENCED_OPS = new Set(['begin', 'submit', 'release', 'interrupt']);
const projectId = { type: 'string', pattern: PROJECT_READ_ID_PATTERNS.project };
const taskId = { type: 'string', pattern: PROJECT_READ_ID_PATTERNS.task };
const sessionToken = { type: 'string', pattern: '^[0-9a-f]{32}\\.[0-9]{1,16}\\.[0-9a-f]{64}$' };
const requestId = { type: 'string', pattern: '^[A-Za-z0-9._-]{1,128}$' };
const positiveInt = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const string = { type: 'string' };
const nonempty = { type: 'string', minLength: 1 };
const array = (items) => ({ type: 'array', items });
const object = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });

const sideEffects = array(object({
  kind: { type: 'string', enum: ['file', 'command', 'network', 'other'] },
  ref: nonempty, note: string, hash: string,
}, ['kind', 'ref']));
const evidence = array(object({
  kind: { type: 'string', enum: EVIDENCE_KINDS },
  ref: nonempty, hash: string, summary: string, acceptanceId: string,
}, ['kind', 'ref']));
const intent = object({
  outcome: { type: 'string', enum: ['stopped'] },
  sideEffects, note: string,
}, ['outcome', 'sideEffects']);
const metadata = {
  title: nonempty,
  description: string,
  priority: { type: 'integer' },
  weight: { type: 'number' },
  deps: array(taskId),
  labels: array(string),
  requiresAudit: { type: 'boolean' },
  acceptance: array(object({
    text: nonempty,
    requiredKinds: array({ type: 'string', enum: EVIDENCE_KINDS }),
  }, ['text'])),
};

function matchesInput(schema, value) {
  switch (schema.type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value)
        && schema.required.every((key) => Object.hasOwn(value, key))
        && Object.entries(value).every(([key, item]) => Object.hasOwn(schema.properties, key)
          && matchesInput(schema.properties[key], item));
    case 'array':
      return Array.isArray(value) && value.every((item) => matchesInput(schema.items, item));
    case 'integer':
      return Number.isSafeInteger(value) && (schema.minimum === undefined || value >= schema.minimum)
        && (schema.maximum === undefined || value <= schema.maximum);
    case 'number':
      return Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string' && value.length >= (schema.minLength ?? 0)
        && (!schema.pattern || new RegExp(schema.pattern).test(value))
        && (!schema.enum || schema.enum.includes(value));
    default:
      return false;
  }
}

function tool(name, description, inputSchema, run, readOnlyHint = false) {
  return {
    name, description, inputSchema,
    annotations: { readOnlyHint, openWorldHint: false },
    run(args) {
      if (!matchesInput(inputSchema, args)) throw new BoardError('invalid-command', 'Invalid MCP write arguments', { status: 400 });
      return run(args);
    },
  };
}

function taskTool(op, description, payload, required, execute) {
  const common = { projectId, sessionToken, projectRev: positiveInt, requestId };
  const requiredKeys = ['projectId', 'sessionToken', 'requestId', ...required];
  if (op !== 'create') {
    common.taskId = taskId;
    common.expectedRev = positiveInt;
    requiredKeys.push('taskId', 'expectedRev');
  }
  if (FENCED_OPS.has(op)) {
    common.fencingToken = positiveInt;
    requiredKeys.push('fencingToken');
  }
  return tool(MCP_WRITE_TOOLS[op], description, object({ ...common, ...payload }, requiredKeys),
    (args) => execute(op, args));
}

function workSessions(clock) {
  const key = randomBytes(32);
  const sign = (project, body) => createHmac('sha256', key).update(project + ':' + body).digest('hex');
  return {
    issue(project) {
      const expires = clock().getTime() + SESSION_TTL_MS;
      const body = randomBytes(16).toString('hex') + '.' + expires;
      return { sessionToken: body + '.' + sign(project, body), expiresAt: new Date(expires).toISOString() };
    },
    authenticate(project, token) {
      const [id, expires, signature] = token.split('.');
      const expected = sign(project, id + '.' + expires);
      if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex')) || clock().getTime() >= Number(expires)) {
        throw new BoardError('work-session-invalid', 'Invalid or expired MCP work session', { status: 403 });
      }
      return 'mcp_' + id;
    },
  };
}

async function executeTask(service, sessions, op, { projectId, sessionToken, expectedRev, projectRev, requestId, ...args }) {
  const sessionId = sessions.authenticate(projectId, sessionToken);
  const cmd = {
    ...args,
    op: 'task.' + op,
    actor: { kind: 'agent', sessionId, agentId: AGENT_ID, via: 'mcp' },
    expected: { entityRev: expectedRev, projectRev },
  };
  // Scope core dedupe to this session and the exact validated request.
  cmd.cmdId = 'cmd_mcp_' + sha256(canonicalJSON([requestId, cmd]));
  const handle = await service.open(projectId);
  const result = await handle.command(cmd, op === 'claim' ? { claimSessionSource: 'mcp' } : undefined);
  const taskId = args.taskId ?? handle.createdTaskId(cmd.cmdId);
  const task = handle.state.tasks[taskId];
  if (!task) throw new BoardError('write-failed', 'Task receipt is unavailable', { status: 500 });
  return {
    projectId, taskId, projectRev: handle.rev, taskRev: task.rev, state: task.state, deduped: result.deduped,
    ...(op === 'claim' ? { lease: handle.liveClaimReceipt({ taskId, sessionId, cmdId: cmd.cmdId }) } : {}),
    ...(result.warnings?.length ? { warnings: result.warnings.map(({ code, severity }) => ({ code, severity })) } : {}),
  };
}

/** Writer admission is independent of the read tools and closes before the service. */
export function createMcpWrite(runtime, settings, env, readToken) {
  if (Object.getOwnPropertyDescriptor(settings ?? {}, 'enabled')?.value !== true) return null;
  const ids = Object.getOwnPropertyDescriptor(settings, 'projectIds')?.value;
  const token = env[WRITE_TOKEN_ENV];
  if (!Array.isArray(ids) || ids.length === 0 || !Array.from(ids).every((id) => matchesInput(projectId, id))
    || typeof token !== 'string' || !SECRET.test(token) || token === readToken) {
    runtime.ctx.logger?.warn?.('[project-board] MCP write disabled: configure project IDs and a distinct ' + WRITE_TOKEN_ENV);
    return null;
  }

  const projects = new Set(ids);
  const sessions = workSessions(runtime.service.clock);
  const pending = new Set();
  let closed = false;
  const authorize = (project) => {
    if (closed) throw new BoardError('closed', 'MCP work service has stopped', { status: 503 });
    if (!projects.has(project)) throw new BoardError('project-forbidden', 'Project is outside the MCP write scope', { status: 403 });
  };
  const execute = async (op, args) => {
    authorize(args.projectId);
    const request = executeTask(runtime.service, sessions, op, args);
    pending.add(request);
    try { return await request; } finally { pending.delete(request); }
  };
  return {
    token,
    tools: [
      tool(MCP_WRITE_TOOLS.openSession, 'Start a project work session. Keep its token in this Codex chat for task writes.',
        object({ projectId }, ['projectId']), (args) => {
          authorize(args.projectId);
          return sessions.issue(args.projectId);
        }, true),
      taskTool('create', 'Create an independent task with acceptance criteria. Retry unchanged to recover its task ID.',
        metadata, ['title', 'acceptance'], execute),
      taskTool('update', 'Edit task metadata using its current revision. Existing agent edit permissions apply.',
        { ...metadata, reason: string }, [], execute),
      taskTool('ready', 'Move a backlog task to ready once its dependencies and acceptance criteria permit it.', {}, [], execute),
      taskTool('claim', 'Claim an existing ready task using its current revision.', {}, [], execute),
      taskTool('begin', 'Record an intent before executing the claimed task.',
        { summary: nonempty, plannedSteps: array(string), expectedArtifacts: array(string) }, ['summary'], execute),
      taskTool('submit', 'Submit evidence for the claimed task. Success enters review.',
        { evidence }, ['evidence'], execute),
      taskTool('release', 'Release a claimed task. With an open intent, declare stopped and list observed side effects.',
        { note: string, intent }, [], execute),
      taskTool('interrupt', 'Interrupt a claimed task when the work outcome is unknown.',
        { note: nonempty, sideEffects }, ['note'], execute),
    ],
    async close() {
      closed = true;
      await Promise.allSettled(pending);
    },
  };
}
