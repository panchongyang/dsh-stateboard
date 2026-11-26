// Compatibility handle around one model transaction publisher and serial writer.
import { BoardError } from './errors.js';
import { runCommand, serializeProject } from './runtime/serial-command.js';
import { createWorkingContext } from './transaction/work.js';
import { durableValue, freezeValue } from './transaction/values.js';
import { lifecyclePorts } from './transaction/lifecycle-authority.js';
import { actorSystem } from './normalize.js';
import { normalizeEvidence } from './evidence.js';
import { boardView, briefView, docView, docsView, eventsView, healthView, planView, plansView, taskView } from './views.js';
import { taskHints } from './application/task-hints.js';
import { buildDigest } from './digest.js';
import { isolatedHealth, cancelHealth } from './health-audit.js';
import { fullHealth, healthSummary } from './health.js';
import { newId } from './util.js';
import {
  assertLease,
  assertPlanActive,
  assertRev,
  assigneeResumeDenial,
  leaseBindingCurrent,
  leaseOf,
  nowMs,
  requireTask,
} from './lease.js';
import { applyRelocate } from './adapters/command-workspace.js';


/** Compatibility guard: only a fully published model value may be read. */
export function assertStateAttached(handle) {
  if (handle.state.lastSeq !== handle.rev || handle.state.lastHash !== handle.lastHash || handle.state.project.rev !== handle.rev) {
    throw new BoardError('state-desync', 'published model watermarks disagree', { status: 500 });
  }
}

export class ProjectHandle {
  constructor(service, meta, store, data) {
    this.service = service;
    // The handle does the lease arithmetic; it must see the same clock as the
    // service so tests can advance time deterministically.
    this.clock = service.clock;
    this.meta = meta;
    this.store = store;
    this.model = store.model;
    this.readOnly = Boolean(data.readOnly);

    this.closed = false;
    // 新项目不是重启；只有从既有日志重放的物理 writer 才需处理历史工作。
    this.recovered = data.lastSeq === 0;
    // Per-command expiry context (normalizeExpiredLeases); null outside a command.
    this._lapsed = null;
  }

  get state() { return this.model.state; }
  get timeline() { return this.model.timeline; }
  get rev() { return this.model.rev; }
  get lastHash() { return this.model.lastHash; }
  get cmdIds() { return this.model.cmdIds; }
  get leases() { return this.model.leases; }
  committedSnapshot() { return this.model.snapshot(); }
  _working(service = this.service) { return createWorkingContext(this.model, { service, store: this.store, meta: this.meta, clock: this.clock }); }

  get id() { return this.state.project.id; }
  get name() { return this.state.project.name; }
  get workspacePath() { return this.state.project.workspacePath; }

  _exclusive(fn) { return serializeProject(this.model, fn); }

  _ensureOpen() {
    if (this.closed) throw new BoardError('closed', 'project handle is closed', { status: 503 });
  }

  command(cmd, options = {}) { return this._commandForService(this.service, cmd, options); }

  async _commandForService(service, cmd, { claimSessionSource, workSessionSource = claimSessionSource, agentSessionSource } = {}) {
    this._ensureOpen();
    const request = freezeValue(durableValue(cmd));
    const session = freezeValue(durableValue({ workSessionSource, agentSessionSource }));
    return this._exclusive(() => runCommand(this, service, request, session))
      .catch(error => { if (this.store.readOnly) this.readOnly = true; throw error; });
  }

  _systemOperations(request, operations, { ephemeral = false } = {}) {
    this._ensureOpen();
    try { return this.model.lifecycle(request, operations, lifecyclePorts(this._transactionPorts(this.service, ephemeral))); }
    catch (error) { if (this.store.readOnly) this.readOnly = true; throw error; }
  }

  _transactionPorts(service, ephemeral = false) {
    this._ensureOpen(); service._assertOpen?.();
    const readOnly = this.readOnly || this.store.readOnly;
    if (readOnly && !ephemeral) throw new BoardError('read-only', 'project writer is read-only', { status: 503 });
    return {
      readOnly, ephemeral, medium: this.store, clock: this.clock, systemActor: actorSystem(),
      privilegedInlineWrites: service.privilegedInlineWrites === true,
      newId: prefix => service.idgen?.(prefix) || newId(prefix),
      historicalAcceptance: ids => {
        const wanted = new Set(ids), found = new Map();
        for (const commit of this.store.commits) for (const { type, data } of commit.events) {
          if (type.startsWith('task/') && wanted.has(data?.id) && data.acceptance?.length) found.set(data.id, structuredClone(data.acceptance));
        }
        return found;
      },
    };
  }

  /** Recover the task ID from its original committed create command, including before a snapshot. */
  createdTaskId(cmdId) {
    const commit = this.store.commits.findLast((entry) => entry.cmdId === cmdId);
    return commit?.events.find((event) => event.type === 'task/created')?.taskId ?? null;
  }

  /** Recover only the still-live grant made by this exact claim command. */
  liveClaimReceipt({ taskId, sessionId, cmdId }) {
    if (this.closed || this.readOnly || this.store.readOnly || this.state.project.phase === 'archived') return null;
    const lease = leaseOf(this, taskId);
    const task = this.state.tasks[taskId];
    if (!lease || lease.sessionId !== sessionId || !leaseBindingCurrent(this.state, lease)
      || task?.state !== 'in_progress' || task.owner?.fencingToken !== lease.token) return null;
    const grant = this.timeline.findLast((entry) => entry.taskId === taskId && entry.type === 'lease/granted');
    return grant?.cmdId === cmdId ? { fencingToken: lease.token, expiresAt: lease.expiresAt } : null;
  }

