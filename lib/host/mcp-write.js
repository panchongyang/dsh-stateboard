import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { BoardError } from '../core/errors.js';
import { canonicalJSON, sha256 } from '../core/util.js';
import { EVIDENCE_KINDS, MCP_WRITE_TOOLS, PROJECT_READ_ID_PATTERNS } from '../shared/contract.js';

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
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
const audit = object({
  report: { ...nonempty, description: 'Self-declared report with 20–4000 characters after trimming.' },
  checklist: {
    ...array(object({ item: nonempty, ok: { type: 'boolean' }, note: string }, ['item', 'ok'])),
    description: 'At most 50 items. Each item is at most 200 characters, each note at most 500.',
  },
}, ['report']);
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

// 签发项目限定的工作会话，凭据和签名密钥只用于本进程的 MCP 认证。
function workSessions(clock) {
  const key = randomBytes(32);
  const sign = (project, body) => createHmac('sha256', key).update(project + ':' + body).digest('hex');
  return {
    issue(project) {
      const expires = clock().getTime() + SESSION_TTL_MS;
      const body = randomBytes(16).toString('hex') + '.' + expires;
      return { sessionToken: body + '.' + sign(project, body), expiresAt: new Date(expires).toISOString() };
    },
    /**
     * 用服务端签发的会话生成稳定身份，避免共享集成 ID 误伤独立的审查会话。
     * @param {string} project
     * @param {string} token
     */
    authenticate(project, token) {
      const [id, expires, signature] = token.split('.');
      const expected = sign(project, id + '.' + expires);
      if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex')) || clock().getTime() >= Number(expires)) {
        throw new BoardError('work-session-invalid', 'Invalid or expired MCP work session', { status: 403 });
      }
      return { kind: 'agent', sessionId: 'mcp_' + id, agentId: 'codex:mcp:' + id, via: 'mcp' };
    },
  };
}

// 认证后把 MCP 载荷交给 core，复用相同的权限、租约、CAS 与持久去重。
async function executeTask(service, sessions, op, { projectId, sessionToken, expectedRev, projectRev, requestId, ...args }) {
  const actor = sessions.authenticate(projectId, sessionToken);
  const cmd = {
    ...args,
    op: 'task.' + op,
    actor,
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
    ...(op === 'claim' ? { lease: handle.liveClaimReceipt({ taskId, sessionId: actor.sessionId, cmdId: cmd.cmdId }) } : {}),
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
      tool(MCP_WRITE_TOOLS.openSession, 'Start a project work session. Keep its token private and reuse it for writes and reviews in the same work session.',
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
      taskTool('verify', 'Record a self-declared audit of a review task after inspecting its evidence. Requires an independent work session, an audit gate and a report. For other tasks, ask a human to verify.',
        { audit }, ['audit'], execute),
      taskTool('reject', 'Return a review task for rework with a reason and optional audit report. If it has a live lease, only its holder may reject with the current fencing token.',
        { reason: nonempty, audit, fencingToken: positiveInt, intent }, ['reason'], execute),
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
