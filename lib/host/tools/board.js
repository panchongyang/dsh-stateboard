import { defineTool } from './definition.js';
import { BoardError } from '../../core/errors.js';
import { EVIDENCE_KINDS, TASK_STATES } from '../../shared/contract.js';
import { METADATA_VIEWS, TASK_DETAIL_SECTIONS } from '../../shared/agent-tools.js';
import { agentContexts } from '../agent-context.js';
import { applicationFor } from '../application.js';
import { actorOf, output, projectIdFor, run, textBlock, shortJson, boardSummary, taskSummary, planSummary, plansSummary, docSummary, docsSummary, eventsSummary, healthSummary } from './shared.js';
import { detailText } from './task-detail.js';

/** Seqs kept per session before the oldest view entry is evicted. */
const SEEN_LIMIT = 200;
const UNCHANGED_HINT = ' (fresh=true to reprint)';

function viewText(value) {
  if (value.view === 'task_detail') return detailText(value);
  if (METADATA_VIEWS.includes(value.view)) return JSON.stringify(value.data);
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

const PARAMETERS = {
      view: { type: 'string', required: true, enum: ['brief', 'board', 'task', 'plan', 'plans', 'docs', 'doc', 'events', 'health', ...METADATA_VIEWS, 'task_detail'], description: 'task = bounded summary + allowedOps; task_detail = selected section, optionally filtered/paged. plan = one plan (planId or focus). Metadata credentials permit only tasks/task_overview/work_context.' },
      section: { type: 'string', enum: TASK_DETAIL_SECTIONS, description: 'task_detail: read only this section; known sections can be requested directly without a summary call.' },
      sections: { type: 'array', items: { type: 'string', enum: TASK_DETAIL_SECTIONS }, description: 'task_detail: alternatively select 1–3 unique sections in one bounded response; do not combine with section.' },
      atRev: { type: 'integer', description: 'task_detail: require this task revision when continuing a page.' },
      offset: { type: 'integer', description: 'task_detail: UTF-8 byte offset from nextOffset; default 0.' },
      evidenceId: { type: 'string', description: 'task_detail section=evidence: optional exact evidence ID.' },
      acceptanceId: { type: 'string', description: 'task_detail section=evidence: optional acceptance ID.' },
      kind: { type: 'string', enum: EVIDENCE_KINDS, description: 'task_detail section=evidence: optional kind filter.' },
      includeSuperseded: { type: 'boolean', description: 'task_detail section=evidence: defaults true; false selects only active evidence.' },
      after: { type: 'string', description: 'tasks: nextCursor from previous page.' },
      state: { type: 'string', enum: TASK_STATES, description: 'tasks: optional state filter.' },
      taskId: { type: 'string', description: 'Required for view=task.' },
      planId: { type: 'string', description: 'Optional for view=plan.' },
      docId: { type: 'string', description: 'Required for view=doc.' },
      query: { type: 'string', description: 'Optional text filter for view=docs.' },
      limit: { type: 'integer', description: 'Event limit for view=events (default 50).' },
      maxBytes: { type: 'integer', description: 'Max body bytes for view=doc.' },
      fresh: { type: 'boolean', description: 'Reprint a view that would collapse to "unchanged since <seq>".' },
    };

/** Project a tool view onto the read port's parameters. */
function readParams(args, sessionId, signal) {
  // The caller's abort signal travels with the read so an in-flight worker
  // (cold task/task_detail replay or health audit) is cancelled, not orphaned.
  const cancel = signal === undefined ? {} : { signal };
  switch (args.view) {
    case 'brief': return { sessionId, ...cancel };
    case 'task': return { taskId: args.taskId, sessionId, ...cancel };
    case 'plan': return { planId: args.planId, ...cancel };
    case 'plans': return { ...cancel };
    case 'docs': return { query: args.query, ...cancel };
    case 'doc': return { docId: args.docId, maxBytes: args.maxBytes, ...cancel };
    case 'events': return { after: 0, limit: args.limit || 50, ...cancel };
    case 'task_detail': return { ...args, sessionId, ...cancel };
    default: return { ...cancel };
  }
}

async function metadataView(runtime, args, exec) {
  await runtime.ready;
  const projectId = exec.projectBoard?.projectId ?? runtime.service.resolveWorkspace(exec.agent.session?.header?.cwd)?.projectId;
  if (!projectId) throw new BoardError('not-found', 'No bound project', { status: 404 });
  const reader = agentContexts(runtime).reader;
  const data = args.view === 'tasks' ? await reader.listTasks({ projectId, state: args.state, limit: args.limit, after: args.after })
    : args.view === 'task_overview' ? await reader.getTask({ projectId, taskId: args.taskId }) : await reader.getWorkContext({ projectId, taskId: args.taskId });
  return { view: args.view, data };
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
    parameters: PARAMETERS,
    output: output((args, value) => textBlock(stable(args, value, viewText(value)))),
    presentCall: (args) => ({ card: 'generic', title: 'Project board · ' + args.view, kind: 'other', rawInput: args }),
    execute: (args, exec) => run(async () => {
      if (METADATA_VIEWS.includes(args.view)) return metadataView(runtime, args, exec);
      const application = applicationFor(runtime);
      const actor = actorOf(exec);
      const projectId = projectIdFor(runtime, exec);
      const sessionId = exec.agent.id;
      if (!projectId) {
        if (args.view === 'brief') {
          return { ok: true, projectId: null, view: 'brief', project: null, hint: 'No ProjectBoard project exists for this workspace. Call project_plan with op=publish to create one.' };
        }
        throw new BoardError('not-found', 'No ProjectBoard project exists for this workspace yet. Call project_plan with op=publish first.', { status: 404 });
      }
      if (args.view === 'task' && !args.taskId) throw new BoardError('invalid-command', 'view=task requires taskId', { status: 400 });
      if (args.view === 'doc' && !args.docId) throw new BoardError('invalid-command', 'view=doc requires docId', { status: 400 });
      const data = await application.read(projectId, args.view, readParams(args, sessionId, exec.signal), actor);
      const view = (extra) => ({ ok: true, projectId, ...extra, sessionId, boardRev: data?.rev ?? null });
      if (args.view === 'brief') {
        // The system prompt already carries the rules (project:brief section).
        const includeRules = !runtime.promptFibers?.has?.(sessionId);
        const digest = await application.read(projectId, 'digest', { sessionId, options: { includeRules } }, actor);
        return view({ view: 'brief', digest, ...data });
      }
      if (args.view === 'health') return view({ view: 'health', health: data });
      return view({ view: args.view, ...data });
    }),
  }));
}
