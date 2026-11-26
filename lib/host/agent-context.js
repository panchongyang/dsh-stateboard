import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { BoardError } from '../core/errors.js';
import { createHostReader } from './reader.js';
import { applicationFor } from './application.js';
import { AGENT_CONTEXT_TTL_MS, metadataOperation } from '../shared/agent-tools.js';

const AUTHORITY = Symbol('project-board.authority');
// The owning execution's original cwd. Only host preparation may set it; tool
// arguments cannot carry a symbol, so a prepared binding root can never replace it.
const OWNING_CWD = Symbol('project-board.owning-cwd');
const LIMIT = 2048;
// Hot-path throttle for the advisory projection hint. One bounded map per owning
// space; the check is a timestamp comparison only (no filesystem or registry I/O).
const TOUCH_WINDOW_MS = 30_000;
const TOUCH_CAP = 64;
const denied = (code, message) => new BoardError(code, message, { status: 403 });

export const executionGrant = exec => exec?.[AUTHORITY];

/**
 * Non-blocking projection touch for the hot path (tasks, reads). Only an owning
 * native execution or a full MCP grant may reach it; metadata and legacy mode
 * never do. It reuses projectionAuthority, so the original owning cwd and the
 * grant currentness are the same as open/query, and never awaits the caller.
 */
export function touchProjection(runtime, exec, projectId) {
  const service = runtime?.service;
  if (!service?.spaceHome || typeof projectId !== 'string') return;
  let authority;
  try { authority = projectionAuthority(exec, { ctx: runtime.ctx, service }); } catch { return; }
  runtime.projectionTouches ??= new Map();
  const slot = authority.scopeKey + '\u0000' + projectId, now = Date.now();
  const last = runtime.projectionTouches.get(slot);
  if (last !== undefined && now - last < TOUCH_WINDOW_MS) return;
  runtime.projectionTouches.delete(slot);
  runtime.projectionTouches.set(slot, now);
  if (runtime.projectionTouches.size > TOUCH_CAP) runtime.projectionTouches.delete(runtime.projectionTouches.keys().next().value);
  try {
    Promise.resolve(service.hintWorkspaceProjection(projectId, { scopeKey: authority.scopeKey, assertCurrent: authority.assertCurrent })).catch(() => {});
  } catch { /* Advisory only; the caller never waits or fails. */ }
}

/** The original native owning cwd, preserved across prepare() rewrites. */
export function owningNativeCwd(exec) {
  if (!exec) return undefined;
  if (exec[OWNING_CWD] !== undefined) return exec[OWNING_CWD];
  // A prepared execution whose original cwd was not recorded cannot prove it.
  if (exec.projectBoard) return undefined;
  return exec.agent?.session?.header?.cwd;
}

/**
 * The trusted authorization generation for workspace projection. It comes only
 * from the execution authority (or the owning native session), never from tool
 * arguments, and core binds every cursor to it. It is never persisted, logged or
 * returned; a cursor from one credential cannot be replayed under another.
 *
 * Foreground projection and the background hint share this one construction.
 * A native session has no revocable credential, so its assertion re-resolves the
 * original owning cwd through the workspace registry and requires the physical
 * root to still be this service's space root. MCP requires a live grant that can
 * re-assert itself.
 */
export function projectionAuthority(exec, { ctx, service } = {}) {
  const grant = executionGrant(exec);
  if (grant) {
    if (typeof grant.key !== 'string' || grant.key === '') throw denied('project-forbidden', 'This execution has no authorization generation');
    if (grant.scope !== 'full') throw denied('forbidden-role', 'Workspace projection requires full authority; metadata credentials cannot see workspace documents.');
    if (typeof grant.assertCurrent !== 'function') throw denied('project-forbidden', 'Workspace projection requires a re-checkable space grant');
    return { scopeKey: grant.key, assertCurrent: () => { if (grant.active?.() === false) throw denied('closed', 'Project tools have stopped'); return typeof grant.assertCurrentAsync === 'function' ? grant.assertCurrentAsync() : grant.assertCurrent(); } };
  }
  if (!exec?.agent?.id) throw denied('forbidden-role', 'Project tools require an owning agent session');
  const cwd = owningNativeCwd(exec);
  if (!service?.spaceHome || typeof cwd !== 'string' || cwd === '') throw denied('project-forbidden', 'Workspace projection requires an authorized owning space');
  return { scopeKey: 'native:' + exec.agent.id, assertCurrent: nativeOwningCurrent(ctx, service, cwd) };
}

/** The owning session must still resolve to exactly this service root. */
function nativeOwningCurrent(ctx, service, cwd) {
  return async () => {
    const home = service.spaceHome;
    if (!home) throw denied('project-forbidden', 'Workspace projection requires an authorized owning space');
    let resolved;
    try {
      const registry = ctx?.workspaceRegistry ?? ctx?.get?.('workspaceRegistry');
      resolved = (await registry?.resolveByPath(cwd))?.path;
    } catch { resolved = undefined; }
    let physical;
    try { physical = typeof resolved === 'string' && resolved ? await fs.promises.realpath(resolved) : undefined; } catch { physical = undefined; }
    // Async identity check only: the worker and owning ingress already verified
    // the medium; no synchronous filesystem call belongs on this callback.
    if (physical !== home.root) throw denied('project-forbidden', 'The owning workspace root is no longer authorized');
  };
}

