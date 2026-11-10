// ProjectHandle: the command bus for one open project.
//
// The handle owns the commit path (validation staging, lease expiry collection,
// append, relocate metadata), the read models and the session lifecycle. Command
// semantics live in lib/core/commands/*; lease arithmetic in lease.js; project
// registry and handle sharing in service.js, which re-exports this class.
//
// The clone/restore dance in command() is load-bearing: a rejected command must
// leave no partial write. store.append() returns the state it applied events to
// and the handle adopts it explicitly; assertStateAttached() guards that hand-off.
// test/alias-guard.test.mjs is the tripwire.

import { BoardError } from './errors.js';
import { validateIntakeCommand } from './command-shape.js';
import { makeCommit } from './store.js';
import { normalizePlanHeads } from './model.js';
import { actorSystem } from './normalize.js';
import { assertNoNewStageDependencies } from './plan-stages.js';
import { normalizeEvidence } from './evidence.js';
import { releaseEvents, restartLeaseRecord } from './contracts.js';
import { boardView, briefView, docView, docsView, eventsView, healthView, planView, plansView, taskView } from './views.js';
import { buildDigest } from './digest.js';
import { isolatedHealth, cancelHealth } from './health-audit.js';
import { fullHealth, healthSummary } from './health.js';
import { newId } from './util.js';
import {
  assertLease,
  assertPlanActive,
  assertRev,
  assigneeResumeDenial,
  collectExpiredLeases,
  expireLeases,
  grantLease,
  isLeaseReclaimable,
  leaseBindingCurrent,
  leaseOf,
  leaseRenewalExpiry,
  markLeaseProgress,
  normalizeExpiredLeases,
  nowMs,
  requireTask,
} from './lease.js';
import { COMMAND_HANDLERS } from './commands/index.js';
import { applyRelocate } from './commands/project.js';
import { sessionBinding, sessionBoundEvents, sessionDetachedEvents, stageClaimBinding } from './commands/session.js';

function isUnarchiveCommand(cmd, wasArchived = false) {
  return Boolean(wasArchived) && cmd.op === 'project.update' && (cmd.phase === 'active' || cmd.phase === 'paused');
}

/**
 * The handle must read the state object the store applies events to. append()
 * returns that state and the handle adopts it; a store implementation that
 * returns a detached copy would otherwise lose every write. Fail loudly.
 */
