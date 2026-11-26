// Command-side capability. No operation writes to a document's source locator.
import { BoardError } from '../errors.js';
import { observeWorkspaceSource, workspaceLocatorKey, assertWorkspaceSourceLocator } from '../documents/workspace-source.js';
import { putWorkspaceObject, readWorkspaceObject } from '../store/workspace-objects.js';
import { inlineVersionAt, locateRelationOwner, missingRelation, owningStoredWorkspaceVersion, recordedFixedVersion } from '../domain/document-relations.js';
import { sha256 } from '../domain/value-hash.js';

function captureDocument({ home, project, service, preview, assertWriter }, doc, { expectedContentHash, allowUnretained = false } = {}) {
  if (!home) throw new BoardError('space-home-unavailable', 'Document capture requires an owning space');
  service._assertOpen();
  const source = observeWorkspaceSource(home, project, doc, { allowUnretained });
  const { contentHash, size } = source;
  if (expectedContentHash !== undefined && contentHash !== expectedContentHash) {
    throw new BoardError('stale-revision', 'document content changed since it was read; re-read and confirm again', {
      status: 409, details: { docId: doc.id, currentContentHash: contentHash },
    });
  }
  if (!source.bytes) return { contentHash, size, currentOnly: 'unsupported-format' };
  // Preflight only simulates log events. It must not create an object or a bucket.
  if (preview) return { contentHash, size };
  // Publish or verify complete bytes before referring to them in the log.
  // If the log transaction later fails, no version or attachment is visible.
  service._assertOpen();
  assertWriter();
  try {
    const object = putWorkspaceObject(home, source.bytes);
    if (object.contentHash !== contentHash || object.size !== size) throw new BoardError('content-object-corrupt', 'Retained object does not match observation', { status: 503 });
    return object;
  } catch (error) {
    if (!allowUnretained || !['content-object-corrupt', 'history-capacity', 'write-capability-unavailable', 'ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EROFS', 'EIO'].includes(error?.code)) throw error;
    // The hash still describes the safely observed current source, not the failed object.
    return { contentHash, size, currentOnly: 'workspace-retention-unavailable' };
  }
}

export function retainedDocumentPort(facts, service, { preview = false, assertWriter = () => {} } = {}) {
  const home = service.spaceHome, project = facts.state.project;
  const assertRelationSpace = () => {
    service._assertOpen();
    if (!home || home.check() !== true || home.readMeta()?.projectId !== project.id) {
      throw new BoardError('space-home-unavailable', 'Version relations require the authorized owning space', { status: 409 });
    }
  };
  return {
    assertRelationSpace,
    relationOwner: from => locateRelationOwner(facts.store.commits, from),
    assertRelationTarget(target, { verifyBytes = true } = {}) {
      assertRelationSpace();
      if (target.kind === 'workspace-body') {
        const version = owningStoredWorkspaceVersion(facts.state, target);
        if (!version) throw missingRelation();
        assertWorkspaceSourceLocator(home, project, version.locator);
        if (verifyBytes && readWorkspaceObject(home, version.versionRef.contentHash).length !== version.size) {
          throw new BoardError('content-object-corrupt', 'Retained version size differs', { status: 503 });
        }
      } else if (target.kind === 'inline') {
        const version = inlineVersionAt(facts.store.commits, target);
        if (!version) throw missingRelation();
        if (verifyBytes) {
          const body = facts.store.readMigrationBlob(version.hash);
          if (typeof body !== 'string' || sha256(body) !== version.hash) throw missingRelation();
        }
        return version.hash;
      } else {
        if (!recordedFixedVersion(facts.state, target)) throw missingRelation();
        // Existing relations remain removable without a repository or Git bytes.
        // New Git targets are rejected at command intake.
      }
    },
    assertUniqueLocator(locator, except) {
      // Do not retroactively reinterpret central-store bindings.
      if (!home) return;
      const key = workspaceLocatorKey(home, project, locator);
      for (const doc of Object.values(facts.state.docs)) {
        if (doc.id === except || doc.source !== 'external' || doc.unregistered) continue;
        try {
          assertWorkspaceSourceLocator(home, project, doc.locator);
          if (doc.locator.relPath !== locator.relPath && workspaceLocatorKey(home, project, doc.locator) !== key) continue;
        } catch (err) {
          // A missing file cannot alias an existing object. A locator from an
          // ungranted binding is not silently rebound to the owning space.
          if (['file-missing','missing-binding','reserved-path','not-regular'].includes(err.code) || (err.code === 'security-rejected' && err.details?.reason === 'multiple-hard-links')) continue;
          throw err;
        }
        throw new BoardError('locator-already-registered', 'This workspace file is already registered', {details:{docId:doc.id}});
      }
    },
    hasOwningSpace: Boolean(home),
    capture: (doc, options) => captureDocument({ home, project, service, preview, assertWriter }, doc, options),
  };
}
