// Retain an observed workspace body for an already registered external
// document. Pure model: no file I/O, no metadata, baseline or revision change.
import { isDeepStrictEqual } from 'node:util';
import { BoardError } from '../../errors.js';
import { isExternal } from '../../documents/external-model.js';
import { validateRelPath } from '../document-path.js';
import {
  latestVersionFor, versionProblem, WORKSPACE_MAX_BYTES, WORKSPACE_RETAINED_EVENT,
  WORKSPACE_VERSION_KIND, WORKSPACE_VERSION_REF_V,
} from '../workspace-record.js';

const HEX64 = /^[0-9a-f]{64}$/;
const FIELDS = Object.freeze(['docId', 'locator', 'contentHash', 'size']);

function invalid(message, details = null) {
  return new BoardError('invalid-command', message, { status: 400, details });
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** Retain the exact observed bytes; only the version ledger changes. */
export function retainVersion(work, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw invalid('operation arguments must be an object');
  for (const key of Object.keys(args)) if (!FIELDS.includes(key)) throw invalid('unsupported retain field: ' + key);
  if (!nonEmpty(args.docId)) throw invalid('docId is required');
  const state = work.state;
  const doc = (state.docs || {})[args.docId];
  if (!doc) throw new BoardError('not-found', 'doc not found: ' + args.docId, { status: 404 });
  if (!isExternal(doc)) {
    throw new BoardError('external-doc-operation-required', 'doc ' + args.docId + ' is not an external workspace document', {
      status: 409, details: { docId: args.docId, source: doc.source ?? 'inline' },
    });
  }
  if (doc.unregistered) throw new BoardError('illegal-transition', 'doc ' + doc.id + ' is unregistered', { status: 409, details: { docId: doc.id } });
  const locator = args.locator;
  if (!locator || typeof locator !== 'object' || Array.isArray(locator)
    || Object.keys(locator).sort().join(',') !== 'bindingId,relPath') {
    throw invalid('locator must be exactly {bindingId, relPath}');
  }
  if (!nonEmpty(locator.bindingId) || !validateRelPath(locator.relPath).ok) throw invalid('locator fields are invalid');
  if (!isDeepStrictEqual(locator, doc.locator)) throw invalid('locator does not match the registered document');
  if (typeof args.contentHash !== 'string' || !HEX64.test(args.contentHash)) throw invalid('contentHash must be lowercase hex64');
  if (!Number.isSafeInteger(args.size) || args.size < 0 || args.size > WORKSPACE_MAX_BYTES) throw invalid('size must be a non-negative safe integer within the 16 MiB body limit');

  const latest = latestVersionFor(state, doc.id);
  if (latest && latest.versionRef.contentHash === args.contentHash && isDeepStrictEqual(latest.locator, locator)) {
    return { events: [], result: { docId: doc.id, versionRef: latest.versionRef, retained: false } };
  }
  const seq = (state.counters?.workspaceVersionSeq || 0) + 1;
  const versionId = doc.id + '~' + seq + '~' + args.contentHash;
  const version = {
    versionRef: {
      v: WORKSPACE_VERSION_REF_V, kind: WORKSPACE_VERSION_KIND, projectId: state.project.id,
      docId: doc.id, versionId, contentHash: args.contentHash,
    },
    locator: { bindingId: locator.bindingId, relPath: locator.relPath },
    size: args.size,
    observedAt: work.clock().toISOString(),
    seq,
    provenance: 'observed',
  };
  const problem = versionProblem(version, { projectId: state.project.id });
  if (problem) throw invalid('retained version is invalid: ' + problem);
  return {
    events: [{ type: WORKSPACE_RETAINED_EVENT, docId: doc.id, data: { version } }],
    result: { docId: doc.id, versionRef: version.versionRef, retained: true },
  };
}

export const RETAINED_DOCUMENT_OPERATIONS = Object.freeze({
  'document.retainVersion': retainVersion,
});
