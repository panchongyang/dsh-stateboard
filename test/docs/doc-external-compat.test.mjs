/**
 * 测试职责：维护外置文档事件、旧读者拒绝策略和快照投影的兼容边界。
 * 典型流程：构造新旧注册表与日志/快照 → 冷重放或严格前缀扫描 → 对照文档投影与拒绝原因。
 * 覆盖边界：覆盖 外置/内嵌历史结构、迁移映射与 Git 观测状态；不覆盖真实仓库业务数据迁移。
 * 外部前置：需要 Git 的观测用例在缺少 Git 时跳过；其余使用临时目录。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EVENT_REGISTRY } from '../../lib/shared/events.js';
import { assertEventSupported, emptyState } from '../../lib/core/model.js';
import { JsonlStore, makeCommit, MemoryStore } from '../../lib/core/store.js';
import { commitHash, validateCommit } from '../../lib/core/store/format.js';
import { scanPrefix } from '../../lib/core/repair.js';
import { checkState } from '../../lib/core/fsck.js';
import { ProjectService } from '../../lib/core/service.js';
import { EXTERNAL_EVENTS } from '../../lib/core/documents/external-model.js';
import { inspectExternalDoc } from '../../lib/core/documents/external-observe.js';

const tmp = (prefix) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')));
const agent = (op, extra = {}) => ({ cmdId: 'cmd_' + crypto.randomUUID(), actor: { kind: 'agent', sessionId: 's1' }, op, ...extra });
const actor = { kind: 'agent', sessionId: 's1' };
const meta = { schemaVersion: 3, project: { schemaVersion: 3, id: 'prj_compat', name: 'c', phase: 'active', workspacePath: 'x', rev: 0 } };
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

// What every reader before this change knew: the registry without external events.
const OLD_REGISTRY = Object.fromEntries(Object.entries(EVENT_REGISTRY).filter(([type]) => !type.startsWith('doc/external-')));

function record(overrides = {}) {
  return {
    id: 'doc_ext1', source: 'external', rev: 1, title: 'Spec', kind: 'spec', status: 'draft',
    locator: { bindingId: 'bnd_x', relPath: 'docs/spec.md' }, links: { taskIds: [], planRefs: [] },
    baseline: null, baselineInContext: false, unregistered: null, createdAt: 'a', updatedAt: 'a', ...overrides,
  };
}

function inlineRecord(overrides = {}) {
  return {
    id: 'doc_old', rev: 1, title: 'Inline', kind: 'note', hash: sha('body'), size: 4,
    links: { taskIds: [], planRefs: [] }, ...overrides,
  };
}

function chain(eventLists) {
  const commits = [];
  let prev = 'genesis';
  eventLists.forEach((events, i) => {
    const commit = makeCommit(i + 1, prev, actor, 'cmd_' + (i + 1), i, events);
    commits.push(commit);
    prev = commit.hash;
  });
  return commits;
}

const created = { type: 'project/created', data: meta.project };
const open = (commits) => new MemoryStore(meta, structuredClone(commits)).open();
const registered = (data = record()) => ({ type: 'doc/external-registered', docId: data.id, rev: data.rev, data });

async function realLog() {
  const board = tmp('pbx-compat-board');
  const ws = tmp('pbx-compat-ws');
  fs.mkdirSync(path.join(ws, 'docs'));
  fs.writeFileSync(path.join(ws, 'docs/spec.md'), '# spec\n');
  const svc = new ProjectService({ rootDir: board, privilegedInlineWrites: true });
  await svc.init();
  const h = await svc.createProject({ workspacePath: ws });
  await h.command(agent('doc.put', { title: 'inline', body: 'old body' }));
  const reg = await h.command(agent('doc.external.register', { title: 'Spec', relPath: 'docs/spec.md' }));
  await h.command(agent('doc.external.update_meta', { docId: reg.docId, expectedMetaRev: 1, status: 'in_review' }));
  await h.command(agent('doc.external.confirm', { docId: reg.docId, expectedMetaRev: 2, expectedContentHash: sha('# spec\n') }));
  const dir = h.meta.dir;
  const projectMeta = { project: h.state.project };
  const state = structuredClone(h.state);
  await svc.close();
  return { dir, meta: projectMeta, docId: reg.docId, state, file: path.join(dir, 'commits.jsonl') };
}

// 责任：外置、固定内容和迁移事件须在注册表标为 applied，而非被静默忽略。
test('external, fixed content and strict migration events are applied', () => {
  for (const type of EXTERNAL_EVENTS) assert.equal(EVENT_REGISTRY[type], 'applied', type);
  assert.equal(EVENT_REGISTRY['doc/content-fixed'], 'applied');
  assert.equal(EVENT_REGISTRY['doc/external-migrated'], 'applied');
  assert.equal(EXTERNAL_EVENTS.includes('doc/external-migrated'), true);
  assert.equal(EVENT_REGISTRY['doc/created'], 'applied');
});

// 责任：删去外置事件的旧注册表重放或严格校验时，必须在未知事件处拒绝。
test('an old reader refuses every external event, in replay and in strict prefix validation', () => {
  const state = emptyState(meta.project);
  for (const type of EXTERNAL_EVENTS) {
    assert.throws(() => assertEventSupported(state, { type }, { seq: 4 }, OLD_REGISTRY), (e) => e.code === 'incompatible-event' && e.details.type === type);
    const commit = makeCommit(1, 'genesis', actor, 'c', 0, [{ type, data: {} }]);
    assert.throws(() => validateCommit(commit, { line: 1, validSeq: 0, validHash: 'genesis' }, { strictEvents: true, registry: OLD_REGISTRY }), (e) => e.details.reason === 'unknown-event');
    assert.doesNotThrow(() => validateCommit(commit, { line: 1, validSeq: 0, validHash: 'genesis' }, { strictEvents: true }));
  }
});

// 责任：当前版本写出的日志须冷开还原文档，旧读者必须停在首个外置提交。
test('a log written by this build opens here, and an old reader stops at the first external commit', async () => {
  const log = await realLog();
  const store = new JsonlStore(log.dir, log.meta);
  const data = store.open();
  store.close();
  assert.deepEqual(data.state.docs, log.state.docs, 'cold replay equals the writer state');

  const commits = fs.readFileSync(log.file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const firstExternal = commits.findIndex((c) => c.events.some((e) => e.type.startsWith('doc/external-')));
  assert.ok(firstExternal > 0);
  const old = scanPrefix(log.file, { registry: OLD_REGISTRY });
  assert.equal(old.lines.length, firstExternal, 'salvage prefix excludes the external commit and everything after it');
  assert.equal(old.diagnostic.details.reason, 'unknown-event');
  const current = scanPrefix(log.file);
  assert.equal(current.lines.length, commits.length);
  assert.equal(current.diagnostic, null);
  for (const commit of commits.slice(firstExternal)) {
    const external = commit.events.find((e) => e.type.startsWith('doc/external-'));
    if (external) assert.throws(() => assertEventSupported(data.state, external, commit, OLD_REGISTRY), { code: 'incompatible-event' });
  }
});

// 责任：即使快照覆盖外置事件仍须校验类型，畸形快照文档行不得打开。
test('snapshots: covered external events are still type-checked and malformed snapshot rows refuse to open', async () => {
  const log = await realLog();
  const commits = fs.readFileSync(log.file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const last = commits.at(-1);
  const snapshotFile = path.join(log.dir, 'snapshot.json');
  fs.writeFileSync(snapshotFile, JSON.stringify({ v: 1, seq: last.seq, hash: last.hash, state: log.state }));
  const opened = new JsonlStore(log.dir, log.meta);
  assert.deepEqual(opened.open().state.docs, log.state.docs, 'snapshot open equals full replay at the same seq');
  opened.close();

  const broken = structuredClone(log.state);
  delete broken.docs[log.docId].locator;
  fs.writeFileSync(snapshotFile, JSON.stringify({ v: 1, seq: last.seq, hash: last.hash, state: broken }));
  assert.throws(() => new JsonlStore(log.dir, log.meta).open(), { code: 'invalid-external-doc' });

  const foreign = structuredClone(commits);
  foreign.at(-1).events.at(-1).type = 'doc/external-from-the-future';
  foreign.at(-1).hash = commitHash(foreign.at(-1));
  fs.writeFileSync(log.file, foreign.map((c) => JSON.stringify(c)).join('\n') + '\n');
  fs.writeFileSync(snapshotFile, JSON.stringify({ v: 1, seq: last.seq, hash: foreign.at(-1).hash, state: log.state }));
  assert.throws(() => new JsonlStore(log.dir, log.meta).open(), (e) => e.code === 'incompatible-event' && e.details.type === 'doc/external-from-the-future');
});

// 责任：有效快照不得掩盖其覆盖日志中的畸形外置事件。
test('a valid snapshot cannot hide a malformed external event in the commits it covers', () => {
  const inlineOver = { id: 'doc_ext1', rev: 2, title: 't', kind: 'note', hash: sha('x'), size: 1, links: { taskIds: [], planRefs: [] } };
  const variants = [
    [[created], [registered(record({ locator: undefined }))]],
    [[created], [registered()], [{ type: 'doc/updated', data: inlineOver }]],
    [[created], [{ type: 'doc/created', data: record() }]],
  ];
  const good = open(chain([[created], [registered()]])).state;
  for (const lists of variants) {
    const dir = tmp('pbx-snap-cover');
    const bad = chain(lists);
    const file = path.join(dir, 'commits.jsonl');
    fs.writeFileSync(file, bad.map((c) => JSON.stringify(c)).join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify({ v: 1, seq: bad.at(-1).seq, hash: bad.at(-1).hash, state: good }));
    const before = fs.readFileSync(file, 'utf8');
    for (const lock of [true, false]) {
      assert.throws(() => new JsonlStore(dir, meta, { lock }).open(), { code: 'invalid-external-doc' });
    }
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'a refused open leaves the log untouched');
  }
});

// 责任：内嵌事件缺失合法 body 身份或夹带外置字段时必须拒绝。
test('inline events require a valid legacy body identity and reject external-only fields', () => {
  const disguised = record();
  delete disguised.source;
  const invalid = [
    disguised,
    { ...disguised, hash: sha('body'), size: 4 },
    inlineRecord({ hash: undefined }),
    inlineRecord({ hash: 'not-a-hash' }),
    inlineRecord({ size: undefined }),
    inlineRecord({ size: -1 }),
    inlineRecord({ size: 1.5 }),
    inlineRecord({ id: '' }),
    inlineRecord({ rev: 0 }),
    inlineRecord({ title: '' }),
    inlineRecord({ kind: 'unknown' }),
    inlineRecord({ links: { taskIds: [], planRefs: null } }),
    ...['locator', 'bindingId', 'relPath', 'baseline', 'baselineInContext', 'status', 'unregistered']
      .map((field) => inlineRecord({ [field]: null })),
  ];
  for (const source of [undefined, 'inline']) {
    for (const row of invalid) {
      const data = { ...row, ...(source === undefined ? {} : { source }) };
      const prefix = [[created], [{ type: 'doc/created', data: inlineRecord() }]];
      for (const type of ['doc/created', 'doc/updated']) {
        const lists = type === 'doc/created' ? [[created], [{ type, data }]] : [...prefix, [{ type, data }]];
        const commits = chain(lists);
        assert.throws(() => open(commits), { code: 'invalid-external-doc' });
        const dir = tmp('pbx-inline-invalid');
        const file = path.join(dir, 'commits.jsonl');
        const bytes = commits.map((c) => JSON.stringify(c)).join('\n'); // no LF: refusal must precede framing repair
        fs.writeFileSync(file, bytes);
        for (const lock of [false, true]) {
          assert.throws(() => new JsonlStore(dir, meta, { lock }).open(), { code: 'invalid-external-doc' });
        }
        assert.equal(fs.readFileSync(file, 'utf8'), bytes);
      }
    }
  }
});

// 责任：快照删掉外置 source 伪装成内嵌记录时，结构校验必须识别并拒绝。
test('snapshot rows cannot disguise external records as source-less inline documents', () => {
  const commits = chain([[created], [registered()]]);
  const snapshot = open(commits).state;
  delete snapshot.docs.doc_ext1.source;
  const dir = tmp('pbx-inline-snapshot');
  fs.writeFileSync(path.join(dir, 'commits.jsonl'), commits.map((c) => JSON.stringify(c)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify({ v: 1, seq: 2, hash: commits[1].hash, state: snapshot }));
  assert.throws(() => new JsonlStore(dir, meta, { lock: false }).open(), { code: 'invalid-external-doc' });
});

// 责任：改写快照文档投影后，即使 seq/hash 锚点正确也不得接受。
test('snapshot document projection must match the log at its own seq/hash', () => {
  const commits = chain([[created], [registered()]]);
  const good = open(commits).state;
  const variants = [
    { ...good.docs, doc_ext1: inlineRecord({ id: 'doc_ext1', source: 'inline' }) },
    { ...good.docs, doc_ext1: record({ title: 'invented title' }) },
    { ...good.docs, doc_ext1: record({ locator: { bindingId: 'bnd_else', relPath: 'else.md' } }) },
    {},
    { ...good.docs, doc_extra: inlineRecord({ id: 'doc_extra' }) },
    { doc_alias: record() },
  ];
  for (const docs of variants) {
    const dir = tmp('pbx-snapshot-projection');
    const file = path.join(dir, 'commits.jsonl');
    const bytes = commits.map((c) => JSON.stringify(c)).join('\n');
    fs.writeFileSync(file, bytes);
    const snapshotFile = path.join(dir, 'snapshot.json');
    const snapshotBytes = JSON.stringify({ v: 1, seq: 2, hash: commits[1].hash, state: { ...good, docs } });
    fs.writeFileSync(snapshotFile, snapshotBytes);
    for (const lock of [false, true]) {
      assert.throws(() => new JsonlStore(dir, meta, { lock }).open(), (e) => e.code === 'invalid-external-doc' && e.details.origin === 'snapshot');
    }
    assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'a mismatch must not normalize the log');
    assert.equal(fs.readFileSync(snapshotFile, 'utf8'), snapshotBytes, 'a mismatch must not rewrite the snapshot');
  }
});

// 责任：快照投影须在自身锚点比较，不能拿更新尾部重放后的文档误判。
test('a matching document snapshot is compared at its anchor, before replaying a newer tail', () => {
  for (const source of [undefined, 'inline', 'external']) {
    const first = source === 'external' ? record() : inlineRecord(source === undefined ? {} : { source });
    const event = source === 'external' ? registered(first) : { type: 'doc/created', data: first };
    const prefix = chain([[created], [event]]);
    const state = open(prefix).state;
    const updated = { ...first, rev: 2, title: 'tail title' };
    const commits = chain([[created], [event], [{ type: source === 'external' ? 'doc/external-updated' : 'doc/updated', data: updated }]]);
    const dir = tmp('pbx-snapshot-anchor');
    fs.writeFileSync(path.join(dir, 'commits.jsonl'), commits.map((c) => JSON.stringify(c)).join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify({ v: 1, seq: 2, hash: commits[1].hash, state }));
    const store = new JsonlStore(dir, meta, { lock: false });
    try {
      assert.deepEqual(store.open().state.docs, open(commits).state.docs);
    } finally {
      store.close();
    }
  }
});

// 责任：genesis 快照凭空添加尚无日志事件的文档时必须拒绝。
test('a genesis snapshot cannot invent a document before the first log event', () => {
  const commits = chain([[created], [registered()]]);
  const state = emptyState(meta.project);
  state.docs.doc_ext1 = record();
  const dir = tmp('pbx-snapshot-genesis');
  fs.writeFileSync(path.join(dir, 'commits.jsonl'), commits.map((c) => JSON.stringify(c)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify({ v: 1, seq: 0, hash: 'genesis', state }));
  assert.throws(() => new JsonlStore(dir, meta, { lock: false }).open(), { code: 'invalid-external-doc' });
});

// 责任：迁移缺严格映射须拒绝，迁移前注册表也不得读取迁移事件。
test('migration requires strict mapping; a pre-D6 reader still refuses it as incompatible', () => {
  const migrated = { type: 'doc/external-migrated', docId: 'doc_ext1', rev: 1, data: record() };
  const preD6 = { ...EVENT_REGISTRY };
  delete preD6['doc/external-migrated'];
  assert.throws(() => open(chain([[created], [migrated]])), { code: 'invalid-external-doc' });
  assert.throws(() => open(chain([[created], [registered()], [{ ...migrated, rev: 2, data: record({ rev: 2 }) }]])), { code: 'invalid-external-doc' });
  assert.throws(() => assertEventSupported(emptyState(meta.project), migrated, { seq: 2 }, preD6), (e) => e.code === 'incompatible-event' && e.details.type === 'doc/external-migrated');
  const dir = tmp('pbx-migrated');
  const file = path.join(dir, 'commits.jsonl');
  fs.writeFileSync(file, chain([[created], [migrated]]).map((c) => JSON.stringify(c)).join('\n') + '\n');
  assert.throws(() => new JsonlStore(dir, meta, { lock: false }).open(), { code: 'invalid-external-doc' });
  assert.equal(scanPrefix(file, { registry: preD6 }).lines.length, 1, 'old salvage prefix stops before the migrated commit');
});

// 责任：畸形外置结构必须中止重放，不能跳过或按内嵌记录读取。
test('replay refuses malformed external structure instead of skipping or reading it as inline', () => {
  const bad = [
    record({ locator: undefined }),
    record({ locator: { bindingId: '', relPath: 'a.md' } }),
    record({ locator: { bindingId: 'b', relPath: '../a.md' } }),
    record({ locator: { bindingId: 'b', relPath: 'a.md', root: 'C:/x' } }),
    record({ bindingId: 'dup' }),
    record({ status: 'published' }),
    record({ hash: sha('x') }),
    record({ baseline: { domain: 'git-blob', contentHash: sha('x') } }),
    record({ baselineInContext: undefined }),
    record({ baselineInContext: true }),
  ];
  for (const data of bad) assert.throws(() => open(chain([[created], [registered(data)]])), { code: 'invalid-external-doc' });

  const ok = record();
  assert.equal(open(chain([[created], [registered(ok)]])).state.docs.doc_ext1.source, 'external');
  const skipped = { ...ok, rev: 3 };
  assert.throws(() => open(chain([[created], [registered(ok)], [{ type: 'doc/external-updated', docId: ok.id, rev: 3, data: skipped }]])), { code: 'invalid-external-doc' });
  assert.throws(() => open(chain([[created], [{ type: 'doc/external-updated', docId: ok.id, rev: 2, data: { ...ok, rev: 2 } }]])), { code: 'invalid-external-doc' });
  assert.throws(() => open(chain([[created], [registered(ok)], [registered(ok)]])), { code: 'invalid-external-doc' });
  assert.throws(() => open(chain([[created], [{ type: 'doc/created', data: { ...ok } }]])), { code: 'invalid-external-doc' });
  const inlineOver = { id: ok.id, rev: 2, title: 't', kind: 'note', hash: sha('x'), size: 1, links: { taskIds: [], planRefs: [] } };
  assert.throws(() => open(chain([[created], [registered(ok)], [{ type: 'doc/updated', data: inlineOver }]])), { code: 'invalid-external-doc' });
});

// 责任：无 source 的旧内嵌行仍可读，fsck 须区分结构错误与文件暂不可用。
test('legacy inline rows without source keep loading and fsck separates external structure from availability', () => {
  const inline = { id: 'doc_old', rev: 1, title: 'old', kind: 'note', hash: sha('body'), size: 4, links: { taskIds: [], planRefs: [] } };
  const state = open(chain([[created], [{ type: 'doc/created', data: inline }], [registered()]])).state;
  assert.equal(state.docs.doc_old.source, undefined);
  const checked = checkState(state);
  const docChecks = checked.checks.filter((c) => c.name.startsWith('doc-'));
  assert.ok(docChecks.some((c) => c.name === 'doc-external:doc_ext1' && c.ok));
  assert.ok(docChecks.every((c) => c.ok), JSON.stringify(docChecks));
  assert.equal(checked.checks.some((c) => c.name === 'doc-hash:doc_ext1'), false, 'external rows are not checked for a body hash');
});

// 责任：在临时 Git 仓库改变文件状态后，观测须区分未跟踪、已提交、修改、忽略及非仓库。
test('git observation distinguishes untracked, committed, modified, ignored and not_a_repo', async (t) => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch {
    t.skip('git is not installed');
    return;
  }
  const board = tmp('pbx-git-board');
  const ws = tmp('pbx-git-ws');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: ws, stdio: 'pipe' });
  fs.mkdirSync(path.join(ws, 'docs'));
  fs.writeFileSync(path.join(ws, 'docs/a.md'), 'a\n');
  fs.writeFileSync(path.join(ws, 'docs/b.md'), 'b\n');
  fs.writeFileSync(path.join(ws, 'docs/c.log.md'), 'c\n');
  fs.writeFileSync(path.join(ws, '.gitignore'), '*.log.md\n');
  const svc = new ProjectService({ rootDir: board, privilegedInlineWrites: true });
  await svc.init();
  const h = await svc.createProject({ workspacePath: ws });
  const reg = async (relPath) => (await h.command(agent('doc.external.register', { title: relPath, relPath }))).docId;
  const a = await reg('docs/a.md');
  const b = await reg('docs/b.md');
  const c = await reg('docs/c.log.md');
  assert.equal(inspectExternalDoc(h, a).git.state, 'not_a_repo');

  git('init', '-q');
  git('add', 'docs/a.md', '.gitignore');
  git('commit', '-q', '-m', 'init');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ws, encoding: 'utf8' }).trim();
  const state = (docId) => inspectExternalDoc(h, docId, { fresh: true }).git;
  assert.equal(state(a).state, 'committed');
  assert.equal(state(b).state, 'untracked');
  assert.equal(state(c).state, 'ignored');
  fs.appendFileSync(path.join(ws, 'docs/a.md'), 'more\n');
  assert.deepEqual(state(a), { state: 'modified', staged: false, unstaged: true });
  git('add', 'docs/a.md');
  assert.equal(state(a).staged, true);

  const hash = sha(fs.readFileSync(path.join(ws, 'docs/a.md')));
  await h.command(agent('doc.external.confirm', { docId: a, expectedMetaRev: 1, expectedContentHash: hash }));
  assert.equal(h.state.docs[a].baseline.gitHeadOid, head);
  await svc.close();
});

// 责任：不同历史链接形状的内嵌事件都须兼容打开，不得因新外置校验而拒绝。
test('legacy inline links keep every historical shape opening', () => {
  // Real stores predate planRefs: rows carry {taskIds} only. Rejecting that
  // shape would make existing projects unopenable, so only present fields are checked.
  const shapes = [
    { taskIds: ['tsk_1'] },
    { taskIds: [] },
    { taskIds: ['tsk_1'], planRefs: [{ planId: 'pln_1', version: 2 }] },
    { planRefs: [] },
    {},
  ];
  for (const links of shapes) {
    const doc = inlineRecord({ links });
    const commits = chain([[created], [{ type: 'doc/created', docId: doc.id, rev: 1, data: doc }]]);
    assert.equal(open(commits).state.docs.doc_old.id, 'doc_old', JSON.stringify(links));
  }
  for (const links of [null, 'x', { taskIds: 'tsk' }, { planRefs: [{ planId: 'pln_1' }] }]) {
    const doc = inlineRecord({ links });
    const commits = chain([[created], [{ type: 'doc/created', docId: doc.id, rev: 1, data: doc }]]);
    assert.throws(() => open(commits), (error) => error.code === 'invalid-external-doc', JSON.stringify(links));
  }
});
