import { defineTool } from '@deepseek-ai/dsh-tools';
import { BoardError } from '../../core/errors.js';
import { validateToolIntake } from '../../core/command-shape.js';
import { EVIDENCE_KINDS, TASK_OPS } from '../../shared/contract.js';
import {
  actorOf, cmdId, output, requireHandle, resolveHandle, run, taskSummary, textBlock,
} from './shared.js';

const RECONCILE_CHOICES = ['resume', 'completed', 'discard'];

const SIDE_EFFECTS = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { type: 'string', required: true, enum: ['file', 'command', 'network', 'other'] },
      ref: { type: 'string', required: true },
      note: { type: 'string' },
      hash: { type: 'string' },
    },
  },
};

const INTENT_SETTLEMENT = {
  type: 'object',
  additionalProperties: false,
  description: 'Settles an open intent; outcome=stopped requires sideEffects (observed, not verified).',
  properties: {
    outcome: { type: 'string', required: true, enum: ['stopped', 'unknown'] },
    sideEffects: SIDE_EFFECTS,
    note: { type: 'string' },
  },
};

const DESCRIPTION = 'Drive one task through the state machine. Read project_board view=task first for rev and allowedOps. claim/begin/submit need a live lease; begin writes an intent before irreversible work; submit attaches evidence and only enters review. verify records acceptance, not correctness: human may verify any review task; an independent agent may verify only an audit gate with audit.report (20–4000 characters). Reports are self-declared; no evidence commands are executed. Any agent may reject review with reason (a live lease requires its owner); unassign remains human-only. Doc evidence is automatic: {kind:"doc", ref:docId} is pinned when the path is committed and clean, otherwise it degrades silently to current-only evidence (fixedState/fixedReason); no repository approval or version confirmation is needed. renew extends a lease (max 2 without progress). gate with requiresAudit:true enables third-party audit (agents can only enable it outside review; human may enable/disable; no lease needed). With an open intent, block/release/cancel/reject must pass intent:{outcome:"stopped",sideEffects:[...]}; if the outcome is unknown, interrupt then reconcile. On stale-revision or fencing-stale, re-read instead of forcing.';

const PARAMETERS = {
  op: { type: 'string', required: true, enum: TASK_OPS },
  taskId: { type: 'string' },
  expectedRev: { type: 'integer', description: 'Current task rev; required to mutate an existing task.' },
  projectRev: { type: 'integer' },
  fencingToken: { type: 'integer', description: 'Lease token from claim; required while you hold the lease.' },
  intent: INTENT_SETTLEMENT,
  sideEffects: { ...SIDE_EFFECTS, description: 'For op=interrupt: side effects already observed.' },
  title: { type: 'string' },
  description: { type: 'string' },
  priority: { type: 'integer' },
  weight: { type: 'number' },
  acceptance: {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', required: true },
        requiredKinds: { type: 'array', items: { type: 'string', enum: EVIDENCE_KINDS } },
      },
    },
  },
  deps: { type: 'array', items: { type: 'string' } },
  labels: { type: 'array', items: { type: 'string' } },
  requiresAudit: { type: 'boolean', description: 'Third-party audit gate. Agents may only enable it outside review; human may enable/disable.' },
  audit: {
    type: 'object', additionalProperties: false,
    description: 'Self-declared verify/reject report; required for agent verify, optional for human. Never executes evidence.',
    properties: {
      report: { type: 'string', required: true, description: '20–4000 trimmed characters for agent verify; human verify does not require a report.' },
      checklist: {
        type: 'array', description: 'At most 50 checklist items.',
        items: { type: 'object', additionalProperties: false, properties: {
          item: { type: 'string', required: true, description: "At most 200 characters." },
          ok: { type: 'boolean', required: true },
          note: { type: 'string', description: "At most 500 characters." },
        } },
      },
    },
  },
  unassign: { type: 'boolean', description: 'Human-only (reject); agents cannot clear the assignee.' },
  note: { type: 'string' },
  reason: { type: 'string' },
  acknowledgeDrift: { type: 'boolean', description: 'Human-only (verify).' },
  refreshDrift: { type: 'boolean', description: 'Human-only (verify).' },
  code: { type: 'string' },
  choice: { type: 'string', enum: RECONCILE_CHOICES },
  summary: { type: 'string' },
  plannedSteps: { type: 'array', items: { type: 'string' } },
  expectedArtifacts: { type: 'array', items: { type: 'string' } },
  evidence: {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, enum: EVIDENCE_KINDS },
        ref: { type: 'string', required: true, description: 'doc evidence: docId; external @rev is metadata and ignored, inline @rev keeps historical bytes.' },
        hash: { type: 'string' },
        summary: { type: 'string' },
        acceptanceId: { type: 'string' },
      },
    },
  },
};

