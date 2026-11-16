import { randomBytes } from 'node:crypto';
import { BoardError } from '../core/errors.js';
import { createProjectReader } from '../core/project-reader.js';
import { AGENT_CONTEXT_TTL_MS, metadataOperation } from '../shared/agent-tools.js';

const AUTHORITY = Symbol('project-board.authority');
const LIMIT = 2048;
const denied = (code, message) => new BoardError(code, message, { status: 403 });

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
    this.attached = new Map();
    this.authorityActors = new Map();
    this.reader = createProjectReader(runtime.service);
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
    const projectId = args.projectId ?? previous?.projectId;
    if (!authority.native && !projectId) throw new BoardError('invalid-command', 'open requires projectId', { status: 400 });
    if (projectId && !authority.allows(projectId)) throw denied('project-forbidden', 'Project is outside this credential scope');
    const binding = authority.scope === 'metadata' && this.runtime.service.metas.has(projectId)
      ? { projectId } : this.project(exec, projectId);
    for (const [key, record] of this.contexts) if (record.expires <= this.now()) this.contexts.delete(key);
    const activeBindings = new Set([...this.contexts.values()].map((record) => record.actorId + '|' + record.projectId));
    for (const key of this.attached.keys()) if (!activeBindings.has(key)) this.attached.delete(key);
    if (this.contexts.size >= LIMIT) throw new BoardError('context-limit', 'Too many active project contexts; reuse an existing context.', { status: 429 });
    const context = randomBytes(32).toString('hex');
    const actorId = authority.native ? exec.agent.id : previous?.actorId ?? 'mcp_' + randomBytes(16).toString('hex');
    const expires = this.now() + AGENT_CONTEXT_TTL_MS;
    this.contexts.set(context, { authority: authority.key, scope: authority.scope, projectId: binding.projectId, actorId, expires });
    if (!authority.native && authority.scope === 'full') {
      if (!this.authorityActors.has(authority.key)) this.authorityActors.set(authority.key, new Set());
      this.authorityActors.get(authority.key).add(actorId);
    }
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
    const forbidden = ['actor', 'sessionId', 'cwd', 'sessionToken', 'requestId'];
    if (name !== 'project_session') forbidden.push('projectId');
    if (forbidden.some((field) => Object.hasOwn(args, field))) {
      throw new BoardError('invalid-command', 'Identity and credentials must come from the owning execution context; use the shared context field.', { status: 400 });
    }
    if (authority.scope !== 'full' && !metadataOperation(name, args)) {
      throw denied('forbidden-role', 'This credential permits metadata only. Use an authorized full context for this operation.');
    }
    const bootstrap = name === 'project_session' && ['open', 'projects'].includes(args.op);
    if (bootstrap) return { ...exec, projectBoardContext: args.context };
    if (authority.native && args.context === undefined) return exec;
    const record = this.lookup(args.context, authority);
    await this.runtime.ready;
    if (metadataOperation(name, args)) return { ...exec, projectBoard: { projectId: record.projectId, scope: authority.scope } };
    const binding = this.project(exec, record.projectId);
    // Native contexts select a project but never replace the owning agent.
    const agent = authority.native ? { ...exec.agent, session: { ...exec.agent.session, header: { ...exec.agent.session?.header, cwd: binding.root } } }
      : { id: record.actorId, session: { header: { cwd: binding.root } } };
    const attach = async (handle) => {
      const key = record.actorId + '|' + handle.id;
      if (authority.native && handle.state.bindings[agent.id] && !handle.state.bindings[agent.id].detachedAt) return;
      if (!this.attached.has(key)) {
        const pending = handle.attach({ sessionId: agent.id, agentId: agent.id, source: authority.native ? 'tool' : 'mcp', role: 'worker' });
        this.attached.set(key, pending);
        pending.catch(() => this.attached.delete(key));
      }
      await this.attached.get(key);
    };
    const defaultWorkspace = authority.native
      && this.runtime.service.resolveWorkspace(exec.agent.session?.header?.cwd)?.projectId === record.projectId;
    return { ...exec, agent, projectBoard: { projectId: record.projectId, scope: authority.scope, via: authority.native ? 'tool' : 'mcp', defaultWorkspace, attach } };
  }

  dropNative(id) {
    for (const [token, record] of this.contexts) if (record.authority === 'native:' + id) this.contexts.delete(token);
    for (const key of this.attached.keys()) if (key.startsWith(id + '|')) this.attached.delete(key);
  }
  async closeAuthority(key) {
    const actors = this.authorityActors.get(key) ?? [];
    const errors = [];
    for (const id of actors) {
      for (const handle of this.runtime.sessionHandles?.get(id) ?? []) {
        try { if (!handle.closed) await handle.detach(id, 'session-closed'); } catch (error) { errors.push(error); }
      }
      this.runtime.sessionHandles?.delete(id);
      this.runtime.sessionProjects.delete(id);
      for (const attached of this.attached.keys()) if (attached.startsWith(id + '|')) this.attached.delete(attached);
    }
    for (const [token, record] of this.contexts) if (record.authority === key) this.contexts.delete(token);
    this.authorityActors.delete(key);
    if (errors.length) throw new AggregateError(errors, 'Project context detach failed');
  }
  async close() {
    this.closed = true;
    this.contexts.clear();
    this.attached.clear();
    await this.reader.close();
  }
}
