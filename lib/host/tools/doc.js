import { defineTool } from '@deepseek-ai/dsh-tools';
import { FIXED_REFERENCE_SCHEMA } from '../../shared/fixed-schema.js';
import { assertFixedReadArgs, getFixedContent } from '../../core/documents/fixed-content.js';
import { BoardError } from '../../core/errors.js';
import { DOC_EXTERNAL_WRITE_FIELDS, DOC_KINDS } from '../../shared/contract.js';
import { MANAGEMENT_STATES } from '../../core/documents/external-model.js';
import { inspectExternalDoc, listExternalDocs } from '../../core/documents/external-observe.js';
import { writeInlineDocumentByWorkspace } from '../../core/inline-doc-access.js';
import {
  actorOf, cmdId, docSummary, docsSummary, output, requireHandle, resolveHandle, run, textBlock,
} from './shared.js';

// External documents are registered workspace files: the command carries the
// registration and expected metaRev, never a body. Inline get/put/link keep
// their old behaviour (core rejects external targets explicitly). The shared
// field table is re-checked here: a schema drift must not silently drop a
// misspelled field.
const EXTERNAL_WRITES = new Set(Object.keys(DOC_EXTERNAL_WRITE_FIELDS));

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

function externalCommand(args) {
  if (args.op === 'register') {
    return { op: 'doc.external.register', title: args.title, kind: args.kind, bindingId: args.bindingId, relPath: args.relPath, links: args.links };
  }
  const base = { op: 'doc.external.' + args.op, docId: args.docId, expectedMetaRev: args.expectedMetaRev };
  if (args.op === 'update_meta') return { ...base, title: args.title, kind: args.kind, links: args.links, status: args.status, reason: args.reason };
  if (args.op === 'relocate') return { ...base, bindingId: args.bindingId, relPath: args.relPath };
  if (args.op === 'confirm') return { ...base, expectedContentHash: args.expectedContentHash };
  return { ...base, reason: args.reason };
}

function recordOf(handle, docId) {
  return docId ? structuredClone(handle.state.docs[docId] ?? null) : null;
}

function externalView(handle, args) {
  if (args.op === 'inspect') {
    if (!args.docId) throw new BoardError('invalid-command', 'inspect requires docId', { status: 400 });
    return inspectExternalDoc(handle, args.docId, { fresh: args.fresh, preview: args.preview });
  }
  return listExternalDocs(handle, { includeUnregistered: args.includeUnregistered });
}

async function externalWrite(handle, args, exec) {
  assertExternalFields(args, args.op);
  if (args.op === 'register' && (!args.title || !args.relPath)) {
    throw new BoardError('invalid-command', 'register requires title and relPath', { status: 400 });
  }
  const cmd = externalCommand(args);
  const result = await handle.command({ cmdId: cmdId(), actor: actorOf(exec), ...cmd });
  const docId = result.docId || cmd.docId || result.events?.find((event) => event.docId)?.docId;
  return { schemaVersion: 1, doc: recordOf(handle, docId), result };
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
  lines.push('confirmation: ' + confirmationLine(value.confirmation), baselineLine(value.confirmation.baseline), 'git: ' + gitLine(value.git));
  return lines.join('\n');
}

async function inlineWrite(runtime, args, exec) {
  const actor = exec.agent?.id ? actorOf(exec) : undefined;
  const cmd = { op: 'doc.' + args.op, cmdId: cmdId(), actor, docId: args.docId, links: args.links };
  if (args.op === 'put') Object.assign(cmd, { title: args.title, kind: args.kind, body: args.body, baseRev: args.baseRev });
  const workspacePath = exec.agent?.session?.header?.cwd;
  await runtime.ready;
  const value = await writeInlineDocumentByWorkspace(runtime.service, workspacePath, cmd, (handle) => {
    runtime.sessionProjects.set(actor.sessionId, handle);
  });
  return { ok: true, ...value };
}