export function mcpExecution(authority, signal) {
  return { [AUTHORITY]: authority, signal, callId: 'call_mcp_' + randomBytes(12).toString('hex') };
}

// One instance per runtime, shared by both registrations. No transport/session
// ID participates in worker identity: a client connection may serve many agents.
export function agentContexts(runtime) {
  return runtime.agentContexts ??= new AgentContexts(runtime);
}

class AgentContexts {
  constructor(runtime) {
    this.runtime = runtime;
    this.contexts = new Map();
    this.authorityActors = new Map();
    // The host entry owns the reader so every ingress shares one read port.
    this.ownsReader = !runtime.reader;
    this.reader = runtime.reader ??= createHostReader(runtime.service);
    this.closed = false;
  }
  now() { return this.runtime.service.clock().getTime(); }

  principal(exec) {
    if (this.closed) throw denied('closed', 'Project tools have stopped');
    if (exec?.[AUTHORITY]) {
      if (exec[AUTHORITY].active?.() === false) throw denied('closed', 'Project tools have stopped');
      return exec[AUTHORITY];
    }
    if (!exec?.agent?.id) throw denied('forbidden-role', 'Project tools require an owning agent session');
    return { key: 'native:' + exec.agent.id, scope: 'full', native: true, allows: () => true };
  }

  lookup(token, authority) {
    const record = this.contexts.get(token);
    if (!record || record.expires <= this.now() || record.authority !== authority.key || record.scope !== authority.scope) {
      throw denied('work-session-invalid', 'Context is invalid or expired. Use project_session op=open and reconcile unfinished work.');
    }
    if (!authority.allows(record.projectId)) throw denied('project-forbidden', 'Project is outside this credential scope');
    return record;
  }

  project(exec, projectId) {
    const binding = projectId ? this.runtime.service.bindings().mainOf(projectId)
      : this.runtime.service.resolveWorkspace(exec.agent?.session?.header?.cwd);
    if (!binding) throw new BoardError('not-found', 'No active project binding. Use project_session op=projects.', { status: 404 });
    return binding;
  }

  async open(args, exec) {
    await this.runtime.ready;
    const authority = this.principal(exec);
    const previous = args.context !== undefined ? this.lookup(args.context, authority) : null;
    const home = this.runtime.service.spaceHome;
    const projectId = args.projectId ?? previous?.projectId ?? (home ? this.runtime.service.metas.keys().next().value : undefined);
    if (home && projectId !== undefined && !this.runtime.service.metas.has(projectId)) throw denied('project-forbidden', 'This project is not in the owning space');
    if (!authority.native && !home && !projectId) throw new BoardError('invalid-command', 'open requires projectId', { status: 400 });
    if (projectId && !authority.allows(projectId)) throw denied('project-forbidden', 'Project is outside this credential scope');
    const binding = authority.scope === 'metadata' && this.runtime.service.metas.has(projectId)
      ? { projectId } : this.project(exec, projectId);
    for (const [key, record] of this.contexts) if (record.expires <= this.now()) this.contexts.delete(key);
    if (this.contexts.size >= LIMIT) throw new BoardError('context-limit', 'Too many active project contexts; reuse an existing context.', { status: 429 });
    const context = randomBytes(32).toString('hex');
    const actorId = authority.native ? exec.agent.id : previous?.actorId ?? 'mcp_' + randomBytes(16).toString('hex');
    const expires = this.now() + AGENT_CONTEXT_TTL_MS;
    this.contexts.set(context, { authority: authority.key, scope: authority.scope, projectId: binding.projectId, actorId, expires });
    if (!authority.native && authority.scope === 'full') {
      if (!this.authorityActors.has(authority.key)) this.authorityActors.set(authority.key, new Set());
      this.authorityActors.get(authority.key).add(actorId);
    }
    // Warm the projection only for a full (write-capable) authority whose
    // selected project is the owning one. Metadata opens stay invisible and
    // schedule nothing. This call never waits for a scan: core owns scheduling
    // and re-validates the authorization in the background.
    this.warmProjection(binding.projectId, authority, exec);
    return { context, projectId: binding.projectId, expiresAt: new Date(expires).toISOString(), scope: authority.scope };
  }

  async projects(args, exec) {
    const authority = this.principal(exec);
    await this.runtime.ready;
    const result = await this.reader.listProjects({ limit: args.limit, after: args.after });
    // Metadata credentials retain the existing discovery scope. Full credentials
    // list only their allowlist; pagination still advances over the source page.
    return { ...result, projects: result.projects.filter((row) => authority.allows(row.id)) };
  }

