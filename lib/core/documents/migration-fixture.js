// Synthetic legacy data only. Never discovers or opens a user's board.
import { MemoryStore, makeCommit } from '../store.js';
import { sha256 } from '../util.js';

export function migrationFixture() {
  const project = { schemaVersion: 3, id: 'prj_migration_fixture', name: 'Synthetic migration', phase: 'active', rev: 0 };
  const links = { taskIds: ['tsk_fixture'], planRefs: [{ planId: 'pln_fixture', version: 1 }] };
  const doc = { id: 'doc_fixture', title: 'Synthetic', kind: 'note', rev: 1, hash: sha256('old\r\n'), size: 5, links };
  const second = { ...doc, rev: 2, hash: sha256('new\n'), size: 4 };
  const linked = { ...second, rev: 3, links: { ...links, taskIds: ['tsk_fixture', 'tsk_other'] } };
  const missing = { ...doc, id: 'doc_missing', hash: sha256('lost'), size: 4 };
  const events = [
    [{ type: 'project/created', data: project }],
    [{ type: 'doc/created', docId: doc.id, data: doc }],
    [{ type: 'doc/updated', docId: doc.id, data: second }],
    [{ type: 'doc/updated', docId: doc.id, data: linked }],
    [{ type: 'doc/created', docId: missing.id, data: missing }],
    [{ type: 'task/created', data: { id: 'tsk_fixture', requiresAudit: false, evidence: [
      { kind: 'doc', ref: 'doc_fixture@1', hash: doc.hash },
      { kind: 'doc', ref: 'doc_fixture@3', hash: linked.hash },
      { kind: 'doc', ref: 'doc_missing@1', hash: missing.hash },
    ] } }],
  ];
  const commits = [];
  for (const list of events) commits.push(makeCommit(commits.length + 1, commits.at(-1)?.hash || 'genesis', { kind: 'human' }, 'fixture_' + commits.length, commits.length, list));
  const store = new MemoryStore({ project: structuredClone(project) }, structuredClone(commits));
  store.blobs.set(doc.hash, 'old\r\n');
  store.blobs.set(second.hash, 'new\n');
  store.open();
  store.commits = commits; // replay stamps projection provenance, not fixture log bytes
  return store;
}
