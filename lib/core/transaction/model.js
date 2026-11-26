// The model owns committed values. Storage returns a physical receipt; it never
// applies events or publishes a partially constructed transaction.
import { BoardError } from '../errors.js';
import { executeOperations, operationDraft, operationSample } from './operations.js';
import { applyEvent, normalizePlanHeads } from '../model.js';
import { assertRecordBatch } from './records.js';
import { eventActor, makeCommit, validateCommit } from '../domain/commit-envelope.js';
import { canonicalJSON } from '../domain/value-hash.js';
import { takeLifecycleAuthority } from './lifecycle-authority.js';

import { durableValue, freezeValue, stateContainers } from './values.js';
export { freezeValue } from './values.js';

// The physical port consumes a one-use, medium-specific receipt request. An arbitrary
// hash-correct envelope, even from a prior successful commit, is not a transaction.
const headerFields = new Set(['cmdId', 'actor', 'expected', 'taskId', 'fencingToken', 'authorized']);
const pending = new WeakMap();
// Only a successful model preparation can issue this ticket. Its caller never sees a raw record.
const initialRecords = new WeakMap();
export function requirePendingRecord(store, record) {
  if (pending.get(store) !== record || !record) throw new BoardError('invalid-command', 'only a staged model transaction may append', { status: 400 });
  pending.delete(store);
}

function flattenTimeline(tail) {
  const chunks = [];
  for (; tail; tail = tail.previous) chunks.push(tail.rows);
  return freezeValue(chunks.reverse().flat());
}

export class TransactionModel {
  #persistedState; #state; #runtime; #cmdIds; #leases;
  #timelineTail; #timelineCache; #cmdIdBase;
  #commands = new WeakMap();