function execute(runtime, args, exec) {
  return run(async () => {
    validateToolIntake(args, 'task');
    const handle = requireHandle(await resolveHandle(runtime, exec, { create: args.op === 'create' }));
    const base = {
      cmdId: cmdId(),
      actor: actorOf(exec),
      expected: { entityRev: args.expectedRev, projectRev: args.projectRev },
      fencingToken: args.fencingToken,
      taskId: args.taskId,
    };
    let cmd;
    if (args.op === 'create') {
      if (!args.taskId) delete base.taskId;
      cmd = { ...base, op: 'task.create', title: args.title, description: args.description, acceptance: args.acceptance, priority: args.priority, weight: args.weight, deps: args.deps, labels: args.labels, requiresAudit: args.requiresAudit };
    } else if (args.op === 'update') {
      cmd = { ...base, op: 'task.update', title: args.title, description: args.description, priority: args.priority, weight: args.weight, acceptance: args.acceptance, deps: args.deps, labels: args.labels, requiresAudit: args.requiresAudit };
    } else if (args.op === 'gate') {
      cmd = { ...base, op: 'task.gate', requiresAudit: args.requiresAudit };
    } else if (args.op === 'claim' || args.op === 'ready' || args.op === 'renew') {
      cmd = { ...base, op: 'task.' + args.op };
    } else if (args.op === 'begin') {
      cmd = { ...base, op: 'task.begin', summary: args.summary, plannedSteps: args.plannedSteps, expectedArtifacts: args.expectedArtifacts };
    } else if (args.op === 'submit') {
      cmd = { ...base, op: 'task.submit', note: args.note, evidence: args.evidence };
    } else if (args.op === 'verify') {
      cmd = { ...base, op: 'task.verify', audit: args.audit, note: args.note, reason: args.reason };
      // Absence is meaningful: even explicit false is forbidden for agents.
      for (const field of ['acknowledgeDrift', 'refreshDrift']) if (Object.hasOwn(args, field)) cmd[field] = args[field];
    } else if (args.op === 'reject') {
      cmd = { ...base, op: 'task.reject', reason: args.reason, audit: args.audit, unassign: args.unassign, intent: args.intent };
    } else if (args.op === 'block') {
      cmd = { ...base, op: 'task.block', code: args.code, note: args.note, intent: args.intent };
    } else if (args.op === 'interrupt') {
      cmd = { ...base, op: 'task.interrupt', note: args.note, sideEffects: args.sideEffects };
    } else if (args.op === 'unblock') {
      cmd = { ...base, op: 'task.unblock', note: args.note };
    } else if (args.op === 'release') {
      cmd = { ...base, op: 'task.release', note: args.note, intent: args.intent };
    } else if (args.op === 'reconcile') {
      cmd = { ...base, op: 'task.reconcile', choice: args.choice, note: args.note, evidence: args.evidence };
    } else if (args.op === 'cancel') {
      cmd = { ...base, op: 'task.cancel', reason: args.reason, intent: args.intent };
    } else if (args.op === 'reopen') {
      cmd = { ...base, op: 'task.reopen', reason: args.reason };
    } else {
      throw new BoardError('invalid-command', 'unknown task op: ' + args.op, { status: 400 });
    }
    const result = await handle.command(cmd);
    const created = result.events?.find((event) => event.type === 'task/created');
    const taskId = args.taskId || created?.taskId;
    const task = taskId ? handle.query('task', { taskId, sessionId: exec.agent.id }) : null;
    return { ok: true, projectId: handle.id, task, result };
  });
}

export function register(ctx, runtime) {
  ctx.tools.register(defineTool({
    name: 'project_task',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: output((_args, value) => textBlock(taskSummary(value))),
    presentCall: (args) => ({ card: 'generic', title: 'Project task · ' + args.op, kind: 'other', rawInput: args }),
    execute: (args, exec) => execute(runtime, args, exec),
  }));
}
