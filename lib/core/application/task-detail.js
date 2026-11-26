// Task detail projection over the authorized query(task) value DTO. It is a
// pure function: no handle, no store, no writer.
import { BoardError } from '../errors.js';
import { TASK_DETAIL_DEFAULT_BYTES, TASK_DETAIL_MAX_BYTES, TASK_DETAIL_SECTIONS } from '../../shared/agent-tools.js';

function invalid(message) { throw new BoardError('invalid-command', message, { status: 400 }); }

export function taskDetailFromView(view, args) {
  const requested = args.sections ?? (args.section ? [args.section] : []);
  if (!args.taskId || !Array.isArray(requested) || requested.length < 1 || requested.length > 3
    || new Set(requested).size !== requested.length || requested.some((section) => !TASK_DETAIL_SECTIONS.includes(section))
    || (args.section !== undefined && args.sections !== undefined)) invalid('task_detail requires taskId and section or 1–3 unique sections');
  const task = view.task;
  if (!task) throw new BoardError('not-found', 'task not found: ' + args.taskId, { status: 404 });
  if (args.atRev !== undefined && args.atRev !== task.rev) {
    throw new BoardError('stale-revision', 'Task changed between detail reads', { status: 409, details: { currentRev: task.rev } });
  }
  const scope = { sections: requested };
  const sections = {
    description: task.description ?? '', acceptance: view.acceptance ?? task.acceptance,
    evidence: view.evidence ?? task.evidence, audit: task.lastAudit ?? null, timeline: view.timeline,
    operations: view.allowedOps, documents: view.linkedDocs, intent: view.intent ?? null,
  };
  if (requested.includes('evidence')) {
    sections.evidence = (sections.evidence ?? []).filter((entry) => (!args.evidenceId || entry.id === args.evidenceId)
      && (!args.acceptanceId || entry.acceptanceId === args.acceptanceId)
      && (!args.kind || entry.kind === args.kind)
      && (args.includeSuperseded !== false || !entry.supersededAt));
    Object.assign(scope, { evidenceId: args.evidenceId ?? null, acceptanceId: args.acceptanceId ?? null, kind: args.kind ?? null, includeSuperseded: args.includeSuperseded !== false });
  }
  if (requested.includes('timeline')) scope.window = 'latest 30 task events';
  const selected = requested.length === 1 ? sections[requested[0]] : Object.fromEntries(requested.map((section) => [section, sections[section] ?? null]));
  const bytes = Buffer.from(typeof selected === 'string' ? selected : JSON.stringify(selected ?? null), 'utf8');
  const offset = args.offset ?? 0;
  const maxBytes = args.maxBytes ?? TASK_DETAIL_DEFAULT_BYTES;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length || (bytes[offset] & 0xc0) === 0x80) invalid('offset must be a returned UTF-8 byte boundary');
  if (!Number.isInteger(maxBytes) || maxBytes < 4 || maxBytes > TASK_DETAIL_MAX_BYTES) invalid('task_detail maxBytes must be between 4 and ' + TASK_DETAIL_MAX_BYTES);
  let end = Math.min(bytes.length, offset + maxBytes);
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return {
    source: { projectId: view.projectId, projectRev: view.projectRev, taskId: task.id, taskRev: task.rev },
    scope, content: bytes.subarray(offset, end).toString('utf8'),
    coverage: { offset, nextOffset: end < bytes.length ? end : null, totalBytes: bytes.length, returnedBytes: end - offset, truncated: offset > 0 || end < bytes.length },
  };
}

export function detailText(value) {
  return 'Source ' + value.source.projectId + ' rev ' + value.source.projectRev + ' / ' + value.source.taskId + ' rev ' + value.source.taskRev
    + '\nScope ' + JSON.stringify(value.scope) + '\nCoverage ' + JSON.stringify(value.coverage)
    + '\nContinue with atRev=' + value.source.taskRev + (value.coverage.nextOffset === null ? ' (end)' : ' offset=' + value.coverage.nextOffset)
    + '\n\n' + value.content;
}