  constructor(data, { leases = data.leases ?? new Map() } = {}) {
    this.#persistedState = freezeValue(normalizePlanHeads(structuredClone(data.state)));
    this.#state = this.#persistedState;
    this.#runtime = {};
    const rows = freezeValue(structuredClone(data.timeline || []));
    this.#timelineTail = { rows, previous: null, length: rows.length };
    this.#timelineCache = rows;
    this.#cmdIds = new Set(data.cmdIds || []);
    this.#cmdIdBase = Object.freeze([...this.#cmdIds]);
    this.#leases = structuredClone(leases);
  }
  get state() { return this.#state; }
  get persistedState() { return this.#persistedState; }
  get leases() { return structuredClone(this.#leases); }
  get cmdIds() { return new Set(this.#cmdIds); }

  /** Build a separate follower from verified disk facts; never mutate or persist through the live writer. */
  static replayTail(previous, history, records) {
    const next = new TransactionModel(previous.snapshot());
    const prefix = history.slice();
    for (const record of records) {
      const prepared = next.#prepare(record, prefix);
      next.#publish(prepared, record, next.#leases);
      prefix.push(record);
    }
    return next;
  }
  get timeline() {
    if (!this.#timelineCache) this.#timelineCache = flattenTimeline(this.#timelineTail);
    return this.#timelineCache;
  }
  get rev() { return this.#state.lastSeq; }
  get lastHash() { return this.#state.lastHash; }
  snapshot() {
    return Object.freeze({ state: this.#state, timeline: this.timeline,
      lastSeq: this.rev, lastHash: this.lastHash,
      cmdIds: new Set(this.#cmdIds), leases: structuredClone(this.#leases) });
  }
  // Capture anchors, not full history. Each optional getter remains pinned to this
  // revision even if it is first requested after a later command publishes.
  readSnapshot() {
    const state = this.#state, tail = this.#timelineTail, base = this.#cmdIdBase;
    const leases = structuredClone(this.#leases);
    let timeline = this.#timelineCache, cmdIds;
    return Object.freeze({ state, lastSeq: state.lastSeq, lastHash: state.lastHash, leases,
      get timeline() { return timeline ??= flattenTimeline(tail); },
      get cmdIds() {
        if (!cmdIds) {
          cmdIds = new Set(base);
          for (let node = tail; node; node = node.previous) if (node.cmdId) cmdIds.add(node.cmdId);
        }
        return cmdIds;
      } });
  }
  #admit(cmd, expectedBase = this.rev) {
    if (!cmd || Array.isArray(cmd) || typeof cmd !== 'object' || Object.keys(cmd).some(k => !headerFields.has(k))) {
      throw new BoardError('invalid-command', 'expected transaction identity and preconditions, not a command', { status: 400 });
    }
    if (typeof cmd.cmdId !== 'string' || cmd.cmdId === '') throw new BoardError('invalid-command', 'cmdId is required', { status: 400 });
    if (this.#cmdIds.has(cmd.cmdId)) return false;
    if (Number.isInteger(cmd.expected?.projectRev) && cmd.expected.projectRev !== expectedBase) {
      throw new BoardError('stale-revision', 'project rev is ' + expectedBase + ', expected ' + cmd.expected.projectRev,
        { status: 409, details: { currentRev: expectedBase } });
    }
    return true;
  }
  /** Start at the serialized write position. The sample is an opaque one-use key, not the draft. */
  beginCommand(header, preparation, ports) { return this.#begin(header, preparation, ports, false); }

  beginFirstCommand(header, preparation, ports) {
    if (this.rev !== 0 || this.lastHash !== 'genesis') throw new BoardError('illegal-transition', 'project already has a log', { status: 409 });
    return this.#begin(header, preparation, ports, true);
  }

  #begin(header, preparation, ports, first) {
    const identity = freezeValue(durableValue(header));
    // Create-on-first-use accepts the version of the newly created project. No prior commit exists.
    if (!this.#admit(identity, first ? this.rev + 1 : this.rev)) return { receipt: this.#duplicate() };
    if (!Array.isArray(preparation)) throw new BoardError('invalid-command', 'expected prepared operation values', { status: 400 });
    const draft = operationDraft(this, identity, ports, durableValue(preparation), first);
    const sample = operationSample(draft);
    this.#commands.set(sample, { draft, ports, leases: this.#leases });
    return { sample };
  }

  #duplicate() { return { ok: true, committed: true, deduped: true, projectRev: this.rev, events: [] }; }

  discardCommand(sample) { this.#commands.delete(sample); }

  #take(sample) {
    const frame = this.#commands.get(sample);
    this.#commands.delete(sample);
    if (!frame || frame.draft.before !== this.#state || frame.leases !== this.#leases) {
      throw new BoardError('stale-revision', 'operation sample no longer identifies the current transaction', { status: 409 });
    }
    return frame;
  }

  submitOperations(sample, operations) {
    const { draft, ports } = this.#take(sample);
    if (draft.first) throw new BoardError('invalid-command', 'use the initial project transaction', { status: 400 });
    return this.#finish(draft.request, executeOperations(draft, operations), ports);
  }

  prepareFirstOperations(sample, operations) {
    const { draft, ports } = this.#take(sample);
    if (!draft.first || ports.readOnly || ports.ephemeral) throw new BoardError('invalid-command', 'expected an initial write', { status: 400 });
    const stage = executeOperations(draft, operations);
    if (!stage.record.events.length) throw new BoardError('invalid-command', 'an empty command cannot create a project', { status: 400 });
    const ticket = Object.freeze({});
    initialRecords.set(ticket, { base: canonicalJSON(this.#state), batch: this.#materialize(draft.request, stage, []) });
    return ticket;
  }

  commitFirst(ticket, ports) {
    const entry = initialRecords.get(ticket);
    initialRecords.delete(ticket);
    const store = ports.medium;
    if (!entry || this.rev !== 0 || store.model !== this || store.lastSeq !== 0 || store.lastHash !== 'genesis'
      || store.commits.length || this.#leases.size || this.#cmdIds.size || canonicalJSON(this.#state) !== entry.base) {
      throw new BoardError('invalid-command', 'initial transaction does not belong to this empty project', { status: 400 });
    }
    if (ports.readOnly || ports.ephemeral) throw new BoardError('read-only', 'initial transaction needs a writer', { status: 503 });
    return this.#commitRecord(store, entry.batch);
  }

  previewOperations(sample, operations) {
    executeOperations(this.#take(sample).draft, operations);
    return true;
  }

  lifecycle(header, operations, ports) {
    const identity = freezeValue(durableValue(header));
    const descriptors = durableValue(operations);
    takeLifecycleAuthority(ports, this, identity.actor, descriptors);
    if (!this.#admit(identity)) return this.#duplicate();
    return this.#finish(identity, executeOperations(operationDraft(this, identity, ports), descriptors), ports);
  }

  #finish(cmd, staged, io) {
    const { record, leases } = staged;
    if (!record.events.length) {
      if (staged.memoryOnly) this.#publishRuntime(leases, staged.bindings);
      return { ...staged.result, ok: true, committed: false, deduped: false, projectRev: this.rev, events: [] };
    }
    if (io.ephemeral || io.readOnly) throw new BoardError('read-only', 'ephemeral operation may not commit', { status: 503 });
    return this.#commitRecord(io.medium, this.#materialize(cmd, staged, io.medium.commits));
  }

  #materialize(cmd, staged, history) {
    const { record, leases, bindings } = staged;
    const commit = makeCommit(record.seq, this.lastHash, record.actor, cmd.cmdId, this.rev, record.events, record.at);
    const prepared = this.#prepare(commit, history, bindings);
    // 回执归调用方；提交前分离可修改的数据，权威记录与投影不向提交者开放。
    const response = { ...staged.result, ok: true, committed: true, deduped: false, projectRev: commit.seq, entityRev: staged.entityRev,
      events: structuredClone(commit.events), ...(staged.warnings.length ? { warnings: staged.warnings } : {}) };
    return { commit: freezeValue(commit), prepared, leases, response };
  }

  #publishRuntime(leases, bindings) {
    const runtime = freezeValue({ ...this.#runtime, ...Object.fromEntries(bindings) });
    const state = freezeValue({ ...this.#persistedState, bindings: { ...this.#persistedState.bindings, ...runtime } });
    this.#runtime = runtime;
    this.#state = state;
    this.#leases = leases;
  }

  #prepare(commit, commits, bindings = new Map()) {
    validateCommit(commit, { line: commit.seq, validSeq: this.rev, validHash: this.lastHash });
    assertRecordBatch(this.#state, commit, commits);
    // Replay replaces entity records; only top-level containers and project /
    // counters are mutable. Untouched records stay frozen and structurally shared.
    // A future nested mutation fails here, before the medium sees a byte.
    const state = stateContainers(this.#persistedState);
    for (const event of commit.events) applyEvent(state, structuredClone(event), commit);
    state.lastSeq = commit.seq;
    state.lastHash = commit.hash;
    state.project.rev = commit.seq;
    const rows = commit.events.map((event) => ({ seq: commit.seq, at: commit.at,
      type: event.type, taskId: event.taskId || null, actor: structuredClone(eventActor(event, commit)), cmdId: commit.cmdId }));
    const runtime = { ...this.#runtime, ...Object.fromEntries(bindings) };
    for (const event of commit.events) if (event.type === 'session/bound' || event.type === 'session/detached') delete runtime[event.data.sessionId];
    const persistedState = freezeValue(state);
    return { state: persistedState, rows: freezeValue(rows), runtime,
      publishedState: Object.keys(runtime).length ? freezeValue({ ...persistedState, bindings: { ...persistedState.bindings, ...runtime } }) : persistedState,
      tail: { rows, cmdId: commit.cmdId, previous: this.#timelineTail, length: this.#timelineTail.length + rows.length } };

  }
  #commitRecord(store, batch) {
    const { commit, prepared, leases, response } = batch;
    let receipt;
    pending.set(store, commit);
    try { receipt = store.commitPhysical(commit); } finally { pending.delete(store); }
    try {
      if (receipt?.seq !== commit.seq || receipt?.hash !== commit.hash) throw new Error('physical receipt does not identify the requested commit');
      this.#publish(prepared, commit, leases);
    } catch (cause) {
      store.readOnly = true;
      store.stopHeartbeat?.();
      throw new BoardError('log-write-uncertain', 'durable commit publication failed; reopen the verified log before writing', {
        status: 503, details: { outcome: 'unknown', phase: 'publish', cause: String(cause) },
      });
    }
    // Side-file failure is not a failure of the durable transaction.
    if (commit.seq % 200 === 0) { try { store.saveSnapshot(); } catch { /* optimization */ } }
    return response;
  }
  #publish(prepared, commit, leases) {
    this.#persistedState = prepared.state;
    this.#runtime = prepared.runtime;
    this.#state = prepared.publishedState;
    this.#timelineTail = prepared.tail;
    this.#timelineCache = null;
    this.#cmdIds.add(commit.cmdId);
    this.#leases = leases;
  }
}
