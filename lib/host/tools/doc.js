import { defineTool } from './definition.js';
import { FIXED_REFERENCE_SCHEMA } from '../../shared/fixed-schema.js';
import {
  DOC_RELATION_READ_VIEW, PROJECTION_DEFAULT_MAX_BYTES, PROJECTION_DOC_OPS, PROJECTION_MAX_BYTES, RETAINED_DOC_OPS, RETAINED_DOC_READ_VIEWS,
} from '../../shared/agent-tools.js';
import { assertFixedReadArgs } from '../../core/documents/fixed-content.js';
import { BoardError } from '../../core/errors.js';
import { DOC_EXTERNAL_WRITE_FIELDS, DOC_KINDS } from '../../shared/contract.js';
import { MANAGEMENT_STATES } from '../../core/documents/external-model.js';
import { applicationFor } from '../application.js';
import { projectionAuthority } from '../agent-context.js';
import {
  actorOf, cmdId, docSummary, docsSummary, output, projectIdFor, run, requireProject, resolveProjectTarget, sessionSource, textBlock, trackProject,
} from './shared.js';

// External documents are registered workspace files: the command carries the
// registration and expected metaRev, never a body. Inline get/put/link keep
// their old behaviour (core rejects external targets explicitly). The shared
// field table is re-checked here: a schema drift must not silently drop a
// misspelled field.
const EXTERNAL_WRITES = new Set(Object.keys(DOC_EXTERNAL_WRITE_FIELDS));
const RELATION_COMMANDS = Object.freeze({ relate: 'doc.relation.add', unrelate: 'doc.relation.remove' });
const RELATION_FIELDS = Object.freeze({
  relate: ['from', 'to', 'expectedRev', 'replacesId'],
  unrelate: ['relationId', 'expectedRev'],
  relations: ['from', 'to', 'docId', 'versionId', 'relationId', 'after', 'limit', 'maxBytes'],
});
const RELATION_OPS = Object.keys(RELATION_FIELDS);
const RELATION_ONLY_FIELDS = ['from', 'to', 'expectedRev', 'replacesId', 'relationId'];
const RESPONSIBILITY_FIELDS = ['purpose', 'scope', 'supersedes'];

function assertExternalFields(args, action) {
  const allowed = new Set(['op', ...DOC_EXTERNAL_WRITE_FIELDS[action]]);
  const unknown = Object.keys(args).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new BoardError('invalid-command', 'unknown field(s) for doc.external.' + action + ': ' + unknown.join(', ') + '; allowed: ' + [...allowed].join(', '), {
      status: 400,
      details: { fields: unknown, allowed: [...allowed] },
    });
  }
}

function externalCommand({ op, ...fields }) {
  // assertExternalFields checked these fields before dispatch. Preserve absence
  // on partial metadata updates rather than forwarding synthetic undefineds.
  return { op: 'doc.external.' + op, ...fields };
}

async function externalWrite(runtime, application, projectId, args, exec) {
  assertExternalFields(args, args.op);
  if (args.op === 'register' && (!args.title || !args.relPath)) {
    throw new BoardError('invalid-command', 'register requires title and relPath', { status: 400 });
  }
  const cmd = externalCommand(args);
  const result = await application.command(projectId, { cmdId: cmdId(), actor: actorOf(exec), ...cmd }, { agentSessionSource: sessionSource(exec) });
  trackProject(runtime, exec.agent.id, { projectId, rev: result.projectRev }, exec.projectBoard?.defaultWorkspace !== false);
  const docId = result.docId || cmd.docId || result.events?.find((event) => event.docId)?.docId;
  // The post-write record is a read: it goes through the read port.
  const doc = docId ? await application.read(projectId, 'doc_record', { docId }, actorOf(exec)) : null;
  return { schemaVersion: 1, doc, result };
}

function confirmationLine(confirmation) {
  return confirmation.state + ' (reason: ' + String(confirmation.reason ?? null) + ')';
}

function baselineLine(baseline) {
  if (!baseline) return 'baseline: null';
  const by = baseline.confirmedBy || {};
  return 'baseline: domain=' + baseline.domain + ' contentHash=' + baseline.contentHash + ' bindingId=' + baseline.bindingId
    + ' relPath=' + baseline.relPath + ' confirmedAt=' + baseline.confirmedAt + ' confirmedBy=' + (by.kind || '?');
}

function gitLine(git) {
  if (!git) return 'null';
  const flags = ['staged', 'unstaged', 'filtered', 'lfs'].filter((field) => git[field]).join(',');
  return git.state + ' (detail: ' + String(git.detail ?? null) + ')' + (flags ? ' [' + flags + ']' : '');
}

