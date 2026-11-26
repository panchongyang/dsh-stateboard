import { defineTool } from './definition.js';
import { BoardError } from '../../core/errors.js';
import { validateToolIntake } from '../../core/command-shape.js';
import { EVIDENCE_KINDS } from '../../shared/contract.js';
import { applicationFor } from '../application.js';
import {
  actorOf, cmdId, commandForProjectTarget, output, planSummary, requireProject, resolveProjectTarget, run, shortJson, textBlock, trackProject,
} from './shared.js';

const DESCRIPTION = 'Manage versioned plans (plan = initiative, steps = phases, tasks = work). Keep tasks within a phase independent; split dependent tasks across phases. publish (a draft, or create+publish without planId), revise (version+1), create (draft), rename, adopt/release tasks, archive/unarchive. adopt/release bump the version and never delete tasks. focus is human-only.';

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

function planCommand(args, actor) {
  const { op, planId, title, goal, assumptions, risks, steps, expectedRev, baseVersion, stepId, taskIds } = args;
  const base = { cmdId: cmdId(), actor, op: 'plan.' + op };
  const expected = { entityRev: expectedRev };
  const content = { title, goal, assumptions, risks, steps };
  const invalid = (message) => { throw new BoardError('invalid-command', message, { status: 400 }); };
  switch (op) {
    case 'publish':
      if (!planId && !title) invalid('publish requires title');
      return { ...base, ...content, planId, expected: planId ? expected : undefined, createIfMissing: !planId };
    case 'revise':
      if (!planId) invalid('revise requires planId');
      return { ...base, ...content, planId, baseVersion, expected: Number.isInteger(expectedRev) ? expected : undefined };
    case 'create':
      if (!title) invalid('create requires title');
      return { ...base, ...content };
    case 'rename':
      if (!planId || !title) invalid('rename requires planId and title');
      return { ...base, planId, expected, title };
    case 'archive':
    case 'unarchive':
      if (!planId) invalid(op + ' requires planId');
      return { ...base, planId, expected };
    case 'focus':
      return { ...base, planId: planId ?? null };
    case 'adopt':
    case 'release':
      if (!planId || !Number.isInteger(baseVersion)) invalid(op + ' requires planId and baseVersion');
      if (op === 'adopt' && (!stepId || !Array.isArray(taskIds))) invalid('adopt requires stepId and taskIds');
      if (op === 'release' && !Array.isArray(taskIds)) invalid('release requires taskIds');
      return { ...base, planId, baseVersion, stepId, taskIds };
    default:
      return invalid('unknown plan op: ' + op);
  }
}

function execute(runtime, args, exec) {
  return run(async () => {
    validateToolIntake(args, 'plan');
    const firstWrite = args.op === 'create' || (args.op === 'publish' && !args.planId);
    const target = requireProject(await resolveProjectTarget(runtime, exec, { firstWrite }));
    const command = planCommand(args, actorOf(exec));
    const { projectId, result } = await commandForProjectTarget(runtime, target, command, exec);
    let planId = args.planId || null;
    if (args.op === 'create' || (args.op === 'publish' && !planId)) {
      const type = args.op === 'create' ? 'plan/created' : 'plan/published';
      planId = result.events.find((event) => event.type === type)?.data.id || null;
    }
    trackProject(runtime, exec.agent.id, { projectId, rev: result.projectRev }, exec.projectBoard?.defaultWorkspace !== false);
    const view = await applicationFor(runtime).read(projectId, 'plan', planId ? { planId } : {}, actorOf(exec));
    return { ok: true, projectId, ...view, result };
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
