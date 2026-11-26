// Current-file evidence has no retained version; observe its own bytes without Git.
import { readLocator } from './external-observe.js';
import { observeWorkspaceSource } from './workspace-source.js';

export function auditCurrentOnlyDoc(handle, row, doc) {
  const warning = (code, message) => ({ evidenceId: row.id, code, severity: 'error', message: message + ': ' + row.ref });
  const home = handle.spaceHome ?? handle.service?.spaceHome;
  let hash;
  if (home) {
    // Confirmation, capture, and re-audit share the same physical source gate.
    try { hash = observeWorkspaceSource(home, handle.state.project, doc, { allowUnretained: true }).contentHash; }
    catch (error) {
      const sourceError = ['security-rejected', 'reserved-path', 'outside-root', 'missing-binding'].includes(error?.code)
        ? error.code : 'doc-unavailable';
      return warning(sourceError, 'current-only doc evidence is not readable');
    }
  } else {
    // The historical central layout has no workspace object store. The hash
    // still supports current-only checking without inventing a version.
    hash = readLocator(handle, doc.locator, { previewBytes: 1 }).read.hash;
  }
  if (typeof hash !== 'string') return warning('doc-unavailable', 'current-only doc evidence is not readable');
  if (hash !== row.hash) return warning('doc-drift', 'current-only doc evidence changed');
  return null;
}
