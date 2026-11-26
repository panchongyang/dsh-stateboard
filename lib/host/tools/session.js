import { defineTool } from './definition.js';
import { agentContexts } from '../agent-context.js';
import { applicationFor } from '../application.js';
import { BoardError } from '../../core/errors.js';
import { actorOf, cmdId, output, requireProject, resolveProjectTarget, run, sessionSource, textBlock, trackProject } from './shared.js';

export function register(ctx, runtime) {
  ctx.tools.register(defineTool({
    name: 'project_session',
    description: 'Create an empty project for this workspace (init), or record a checkpoint/handoff note. init exists so a project can be inspected before any plan exists; it creates no plan and no placeholder task. Checkpoint/handoff do not change task state.',
    parameters: {
      op: { type: 'string', required: true, enum: ['init', 'checkpoint', 'handoff', 'projects', 'open'] },
      projectId: { type: 'string', description: 'open: confirmed project ID. Native DSH defaults to its bound workspace.' },
      limit: { type: 'integer', description: 'projects: page size, default 30, maximum 100.' },
      after: { type: 'string', description: 'projects: previous nextCursor.' },
      name: { type: 'string', description: 'Optional project name for init; defaults to the workspace directory name.' },
      note: { type: 'string', description: 'Required for checkpoint/handoff.' },
      nextActions: { type: 'array', items: { type: 'string' } },
    },
    output: output((args, value) => textBlock(['open', 'projects'].includes(args.op) ? JSON.stringify(value) : value.op === 'init'
      ? 'Created empty project ' + value.projectId + ' at ' + value.project.workspacePath + '. No plan or task was created.'
      : 'Recorded ' + value.op + ' for ' + value.projectId + ': ' + value.note)),
    presentCall: (args) => ({ card: 'generic', title: 'Project session · ' + args.op, kind: 'other', rawInput: args }),
    execute: (args, exec) => run(async () => {
      if (args.op === 'projects') return agentContexts(runtime).projects(args, exec);
      if (args.op === 'open') return agentContexts(runtime).open({ ...args, context: exec.projectBoardContext }, exec);
      if (args.op === 'init') {
        // Explicit creation/attach: init is the one lifecycle action that may
      // Explicit init may create an empty project; first business writes create it only with their entity.
        const cwd = exec.agent.session?.header?.cwd;
        if (typeof cwd !== 'string' || cwd === '') throw new BoardError('invalid-command', 'the session has no working directory', { status: 400 });
        const application = applicationFor(runtime);
        const project = await application.capabilities.ensureProjectForSession({
          workspacePath: cwd, projectId: exec.projectBoard?.projectId, name: args.name, actor: actorOf(exec),
          sessionId: exec.agent.id, agentId: exec.agent.id, source: sessionSource(exec),
        });
        trackProject(runtime, exec.agent.id, { projectId: project.projectId, rev: project.rev }, exec.projectBoard?.defaultWorkspace !== false);
        return { ok: true, projectId: project.projectId, op: 'init', project: { id: project.projectId, name: project.name, workspacePath: project.workspacePath, rev: project.rev } };
      }
      if (typeof args.note !== 'string' || args.note.trim() === '') {
        throw new BoardError('invalid-command', 'checkpoint/handoff requires a note', { status: 400 });
      }
      const project = requireProject(await resolveProjectTarget(runtime, exec));
      const result = await applicationFor(runtime).command(project.projectId, {
        cmdId: cmdId(),
        actor: actorOf(exec),
        op: args.op === 'handoff' ? 'session.handoff' : 'session.checkpoint',
        note: args.note,
        nextActions: args.nextActions,
      }, { agentSessionSource: sessionSource(exec) });
      trackProject(runtime, exec.agent.id, { projectId: project.projectId, rev: result.projectRev }, exec.projectBoard?.defaultWorkspace !== false);
      return { ok: true, projectId: project.projectId, op: args.op, note: args.note };
    }),
  }));
}
