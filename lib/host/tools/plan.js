import { defineTool } from '@deepseek-ai/dsh-tools';
import { BoardError } from '../../core/errors.js';
import { validateToolIntake } from '../../core/command-shape.js';
import { EVIDENCE_KINDS } from '../../shared/contract.js';
import {
  actorOf, cmdId, output, planSummary, requireHandle, resolveHandle, run, shortJson, textBlock,
} from './shared.js';

const DESCRIPTION = 'Manage versioned plans (plan = initiative, steps = phases, tasks = work). publish (a draft, or create+publish without planId), revise (version+1), create (draft), rename, adopt/release tasks, archive/unarchive. adopt/release bump the version and never delete tasks. focus is human-only.';

const PARAMETERS = {
  op: { type: 'string', required: true, enum: ['publish', 'revise', 'create', 'rename', 'archive', 'unarchive', 'focus', 'adopt', 'release'] },
  planId: { type: 'string', description: 'Required except for create and create+publish.' },
  expectedRev: { type: 'integer', description: 'Plan head rev, for ops on a draft or the plan head.' },
  baseVersion: { type: 'integer', description: 'Required for active revise and adopt/release; must match head.currentVersion.' },
  stepId: { type: 'string', description: 'Required for adopt.' },
  taskIds: { type: 'array', items: { type: 'string' }, description: 'Required for adopt/release.' },
  title: { type: 'string', description: 'Required for create/rename; optional elsewhere.' },
  goal: { type: 'string' },
  assumptions: { type: 'array', items: { type: 'string' } },
  risks: { type: 'array', items: { type: 'string' } },
  steps: {
    type: 'array',
    description: 'Required for publish. Tasks use a plan-local key (taskId on revise); deps reference keys.',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        title: { type: 'string', required: true },
        tasks: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              key: { type: 'string' },
              taskId: { type: 'string' },
              title: { type: 'string', required: true },
              description: { type: 'string' },
              priority: { type: 'integer' },
              weight: { type: 'number' },
              labels: { type: 'array', items: { type: 'string' } },
              requiresAudit: { type: 'boolean' },
              deps: { type: 'array', items: { type: 'string' } },
              acceptance: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    text: { type: 'string', required: true },
                    requiredKinds: { type: 'array', items: { type: 'string', enum: EVIDENCE_KINDS } },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

function execute(runtime, args, exec) {
  return run(async () => {
    validateToolIntake(args, 'plan');
    const op = args.op;
    const createsProject = op === 'create' || (op === 'publish' && !args.planId);
    const handle = requireHandle(await resolveHandle(runtime, exec, { create: createsProject }));
    const base = { cmdId: cmdId(), actor: actorOf(exec) };
    let result;
    let planId = args.planId || null;

    if (op === 'publish') {
      if (!args.planId && !args.title) throw new BoardError('invalid-command', 'publish requires title', { status: 400 });
      result = await handle.command({
        ...base,
        op: 'plan.publish',
        planId: args.planId,
        expected: args.planId ? { entityRev: args.expectedRev } : undefined,
        title: args.title,
        goal: args.goal,
        assumptions: args.assumptions,
        risks: args.risks,
        steps: args.steps,
        createIfMissing: !args.planId,
      });
      if (!planId) planId = result.events.find((event) => event.type === 'plan/published')?.data.id || null;
    } else if (op === 'revise') {
      if (!args.planId) throw new BoardError('invalid-command', 'revise requires planId', { status: 400 });
      result = await handle.command({
        ...base,
        op: 'plan.revise',
        planId: args.planId,
        baseVersion: args.baseVersion,
        expected: Number.isInteger(args.expectedRev) ? { entityRev: args.expectedRev } : undefined,
        title: args.title,
        goal: args.goal,
        assumptions: args.assumptions,
        risks: args.risks,
        steps: args.steps,
      });
    } else if (op === 'create') {
      if (!args.title) throw new BoardError('invalid-command', 'create requires title', { status: 400 });
      result = await handle.command({ ...base, op: 'plan.create', title: args.title, goal: args.goal, assumptions: args.assumptions, risks: args.risks, steps: args.steps });
      planId = result.events.find((event) => event.type === 'plan/created')?.data.id || null;
    } else if (op === 'rename') {
      if (!args.planId || !args.title) throw new BoardError('invalid-command', 'rename requires planId and title', { status: 400 });
      result = await handle.command({ ...base, op: 'plan.rename', planId: args.planId, expected: { entityRev: args.expectedRev }, title: args.title });
    } else if (op === 'archive' || op === 'unarchive') {
      if (!args.planId) throw new BoardError('invalid-command', op + ' requires planId', { status: 400 });
      result = await handle.command({ ...base, op: 'plan.' + op, planId: args.planId, expected: { entityRev: args.expectedRev } });
    } else if (op === 'focus') {
      result = await handle.command({ ...base, op: 'plan.focus', planId: args.planId ?? null });
      planId = args.planId || null;
    } else if (op === 'adopt' || op === 'release') {
      if (!args.planId || !Number.isInteger(args.baseVersion)) {
        throw new BoardError('invalid-command', op + ' requires planId and baseVersion', { status: 400 });
      }
      if (op === 'adopt' && (!args.stepId || !Array.isArray(args.taskIds))) {
        throw new BoardError('invalid-command', 'adopt requires stepId and taskIds', { status: 400 });
      }
      if (op === 'release' && !Array.isArray(args.taskIds)) {
        throw new BoardError('invalid-command', 'release requires taskIds', { status: 400 });
      }
      result = await handle.command({ ...base, op: 'plan.' + op, planId: args.planId, baseVersion: args.baseVersion, stepId: args.stepId, taskIds: args.taskIds });
    } else {
      throw new BoardError('invalid-command', 'unknown plan op: ' + op, { status: 400 });
    }

    const view = planId ? handle.query('plan', { planId }) : handle.query('plan', {});
    return { ok: true, projectId: handle.id, ...view, result };
  });
}

export function register(ctx, runtime) {
  ctx.tools.register(defineTool({
    name: 'project_plan',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: output((_args, value) => textBlock(planSummary(value) + '\n' + shortJson(value.plan ? { planId: value.plan.id, version: value.plan.version, status: value.plan.status } : {}, 1000))),
    presentCall: (args) => ({ card: 'generic', title: 'Project plan · ' + args.op, kind: 'other', rawInput: args }),
    execute: (args, exec) => execute(runtime, args, exec),
  }));
}