  _applyRelocateSafe(relocate, warnings) {
    if (!relocate) return;
    try {
      applyRelocate(this, relocate);
    } catch (error) {
      // The commit is already durable: never turn a derived meta/registry
      // failure into a failed command. Surface it and let the next open heal.
      warnings.push({
        code: 'relocate-meta-failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 内部诊断只允许不会写 blob 或预留绑定的操作，不是查询或写授权。 */
  async _preflight(cmd) {
    this._ensureOpen();
    return this._exclusive(() => {
      if (!cmd || typeof cmd.op !== 'string') throw new BoardError('invalid-command', 'command op is required', { status: 400 });
      if (this.readOnly || this.store.readOnly) throw new BoardError('read-only', 'project writer is read-only', { status: 503 });
      if (!['task.reconcile', 'task.submit'].includes(cmd.op)) throw new BoardError('invalid-command', 'no preflight for this operation', { status: 400 });
      return runCommand(this, this.service, freezeValue(durableValue(cmd)), {}, true);
    });
  }

  // Thin delegates keep every call site unchanged; the implementations live in
  // lease.js (and evidence.js), which take this handle as their first argument.
  _requireTask(cmd) { return requireTask(this, cmd); }
  _assertRev(task, cmd) { return assertRev(this, task, cmd); }
  _nowMs() { return nowMs(this); }
  _leaseOf(taskId) { return leaseOf(this, taskId); }
  _assigneeResumeDenial(assignee) { return assigneeResumeDenial(this, assignee); }
  _assertLease(task, cmd, options = {}) { return assertLease(this, task, cmd, options); }
  _assertPlanActive(task) { return assertPlanActive(this, task); }
  _expireLeases() {
    if (this.readOnly || this.store.readOnly || this.state.project.phase === 'archived') return;
    return this._systemOperations({ actor: actorSystem(), cmdId: 'cmd_expire_' + newId('x') },
      [{ kind: 'lifecycle.sweep', args: {} }]);
  }
  _normalizeEvidence(task, raw, at, actor) { return normalizeEvidence(this, task, raw, at, actor); }

  /** One recovery operation installs expiry and task/intent audit in one receipt. */
  recover() {
    if (this.readOnly || this.store.readOnly || this.recovered || this.state.project.phase === 'archived') return;
    this._systemOperations({ actor: actorSystem(), cmdId: 'cmd_recover_' + newId('x') },
      [{ kind: 'lifecycle.recover', args: {} }]);
    this.recovered = true;
  }

  async attach({ sessionId, agentId, source, role } = {}) {
    this._ensureOpen();
    return this._exclusive(() => {
      const result = this._systemOperations({ actor: { kind: 'system', via: 'system' }, cmdId: 'cmd_bind_' + newId('x') },
        [{ kind: 'lifecycle.attach', args: { sessionId, agentId, source, role } }],
        { ephemeral: this.readOnly || this.store.readOnly || this.state.project.phase === 'archived' });
      return result.binding;
    });
  }

  async detach(sessionId, reason = 'session-closed') {
    if (!sessionId) return;
    return this._exclusive(() => {
      this._systemOperations({ actor: { kind: 'system', via: 'system' }, cmdId: 'cmd_detach_' + newId('x') },
        [{ kind: 'lifecycle.detach', args: { sessionId, reason } }],
        { ephemeral: this.readOnly || this.store.readOnly || this.state.project.phase === 'archived' });
    });
  }

  touch(sessionId) {
    if (!sessionId || this.closed || this.readOnly || this.store.readOnly || this.state.project.phase === 'archived') return;
    this._systemOperations({ actor: actorSystem(), cmdId: 'cmd_activity_' + newId('x') },
      [{ kind: 'lifecycle.activity', args: { sessionId } }], { ephemeral: true });
    this.store.touchLock?.();
  }

  /**
   * Pull in commits another process appended since this handle last looked.
   * Only meaningful for a read-only handle; a writer already has the state.
   */
  refresh() {
    if (!this.store || typeof this.store.refresh !== 'function') return null;
    const data = this.store.refresh();
    if (!data) return null;
    this.model = this.store.model;
    return this.rev;
  }

  digest(sessionId, options) {
    this._ensureOpen();
    return buildDigest(briefView(this, sessionId), sessionId, options);
  }

  healthSummary() { return healthSummary(this); }

  /** Host-facing full audit: synchronous internals run only in a worker. */
  healthAsync(options) {
    this._ensureOpen();
    return isolatedHealth(this, options);
  }

  /** Compatibility API: explicit synchronous callers retain the full audit. */
  health(options) { return fullHealth(this, options); }

  query(view, params = {}) {
    const hintsFor = (handle, input) => taskHints({
      state: handle.state, leases: handle.leases, now: handle._nowMs(), readOnly: handle.readOnly,
      taskId: input.taskId, sessionId: input.sessionId,
    });
    this._ensureOpen();
    switch (view) {
      case 'brief': return briefView(this, params.sessionId);
      case 'board': return boardView(this);
      case 'task': return taskView(this, params.taskId, params.sessionId, hintsFor(this, params));
      case 'plan': return planView(this, params.planId);
      case 'plans': return plansView(this, params);
      case 'docs': return docsView(this);
      case 'doc': return docView(this, params.docId, params.maxBytes);
      case 'events': return eventsView(this, params.after, params.limit);
      case 'health': return healthView(this);
      default: throw new BoardError('invalid-command', 'unknown view: ' + view, { status: 400 });
    }
  }

  close() {
    this.closed = true;
    cancelHealth(this);
    this.store.close?.();
  }
}