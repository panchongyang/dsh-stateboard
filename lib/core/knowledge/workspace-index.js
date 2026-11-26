// Bounded fold of allowed observations into a disposable namespace. No source text is retained by the index.
import { BoardError } from '../errors.js';
import { canonicalJSON, sha256 } from '../util.js';
import { workspaceBodyCandidate, workspaceCurrentCandidate, readWorkspaceSource, workspaceChunks } from './workspace-sources.js';

const seenLimit = 16384;
const isCurrent = origin => origin.startsWith('workspace-current:');
export const isWorkspaceOrigin = origin => isCurrent(origin) || origin.startsWith('workspace-body:');

function prepareWorkspace(snapshot, previous, position) {
  if (!snapshot.workspace) return null;
  const page = snapshot.discovery;
  const entries = page?.entries ?? [];
  const retained = Object.values(snapshot.state.workspaceVersions ?? {}).sort((a, b) => a.versionRef.versionId.localeCompare(b.versionRef.versionId));
  const signature = sha256(retained.map(row => row.versionRef.versionId).join('\n'));
  const pageId = page && sha256(canonicalJSON([page.scanGeneration ?? null, page.observedAt ?? null, page.nextCursor ?? null,
    entries.map(entry => entry.relPath)]));
  const samePage = !!pageId && pageId === previous?.pageId;
  const retainedStart = position?.workspaceBody ?? (previous?.signature === signature && previous.retainedNext < retained.length ? previous.retainedNext : 0);
  const currentStart = position?.workspaceCurrent ?? (samePage ? previous.currentNext : 0);
  if (position && ((position.workspacePage && position.workspacePage !== pageId) || currentStart > entries.length || retainedStart > retained.length)) {
    throw new BoardError('knowledge-cursor-stale', 'Workspace scan page changed; restart this query', { status: 409 });
  }
  let retainedNext = retainedStart, currentNext = currentStart, retainedRead = 0, currentRead = 0;
  const unavailable = {}, discovered = [], bodies = [], workspaceHits = [];
  const count = why => { unavailable[why] = (unavailable[why] ?? 0) + 1; };
  function collect(candidate, list, quota) {
    const source = quota.read(() => {
      try { return readWorkspaceSource(snapshot, candidate.ref); }
      catch (error) { return { availability: error.code || 'source-unavailable' }; }
    });
    list.push({ origin: candidate.origin, source });
    if (source.availability !== 'available') count(source.availability);
    else workspaceHits.push(source);
  }
  return {
    tryRetained(quota) {
      while (retainedNext < retained.length) {
        const candidate = workspaceBodyCandidate(snapshot, retained[retainedNext++].versionRef);
        if (!candidate) continue; // Authorization alone does not consume a body attempt.
        collect(candidate, bodies, quota); retainedRead++;
        return true;
      }
      return false;
    },
    tryCurrent(quota) {
      while (currentNext < entries.length) {
        const candidate = workspaceCurrentCandidate(snapshot, entries[currentNext++]);
        if (!candidate) { count('source-not-observed'); continue; }
        collect(candidate, discovered, quota); currentRead++;
        return true;
      }
      return false;
    },
    finish() {
      const deferred = entries.length - currentNext;
      const pagePending = deferred > 0;
      const scanComplete = !!page && !page.partial && !page.nextCursor && !pagePending;
      const retainedDeferred = retained.length - retainedNext;
      return { signature, retainedNext, pageId, currentNext, discovered, bodies, workspaceHits, scanComplete,
        start: { workspaceBody: retainedStart, workspaceCurrent: currentStart, ...(pageId ? { workspacePage: pageId } : {}) },
        coverage: { scope: 'authorized-workspace', partial: !scanComplete || retainedDeferred > 0,
          scanGeneration: page?.scanGeneration ?? null, observedAt: page?.observedAt ?? null,
          ...(page?.error ? { reason: page.error } : {}), coverageGaps: page?.coverageGaps ?? null,
          currentRead, deferred, pagePending, retainedKnown: retained.length, retainedRead, retainedThrough: retainedNext,
          retainedDeferred, unavailable } };
    },
  };
}

function replaceOrigin(index, { origin, source }) {
  const old = index.byOrigin(origin);
  if (source.availability !== 'available') return index.remove(origin);
  if (old.length && old.every(row => row.sourceRef === source.sourceRef && row.title === source.title
    && row.state === source.state && row.revision === source.revision)) return false;
  let changed = index.remove(origin);
  for (const chunk of workspaceChunks(source)) changed = index.put({ ...chunk, origin }) || changed;
  return changed;
}

export function prepareWorkspaceBatch(index, snapshot) {
  if (!snapshot.workspace) return null;
  const previous = index.get('workspaceSweep');
  const batch = prepareWorkspace(snapshot, previous);
  return { ...batch, finish() {
    const progress = batch.finish();
    const { coverage } = progress;
    const scanGeneration = coverage.scanGeneration ?? previous?.scanGeneration;
    const continuing = previous?.scanGeneration && previous.scanGeneration === scanGeneration;
    const seen = new Set(continuing ? previous.seen : []);
    let sweepComplete = continuing ? previous.sweepComplete !== false : true;
    let changed = false;
    for (const row of progress.discovered) {
      if (seen.has(row.origin) || seen.size < seenLimit) seen.add(row.origin); else sweepComplete = false;
      changed = replaceOrigin(index, row) || changed;
    }
    for (const row of progress.bodies) changed = replaceOrigin(index, row) || changed;
    if (progress.scanComplete && scanGeneration && sweepComplete) {
      for (const origin of index.origins()) if (isCurrent(origin) && !seen.has(origin)) changed = index.remove(origin) || changed;
    }
    coverage.partial ||= !sweepComplete;
    index.set('workspaceSweep', { signature: progress.signature, retainedNext: progress.retainedNext,
      scanGeneration, seen: [...seen], sweepComplete, coverage,
      pageId: progress.pageId, currentNext: progress.currentNext });
    return { changed, workspace: coverage };
  } };
}

// The cursor carries positions and a hash, never a path or body from discovery.
export function prepareWorkspaceScan(snapshot, position) {
  const batch = prepareWorkspace(snapshot, null, position);
  if (!batch) return null;
  return { ...batch, finish() {
    const progress = batch.finish();
    return { coverage: progress.coverage, rows: progress.workspaceHits.flatMap(source => [...workspaceChunks(source)]),
      start: progress.start,
      next: { ...progress.start, workspaceBody: progress.retainedNext, workspaceCurrent: progress.currentNext },
      pending: progress.coverage.pagePending || progress.coverage.retainedDeferred > 0 };
  } };
}
