// Read committed relations only. Authorization follows each exact target, never current links.
import { isDeepStrictEqual } from 'node:util';
import { PROJECT_READ_PAGE_DEFAULT } from '../../shared/contract.js';
import {
  normalizeRelationSource, normalizeRelationTarget, missingRelation, recordedFixedVersion, relationIdIsValid,
} from '../domain/document-relations.js';
import { legacyGitRecord } from '../documents/fixed-content.js';
import { exportInlineContent } from '../documents/migration-inventory.js';
import { BoardError } from '../errors.js';
import { WORKSPACE_OBJECT_MAX_BYTES } from '../store/workspace-objects.js';
import { checkProjectionLexical } from './discovery/path-policy.js';
import { resolveExactWorkspaceVersion } from './workspace-retained.js';

const SELECTORS = ['from', 'docId', 'to', 'relationId'];
const FIELDS = new Set([...SELECTORS, 'versionId', 'after', 'limit', 'maxBytes']);
const WORKSPACE_UNAVAILABLE = new Set(['content-object-missing', 'content-object-corrupt', 'security-rejected']);
const invalid = message => new BoardError('invalid-command', message, { status: 400 });

/** The common query entry validates overall page and byte bounds before calling this. */
export function normalizeDocumentRelationQuery(params) {
  if (Object.keys(params).some(key => !FIELDS.has(key))) throw invalid('Unsupported document relation field');
  const selectors = SELECTORS.filter(key => params[key] !== undefined);
  if (selectors.length !== 1) throw invalid('Select exactly one of from, docId, to or relationId');
  const [selector] = selectors;
  if (params.versionId !== undefined && selector !== 'docId') throw invalid('versionId requires the docId selector');
  if (selector === 'relationId') {
    if (!relationIdIsValid(params.relationId)) throw invalid('Invalid relationId');
    if (params.after !== undefined || params.limit !== undefined) throw invalid('after and limit require a relation list selector');
    if (params.maxBytes > WORKSPACE_OBJECT_MAX_BYTES) throw invalid('maxBytes cannot exceed 16 MiB');
    return { relationId: params.relationId, maxBytes: params.maxBytes };
  }
  if (params.maxBytes !== undefined) throw invalid('maxBytes requires relationId');
  if (params.after !== undefined && !relationIdIsValid(params.after)) throw invalid('Invalid relation cursor');
  const page = { after: params.after, limit: params.limit };
  if (selector === 'from') return { ...page, from: normalizeRelationSource(params.from) };
  if (selector === 'to') return { ...page, to: normalizeRelationTarget(params.to) };
  if (params.versionId !== undefined) {
    const { docId, versionId } = normalizeRelationTarget({ kind: 'workspace-body', docId: params.docId, versionId: params.versionId });
    return { ...page, docId, versionId };
  }
  const { docId } = normalizeRelationTarget({ kind: 'workspace-current', docId: params.docId }, { allowCurrent: true });
  return { ...page, docId };
}

function matching(row, params) {
  if (params.from) return isDeepStrictEqual(row.fromVersion, params.from);
  if (params.to) return isDeepStrictEqual(row.toVersionRef, params.to);
  return row.toVersionRef.docId === params.docId
    && (params.versionId === undefined || (row.toVersionRef.kind === 'workspace-body' && row.toVersionRef.versionId === params.versionId));
}

export function documentRelationTargetAccess({ snapshot, spaceHome, bindings }) {
  const { state } = snapshot;
  const workspace = new Map();
  return target => {
    if (target.kind === 'inline') return {}; // Replay authenticated the archival revision.
    if (target.kind === 'git-fixed') {
      if (!recordedFixedVersion(state, target)) return null;
      if (!spaceHome || spaceHome.check() !== true || spaceHome.readMeta()?.projectId !== state.project.id) return null;
      try { checkProjectionLexical(target.fixed.pathAtCommit, snapshot.workspace?.denyPrefixes || []); }
      catch (error) { if (error instanceof BoardError) return null; throw error; }
      return legacyGitRecord(target.fixed);
    }
    if (target.kind !== 'workspace-body') return null;
    const key = JSON.stringify([target.docId, target.versionId]);
    if (!workspace.has(key)) {
      let exact;
      try { exact = resolveExactWorkspaceVersion(spaceHome, state, target); }
      catch (error) {
        if (!(error instanceof BoardError) || error.code === 'space-home-unavailable') throw error;
        exact = null;
      }
      workspace.set(key, exact);
    }
    return workspace.get(key);
  };
}

function readTarget(relation, access, { maxBytes, readBlob }) {
  const target = relation.toVersionRef;
  if (target.kind === 'workspace-body') {
    try { return access.read(maxBytes); }
    catch (error) {
      if (!(error instanceof BoardError) || !WORKSPACE_UNAVAILABLE.has(error.code)) throw error;
      return { docId: target.docId, versionRef: access.versionRef, state: 'unavailable', reason: error.code };
    }
  }
  const readRef = target;
  if (target.kind === 'inline') {
    const content = exportInlineContent(readBlob, relation.inlineHash);
    if (content.status !== 'available') return { readRef, state: 'unavailable', reason: content.status };
    const bytes = Buffer.from(content.body, 'utf8');
    const max = maxBytes ?? 256 * 1024;
    const truncated = bytes.length > max;
    const body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, max), { stream: truncated });
    return { readRef, body, size: bytes.length, truncated };
  } else if (target.kind === 'git-fixed') {
    return { readRef, ...legacyGitRecord(target.fixed), body: null };
  }
  return { readRef };
}

export function executeDocumentRelationRead({ snapshot, params, spaceHome, bindings, readBlob }) {
  const rows = snapshot.state.documentRelations || {};
  const accessFor = documentRelationTargetAccess({ snapshot, spaceHome, bindings });
  const byId = id => Object.hasOwn(rows, id) ? rows[id] : null;
  const authorized = row => row && accessFor(row.toVersionRef);
  const visibleRow = row => {
    // A predecessor is still visible when closed, but may not disclose a hidden successor.
    const shown = row.toVersionRef.kind === 'git-fixed' ? { ...row, ...legacyGitRecord(row.toVersionRef.fixed) } : row;
    if (!row.replacedBy || authorized(byId(row.replacedBy))) return shown;
    const { replacedBy: _hidden, ...visible } = shown;
    return visible;
  };
  if (params.relationId !== undefined) {
    const row = byId(params.relationId);
    const access = authorized(row);
    if (!access) throw missingRelation();
    return { relation: visibleRow(row), ...readTarget(row, access, { maxBytes: params.maxBytes, readBlob }) };
  }
  const matchingRows = Object.values(rows).filter(row => matching(row, params) && authorized(row));
  matchingRows.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.relationId.localeCompare(b.relationId));
  const start = params.after === undefined ? 0 : matchingRows.findIndex(row => row.relationId === params.after) + 1;
  if (params.after !== undefined && !start) throw invalid('Unknown relation cursor for this selector');
  const page = matchingRows.slice(start, start + (params.limit ?? PROJECT_READ_PAGE_DEFAULT));
  return { relations: page.map(visibleRow), nextCursor: start + page.length < matchingRows.length ? page.at(-1).relationId : null };
}
