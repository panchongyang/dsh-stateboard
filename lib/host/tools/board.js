import { defineTool } from '@deepseek-ai/dsh-tools';
import { BoardError } from '../../core/errors.js';
import {
  output, run, textBlock, shortJson, boardSummary, taskSummary, planSummary,
  plansSummary, docSummary, docsSummary, eventsSummary, healthSummary, resolveHandle,
} from './shared.js';

/** Seqs kept per session before the oldest view entry is evicted. */
const SEEN_LIMIT = 200;
const UNCHANGED_HINT = ' (fresh=true to reprint)';

function viewText(value) {
  if (value.view === 'brief') return value.project ? value.digest : (value.hint || 'No project.');
  if (value.view === 'board') return boardSummary(value);
  if (value.view === 'task') return taskSummary(value);
  if (value.view === 'plan') return planSummary(value);
  if (value.view === 'plans') return plansSummary(value);
  if (value.view === 'docs') return docsSummary(value);
  if (value.view === 'doc') return docSummary(value) + (value.body ? '\n\n' + value.body : '');
  if (value.view === 'events') return eventsSummary(value);
  if (value.view === 'health') return healthSummary(value);
  return shortJson(value);
}

export function register(ctx, runtime) {
  // Re-printing a read view whose text is byte-identical to what this session
  // already received costs context and buys nothing. Memory stays here in the
  // host adapter: core digests remain deterministic (CONTRACT §3.4.2).
  const seen = new Map();

  const stable = (args, value, text) => {
    if (!value.sessionId || value.view === 'brief') return text;
    const key = value.sessionId + '|' + value.view + '|' + JSON.stringify({ ...args, fresh: undefined });
    const previous = seen.get(key);
    if (previous && previous.text === text && args.fresh !== true) {
      return 'board rev ' + value.boardRev + ' unchanged since ' + previous.rev + UNCHANGED_HINT;
    }
    seen.delete(key);
    seen.set(key, { text, rev: value.boardRev });
    if (seen.size > SEEN_LIMIT) seen.delete(seen.keys().next().value);
    return text;
  };

  ctx.tools.register(defineTool({
    name: 'project_board',
    description: 'Read current ProjectBoard state for this workspace (authoritative over memory or chat). Use search_project_knowledge and read_project_knowledge for retained history and original sources. The brief is already in your system prompt; do not re-read it for rules. Read view=task before mutating a task; view=board only when you need every card.',
    parameters: {
      view: { type: 'string', required: true, enum: ['brief', 'board', 'task', 'plan', 'plans', 'docs', 'doc', 'events', 'health'], description: 'task = full task + allowedOps; plan = one plan (planId or focus).' },
      taskId: { type: 'string', description: 'Required for view=task.' },
      planId: { type: 'string', description: 'Optional for view=plan.' },
      docId: { type: 'string', description: 'Required for view=doc.' },
      query: { type: 'string', description: 'Optional text filter for view=docs.' },
      limit: { type: 'integer', description: 'Event limit for view=events (default 50).' },
      maxBytes: { type: 'integer', description: 'Max body bytes for view=doc.' },
      fresh: { type: 'boolean', description: 'Reprint a view that would collapse to "unchanged since <seq>".' },
    },
    output: output((args, value) => textBlock(stable(args, value, viewText(value)))),
    presentCall: (args) => ({ card: 'generic', title: 'Project board · ' + args.view, kind: 'other', rawInput: args }),
    execute: (args, exec) => run(async () => {
      const handle = await resolveHandle(runtime, exec);
      const sessionId = exec.agent.id;
      if (!handle) {
        if (args.view === 'brief') {
          return { ok: true, projectId: null, view: 'brief', project: null, hint: 'No ProjectBoard project exists for this workspace. Call project_plan with op=publish to create one.' };
        }
        throw new BoardError('not-found', 'No ProjectBoard project exists for this workspace yet. Call project_plan with op=publish first.', { status: 404 });
      }
      const view = (extra) => ({ ok: true, projectId: handle.id, ...extra, sessionId, boardRev: handle.rev });
      if (args.view === 'brief') {
        const brief = handle.query('brief', { sessionId });
        // The system prompt already carries the rules (project:brief section).
        const includeRules = !runtime.promptFibers?.has?.(sessionId);
        return view({ view: 'brief', digest: handle.digest(sessionId, { includeRules }), ...brief });
      }
      if (args.view === 'board') {
        return view({ view: 'board', ...handle.query('board', { sessionId }) });
      }
      if (args.view === 'task') {
        if (!args.taskId) throw new BoardError('invalid-command', 'view=task requires taskId', { status: 400 });
        return view({ view: 'task', ...handle.query('task', { taskId: args.taskId, sessionId }) });
      }
      if (args.view === 'plan') {
        return view({ view: 'plan', ...handle.query('plan', { planId: args.planId }) });
      }
      if (args.view === 'plans') {
        return view({ view: 'plans', ...handle.query('plans', {}) });
      }
      if (args.view === 'docs') {
        return view({ view: 'docs', ...handle.query('docs', { query: args.query }) });
      }
      if (args.view === 'doc') {
        if (!args.docId) throw new BoardError('invalid-command', 'view=doc requires docId', { status: 400 });
        return view({ view: 'doc', ...handle.query('doc', { docId: args.docId, maxBytes: args.maxBytes }) });
      }
      if (args.view === 'events') {
        return view({ view: 'events', ...handle.query('events', { after: 0, limit: args.limit || 50 }) });
      }
      if (args.view === 'health') {
        return view({ view: 'health', health: await handle.healthAsync() });
      }
      throw new BoardError('invalid-command', 'unknown view: ' + args.view, { status: 400 });
    }),
  }));
}