function previewLines(observation) {
  if (!Object.hasOwn(observation, 'preview')) return [];
  if (!observation.preview) return ['preview: null'];
  return ['preview (truncated: ' + observation.preview.truncated + ', totalBytes: ' + observation.preview.totalBytes + '):', observation.preview.text];
}

/**
 * Text rendering of inspect. Every field a caller needs to decide what to do
 * next is printed explicitly, including nulls: "contentHash: null" must not
 * look like a hash that was simply omitted.
 */
function responsibilityLines(doc) {
  return RESPONSIBILITY_FIELDS.filter(key => doc?.[key] !== undefined)
    .map(key => key + ': ' + JSON.stringify(doc[key]));
}

function inspectSummary(value) {
  const doc = value.doc;
  const lines = [
    'Doc ' + doc.id + ' "' + doc.title + '" rev ' + doc.rev + ' (external ' + doc.kind + ', ' + doc.status + ')',
    'metaRev: ' + value.metaRev + ' · projectRev: ' + value.projectRev + ' · unregistered: ' + value.unregistered,
    'locator: bindingId=' + doc.locator.bindingId + ' relPath=' + doc.locator.relPath,
    'availability: ' + String(value.availability) + ' · code: ' + String(value.code),
  ];
  const observation = value.observation;
  if (!observation) {
    lines.push('observation: null');
  } else {
    lines.push(
      'observedAt: ' + observation.observedAt + ' · cached: ' + observation.cached,
      'context: bindingId=' + observation.context.bindingId + ' root=' + String(observation.context.root) + ' relPath=' + observation.context.relPath + ' role=' + String(observation.context.role),
      'contentHash: ' + String(observation.contentHash),
      'size: ' + String(observation.size) + ' · previewable: ' + observation.previewable,
      // Structured read diagnosis: 'extension' vs null tells an unsupported
      // format apart from a plain miss, so it is rendered, never dropped.
      'observationDetail: ' + (Object.hasOwn(observation, 'detail') ? JSON.stringify(observation.detail) : 'null'),
    );
    lines.push(...previewLines(observation));
  }
  lines.push(...responsibilityLines(doc), 'confirmation: ' + confirmationLine(value.confirmation), baselineLine(value.confirmation.baseline), 'git: ' + gitLine(value.git));
  return lines.join('\n');
}

async function inlineWrite(runtime, args, exec) {
  const actor = actorOf(exec);
  // Inline put/link admission is re-run inside the command entry before any
  // writer opens; no lifecycle attach may precede a possible rejection.
  const project = requireProject(await resolveProjectTarget(runtime, exec, { lifecycle: false }));
  const application = applicationFor(runtime);
  const cmd = { op: 'doc.' + args.op, cmdId: cmdId(), actor, docId: args.docId, links: args.links };
  if (args.op === 'put') Object.assign(cmd, { title: args.title, kind: args.kind, body: args.body, baseRev: args.baseRev });
  // The command entry re-runs inline admission before acquiring the writer.
  const result = await application.command(project.projectId, cmd, { agentSessionSource: sessionSource(exec) });
  const docId = args.docId || result.events.find((event) => event.type === 'doc/created')?.docId || null;
  // The body is a read and always comes from the read port.
  const doc = docId ? await application.read(project.projectId, 'doc_record', { docId }, actor) : null;
  trackProject(runtime, actor.sessionId, { projectId: project.projectId, rev: result.projectRev }, exec.projectBoard?.defaultWorkspace !== false);
  return { ok: true, projectId: project.projectId, result, doc };
}