function executeDoc(runtime, args, exec) {
  return run(async () => {
    // Field validation happens before the project is opened: opening a cold
    // project can run recovery writes, and a rejected call must write nothing.
    if (EXTERNAL_WRITES.has(args.op)) assertExternalFields(args, args.op);
    if (args.op === 'get_fixed') assertFixedReadArgs(args);
    if (args.op === 'put' || args.op === 'link') return inlineWrite(runtime, args, exec);
    const handle = requireHandle(await resolveHandle(runtime, exec));
    const base = { ok: true, projectId: handle.id };
    if (args.op === 'get_fixed') return { ...base, ...getFixedContent(handle, args) };
    if (args.op === 'get') {
      if (!args.docId) throw new BoardError('invalid-command', 'get requires docId', { status: 400 });
      return { ...base, ...handle.query('doc', { docId: args.docId, maxBytes: args.maxBytes }) };
    }
    if (args.op === 'list') {
      return { ...base, ...handle.query('docs', {}) };
    }
    if (args.op === 'inspect' || args.op === 'list_external') {
      return { ...base, ...externalView(handle, args) };
    }
    if (EXTERNAL_WRITES.has(args.op)) {
      return { ...base, ...(await externalWrite(handle, args, exec)) };
    }
    throw new BoardError('invalid-command', 'unknown doc op: ' + args.op, { status: 400 });
  });
}

export function register(ctx, runtime) {
  ctx.tools.register(defineTool({
    name: 'project_doc',
    description: 'Read or write project documents. Inline documents are read-only archives: put/link return inline-write-disabled unless the project owner explicitly re-enabled inline writes; reads and historical docId@rev keep working. External documents are registered workspace files: register/inspect/update_meta/relocate/confirm/unregister work on a locator and expectedMetaRev and never read or write a body blob; get/put/link reject external docs. Doc evidence is automatic: submit {kind:"doc", ref:docId} and the server pins a committed clean Git version or silently degrades to current-only evidence with fixedState/fixedReason; no approval or confirmation step exists, and callers never pass a fixed reference as evidence. For external docs an @rev suffix is ignored (it is metadata, not content); inline docId@rev keeps its historical pinned bytes. get_fixed is an advanced read of explicit Git bytes and creates no evidence.',
    parameters: {
      op: {
        type: 'string',
        required: true,
        enum: ['get', 'put', 'list', 'link', 'register', 'inspect', 'update_meta', 'relocate', 'confirm', 'unregister', 'list_external', 'get_fixed'],
      },
      fixed: FIXED_REFERENCE_SCHEMA,
      commitOid: { type: 'string', description: 'get_fixed: explicit full commit OID (alternative to fixed).' },
      pathAtCommit: { type: 'string', description: 'get_fixed: repository-relative path at commitOid.' },
      docId: { type: 'string' },
      title: { type: 'string' },
      kind: { type: 'string', enum: DOC_KINDS },
      body: { type: 'string' },
      baseRev: { type: 'integer' },
      maxBytes: { type: 'integer' },
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
      relPath: { type: 'string', description: 'Workspace-relative path of the external file (register/relocate).' },
      expectedMetaRev: { type: 'integer', description: 'External doc metaRev; required for update_meta/relocate/confirm/unregister.' },
      expectedContentHash: { type: 'string', description: 'Lowercase hex64 SHA-256 of the full file (confirm).' },
      status: { type: 'string', enum: MANAGEMENT_STATES, description: 'Management state for update_meta.' },
      reason: { type: 'string' },
      includeUnregistered: { type: 'boolean', description: 'list_external: include unregistered tombstones.' },
      fresh: { type: 'boolean', description: 'inspect: bypass the 30 s observation cache.' },
      preview: { type: 'boolean', description: 'inspect: include the bounded preview text.' },
    },
    output: output((args, value) => {
      if (args.op === 'get_fixed') return textBlock('Fixed Git content (not evidence) · ' + value.docId + '\n' + JSON.stringify(value.fixed) + '\nworkspaceComparison: ' + JSON.stringify(value.workspaceComparison) + '\ntruncated: ' + value.truncated + ' · totalBytes: ' + value.totalBytes + '\n\n' + value.body);
      if (args.op === 'inspect') return textBlock(inspectSummary(value));
      if (value.body) return textBlock(docSummary(value) + '\n\n' + value.body);
      if (value.docs) return textBlock(docsSummary(value));
      return textBlock(docSummary(value));
    }),
    presentCall: (args) => ({ card: 'generic', title: 'Project doc · ' + args.op, kind: 'other', rawInput: args }),
    execute: (args, exec) => executeDoc(runtime, args, exec),
  }));
}
