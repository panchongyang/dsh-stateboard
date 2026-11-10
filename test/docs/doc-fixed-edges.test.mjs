/**
 * 测试职责：限制历史固定证据、快照及 Git 内容读取的真实性边界。
 * 典型流程：创建固定记录 → 篡改屏障/快照或暂移 blob → 重放、审计和预览 → 对照错误与副作用。
 * 覆盖边界：覆盖 固定屏障、缺对象、CRLF、属性和预览规则；不覆盖远程对象修复或下载。
 * 外部前置：需要 Git；全部仓库与对象故障位于临时目录。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ProjectService } from '../../lib/core/service.js';
import { JsonlStore, makeCommit, MemoryStore } from '../../lib/core/store.js';
import { applyEvent } from '../../lib/core/model.js';
import { assertFixedCommit, contentFixedEvents } from '../../lib/core/documents/fixed-reference.js';
import { auditEvidence, normalizeEvidence } from '../../lib/core/evidence.js';
import { getFixedContent } from '../../lib/core/documents/fixed-content.js';
import { repositoryAt } from '../../lib/core/documents/fixed-git.js';
import { assertCleanPath } from '../../lib/core/documents/fixed-worktree.js';
import { bootstrapPin, command, git, put, repository, temp } from '../helpers/fixed-fixture.mjs';

async function setup() {
  const { root, oid } = repository();
  const board = temp();
  const svc = new ProjectService({ rootDir: board, privilegedInlineWrites: true });
  await svc.init();
  const h = await svc.createProject({ workspacePath: root });
  const out = await h.command(command('doc.external.register', { title: '边界', relPath: 'docs/spec.md' }));
  await bootstrapPin(h, out.docId);
  const view = getFixedContent(h, { docId: out.docId, commitOid: oid, pathAtCommit: 'docs/spec.md' });
  // Historical explicit-entry row shape: logs written before the auto shell
  // still carry exactly this data and must stay readable.
  const row = { id: 'ev_legacy', taskId: 'tsk_edge', kind: 'doc', ref: out.docId, hash: view.fixed.blobContentHash, fixed: view.fixed, verifiedAt: '2025-01-01T00:00:00.000Z' };
  return { root, oid, svc, h, docId: out.docId, row, board };
}

// 责任：预登记内容不能替代首条任务证据同提交屏障，缺失或身份不匹配必须拒绝。
test('pre-registering fixed content does not replace the first task evidence atomic barrier', async () => {
  const s = await setup();
  const event = contentFixedEvents([s.row])[0];
  const before = s.h.rev;
  s.h._appendEvents([event], { kind: 'human' }, 'cmd_fixed_only', before);
  const taskEvent = { type: 'task/updated', data: { id: 'tsk_new', evidence: [s.row] } };
  assert.throws(() => assertFixedCommit(s.h.state, { events: [taskEvent] }), { code: 'invalid-fixed-reference' });
  assert.throws(() => applyEvent(s.h.state, taskEvent), { code: 'invalid-fixed-reference' });
  assert.doesNotThrow(() => assertFixedCommit(s.h.state, { events: [event, taskEvent] }));
  const wrong = structuredClone(event);
  wrong.data.fixed.pathAtCommit = 'docs/other.md';
  assert.throws(() => assertFixedCommit(s.h.state, { events: [wrong, taskEvent] }), { code: 'invalid-fixed-reference' });
  const commits = fs.readFileSync(s.h.store.commitsFile, 'utf8').trim().split('\n').map(JSON.parse);
  const memory = new MemoryStore({ project: s.h.meta.project }, structuredClone(commits));
  memory.open();
  const commit = makeCommit(before + 2, commits.at(-1).hash, { kind: 'human' }, 'cmd_new_task', before + 1, [taskEvent]);
  assert.throws(() => memory.append(commit), { code: 'invalid-fixed-reference' });
  await s.svc.close();
});

// 责任：旧内嵌 fixed 行须可重放审计，但新增同类证据缺原子屏障仍须拒绝。
test('a historical inline fixed row replays and audits but still needs its same-commit barrier', async () => {
  const s = await setup();
  const put = await s.h.command(command('doc.put', { title: '历史内嵌', body: 'inline legacy body' }));
  const inlineId = put.events[0].data.id;
  const row = { id: 'ev_inline_legacy', taskId: 'tsk_inline_legacy', kind: 'doc', ref: inlineId, hash: s.row.hash, fixed: s.row.fixed, verifiedAt: '2025-01-01T00:00:00.000Z' };
  const event = { type: 'task/updated', data: { id: 'tsk_inline_legacy', requiresAudit: false, evidence: [row] } };
  s.h._appendEvents([contentFixedEvents([row])[0], event], { kind: 'human' }, 'cmd_inline_legacy', s.h.rev);
  assert.deepEqual(auditEvidence(s.h, s.h.state.tasks.tsk_inline_legacy), []);
  s.h.store.saveSnapshot();
  const projectId = s.h.id;
  await s.svc.close();

  const svc = new ProjectService({ rootDir: s.board, privilegedInlineWrites: true });
  await svc.init();
  const h = await svc.open(projectId);
  assert.deepEqual(h.state.tasks.tsk_inline_legacy.evidence[0], row);
  assert.deepEqual(auditEvidence(h, h.state.tasks.tsk_inline_legacy), []);
  const last = h.store.commits.at(-1);
  const broken = makeCommit(last.seq + 1, last.hash, { kind: 'human' }, 'cmd_inline_missing', last.baseRev + 1, [{
    type: 'task/updated', data: { id: 'tsk_inline_legacy', requiresAudit: false, evidence: [{ ...row, id: 'ev_inline_missing' }] },
  }]);
  const memory = new MemoryStore({ project: h.meta.project }, structuredClone(h.store.commits));
  memory.open();
  assert.throws(() => memory.append(broken), { code: 'invalid-fixed-reference' });
  await svc.close();
});

// 责任：暂移 Git blob 后须报 fixed-object-missing，不读当前文件也不从 promisor 取回对象。
test('a physically missing blob reports fixed-object-missing, never current workspace fallback', async () => {
  const s = await setup();
  const backup = temp();
  fs.cpSync(s.root, backup, { recursive: true });
  git(s.root, 'config', 'extensions.partialClone', 'origin');
  git(s.root, 'config', 'remote.origin.url', backup);
  git(s.root, 'config', 'remote.origin.promisor', 'true');
  git(s.root, 'config', 'protocol.file.allow', 'always');
  const oid = s.row.fixed.blobOid;
  const file = path.join(s.root, '.git', 'objects', oid.slice(0, 2), oid.slice(2));
  const moved = file + '.held';
  assert.ok(fs.existsSync(file));
  fs.renameSync(file, moved);
  try {
    assert.throws(() => getFixedContent(s.h, { docId: s.docId, fixed: s.row.fixed }), { code: 'fixed-object-missing', status: 404 });
    assert.equal(auditEvidence(s.h, { evidence: [s.row] })[0].code, 'fixed-object-missing');
    assert.equal(fs.existsSync(file), false, 'even a configured available promisor remote is never fetched');
  } finally {
    fs.renameSync(moved, file);
    await s.svc.close();
  }
});

// 责任：篡改快照固定索引或仓库审批不得凭空制造日志未记录的身份。
test('snapshot fixed index and repository approval cannot invent unlogged identity', async () => {
  const s = await setup();
  s.h._appendEvents(contentFixedEvents([s.row]), { kind: 'human' }, 'cmd_fixed_snapshot', s.h.rev);
  s.h.store.saveSnapshot();
  const dir = s.h.meta.dir;
  const meta = structuredClone(s.h.meta);
  await s.svc.close();
  const file = path.join(dir, 'snapshot.json');
  const original = fs.readFileSync(file, 'utf8');
  const changed = JSON.parse(original);
  changed.state.fixedContents = {};
  fs.writeFileSync(file, JSON.stringify(changed));
  assert.throws(() => new JsonlStore(dir, meta, { lock: false }).open(), { code: 'invalid-fixed-reference' });
  const changedSource = JSON.parse(original);
  changedSource.state.project.gitContentRepository.bindingIds.push('bnd_unlogged');
  fs.writeFileSync(file, JSON.stringify(changedSource));
  assert.throws(() => new JsonlStore(dir, meta, { lock: false }).open(), { code: 'invalid-fixed-reference' });
  const inventedTask = JSON.parse(original);
  inventedTask.state.tasks.tsk_invented = { id: 'tsk_invented', evidence: [s.row] };
  fs.writeFileSync(file, JSON.stringify(inventedTask));
  assert.throws(() => new JsonlStore(dir, meta, { lock: false }).open(), { code: 'invalid-fixed-reference' });
});

// 责任：切分支属性或迁移后，历史内容与历史属性仍须取对应提交而非当前分支。
test('historical content and attributes are independent of current branch attributes and relocation', async () => {
  const s = await setup();
  put(s.root, '.gitattributes', '*.md filter=untrusted\n');
  assert.equal(getFixedContent(s.h, { docId: s.docId, fixed: s.row.fixed }).body, 'version one\n');
  put(s.root, 'docs/moved.md', 'different current file\n');
  await s.h.command(command('doc.external.relocate', { docId: s.docId, expectedMetaRev: 1, relPath: 'docs/moved.md' }));
  assert.deepEqual(auditEvidence(s.h, { evidence: [s.row] }), []);
  assert.equal(s.row.fixed.pathAtCommit, 'docs/spec.md');
  await s.svc.close();
});

// 责任：仅 LF/CRLF 合法转换的干净文件须自动固定，不得误报工作区脏。
test('clean CRLF bytes pin automatically without a false dirty diagnosis', async () => {
  const s = await setup();
  git(s.root, 'config', 'core.autocrlf', 'true');
  put(s.root, 'docs/spec.md', 'version one\r\n');
  const view = getFixedContent(s.h, { docId: s.docId, fixed: s.row.fixed });
  assert.equal(view.workspaceComparison.state, 'differs_from_git_bytes');
  const row = normalizeEvidence(s.h, { id: 'tsk_crlf', acceptance: [] }, { kind: 'doc', ref: s.docId }, 'now', {});
  assert.equal(row.fixedState, 'pinned');
  assert.equal(row.hash, view.fixed.blobContentHash);
  assert.deepEqual(row.fixed, view.fixed);
  await s.svc.close();
});

// 责任：文档落在嵌套仓库时须先降级 current-only，不能继续向错误仓库查对象。
test('a nested repository degrades to current-only before any object lookup', async () => {
  const s = await setup();
  git(path.join(s.root, 'docs'), 'init');
  const row = normalizeEvidence(s.h, { id: 'tsk_nested', acceptance: [] }, {
    kind: 'doc', ref: s.docId,
  }, new Date().toISOString(), {});
  assert.equal(row.fixedState, 'current-only');
  assert.equal(row.fixedReason, 'nested-repository');
  assert.equal(Object.hasOwn(row, 'fixed'), false);
  await s.svc.close();
});

// 责任：固定预览须严格 UTF-8、去显示 BOM 并守格式及字符边界截断规则。
test('fixed previews reuse strict UTF-8, BOM, text format and truncation rules', async () => {
  const s = await setup();
  put(s.root, 'docs/bom.md', Buffer.from('\ufeff正文\n'));
  put(s.root, 'docs/bad.md', Buffer.from([0xff]));
  put(s.root, 'docs/opaque.pdf', 'not markdown\n');
  put(s.root, 'docs/large.md', '中'.repeat(100000));
  git(s.root, 'add', '.');
  git(s.root, 'commit', '-m', '测试固定预览格式');
  const commitOid = git(s.root, 'rev-parse', 'HEAD');
  const read = (pathAtCommit) => getFixedContent(s.h, { docId: s.docId, commitOid, pathAtCommit });
  assert.equal(read('docs/bom.md').body, '正文\n');
  assert.throws(() => read('docs/bad.md'), { code: 'undecodable', status: 400 });
  assert.throws(() => read('docs/opaque.pdf'), { code: 'unsupported-format', status: 400 });
  const large = read('docs/large.md');
  assert.equal(large.truncated, true);
  assert.equal(large.totalBytes, 300000);
  assert.ok(Buffer.byteLength(large.body) <= 256 * 1024);
  assert.equal(large.body.endsWith('中'), true);
  await s.svc.close();
});

function commitAttributes(root, text) {
  put(root, '.gitattributes', text);
  git(root, 'add', '.gitattributes');
  git(root, 'commit', '-m', '测试属性');
  return git(root, 'rev-parse', 'HEAD');
}

// 责任：PDF 带 astextplain 属性仍须 unsupported-format，禁止执行 textconv。
test('explicit diff=astextplain on pdf keeps unsupported-format and never runs textconv', async () => {
  const s = await setup();
  git(s.root, 'config', 'diff.astextplain.textconv', 'echo X > MARK');
  put(s.root, '.gitattributes', '*.pdf diff=astextplain\n');
  put(s.root, 'docs/opaque.pdf', 'not markdown\n');
  git(s.root, 'add', '.');
  git(s.root, 'commit', '-m', '测试 pdf 属性');
  const commitOid = git(s.root, 'rev-parse', 'HEAD');
  assert.throws(() => getFixedContent(s.h, { docId: s.docId, commitOid, pathAtCommit: 'docs/opaque.pdf' }), { code: 'unsupported-format', status: 400 });
  assert.equal(fs.existsSync(path.join(s.root, 'MARK')), false);
  await s.svc.close();
});

// 责任：markdown 配置危险 diff/textconv 时仍可只读干净字节，驱动不得执行。
test('diff=danger with textconv on markdown is readable and clean without execution', async () => {
  const s = await setup();
  const commitOid = commitAttributes(s.root, '*.md diff=danger\n');
  git(s.root, 'config', 'diff.danger.textconv', 'echo X > MARK');
  const view = getFixedContent(s.h, { docId: s.docId, commitOid, pathAtCommit: 'docs/spec.md' });
  assert.equal(view.body, 'version one\n');
  assert.equal(assertCleanPath(repositoryAt(s.root), 'docs/spec.md', commitOid).eolTransformed, false);
  assert.equal(fs.existsSync(path.join(s.root, 'MARK')), false);
  await s.svc.close();
});

// 责任：匹配 lfs 或自定义 filter 的路径须返回 422，配置的驱动不得运行。
test('filter=lfs and filter=danger are refused with 422 and never executed', async () => {
  const s = await setup();
  for (const driver of ['lfs', 'danger']) {
    const commitOid = commitAttributes(s.root, '*.md filter=' + driver + '\n');
    if (driver === 'danger') {
      git(s.root, 'config', 'filter.danger.clean', 'echo X > MARK');
      git(s.root, 'config', 'filter.danger.smudge', 'echo X > MARK');
    }
    assert.throws(() => getFixedContent(s.h, { docId: s.docId, commitOid, pathAtCommit: 'docs/spec.md' }), { code: 'unsupported-content-transform', status: 422 });
    assert.throws(() => assertCleanPath(repositoryAt(s.root), 'docs/spec.md', commitOid), { code: 'unsupported-content-transform', status: 422 });
    assert.equal(fs.existsSync(path.join(s.root, 'MARK')), false);
  }
  await s.svc.close();
});
