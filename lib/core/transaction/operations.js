// The command-facing payload contains operation requests. Only the model owns implementations and the log.
import { BoardError } from '../errors.js';
import { applyEvent } from '../model.js';
import { assertNoNewStageDependencies } from '../plan-stages.js';
import { privateOperationContext } from '../domain/operation-context.js';
import { taskOperations } from '../domain/operations/tasks.js';
import { PLAN_OPERATIONS } from '../domain/operations/plans.js';
import { DOCUMENT_OPERATIONS } from '../domain/operations/documents.js';
import { projectOperations } from '../domain/operations/projects.js';
import { sessionOperations } from '../domain/operations/sessions.js';
import { LIFECYCLE_OPERATIONS, PREPARATION_OPERATIONS } from '../domain/operations/lifecycle.js';
import { assertPlanOperationBatch, assertPlanOperationCompletion } from '../domain/operations/plans-invariants.js';
import { durableValue, freezeValue, stateContainers } from './values.js';

const operations = Object.freeze({ ...taskOperations, ...PLAN_OPERATIONS, ...DOCUMENT_OPERATIONS, ...projectOperations, ...sessionOperations });
const invalid = message => new BoardError('invalid-command', message, { status: 400 });

function mergeOutcome(out, value) {
  if (value.result) Object.assign(out.result, durableValue(value.result));
  if (value.entityRev !== undefined) out.entityRev = value.entityRev;
  if (value.warnings?.length) out.warnings.push(...durableValue(value.warnings));
  if (value.memoryOnly) out.memoryOnly = true;
}

/** Install the facts of one model operation on the private projection. No I/O or publication here. */
function applyOperations(table, list, work, request, record, out) {
  if (!Array.isArray(list)) throw invalid('expected a list of named operations');
  for (const op of list) {
    if (!op || typeof op !== 'object' || Object.keys(op).some(k => k !== 'kind' && k !== 'args')
        || typeof op.kind !== 'string' || !Object.hasOwn(table, op.kind)) throw invalid('unregistered or invalid model operation: ' + String(op?.kind));
    const facts = table[op.kind](work, freezeValue(durableValue(op.args ?? {})), request) ?? {};
    const rows = durableValue(facts.events ?? []);
    if (!Array.isArray(rows)) throw invalid('model operation returned invalid facts');
    record.events.push(...rows);
    for (const row of rows) applyEvent(work.state, structuredClone(row), record);
    mergeOutcome(out, facts);
  }
}

/** The completed batch, not an intermediate state, is checked. Historical replay never calls this. */
function complete(work, before, events) {
  const deferred = work._lapsed?.pendingDisposition;
  if (events.length && deferred) {
    const interrupted = events.some(row => row.taskId === deferred && row.type === 'task/interrupted');
    if (!interrupted || (work.state.tasks[deferred]?.state === 'in_progress' && !work.leases.has(deferred))) {
      throw invalid('deferred expiry requires an actual interruption of the expired work');
    }
  }
  assertPlanOperationCompletion(work);
  if (work.scratch.size) throw invalid('model operation batch contains unfinished transitions');
  assertPlanOperationBatch(before, work.state, events);
  assertNoNewStageDependencies(before, events);
}

/** Derive provisional facts only in model-owned memory. No command code runs here. */
export function operationDraft(model, request, ports, preparation = null, first = false) {
  const before = model.state;
  const work = privateOperationContext(model, stateContainers(before), model.leases, ports);
  const record = { cmdId: request.cmdId, actor: request.actor ?? ports.systemActor, at: work.clock().toISOString(), seq: model.rev + 1, events: [] };
  const out = { result: {}, warnings: [], memoryOnly: false };
  if (preparation !== null) {
    const restart = !first && ports.restartRecovery === true;
    const bindingIndex = restart ? 2 : 1;
    if (preparation[0]?.kind !== 'lease.normalizeBeforeCommand'
      || (restart && preparation[1]?.kind !== 'lifecycle.recoverBeforeCommand')
      || preparation.length < bindingIndex || preparation.length > bindingIndex + 1
      || (preparation.length > bindingIndex && !['session.bindForCommand', 'session.bindBeforeGrant'].includes(preparation[bindingIndex]?.kind))) {
      throw invalid('invalid transaction preparation');
    }
    if (first) applyOperations(LIFECYCLE_OPERATIONS, [{ kind: 'lifecycle.bootstrap', args: {} }], work, request, record, out);
    applyOperations(PREPARATION_OPERATIONS, preparation, work, request, record, out);
  }
  return { before, work, request, record, out, first, system: preparation === null, prefixSize: record.events.length };
}

/** Only values leave the model; maps are detached and the published entities stay immutable. */
export function operationSample({ work, record }) {
  return Object.freeze({ state: freezeValue(stateContainers(work.state)), leases: structuredClone(work.leases),
    lapsed: structuredClone(work._lapsed), rev: work.rev, at: record.at });
}

/** Execute only materialized operation values. The caller cannot supply transitions, records or functions. */
export function executeOperations(draft, descriptors) {
  const { before, request, work, record, out, system, prefixSize } = draft;
  const list = durableValue(descriptors);
  if (!Array.isArray(list)) throw invalid('expected an array of model operations');
  if (system) {
    if (list.length !== 1) throw invalid('expected one standalone lifecycle operation');
    applyOperations(LIFECYCLE_OPERATIONS, list, work, request, record, out);
  } else {
    if (before.project.phase === 'archived' && (list.length !== 1 || list[0]?.kind !== 'project.applyUpdate')) {
      throw new BoardError('project-archived', 'only unarchive may write an archived project', { status: 409 });
    }
    applyOperations(operations, list, work, request, record, out);
    if (record.events.length > prefixSize && record.events.slice(0, prefixSize).some(e => e.type === 'session/bound' && e.data.autoResume === false)
      && !record.events.slice(prefixSize).some(e => e.type === 'lease/granted' && e.data.sessionId === request.actor?.sessionId)) {
      throw invalid('grant-only binding requires an actual lease grant');
    }
    if (prefixSize === record.events.length) {
      // A no-op or a runtime-only renewal never publishes a first binding or an unrelated sweep.
      record.events.length = 0;
      for (const [id, lease] of work._lapsed?.expired ?? []) if (!work.leases.has(id)) work.leases.set(id, lease);
    }
  }
  complete(work, before, record.events);
  return { ...out, record, leases: work.leases, bindings: work.bindingUpdates };
}
