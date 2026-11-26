// Inline document projection: metadata is pure; the body read is injected by
// the caller so blob I/O never hides inside a logical projection.
import { BoardError } from '../errors.js';
import { isExternal, externalOperationRequired } from '../documents/external-model.js';

const DEFAULT_MAX_BYTES = 262144;

export function inlineDocProjection(snapshot, docId, body, maxBytes) {
  const doc = snapshot.state.docs[docId];
  if (!doc) throw new BoardError('not-found', 'doc not found: ' + docId, { status: 404 });
  if (isExternal(doc)) throw externalOperationRequired(docId, 'the inline doc view');
  if (body === null || body === undefined) {
    throw new BoardError('hash-chain-broken', 'document blob missing: ' + doc.hash, { status: 503 });
  }
  const limit = Number.isInteger(maxBytes) ? maxBytes : DEFAULT_MAX_BYTES;
  const truncated = body.length > limit;
  return { doc: structuredClone(doc), body: truncated ? body.slice(0, limit) : body, truncated, rev: snapshot.rev };
}
