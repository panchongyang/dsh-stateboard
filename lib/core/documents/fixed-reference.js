import { isDeepStrictEqual } from 'node:util';
import { validateRelPath } from './locate.js';
import { fixedError } from './fixed-git.js';

const FIXED_KEYS = 'blobContentHash,blobOid,commitOid,objectFormat,pathAtCommit,projectId,v';

export function assertFixedReference(fixed, projectId) {
  let problem = null;
  if (!fixed || typeof fixed !== 'object' || Array.isArray(fixed)) problem = 'fixed must be an object';
  else if (Object.keys(fixed).sort().join(',') !== FIXED_KEYS || fixed.v !== 1) problem = 'unsupported fixed structure/version';
  else if (typeof fixed.projectId !== 'string' || fixed.projectId === '' || (projectId && fixed.projectId !== projectId)) problem = 'fixed project identity mismatch';
  else if (!['sha1', 'sha256'].includes(fixed.objectFormat)) problem = 'invalid object format';
  else {
    const oid = fixed.objectFormat === 'sha1' ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/;
    if (typeof fixed.commitOid !== 'string' || typeof fixed.blobOid !== 'string' || !oid.test(fixed.commitOid) || !oid.test(fixed.blobOid)) problem = 'invalid object identity';
    else if (typeof fixed.blobContentHash !== 'string' || !/^[0-9a-f]{64}$/.test(fixed.blobContentHash)) problem = 'invalid blob content hash';
    else if (!validateRelPath(fixed.pathAtCommit).ok) problem = 'invalid repository-relative path';
  }
  if (problem) throw fixedError('invalid-fixed-reference', problem);
  return fixed;
}

export function assertRepositoryApproval(source) {
  if (source === undefined) return;
  const keys = source && typeof source === 'object' && !Array.isArray(source) ? Object.keys(source).sort().join(',') : '';
  const oid = source?.objectFormat === 'sha1' ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/;
  if (keys !== 'anchorCommitOid,bindingIds,objectFormat,v' || source.v !== 1 || !['sha1', 'sha256'].includes(source.objectFormat)
    || typeof source.anchorCommitOid !== 'string' || !oid.test(source.anchorCommitOid) || !Array.isArray(source.bindingIds) || source.bindingIds.length === 0
    || source.bindingIds.some((id) => typeof id !== 'string' || !id.startsWith('bnd_')) || new Set(source.bindingIds).size !== source.bindingIds.length) {
    throw fixedError('invalid-fixed-reference', 'invalid project repository approval');
  }
}

export function fixedKey(ref, fixed) {
  return JSON.stringify([ref, fixed.projectId, fixed.commitOid, fixed.pathAtCommit, fixed.blobOid, fixed.objectFormat, fixed.blobContentHash]);
}

function assertFixedRow(row, projectId) {
  assertFixedReference(row?.fixed, projectId);
  if (row.kind !== 'doc' || typeof row.ref !== 'string' || !row.ref.startsWith('doc_') || row.ref.includes('@') || row.hash !== row.fixed.blobContentHash) {
    throw fixedError('invalid-fixed-reference', 'fixed evidence requires docId and matching content hash');
  }
}

export function contentFixedEvents(added) {
  return added.filter((row) => Object.hasOwn(row, 'fixed')).map((row) => ({
    type: 'doc/content-fixed', docId: row.ref,
    data: { kind: 'doc', ref: row.ref, hash: row.hash, fixed: structuredClone(row.fixed) },
  }));
}

export function applyContentFixed(state, event) {
  const row = event.data;
  assertFixedRow(row, state.project?.id);
  if (event.docId !== row.ref || !state.docs[row.ref]) throw fixedError('invalid-fixed-reference', 'fixed event must target an existing doc');
  const key = fixedKey(row.ref, row.fixed);
  state.fixedContents ||= {};
  const existing = state.fixedContents[key];
  if (existing && !isDeepStrictEqual(existing, row)) throw fixedError('fixed-object-mismatch', 'immutable fixed reference cannot be overwritten');
  state.fixedContents[key] = structuredClone(row);
}

