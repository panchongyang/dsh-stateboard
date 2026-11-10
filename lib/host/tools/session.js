import { defineTool } from '@deepseek-ai/dsh-tools';
import { BoardError } from '../../core/errors.js';
import { actorOf, cmdId, output, requireHandle, resolveHandle, run, textBlock } from './shared.js';

export function register(ctx, runtime) {
  ctx.tools.register(defineTool({
    name: 'project_session',
    description: 'Create an empty project for this workspace (init), or record a checkpoint/handoff note. init exists so a project can be inspected before any plan exists; it creates no plan and no placeholder task. Checkpoint/handoff do not change task state.',
    parameters: {
      op: { type: 'string', required: true, enum: ['init', 'checkpoint', 'handoff'] },
      name: { type: 'string', description: 'Optional project name for init; defaults to the workspace directory name.' },
      note: { type: 'string', description: 'Required for checkpoint/handoff.' },
      nextActions: { type: 'array', items: { type: 'string' } },
    },
    output: output((_args, value) => textBlock(value.op === 'init'
      ? 'Created empty project ' + value.projectId + ' at ' + value.project.workspacePath + '. No plan or task was created.'
      : 'Recorded ' + value.op + ' for ' + value.projectId + ': ' + value.note)),
    presentCall: (args) => ({ card: 'generic', title: 'Project session · ' + args.op, kind: 'other', rawInput: args }),
    execute: (args, exec) => run(async () => {
      if (args.op === 'init') {
        const handle = requireHandle(await resolveHandle(runtime, exec, { create: true, name: args.name }));
        return { ok: true, projectId: handle.id, op: 'init', project: { id: handle.id, name: handle.name, workspacePath: handle.workspacePath, rev: handle.rev } };
      }
      if (typeof args.note !== 'string' || args.note.trim() === '') {
        throw new BoardError('invalid-command', 'checkpoint/handoff requires a note', { status: 400 });
      }
      const handle = requireHandle(await resolveHandle(runtime, exec));
      await handle.command({
        cmdId: cmdId(),
        actor: actorOf(exec),
        op: args.op === 'handoff' ? 'session.handoff' : 'session.checkpoint',
        note: args.note,
        nextActions: args.nextActions,
      });
      return { ok: true, projectId: handle.id, op: args.op, note: args.note };
    }),
  }));
}
