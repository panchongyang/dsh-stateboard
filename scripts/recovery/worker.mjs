import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { ProjectService } from '../../lib/core/service.js';
import { validateCommits } from '../../lib/core/store/format.js';
import { sha256 } from '../../lib/core/util.js';
import { root, inside, fixture, json, put, digest } from './harness.mjs';

const [name, action, ...extra] = process.argv.slice(2);
assert.equal(extra.length, 0);
assert.match(name || '', /^[a-z-]+$/);
const actor = { kind: 'agent', sessionId: 'recovery-fixture', agentId: 'synthetic' };
const human = { kind: 'human', sessionId: 'fixture-human' };
function envelope(op, payload = {}) { return { op, actor, cmdId: 'cmd_' + crypto.randomUUID(), ...payload }; }
async function commit(h, op, payload = {}) {
  const cmd = envelope(op, payload);
  const result = await h.command(cmd);
  assert.equal(result.committed, true, op);
  console.log(JSON.stringify({ command: cmd, result }));
  return cmd;
}
function taskPayload(h, taskId) {
  return { taskId, expected: { entityRev: h.state.tasks[taskId].rev }, fencingToken: h.leases.get(taskId)?.token };
}
function healthy(h) {
  assert.equal(h.readOnly, false);
  assert.equal(h.health().ok, true, JSON.stringify(h.health()));
}

async function seed() {
  const base = inside(path.join(root, 'cases', name));
  fs.mkdirSync(base, { recursive: true });
  const data = path.join(base, 'data');
  const workspace = path.join(base, 'workspace');
  fs.mkdirSync(workspace);
  const svc = new ProjectService({ rootDir: data, privilegedInlineWrites: true });
  try {
    await svc.init();
    const h = await svc.createProject({ workspacePath: workspace, name: 'Synthetic recovery ' + name });
    await commit(h, 'task.create', { title: 'Kept task', acceptance: [{ text: 'fixture only' }] });
    await commit(h, 'doc.put', { title: 'Kept document', body: 'synthetic retained body' });
    await commit(h, 'task.create', { title: 'Suffix task', acceptance: [{ text: 'fixture suffix' }] });
    h.store.saveSnapshot();
    healthy(h);
    put(path.join(base, 'fixture.json'), { data, workspace, id: h.id, dir: h.meta.dir });
    put(path.join(base, 'expected.json'), { rev: h.rev, tasks: 2, docs: 1 });
    console.log(JSON.stringify({ seeded: h.id, rev: h.rev, hash: h.lastHash }));
  } finally { await svc.close(); }
}

function checkRetained(h, expected, after = false) {
  assert.equal(h.rev, expected.rev + (after ? 1 : 0));
  const tasks = Object.values(h.state.tasks);
  assert.equal(tasks.length, expected.tasks + (after ? 1 : 0));
  assert.ok(tasks.some((t) => t.title === 'Kept task'));
  assert.equal(Object.keys(h.state.docs).length, expected.docs);
  for (const doc of Object.values(h.state.docs)) assert.equal(h.store.readBlob(doc.hash), 'synthetic retained body');
  if (after) assert.ok(tasks.some((t) => t.title === 'After recovery ' + name));
  healthy(h);
}

async function continuation(f, h) {
  const expected = json(path.join(f.base, 'expected.json'));
  checkRetained(h, expected);
  await commit(h, 'task.create', { title: 'After recovery ' + name, acceptance: [{ text: 'continued delivery' }] });
  checkRetained(h, expected, true);
}

async function orphan(f, h) {
  const doc = Object.values(h.state.docs)[0];
  const before = fs.readFileSync(path.join(f.dir, 'commits.jsonl'));
  const body = 'uncommitted synthetic orphan';
  await assert.rejects(h.command(envelope('doc.put', { docId: doc.id, baseRev: 0, title: 'Rejected', body })), { code: 'stale-revision' });
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'commits.jsonl')), before);
  const hash = sha256(body);
  assert.equal(fs.readFileSync(path.join(f.dir, 'blobs', hash), 'utf8'), body);
  const publicDocs = h.query('docs').docs;
  const references = before.toString('utf8').trim().split('\n').map(JSON.parse)
    .flatMap((c) => c.events).filter((event) => /^doc\//.test(event.type)).map((event) => event.data.hash);
  assert.equal(publicDocs.some((d) => d.hash === hash), false);
  assert.equal(references.includes(hash), false);
  put(path.join(f.base, 'orphan.json'), { hash, reason: 'stale-revision before commit', public: false, retained: true, references });
  console.log(JSON.stringify({ orphan: hash, publicDocs, references, logSha256: digest(before) }));
}

async function chainBegin(f, h) {
  await h.attach({ sessionId: actor.sessionId, agentId: actor.agentId });
  await commit(h, 'plan.publish', { title: 'Recovery delivery', goal: 'continue across cold restart', steps: [
    { title: 'Deliver', tasks: [{ key: 'deliver', title: 'Deliver artifact', requiresAudit: true,
      acceptance: [{ text: 'artifact retained', requiredKinds: ['file'] }] }] },
  ] });
  const task = Object.values(h.state.tasks).find((t) => t.title === 'Deliver artifact');
  assert.equal(task.requiresAudit, true);
  assert.ok(task.labels.includes('gate:audit'));
  await commit(h, 'task.claim', taskPayload(h, task.id));
  const begin = await commit(h, 'task.begin', { ...taskPayload(h, task.id), summary: 'write synthetic artifact after restart',
    plannedSteps: ['restart', 'reconcile', 'write artifact', 'submit'], expectedArtifacts: ['artifact.txt'] });
  put(path.join(f.base, 'chain.json'), { taskId: task.id, begin, beforeRestartRev: h.rev, beforeRestartHash: h.lastHash });
}