async function retainedDoc(runtime, args, exec) {
  const { op, docId, versionId, limit, after, maxBytes } = args;
  const needsVersion = op === 'read_version' || op === 'compare';
  const options = op === 'history' ? { limit, after } : op === 'read_version' ? { maxBytes } : {};
  const allowed = new Set(['op', 'docId', ...(needsVersion ? ['versionId'] : []), ...Object.keys(options)]);
  if (Object.keys(args).some(key => !allowed.has(key)) || !/^doc_[A-Za-z0-9_-]{1,126}$/.test(docId ?? '')
    || (needsVersion && (!versionId || versionId.length > 256))) {
    throw new BoardError('invalid-command', `${op} requires a plain docId${needsVersion ? ' and versionId' : ''}, with no other business fields`, { status: 400 });
  }
  if (!runtime.service.spaceHome) throw new BoardError('space-home-unavailable', 'Workspace history requires the authorized space home', { status: 409 });
  const { projectId } = requireProject(await resolveProjectTarget(runtime, exec, { lifecycle: false }));
  const actor = actorOf(exec);
  const application = applicationFor(runtime);
  if (op !== 'capture') {
    const result = await application.read(projectId, RETAINED_DOC_READ_VIEWS[op], { docId, ...(needsVersion ? { versionId } : {}), ...options, signal: exec.signal }, actor);
    return { ok: true, ...result };
  }
  const result = await application.command(projectId, { op: 'doc.workspace_capture', cmdId: cmdId(), actor, docId }, { agentSessionSource: sessionSource(exec) });
  if (result.committed && Number.isInteger(result.projectRev)) {
    trackProject(runtime, actor.sessionId, { projectId, rev: result.projectRev }, exec.projectBoard?.defaultWorkspace !== false);
  }
  return { ok: true, projectId, result };
}

/**
 * Workspace projection goes through the owning space service, never through a
 * caller-supplied root or scope. The complete business arguments are relayed
 * unchanged: core owns op/field/range validation for both transports, so this
 * layer adds no second validation layer and silently drops nothing. Core also
 * re-checks the supplied assertion before the batch and before returning.
 */
async function projectionDoc(runtime, args, exec) {
  // Same trusted construction as the background hint: legacy consolidated mode
  // has no owning space and is rejected here rather than called without one.
  const authority = projectionAuthority(exec, { ctx: runtime.ctx, service: runtime.service });
  const projectId = projectIdFor(runtime, exec, { touch: false });
  if (!projectId) throw new BoardError('not-found', 'No ProjectBoard project exists for this workspace yet. Call project_plan with op=publish first.', { status: 404 });
  const value = await runtime.service.queryWorkspaceProjection(projectId, { ...args }, { scopeKey: authority.scopeKey, assertCurrent: authority.assertCurrent });
  if (!value || typeof value !== 'object') throw new BoardError('projection-unavailable', 'Workspace projection returned no value', { status: 503 });
  return { ok: true, projectId, ...value };
}

async function relationDoc(runtime, { op, ...fields }, exec) {
  // Only translate the outer envelope here. Core owns reference, selector,
  // revision and pagination semantics (including any explicit current capture).
  const unknown = Object.keys(fields).filter(key => !RELATION_FIELDS[op].includes(key));
  if (unknown.length) throw new BoardError('invalid-command', `${op} does not accept: ${unknown.join(', ')}`, { status: 400 });
  if (!runtime.service.spaceHome) throw new BoardError('space-home-unavailable', 'Document relations require the authorized owning space', { status: 409 });
  await runtime.ready;
  const projectId = projectIdFor(runtime, exec, { touch: false });
  requireProject(projectId);
  const actor = actorOf(exec);
  const application = applicationFor(runtime);
  if (op === 'relations') {
    const value = await application.read(projectId, DOC_RELATION_READ_VIEW, { ...fields, signal: exec.signal }, actor);
    return { ok: true, projectId, ...value };
  }
  const result = await application.command(projectId, { op: RELATION_COMMANDS[op], cmdId: cmdId(), actor, ...fields }, { agentSessionSource: sessionSource(exec) });
  if (result.committed && Number.isInteger(result.projectRev)) {
    trackProject(runtime, actor.sessionId, { projectId, rev: result.projectRev }, exec.projectBoard?.defaultWorkspace !== false);
  }
  return { ok: true, projectId, result };
}