export function assertFixedCommit(state, commit) {
  const projectId = state.project?.id;
  const barriers = new Set();
  for (const event of commit.events || []) {
    if (event.type !== 'doc/content-fixed') continue;
    assertFixedRow(event.data, projectId);
    if (event.docId !== event.data.ref || Object.keys(event.data).sort().join(',') !== 'fixed,hash,kind,ref') throw fixedError('invalid-fixed-reference', 'invalid fixed event envelope');
    const exists = state.docs?.[event.data.ref] || commit.events.some((item) => item.type?.startsWith('doc/') && item.data?.id === event.data.ref);
    if (!exists) throw fixedError('invalid-fixed-reference', 'fixed event doc does not exist');
    barriers.add(fixedKey(event.data.ref, event.data.fixed));
  }
  for (const event of commit.events || []) {
    if (!event.type?.startsWith('task/')) continue;
    for (const row of event.data?.evidence || []) {
      if (!Object.hasOwn(row, 'fixed')) continue;
      assertFixedRow(row, projectId);
      if (typeof row.id !== 'string' || row.id === '') throw fixedError('invalid-fixed-reference', 'persisted fixed task evidence requires an evidence id');
      const key = fixedKey(row.ref, row.fixed);
      const existing = state.tasks?.[event.data.id]?.evidence?.find((item) => item.id === row.id && Object.hasOwn(item, 'fixed'));
      const unchanged = existing && existing.hash === row.hash && fixedKey(existing.ref, existing.fixed) === key;
      if (!unchanged && !barriers.has(key)) {
        throw fixedError('invalid-fixed-reference', 'first fixed task evidence requires doc/content-fixed in the same atomic commit', { seq: commit.seq, docId: row.ref });
      }
    }
  }
}

function fixedTaskRows(tasks) {
  return Object.fromEntries(Object.entries(tasks || {}).map(([id, task]) => [id, (task.evidence || []).filter((row) => Object.hasOwn(row, 'fixed'))])
    .filter(([, rows]) => rows.length > 0));
}

export function assertFixedLog(commits, project, snapshot = null) {
  const shadow = { project, docs: {}, tasks: {}, fixedContents: {} };
  let anchored = {};
  let approvedAtSnapshot;
  let tasksAtSnapshot = {};
  for (const commit of commits) {
    assertFixedCommit(shadow, commit);
    for (const event of commit.events) {
      if (event.type === 'project/created' || event.type === 'project/updated') {
        assertRepositoryApproval(event.data.gitContentRepository);
        shadow.project = event.data;
      }
      if (event.type.startsWith('doc/') && event.data?.id) shadow.docs[event.data.id] = event.data;
      if (event.type === 'doc/content-fixed') applyContentFixed(shadow, event);
      if (event.type.startsWith('task/') && event.data?.id && Array.isArray(event.data.evidence)) shadow.tasks[event.data.id] = event.data;
    }
    if (snapshot?.seq === commit.seq) {
      anchored = structuredClone(shadow.fixedContents);
      approvedAtSnapshot = shadow.project?.gitContentRepository;
      tasksAtSnapshot = structuredClone(fixedTaskRows(shadow.tasks));
    }
  }
  if (snapshot && !isDeepStrictEqual(snapshot.state.project?.gitContentRepository, approvedAtSnapshot)) {
    throw fixedError('invalid-fixed-reference', 'snapshot repository approval differs from its log anchor');
  }
  if (snapshot && !isDeepStrictEqual(snapshot.state.fixedContents || {}, anchored)) {
    throw fixedError('invalid-fixed-reference', 'snapshot fixed content projection differs from its log anchor');
  }
  if (snapshot && !isDeepStrictEqual(fixedTaskRows(snapshot.state.tasks), tasksAtSnapshot)) {
    throw fixedError('invalid-fixed-reference', 'snapshot fixed task evidence differs from its log anchor');
  }
  for (const task of Object.values(snapshot?.state.tasks || {})) {
    for (const row of task.evidence || []) {
      if (!Object.hasOwn(row, 'fixed')) continue;
      assertFixedRow(row, snapshot.state.project?.id);
      if (!anchored[fixedKey(row.ref, row.fixed)]) throw fixedError('invalid-fixed-reference', 'snapshot evidence has no fixed content registration');
    }
  }
}
