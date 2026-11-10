/**
 * 测试职责：约束 project_doc 工具到外置文档命令的映射及中文渲染保留的诊断信息。
 * 典型流程：合成宿主注册工具 → 执行登记/观测/管理和错误参数 → 比较响应、渲染与 store。
 * 覆盖边界：覆盖 工具白名单、版本守卫、来源标记和只改元数据；不覆盖真实宿主调度或 UI。
 * 外部前置：需要可导入的 DSH 工具 peer；文件和 store 均为临时 fixture。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../../lib/index.js';
import { ProjectService } from '../../lib/core/service.js';

// Host-tool surface for external documents (D3b): op mapping, metaRev guards,
// old-op rejection and the docs view's source marker. The core semantics are
// covered by test/docs/doc-external*.test.mjs; this file proves the adapter neither
// bypasses them nor fabricates body metadata.

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-ext-tool-state-'));
const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-ext-tool-ws-'));
const tools = new Map();
const disposers = [];
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  tools: { register(tool) { tools.set(tool.name, tool); } },
  systemPrompt: { section() { return () => {}; }, getSectionOrder() { return 9000; } },
  agents: { list() { return []; } },
  on() { return () => {}; },
  effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return () => {}; },
  get() { return undefined; },
};

const exec = { agent: { id: 'session-ext-tool', session: { header: { cwd: wsDir } } }, callId: 'call-ext-tool' };
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const rejects = (promise, code) => assert.rejects(promise, (error) => {
  assert.equal(error.code, code, error.message);
  return true;
});

function put(rel, body) {
  const file = path.join(wsDir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

/** Every blob filename already written to this store: a registration must add none. */
function blobNames(root, out = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name === 'blobs') out.push(...fs.readdirSync(full).map((name) => path.join(full, name)));
    else blobNames(full, out);
  }
  return out.sort();
}

/** Content hash of the project log(s): a rejected write must not append a commit. */
function logBytes(root, out = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) logBytes(full, out);
    else if (entry.name === 'commits.jsonl') out.push(path.relative(root, full) + ' ' + sha(fs.readFileSync(full)));
  }
  return out.sort().join('|');
}