async function chainFinish(f, h) {
  const state = json(path.join(f.base, 'chain.json'));
  const taskId = state.taskId;
  assert.equal(h.state.tasks[taskId].state, 'interrupted');
  assert.equal(h.state.tasks[taskId].requiresAudit, true, 'audit gate survives cold restart');
  assert.ok(h.state.tasks[taskId].labels.includes('gate:audit'));
  const before = h.rev;
  const replay = await h.command(state.begin);
  assert.equal(replay.deduped, true, 'cmdId retained across cold restart');
  assert.equal(h.rev, before, 'deduplication must not append another commit');
  await h.attach({ sessionId: actor.sessionId, agentId: actor.agentId });
  await commit(h, 'task.reconcile', { ...taskPayload(h, taskId), choice: 'resume', note: 'checked fixture side effects; redo safely' });
  fs.writeFileSync(inside(path.join(h.workspacePath, 'artifact.txt')), 'synthetic delivered artifact\n', { flag: 'wx' });
  await commit(h, 'task.submit', { ...taskPayload(h, taskId), evidence: [{ kind: 'file', ref: 'artifact.txt',
    acceptanceId: h.state.tasks[taskId].acceptance[0].id }] });
  assert.equal(h.state.tasks[taskId].state, 'review');
  await commit(h, 'task.verify', { ...taskPayload(h, taskId), actor: human });
  assert.equal(h.state.tasks[taskId].state, 'done');
  const commits = fs.readFileSync(path.join(f.dir, 'commits.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  validateCommits(commits);
  assert.equal(commits.at(-1).seq, h.rev);
  assert.equal(commits.at(-1).hash, h.lastHash);
  put(path.join(f.base, 'chain-final.json'), { taskId, rev: h.rev, hash: h.lastHash, cmdIdDeduped: true,
    artifactSha256: digest(fs.readFileSync(path.join(h.workspacePath, 'artifact.txt'))) });
  healthy(h);
}

async function operate() {
  if (action === 'seed') return seed();
  const f = fixture(name);
  const svc = new ProjectService({ rootDir: f.data, privilegedInlineWrites: true });
  await svc.init();
  try {
    if (action === 'fail-open' || action === 'missing-meta') {
      await assert.rejects(svc.open(f.id), { code: action === 'fail-open' ? 'hash-chain-broken' : 'not-found' });
      console.log(JSON.stringify({ expectedRefusal: action }));
      return;
    }
    const h = action === 'discover' ? await svc.openByWorkspace(path.join(f.base, 'relocated')) : await svc.open(f.id);
    assert.ok(h);
    if (action === 'hold') {
      console.log(JSON.stringify({ ready: true, pid: process.pid }));
      process.stdin.resume();
      await once(process.stdin, 'data');
      // Intentional natural child exit without close: leave only our own known lock.
      process.exit(0);
    } else if (action === 'live-refusal') {
      const before = fs.readFileSync(path.join(f.dir, 'commits.jsonl'));
      assert.equal(h.readOnly, true);
      await assert.rejects(h.command(envelope('task.create', { title: 'MUST NOT COMMIT' })), { code: 'read-only' });
      assert.deepEqual(fs.readFileSync(path.join(f.dir, 'commits.jsonl')), before);
    } else if (action === 'continue' || action === 'discover') {
      if (action === 'discover') {
        assert.equal(h.id, f.id);
        assert.equal(h.workspacePath.toLowerCase(), path.join(f.base, 'relocated').toLowerCase());
        assert.equal(json(path.join(f.dir, 'meta.json')).project.workspacePath, h.workspacePath);
      }
      await continuation(f, h);
    } else if (action === 'verify') {
      checkRetained(h, json(path.join(f.base, 'expected.json')), true);
      if (fs.existsSync(path.join(f.base, 'orphan.json'))) {
        const orphan = json(path.join(f.base, 'orphan.json'));
        assert.ok(fs.existsSync(path.join(f.dir, 'blobs', orphan.hash)));
        assert.equal(Object.values(h.state.docs).some((d) => d.hash === orphan.hash), false);
      }
    } else if (action === 'orphan') await orphan(f, h);
    else if (action === 'relocate') {
      fs.mkdirSync(path.join(f.base, 'relocated'));
      await commit(h, 'project.relocate', { actor: human, workspacePath: path.join(f.base, 'relocated') });
      const expected = json(path.join(f.base, 'expected.json'));
      put(path.join(f.base, 'expected.json'), { ...expected, rev: h.rev });
    } else if (action === 'chain-begin') await chainBegin(f, h);
    else if (action === 'chain-finish') await chainFinish(f, h);
    else if (action === 'chain-verify') {
      const final = json(path.join(f.base, 'chain-final.json'));
      assert.equal(h.state.tasks[final.taskId].state, 'done');
      assert.equal(h.rev, final.rev);
      assert.equal(h.lastHash, final.hash);
      assert.equal(digest(fs.readFileSync(path.join(h.workspacePath, 'artifact.txt'))), final.artifactSha256);
      healthy(h);
    } else throw new Error('unknown internal action: ' + action);
    console.log(JSON.stringify({ action, rev: h.rev, hash: h.lastHash, readOnly: h.readOnly, health: h.health() }));
  } finally { await svc.close(); }
}
await operate();
