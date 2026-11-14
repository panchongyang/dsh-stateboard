import { StringDecoder } from 'node:string_decoder';
import { BoardError } from './errors.js';
import { createReadHandle } from './project-read-handle.js';
import { getFixedContent } from './documents/fixed-content.js';
import { inspectExternalDoc, listExternalDocs } from './documents/external-observe.js';
import { MCP_WRITE_TOOLS } from '../shared/contract.js';

const MAX_BODY_BYTES = 24 * 1024;
const MAX_VIEW_BYTES = 256 * 1024;
const HIDDEN_FIELDS = new Set(['fencingToken', 'token', 'sessionToken', 'mcpRenewals', 'workspacePath', 'root', 'gitContentRepository']);

// Same native projections, backed only by a captured or replayed project.
// Never expose raw lease/binding data or diagnostic strings from the host.
function limitText(text, limit) {
  const bytes = Buffer.from(text);
  const truncated = bytes.length > limit;
  return { text: truncated ? new StringDecoder('utf8').write(bytes.subarray(0, limit)) : text, truncated };
}

function safeView(view, data, actor, live, maxBytes) {
  if (view === 'brief') {
    data.session = {
      leases: data.session.leases.map(({ taskId, expiresAt }) => ({ taskId, expiresAt })),
      available: live,
    };
    data.health = { evidenceAudit: data.health.evidenceAudit, warningCount: data.health.total };
  }
  if (view === 'task') {
    data.allowedOps = live ? data.allowedOps.filter(({ op }) => Object.hasOwn(MCP_WRITE_TOOLS, op)) : null;
    data.lease = data.lease?.sessionId === actor.sessionId ? { expiresAt: data.lease.expiresAt } : null;
  }
  if (typeof data.body === 'string') {
    const body = limitText(data.body, maxBytes ?? MAX_BODY_BYTES);
    data.body = body.text;
    data.truncated ||= body.truncated;
  }
  if (data.observation?.preview) {
    const preview = data.observation.preview;
    const body = limitText(preview.text, MAX_BODY_BYTES);
    data.observation.preview = { ...preview, text: body.text, truncated: preview.truncated || body.truncated };
  }
  return data;
}

function readView(handle, { view, taskId, planId, docId, query, maxBytes: _maxBytes, after, limit, ...options }, actor) {
  switch (view) {
    case 'brief': return handle.query(view, { sessionId: actor.sessionId });
    case 'board': case 'plans': return handle.query(view);
    case 'task': return handle.query(view, { taskId, sessionId: actor.sessionId });
    case 'plan': {
      const result = handle.query(view, { planId });
      if (planId && !result.plan) throw new BoardError('not-found', 'Plan not found', { status: 404 });
      return result;
    }
    case 'docs': {
      const result = handle.query(view);
      if (!query) return result;
      const needle = query.toLowerCase();
      return { ...result, docs: result.docs.filter((doc) => doc.title.toLowerCase().includes(needle)) };
    }
    case 'doc': return handle.query(view, { docId, maxBytes: Number.MAX_SAFE_INTEGER });
    case 'list_external': return listExternalDocs(handle, options);
    case 'inspect': return inspectExternalDoc(handle, docId, options);
    // A project inside a larger checkout must not grant access to the enclosing repository.
    case 'get_fixed': return getFixedContent(handle, { docId, ...options }, { withinBinding: true });
    case 'events': return handle.query(view, { after: after ?? 0, limit: limit ?? 50 });
    case 'health': {
      const health = handle.health({ includeEvidenceWarnings: true });
      return {
        ok: health.ok, hashChain: health.hashChain, counts: health.counts,
        checks: health.checks.map(({ name, ok }) => ({ name, ok })),
        warningCount: health.warnings.length, openIntentCount: health.intents.length,
        evidenceAudit: { status: 'complete' },
      };
    }
    default: throw new BoardError('invalid-command', 'Unknown project view', { status: 400 });
  }
}

export function projectViewResult({ projectId, rootDir, dir, params, actor, now, live }, snapshot) {
  const handle = createReadHandle({ projectId, rootDir, dir, now, live }, snapshot);
  const { view } = params;
  const data = safeView(view, readView(handle, params, actor), actor, Boolean(live), params.maxBytes);
  const result = JSON.stringify({ projectId, projectRev: handle.rev, view, ...data },
    (key, value) => {
      if (HIDDEN_FIELDS.has(key)) return undefined;
      if (key === 'warnings' && Array.isArray(value)) {
        return value.map(({ evidenceId, code, severity }) => ({ evidenceId, code, severity }));
      }
      if (key === 'ref' && typeof value === 'string' && /^(?:[A-Za-z]:[\\/]|[\\/])/.test(value)) return null;
      return value;
    });
  if (Buffer.byteLength(result, 'utf8') > MAX_VIEW_BYTES) {
    throw new BoardError('result-too-large', 'Project view exceeds the MCP response limit', { status: 413 });
  }
  return JSON.parse(result);
}