function executeDoc(runtime, args, exec) {
  return run(async () => {
    if (PROJECTION_DOC_OPS.includes(args.op)) return projectionDoc(runtime, args, exec);
    if (RETAINED_DOC_OPS.includes(args.op)) return retainedDoc(runtime, args, exec);
    if (RELATION_OPS.includes(args.op)) return relationDoc(runtime, args, exec);
    if (RELATION_ONLY_FIELDS.some(key => Object.hasOwn(args, key))) {
      throw new BoardError('invalid-command', 'Relation fields are only supported by relate/unrelate/relations', { status: 400 });
    }
    if (!['register', 'update_meta'].includes(args.op) && RESPONSIBILITY_FIELDS.some(key => Object.hasOwn(args, key))) {
      throw new BoardError('invalid-command', 'purpose/scope/supersedes are only supported by register/update_meta', { status: 400 });
    }
    if (Object.hasOwn(args, 'format')) throw new BoardError('invalid-command', 'project_doc does not support workspace body writes', { status: 400 });
    if (Object.hasOwn(args, 'versionId') || Object.hasOwn(args, 'after') || Object.hasOwn(args, 'limit')) {
      throw new BoardError('invalid-command', 'versionId is for read_version/compare; after/limit are for history', { status: 400 });
    }
    // Field validation happens before the project is opened: opening a cold
    // project can run recovery writes, and a rejected call must write nothing.
    if (EXTERNAL_WRITES.has(args.op)) assertExternalFields(args, args.op);
    if (args.op === 'get_fixed') assertFixedReadArgs(args);
    if (args.op === 'put' || args.op === 'link') return inlineWrite(runtime, args, exec);
    const application = applicationFor(runtime);
    const actor = actorOf(exec);
    if (args.op === 'inspect' && !args.docId) throw new BoardError('invalid-command', 'inspect requires docId', { status: 400 });
    if (EXTERNAL_WRITES.has(args.op)) {
      const projectId = projectIdFor(runtime, exec);
      if (!projectId) throw new BoardError('not-found', 'No ProjectBoard project exists for this workspace yet. Call project_plan with op=publish first.', { status: 404 });
      const base = { ok: true, projectId };
      return { ...base, ...(await externalWrite(runtime, application, projectId, args, exec)) };
    }
    // Every read (get/list/inspect/list_external/get_fixed) is served by the read port.
    const projectId = projectIdFor(runtime, exec);
    if (!projectId) throw new BoardError('not-found', 'No ProjectBoard project exists for this workspace yet. Call project_plan with op=publish first.', { status: 404 });
    const base = { ok: true, projectId };
    if (args.op === 'get_fixed') return { ...base, ...await application.read(projectId, 'get_fixed', { ...args, signal: exec.signal }, actor) };
    if (args.op === 'get') {
      if (!args.docId) throw new BoardError('invalid-command', 'get requires docId', { status: 400 });
      return { ...base, ...await application.read(projectId, 'doc', { docId: args.docId, maxBytes: args.maxBytes, signal: exec.signal }, actor) };
    }
    if (args.op === 'list') return { ...base, ...await application.read(projectId, 'docs', { signal: exec.signal }, actor) };
    if (args.op === 'inspect') {
      return { ...base, ...await application.read(projectId, 'inspect', { docId: args.docId, fresh: args.fresh, preview: args.preview, signal: exec.signal }, actor) };
    }
    if (args.op === 'list_external') {
      return { ...base, ...await application.read(projectId, 'list_external', { includeUnregistered: args.includeUnregistered, signal: exec.signal }, actor) };
    }
    throw new BoardError('invalid-command', 'unknown doc op: ' + args.op, { status: 400 });
  });
}

function renderDoc(args, value) {
  if (PROJECTION_DOC_OPS.includes(args.op)) return textBlock(JSON.stringify(value));
  if (RETAINED_DOC_OPS.includes(args.op) || RELATION_OPS.includes(args.op)) return textBlock(JSON.stringify(value));
  if (args.op === 'get_fixed') return textBlock(JSON.stringify(value));
  if (args.op === 'inspect') return textBlock(inspectSummary(value));
  if (value.body) return textBlock(docSummary(value) + '\n\n' + value.body);
  if (value.docs) return textBlock(docsSummary(value));
  return textBlock([docSummary(value), ...responsibilityLines(value.doc)].join('\n'));
}