export function assertStateAttached(handle) {
  if (handle.state !== handle.store.state) {
    throw new BoardError('state-desync', 'handle.state is not the store state; a commit would be applied to a detached object', { status: 500 });
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
    this.state = data.state;
    normalizePlanHeads(this.state);
    this.timeline = data.timeline;
    this.rev = data.lastSeq;
    this.lastHash = data.lastHash;
    this.cmdIds = data.cmdIds;
    this.readOnly = Boolean(data.readOnly);
    this.leases = new Map();
    this.closed = false;
    this.recovered = false;
    // Per-command expiry context (normalizeExpiredLeases); null outside a command.
    this._lapsed = null;
    this._chain = Promise.resolve();
  }

  get id() { return this.state.project.id; }
  get name() { return this.state.project.name; }
  get workspacePath() { return this.state.project.workspacePath; }

  _exclusive(fn) {
    const next = this._chain.then(fn, fn);
    this._chain = next.then(() => undefined, () => undefined);
    return next;
  }

  _ensureOpen() {
    if (this.closed) throw new BoardError('closed', 'project handle is closed', { status: 503 });
  }

  _appendEvents(events, actor, cmdId, baseRev, { allowArchived = false } = {}) {
    if (!events || events.length === 0) return null;
    if (this.state.project.phase === 'archived' && !allowArchived) {
      throw new BoardError('project-archived', 'the project is archived; only unarchive may write', { status: 409, details: { projectId: this.id, phase: 'archived' } });
    }
    const seq = this.rev + 1;
    const commit = makeCommit(seq, this.lastHash, actor || actorSystem(), cmdId, baseRev ?? this.rev, events);
    try {
      this.state = this.store.append(commit);
    } catch (error) {
      // An uncertain write must also close the command entry gate: a retry must
      // not stage leases or write another blob before the store rejects it.
      if (this.store.readOnly) this.readOnly = true;
      throw error;
    }
    assertStateAttached(this);
    this.rev = seq;
    this.lastHash = commit.hash;
    this.cmdIds.add(commit.cmdId);
    this.state.lastSeq = seq;
    this.state.lastHash = commit.hash;
    this.state.project.rev = seq;
    return commit;
  }

  async command(cmd, { claimSessionSource } = {}) {
    this._ensureOpen();
    return this._exclusive(async () => {
      if (!cmd || typeof cmd.op !== 'string') throw new BoardError('invalid-command', 'command op is required', { status: 400 });
      if (typeof cmd.cmdId !== 'string' || cmd.cmdId === '') throw new BoardError('invalid-command', 'cmdId is required', { status: 400 });
      if (this.readOnly) throw new BoardError('read-only', 'another process holds this project lock', { status: 503 });
      if (this.cmdIds.has(cmd.cmdId)) {
        return { ok: true, committed: true, deduped: true, projectRev: this.rev, events: [] };
      }
      if (cmd.expected && Number.isInteger(cmd.expected.projectRev) && cmd.expected.projectRev !== this.rev) {
        throw new BoardError('stale-revision', 'project rev is ' + this.rev + ', expected ' + cmd.expected.projectRev, {
          status: 409,
          details: { currentRev: this.rev },
        });
      }
      // Entry precheck: reject before the handler can write a blob or mutate the
      // in-memory lease table. _appendEvents repeats the check as a backstop for
      // every direct writer (recover/attach/detach/expire).
      const wasArchived = this.state.project.phase === 'archived';
      const unarchive = isUnarchiveCommand(cmd, wasArchived);
      if (wasArchived && !unarchive) {
        throw new BoardError('project-archived', 'the project is archived; unarchive it before any write', {
          status: 409,
          details: { projectId: this.id, phase: 'archived', allowed: ['project.update(phase=active|paused)'] },
        });
      }
      const realState = this.state;
      const realLeases = this.leases;
      const { result, preceding, lapsed } = this._executeOnWorkingCopy(cmd, claimSessionSource);
      const events = result.events || [];
      if (events.length === 0) {
        const workingLeases = this.leases;
        this.state = realState;
        if (result.memoryOnly) {
          // Nothing is committed, so the uncommitted expiry must not leak into the
          // runtime lease table either.
          for (const [taskId, lease] of lapsed.expired) if (!workingLeases.has(taskId)) workingLeases.set(taskId, lease);
        }
        this.leases = result.memoryOnly ? workingLeases : realLeases;
        return {
          ok: true,
          committed: false,
          deduped: false,
          projectRev: this.rev,
          events: [],
          ...(result.result || {}),
        };
      }
      if (preceding.length > 0) events.unshift(...preceding);
      const warnings = [];
      if (Array.isArray(result.warnings)) warnings.push(...result.warnings);
      const workingLeases = this.leases;
      const claimBinding = claimSessionSource ? this.state.bindings[cmd.actor.sessionId] : null;
      this.state = realState;
      this.leases = realLeases;
      const commit = this._appendEvents(events, cmd.actor || actorSystem(), cmd.cmdId, cmd.expected?.projectRev ?? this.rev, { allowArchived: unarchive });
      this.leases = workingLeases;
      // An external session has no DSH touch calls. A successful grant refreshes
      // runtime liveness. Replace the projection so a historical event stays immutable.
      if (claimBinding) this.state.bindings[claimBinding.sessionId] = { ...claimBinding };
      if (unarchive) {
        this.recovered = true;
        this.leases.clear();
      }
      this._applyRelocateSafe(result.relocate, warnings);
      return {
        ok: true,
        committed: true,
        deduped: false,
        projectRev: this.rev, entityRev: result.entityRev,
        events: commit.events,
        ...(result.result || {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    });
  }

  /**
   * Swap in a cloned state/lease table, apply expiry to it, then run the handler.
   * Expiry and the command's events ride in one commit; a rejection restores the
   * real state/leases and drops both. On success the working copy stays installed.
   */
  _executeOnWorkingCopy(cmd, claimSessionSource) {
    const realState = this.state;
    const realLeases = this.leases;
    this.state = structuredClone(realState);
    this.leases = new Map([...realLeases].map(([taskId, lease]) => [taskId, structuredClone(lease)]));
    try {
      const preceding = normalizeExpiredLeases(this, cmd);
      if (claimSessionSource) stageClaimBinding(this, cmd, claimSessionSource, preceding);
      const result = this._execute(cmd);
      return { result, preceding, lapsed: this._lapsed };
    } catch (error) {
      this.state = realState;
      this.leases = realLeases;
      throw error;
    } finally {
      this._lapsed = null;
    }
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

  _execute(cmd) {
    // One registry for every command: op -> handler(handle, cmd). hasOwn keeps an
    // op like `constructor` on the unknown-command path instead of calling it.
    const handler = Object.hasOwn(COMMAND_HANDLERS, cmd.op) ? COMMAND_HANDLERS[cmd.op] : null;
    if (!handler) throw new BoardError('invalid-command', 'unknown command op: ' + cmd.op, { status: 400 });
    validateIntakeCommand(cmd, this.state);
    const result = handler(this, cmd);
    assertNoNewStageDependencies(this.state, result.events);
    return result;
  }

  /**
   * Validate a command on cloned state without committing. The host uses this
   * before executing command evidence: a submit to a missing/stale task must
   * fail before the command's side effects happen. It does not dedupe, append,
   * collect expired leases, or touch blobs.
   */
  async _preflight(cmd) {
    this._ensureOpen();
    return this._exclusive(async () => {
      if (!cmd || typeof cmd.op !== 'string') throw new BoardError('invalid-command', 'command op is required', { status: 400 });
      if (this.readOnly) throw new BoardError('read-only', 'another process holds this project lock', { status: 503 });
      if (this.state.project.phase === 'archived' && !isUnarchiveCommand(cmd, true)) {
        throw new BoardError('project-archived', 'the project is archived; unarchive it before any write', { status: 409 });
      }
      if (cmd.expected && Number.isInteger(cmd.expected.projectRev) && cmd.expected.projectRev !== this.rev) {
        throw new BoardError('stale-revision', 'project rev is ' + this.rev + ', expected ' + cmd.expected.projectRev, { status: 409 });
      }
      const realState = this.state;
      const realLeases = this.leases;
      this.state = structuredClone(realState);
      this.leases = new Map([...realLeases].map(([taskId, lease]) => [taskId, structuredClone(lease)]));
      try {
        normalizeExpiredLeases(this, cmd);
        this._execute(cmd);
      } finally {
        this._lapsed = null;
        this.state = realState;
        this.leases = realLeases;
      }
      return true;
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
  _grantLease(task, actor, at) { return grantLease(this, task, actor, at); }
  _markLeaseProgress(taskId) { return markLeaseProgress(this, taskId); }
  _expireLeases() { return expireLeases(this); }
  _collectExpiredLeases() { return collectExpiredLeases(this); }
  _normalizeEvidence(task, raw, at, actor) { return normalizeEvidence(this, task, raw, at, actor); }

  /**
   * One recovery pass per writer. Each in_progress task is released together
   * with the audit of the lease that died with the previous process — the
   * `lease/expired` record and the state transition land in the SAME commit,
   * because a restart must leave "why did this lease end" in the log.
   * The record can only be rebuilt from durable data (restartLeaseRecord); the
   * lease table is empty after a cold start.
   * A second recover, or a second writer opening the recovered log, finds no
   * in_progress task and appends nothing. Archived projects take no recover
   * commit at all; unarchive carries the recovery events instead.
   */
  recover() {
    if (this.readOnly || this.recovered) return;
    if (this.state.project.phase === 'archived') return;
    this.recovered = true;
    const at = new Date().toISOString();
    const events = [];
    for (const task of Object.values(this.state.tasks)) {
      if (task.state !== 'in_progress') continue;
      events.push(...releaseEvents(this, restartLeaseRecord(task), at, 'lease/expired'));
    }
    if (events.length > 0) this._appendEvents(events, actorSystem(), 'cmd_recover_' + newId('x'), this.rev);
  }

  async attach({ sessionId, agentId, source, role } = {}) {
    this._ensureOpen();
    return this._exclusive(async () => {
      if (typeof sessionId !== 'string' || sessionId === '') throw new BoardError('invalid-command', 'sessionId is required', { status: 400 });
      const binding = sessionBinding(this, sessionId, { source, role, agentId });
      // Archived means "no events". Keep the binding ephemeral so the panel can
      // still be opened read-only; persist it again only after unarchive.
      if (this.readOnly || this.state.project.phase === 'archived') {
        this.state.bindings[sessionId] = binding;
        return binding;
      }
      const events = sessionBoundEvents(this, sessionId, binding);
      this._appendEvents(events, { kind: 'system', via: 'system' }, 'cmd_bind_' + sessionId + '_' + binding.epoch, this.rev);
      return binding;
    });
  }

  async detach(sessionId, reason = 'session-closed') {
    if (!sessionId) return;
    return this._exclusive(async () => {
      if (this.state.project.phase === 'archived') {
        const binding = this.state.bindings[sessionId];
        const at = this.clock().toISOString();
        if (binding) this.state.bindings[sessionId] = { ...binding, detachedAt: at, lastSeenAt: at, reason };
        return undefined;
      }
      const { at, binding, events } = sessionDetachedEvents(this, sessionId, reason);
      if (events.length > 0 && !this.readOnly) this._appendEvents(events, { kind: 'system', via: 'system' }, 'cmd_detach_' + sessionId + '_' + this._nowMs(), this.rev);
      if (this.readOnly) this.state.bindings[sessionId] = { ...(binding || {}), detachedAt: at, reason };
      return undefined;
    });
  }

  touch(sessionId) {
    if (!sessionId || this.closed || this.readOnly || this.state.project.phase === 'archived') return;
    const now = this._nowMs();
    const binding = this.state.bindings[sessionId];
    if (!binding || binding.detachedAt) {
      this.store.touchLock?.();
      return;
    }
    binding.lastSeenAt = new Date(now).toISOString();
    for (const lease of this.leases.values()) {
      if (lease.sessionId !== sessionId) continue;
      if (binding.epoch != null && lease.epoch != null && lease.epoch !== binding.epoch) continue;
      if (isLeaseReclaimable(this, lease, now)) continue;
      const expiry = leaseRenewalExpiry(this, lease, now);
      if (expiry !== null) lease.expiresAt = new Date(expiry).toISOString();
    }
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
    this.state = data.state;
    this.timeline = data.timeline;
    this.rev = data.lastSeq;
    this.lastHash = data.lastHash;
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
    this._ensureOpen();
    switch (view) {
      case 'brief': return briefView(this, params.sessionId);
      case 'board': return boardView(this);
      case 'task': return taskView(this, params.taskId, params.sessionId);
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