  async prepare(name, args, exec) {
    const authority = this.principal(exec);
    const forbidden = ['actor', 'sessionId', 'cwd', 'spaceRoot', 'spaceId', 'workspaceId', 'workspacePath', 'sessionToken', 'requestId', 'source', 'sessionSource', 'agentSessionSource'];
    if (name !== 'project_session') forbidden.push('projectId');
    if (forbidden.some((field) => Object.hasOwn(args, field))) {
      throw new BoardError('invalid-command', 'Identity and credentials must come from the owning execution context; use the shared context field.', { status: 400 });
    }
    if (authority.scope !== 'full' && !metadataOperation(name, args)) {
      throw denied('forbidden-role', 'This credential permits metadata only. Use an authorized full context for this operation.');
    }
    const bootstrap = name === 'project_session' && ['open', 'projects'].includes(args.op);
    if (bootstrap) return { ...exec, [OWNING_CWD]: owningNativeCwd(exec), projectBoardContext: args.context };
    if (authority.native && args.context === undefined) return exec;
    const record = this.lookup(args.context, authority);
    await this.runtime.ready;
    if (metadataOperation(name, args)) return { ...exec, projectBoard: { projectId: record.projectId, scope: authority.scope } };
    const binding = this.project(exec, record.projectId);
    // Native contexts select a project but never replace the owning agent.
    // Attach/activity belong to the write capability, not to this resolver.
    const agent = authority.native ? { ...exec.agent, session: { ...exec.agent.session, header: { ...exec.agent.session?.header, cwd: binding.root } } }
      : { id: record.actorId, session: { header: { cwd: binding.root } } };
    const defaultWorkspace = authority.native
      && this.runtime.service.resolveWorkspace(exec.agent.session?.header?.cwd)?.projectId === record.projectId;
    return { ...exec, [OWNING_CWD]: owningNativeCwd(exec), agent, projectBoard: { projectId: record.projectId, scope: authority.scope, via: authority.native ? 'tool' : 'mcp', defaultWorkspace } };
  }

  /**
   * Owning means the selected project is the one bound to this execution's own
   * workspace. MCP full grants are already allowlisted by the transport; a
   * native session may select another project explicitly, which is not owning.
   */
  owning(projectId, authority, exec) {
    if (!authority.native) return true;
    const cwd = owningNativeCwd(exec);
    if (typeof cwd !== 'string' || cwd === '') return false;
    try { return this.runtime.service.resolveWorkspace(cwd)?.projectId === projectId; } catch { return false; }
  }

  warmProjection(projectId, principal, exec) {
    // Legacy consolidated mode owns no space authority and never warms.
    if (!this.runtime.service.spaceHome) return;
    if (principal.scope !== 'full') return;
    if (!this.owning(projectId, principal, exec)) return;
    let authority;
    try { authority = projectionAuthority(exec, { ctx: this.runtime.ctx, service: this.runtime.service }); } catch { return; }
    const assertCurrent = async () => {
      if (this.closed || this.runtime.closing) throw denied('closed', 'Project tools have stopped');
      await authority.assertCurrent();
    };
    try {
      // Advisory work: never awaited and never allowed to fail this open. Core
      // dedupes concurrent hints and renews them while the context is active.
      Promise.resolve(this.runtime.service.hintWorkspaceProjection(projectId, { scopeKey: authority.scopeKey, assertCurrent })).catch(() => {});
      this.runtime.projectionTouches ??= new Map();
      const slot = authority.scopeKey + '\u0000' + projectId;
      this.runtime.projectionTouches.delete(slot);
      this.runtime.projectionTouches.set(slot, Date.now());
      if (this.runtime.projectionTouches.size > TOUCH_CAP) this.runtime.projectionTouches.delete(this.runtime.projectionTouches.keys().next().value);
    } catch { /* Warming is best-effort; the first real query still works. */ }
  }

  dropNative(id) {
    for (const [token, record] of this.contexts) if (record.authority === 'native:' + id) this.contexts.delete(token);
  }
  async closeAuthority(key) {
    const actors = this.authorityActors.get(key) ?? [];
    const errors = [];
    const application = applicationFor(this.runtime);
    for (const id of actors) {
      const refs = new Set(this.runtime.sessionProjectRefs?.get(id) ?? []);
      const current = this.runtime.sessionProjects.get(id);
      if (current?.projectId) refs.add(current.projectId);
      for (const projectId of refs) {
        try {
          await application.capabilities.detachAgentSession({ projectId, sessionId: id, reason: 'session-closed' });
        } catch (error) { errors.push(error); }
      }
      this.runtime.sessionProjectRefs?.delete(id);
      this.runtime.sessionProjects.delete(id);
    }
    for (const [token, record] of this.contexts) if (record.authority === key) this.contexts.delete(token);
    this.authorityActors.delete(key);
    if (errors.length) throw new AggregateError(errors, 'Project context detach failed');
  }
  async close() {
    this.closed = true;
    try {
      if (this.runtime.service.spaceHome) await Promise.all([...this.authorityActors.keys()].map(key => this.closeAuthority(key)));
    } finally { this.contexts.clear(); if (this.ownsReader) await this.reader.close(); }
  }
}