try {
  // 分段职责：用构造特权播种旧内嵌记录，仅供读取兼容，不通过生产工具绕写屏障。
  // Legacy inline rows predate the archive-only policy; seed one through the
  // constructor-only internal path so the list/get coverage stays real.
  const seedSvc = new ProjectService({ rootDir: stateDir, privilegedInlineWrites: true });
  await seedSvc.init();
  const seedHandle = await seedSvc.createProject({ workspacePath: wsDir });
  const seeded = await seedHandle.command({
    cmdId: 'cmd_seed_' + crypto.randomUUID(), actor: { kind: 'system', via: 'system' },
    op: 'doc.put', title: 'Seeded inline', kind: 'note', body: 'seeded body',
  });
  const seededDocId = seeded.events[0].docId;
  await seedSvc.close();

  apply(ctx, { rootDir: stateDir });
  await new Promise((resolve) => setTimeout(resolve, 30));

  const planTool = tools.get('project_plan');
  const docTool = tools.get('project_doc');
  const boardTool = tools.get('project_board');
  const published = await planTool.execute({
    op: 'publish',
    title: 'External docs plan',
    steps: [{ id: 's1', title: 'one', tasks: [{ key: 't1', title: 'Link target', acceptance: [{ text: 'x' }] }] }],
  }, exec);
  const taskId = published.steps[0].tasks[0].id;

  put('docs/spec.md', '# Spec\n\nbody\n');
  put('notes.txt', 'plain\n');
  const file = path.join(wsDir, 'docs', 'spec.md');
  const blobsBefore = blobNames(stateDir);

  // 分段职责：登记只增元数据无 blob，inspect 须返回原字节哈希和缓存/fresh 区分。
  // ---- register / list / inspect -----------------------------------------
  const registered = await docTool.execute({
    op: 'register', title: 'Spec', kind: 'spec', relPath: 'docs/spec.md', links: { taskIds: [taskId] },
  }, exec);
  assert.equal(registered.ok, true);
  assert.equal(registered.schemaVersion, 1);
  const docId = registered.doc.id;
  assert.match(docId, /^doc_/);
  assert.equal(registered.doc.source, 'external');
  assert.equal(registered.doc.rev, 1);
  assert.equal(registered.doc.status, 'draft');
  assert.deepEqual(registered.doc.locator.relPath, 'docs/spec.md');
  assert.equal(registered.doc.hash, undefined, 'external rows carry no body hash');
  assert.equal(registered.doc.size, undefined, 'external rows carry no body size');
  assert.deepEqual(registered.doc.links.taskIds, [taskId]);
  assert.deepEqual(blobNames(stateDir), blobsBefore, 'register writes no body blob');

  const listed = await docTool.execute({ op: 'list_external' }, exec);
  assert.equal(listed.ok, true);
  assert.equal(listed.schemaVersion, 1);
  assert.deepEqual(listed.docs.map((doc) => doc.id), [docId]);

  const first = await docTool.execute({ op: 'inspect', docId, preview: true }, exec);
  assert.equal(first.ok, true);
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.metaRev, 1);
  assert.equal(first.availability, 'readable');
  assert.equal(first.code, null);
  assert.equal(first.observation.contentHash, sha(fs.readFileSync(file)));
  assert.equal(first.observation.size, fs.statSync(file).size);
  assert.equal(first.observation.cached, false);
  assert.equal(first.confirmation.state, 'unconfirmed');
  assert.equal(first.git.state, 'not_a_repo');
  assert.ok(first.observation.preview.text.includes('# Spec'));

  const cached = await docTool.execute({ op: 'inspect', docId }, exec);
  assert.equal(cached.observation.cached, true, 'second inspect uses the 30 s cache');
  const uncached = await docTool.execute({ op: 'inspect', docId, fresh: true }, exec);
  assert.equal(uncached.observation.cached, false, 'fresh bypasses the cache');

  // 分段职责：拼错和跨域字段须 invalid-command，日志/项目 rev/metaRev 均不变。
  // ---- strict field whitelist: a misspelled/cross-domain field is 400 and
  // ---- never reaches a command (no rev bump, no log append) ---------------
  const logBeforeFields = logBytes(stateDir);
  const revBeforeFields = (await boardTool.execute({ view: 'board' }, exec)).rev;
  const badFieldCases = [
    ['register misspelled bindingId', { op: 'register', title: 'Wrong binding', relPath: 'notes.txt', bindingID: 'bnd_nonexistent' }, 'bindingID'],
    ['register cross-domain status', { op: 'register', title: 'Wrong status', relPath: 'notes.txt', status: 'archived' }, 'status'],
    ['update_meta misspelled status', { op: 'update_meta', docId, expectedMetaRev: 1, statuss: 'archived' }, 'statuss'],
    ['relocate cross-domain hash', { op: 'relocate', docId, expectedMetaRev: 1, expectedContentHash: '0'.repeat(64) }, 'expectedContentHash'],
    ['confirm cross-domain title', { op: 'confirm', docId, expectedMetaRev: 1, expectedContentHash: '0'.repeat(64), title: 'x' }, 'title'],
    ['unregister cross-domain binding', { op: 'unregister', docId, expectedMetaRev: 1, bindingId: 'bnd_nonexistent' }, 'bindingId'],
  ];
  for (const [label, args, field] of badFieldCases) {
    const error = await docTool.execute(args, exec).then(() => null, (reason) => reason);
    assert.ok(error, label + ' must be rejected');
    assert.equal(error.code, 'invalid-command', label + ' maps to invalid-command');
    assert.ok(JSON.parse(error.message).details.fields.includes(field), label + ' names the offending field');
  }
  assert.equal((await boardTool.execute({ view: 'board' }, exec)).rev, revBeforeFields, 'rejected writes never bump the project rev');
  assert.equal(logBytes(stateDir), logBeforeFields, 'rejected writes never append to the project log');
  assert.equal((await docTool.execute({ op: 'list_external' }, exec)).docs[0].rev, 1, 'rejected writes never move metaRev');

  // 分段职责：get/put/link 指向外置记录时须要求外置操作，不能生成新 blob。
  // ---- the old inline ops refuse an external target -----------------------
  await rejects(docTool.execute({ op: 'get', docId }, exec), 'external-doc-operation-required');
  await rejects(docTool.execute({ op: 'put', docId, title: 'Hijack', body: 'x' }, exec), 'external-doc-operation-required');
  await rejects(docTool.execute({ op: 'link', docId, links: { taskIds: [] } }, exec), 'external-doc-operation-required');
  assert.deepEqual(blobNames(stateDir), blobsBefore, 'a rejected put writes no blob either');

  // 分段职责：确认须比较新鲜哈希，后续元数据/定位/注销须按版本与状态执行。
  // ---- confirm / update_meta / relocate / unregister -----------------------
  const wrongHash = '0'.repeat(64);
  const staleConfirm = await docTool.execute({ op: 'confirm', docId, expectedMetaRev: 1, expectedContentHash: wrongHash }, exec)
    .then(() => null, (error) => error);
  assert.equal(staleConfirm.code, 'stale-revision');
  assert.equal(JSON.parse(staleConfirm.message).details.currentContentHash, sha(fs.readFileSync(file)));

  const confirmed = await docTool.execute({
    op: 'confirm', docId, expectedMetaRev: 1, expectedContentHash: sha(fs.readFileSync(file)),
  }, exec);
  assert.equal(confirmed.doc.rev, 2);
  assert.equal(confirmed.doc.baseline.contentHash, sha(fs.readFileSync(file)));
  assert.equal(confirmed.doc.baselineInContext, true);
  assert.equal((await docTool.execute({ op: 'inspect', docId, fresh: true }, exec)).confirmation.state, 'matches_baseline');

  // 分段职责：工具文本须保留完整可用性、确认、Git、预览与字节诊断。
  // ---- inspect rendering carries the whole observation -------------------
  const renderedInspect = await docTool.execute({ op: 'inspect', docId, fresh: true }, exec);
  const renderedText = docTool.output.render({ op: 'inspect' }, renderedInspect)[0].text;
  for (const expected of [
    docId, 'metaRev: 2', 'locator: bindingId=' + renderedInspect.doc.locator.bindingId, 'relPath=docs/spec.md',
    'availability: readable', 'code: null', 'observedAt: ', 'cached: false',
    'contentHash: ' + sha(fs.readFileSync(file)), 'size: ' + fs.statSync(file).size,
    'previewable: true', 'confirmation: matches_baseline', 'baseline: domain=workspace-bytes', 'git: not_a_repo',
  ]) assert.ok(renderedText.includes(expected), 'inspect render includes ' + expected);

  const notesFile = path.join(wsDir, 'notes.txt');
  const notes = await docTool.execute({ op: 'register', title: 'Notes', relPath: 'notes.txt' }, exec);
  const readableNotes = await docTool.execute({ op: 'inspect', docId: notes.doc.id, preview: true, fresh: true }, exec);
  const readableNotesText = docTool.output.render({ op: 'inspect' }, readableNotes)[0].text;
  for (const expected of [
    notes.doc.id, 'metaRev: 1', 'relPath=notes.txt', 'availability: readable', 'code: null',
    'observedAt: ', 'cached: false', 'contentHash: ' + sha(fs.readFileSync(notesFile)),
    'size: ' + fs.statSync(notesFile).size, 'previewable: true',
    'preview (truncated: false, totalBytes: 6):', 'plain',
    'confirmation: unconfirmed', 'baseline: null', 'git: not_a_repo',
  ]) assert.ok(readableNotesText.includes(expected), 'readable inspect render includes ' + expected);

  fs.rmSync(notesFile);
  const missingNotes = await docTool.execute({ op: 'inspect', docId: notes.doc.id, preview: true, fresh: true }, exec);
  const missingNotesText = docTool.output.render({ op: 'inspect' }, missingNotes)[0].text;
  for (const expected of ['availability: missing', 'code: file-missing', 'contentHash: null', 'size: null', 'previewable: false', 'preview: null']) {
    assert.ok(missingNotesText.includes(expected), 'missing inspect render includes ' + expected);
  }
  assert.notEqual(missingNotesText, readableNotesText, 'readable and missing inspect renders differ');

  // 分段职责：空 reason/detail 须明确打印 null，结构化读取诊断不能在渲染中丢失。
  // Diagnostics stay distinguishable: an absent reason/detail prints null, and a
  // structured read detail survives instead of vanishing from the render.
  assert.ok(renderedText.includes('confirmation: matches_baseline (reason: null)'), 'matches_baseline prints reason: null');
  assert.ok(renderedText.includes('git: not_a_repo (detail: null)'), 'git without detail prints detail: null');
  assert.ok(readableNotesText.includes('observationDetail: null'), 'readable text prints observationDetail: null');

  const staleMeta = await docTool.execute({ op: 'update_meta', docId, expectedMetaRev: 1, title: 'Nope' }, exec)
    .then(() => null, (error) => error);
  assert.equal(staleMeta.code, 'stale-revision');
  assert.equal(JSON.parse(staleMeta.message).details.currentMetaRev, 2);

  const updated = await docTool.execute({
    op: 'update_meta', docId, expectedMetaRev: 2, title: 'Spec renamed', status: 'in_review', reason: 'review',
  }, exec);
  assert.equal(updated.doc.rev, 3);
  assert.equal(updated.doc.title, 'Spec renamed');
  assert.equal(updated.doc.status, 'in_review');
  await rejects(docTool.execute({ op: 'update_meta', docId, expectedMetaRev: 3 }, exec), 'invalid-command');

  put('docs/spec-v2.md', '# Spec\n\nbody\n');
  const relocated = await docTool.execute({ op: 'relocate', docId, expectedMetaRev: 3, relPath: 'docs/spec-v2.md' }, exec);
  assert.equal(relocated.doc.rev, 4);
  assert.deepEqual(relocated.doc.locator, { bindingId: relocated.doc.locator.bindingId, relPath: 'docs/spec-v2.md' });
  assert.equal(fs.readFileSync(file, 'utf8'), '# Spec\n\nbody\n', 'relocate never touches the old file');
  assert.equal((await docTool.execute({ op: 'inspect', docId, fresh: true }, exec)).confirmation.state, 'not_comparable');

  const reconfirmed = await docTool.execute({
    op: 'confirm', docId, expectedMetaRev: 4, expectedContentHash: sha(fs.readFileSync(path.join(wsDir, 'docs', 'spec-v2.md'))),
  }, exec);
  assert.equal(reconfirmed.doc.rev, 5);

  const tomb = await docTool.execute({ op: 'unregister', docId, expectedMetaRev: 5, reason: 'done' }, exec);
  assert.equal(tomb.doc.rev, 6);
  assert.ok(tomb.doc.unregistered.at);
  const liveExternal = (await docTool.execute({ op: 'list_external' }, exec)).docs;
  assert.deepEqual(liveExternal.map((doc) => doc.id), [notes.doc.id], 'unregistered tombstones are hidden from the live list');
  assert.equal((await docTool.execute({ op: 'list_external', includeUnregistered: true }, exec)).docs.length, 2);
  await rejects(docTool.execute({ op: 'unregister', docId, expectedMetaRev: 6 }, exec), 'illegal-transition');

  const gone = await docTool.execute({ op: 'inspect', docId }, exec);
  assert.equal(gone.unregistered, true);
  assert.equal(gone.observation, null);
  assert.equal(gone.availability, null);
  assert.equal(gone.confirmation.reason, 'unregistered');
  assert.equal(gone.doc.links.taskIds[0], taskId, 'unregister keeps links');

  // 分段职责：缺文件和目录登记须映射契约码，并给定位/注销的补救提示。
  // ---- registration failures map to contract codes ------------------------
  const missing = await docTool.execute({ op: 'register', title: 'Gone', relPath: 'docs/missing.md' }, exec)
    .then(() => null, (error) => error);
  assert.equal(missing.code, 'file-missing');
  assert.match(JSON.parse(missing.message).next, /relocate|unregister/, 'NEXT carries the recovery hint');
  await rejects(docTool.execute({ op: 'register', title: 'Dir', relPath: 'docs' }, exec), 'not-regular');

  // 分段职责：列表须区分 inline/external 来源，只有内嵌行保留 body hash/size。
  // ---- docs view distinguishes sources, inline docs keep hash/size ---------
  const inline = await docTool.execute({ op: 'put', title: 'Inline note', kind: 'note', body: 'inline body' }, exec)
    .then(() => null, (error) => error);
  assert.equal(inline.code, 'inline-write-disabled');
  const inlineId = seededDocId;
  await rejects(docTool.execute({ op: 'inspect', docId: inlineId }, exec), 'invalid-command');

  const list = await docTool.execute({ op: 'list' }, exec);
  const externalRow = list.docs.find((doc) => doc.id === docId);
  const inlineRow = list.docs.find((doc) => doc.id === inlineId);
  assert.equal(externalRow.source, 'external');
  assert.equal(externalRow.hash, undefined);
  assert.equal(externalRow.size, undefined);
  assert.equal(inlineRow.source, 'inline');
  assert.equal(typeof inlineRow.hash, 'string');
  assert.equal(typeof inlineRow.size, 'number');

  const taskView = await boardTool.execute({ view: 'task', taskId }, exec);
  assert.equal(taskView.linkedDocs.find((doc) => doc.id === docId).source, 'external');
  const docsText = docTool.output.render({ op: 'list' }, list)[0].text;
  assert.ok(docsText.includes('(external)'), 'docs render marks external rows');

  fs.writeFileSync(path.join(wsDir, 'opaque.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]));
  const opaque = await docTool.execute({ op: 'register', title: 'Opaque', relPath: 'opaque.bin' }, exec);
  const opaqueInspect = await docTool.execute({ op: 'inspect', docId: opaque.doc.id, fresh: true }, exec);
  const opaqueText = docTool.output.render({ op: 'inspect' }, opaqueInspect)[0].text;
  assert.ok(opaqueText.includes('availability: unsupported_format'), 'binary keeps unsupported_format availability');
  assert.ok(opaqueText.includes('observationDetail: "extension"'), 'structured read detail is rendered, not dropped');

  console.log('PASS doc-external-tools: register/inspect/update_meta/relocate/confirm/unregister/list_external + source view');
} finally {
  for (const dispose of disposers) { try { dispose(); } catch { /* ignore */ } }
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(wsDir, { recursive: true, force: true });
}