export function register(ctx, runtime) {
  ctx.tools.register(defineTool({
    name: 'project_doc',
    description: 'Read or write project documents. Inline documents are read-only archives: put/link return inline-write-disabled unless the project owner explicitly re-enabled inline writes; reads and historical docId@rev keep working. External documents are registered workspace files: register/inspect/update_meta/relocate/confirm/unregister use a locator and expectedMetaRev; confirm in an owning workspace retains the confirmed version without editing its file. get/put/link reject external docs. Doc evidence is automatic: submit {kind:"doc", ref:docId}; the server retains the exact workspace version when available, otherwise reports current-only evidence. Callers do not supply proof or version fields. For external docs an @rev suffix is ignored (it is metadata, not content); inline docId@rev keeps its historical pinned bytes. get_fixed is deprecated: it returns recorded historical Git provenance only, without original bytes or re-verification. For a registered file in the owning space, capture retains its observed bytes without editing the file; history lists retained versions, read_version reads one exact version, and compare checks current bytes against that version without writing. These operations require full authority; retained history is not a complete record of external edits. Workspace projection (discover/read_current/refresh_current) is derived from the owning space only: discover pages through supported documents whether registered or not; read_current returns a fresh bounded text preview and refresh_current reports one path\'s fresh observation without writing. Projection requires full authority and takes no project, root or scope argument. In the owning space, relate adds or replaces an explicit version relation, unrelate removes an active relation without erasing history, and relations reads relations without capture. All three require full authority and do not change current links.',
    parameters: {
      op: {
        type: 'string',
        required: true,
        enum: ['get', 'put', 'list', 'link', 'register', 'inspect', 'update_meta', 'relocate', 'confirm', 'unregister', 'list_external', 'get_fixed', ...RETAINED_DOC_OPS, ...PROJECTION_DOC_OPS, ...RELATION_OPS],
      },
      fixed: FIXED_REFERENCE_SCHEMA,
      commitOid: { type: 'string', description: 'Deprecated get_fixed: recorded full commit OID (alternative to fixed).' },
      pathAtCommit: { type: 'string', description: 'Deprecated get_fixed: the recorded repository-relative path at commitOid.' },
      docId: { type: 'string' },
      title: { type: 'string' },
      kind: { type: 'string', enum: DOC_KINDS },
      body: { type: 'string' },
      baseRev: { type: 'integer' },
      maxBytes: { type: 'integer', description: 'read_version: defaults to 256 KiB, up to 16 MiB. read_current: 1–' + PROJECTION_MAX_BYTES + ' bytes, defaults to ' + PROJECTION_DEFAULT_MAX_BYTES + '. relations: workspace body read by relationId only.' },
      versionId: { type: 'string', description: 'Exact retained versionId; required by read_version/compare, optional with docId for relations.' },
      limit: { type: 'integer', description: 'List page size for history (default 30, max 100) or relations.' },
      after: { type: 'string', description: 'nextCursor from the previous page of history or a relations list.' },
      from: {
        type: 'object',
        description: 'Source event position for relate, or a forward relations selector; event is a zero-based ordinal within commit seq.',
        properties: {
          kind: { type: 'string', description: 'task, plan, evidence or audit.' },
          id: { type: 'string' },
          seq: { type: 'integer' },
          event: { type: 'integer' },
        },
      },
      to: {
        type: 'object',
        description: 'Target for relate or an exact reverse relations selector. Supply kind and docId: workspace-body requires versionId; inline requires rev; git-fixed requires fixed (a saved FixedRef). workspace-current is accepted only by relate.',
      },
      relationId: { type: 'string', description: 'Required by unrelate; for relations selects one relation, optionally with maxBytes for its workspace body. Use exactly one selector: from, to, docId (optionally with versionId), or relationId.' },
      expectedRev: { type: 'integer', description: 'Expected source revision for relate/unrelate.' },
      replacesId: { type: 'string', description: 'relate: optional relation ID explicitly replaced by the new relation.' },
      purpose: { type: 'string', description: 'Document purpose (register/update_meta only).' },
      scope: { type: 'string', description: 'Document responsibility scope (register/update_meta only).' },
      supersedes: { type: 'array', items: { type: 'string' }, description: 'Stable document IDs explicitly superseded (register/update_meta only).' },
      links: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskIds: { type: 'array', items: { type: 'string' } },
          planRefs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                planId: { type: 'string', required: true },
                version: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      bindingId: { type: 'string', description: 'External locator binding; defaults to the project main binding.' },
      relPath: { type: 'string', description: 'Workspace-relative path of the external file (register/relocate) or of the current projection (read_current/refresh_current).' },
      cursor: { type: 'string', description: 'discover: opaque nextCursor from the previous page. Bound to this credential, project and operation; never construct one.' },
      expectedMetaRev: { type: 'integer', description: 'External doc metaRev; required for update_meta/relocate/confirm/unregister.' },
      expectedContentHash: { type: 'string', description: 'Lowercase hex64 SHA-256 of the full file (confirm).' },
      status: { type: 'string', enum: MANAGEMENT_STATES, description: 'Management state for update_meta.' },
      reason: { type: 'string' },
      includeUnregistered: { type: 'boolean', description: 'list_external: include unregistered tombstones.' },
      fresh: { type: 'boolean', description: 'inspect: bypass the 30 s observation cache.' },
      preview: { type: 'boolean', description: 'inspect: include the bounded preview text.' },
    },
    output: output(renderDoc),
    presentCall: (args) => ({ card: 'generic', title: 'Project doc · ' + args.op, kind: 'other', rawInput: args }),
    execute: (args, exec) => executeDoc(runtime, args, exec),
  }));
}
