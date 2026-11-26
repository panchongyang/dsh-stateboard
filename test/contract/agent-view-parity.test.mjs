/**
 * 测试职责：完整视图、计划/文档操作及有界精读的双端实际行为一致。
 * 典型流程：原生注册与 HTTP 在同一合成项目读取相同水位，逐字比较输出。
 * 覆盖边界：覆盖 既有 DSH 默认值、过滤、范围、重复读取与精读分页。；不覆盖真实用户数据与 LLM 推理。
 * 外部前置：Node 与回环临时端口；数据不来自真实项目。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, text, error } from '../helpers/agent-parity-fixture.mjs';
import { command } from '../helpers/service-fixture.mjs';
import { put, temp, bootstrapPin } from '../helpers/fixed-fixture.mjs';

// 责任：同业务身份逐字比较全部视图，仅对独立审计时间显式归一。
test('all board views share DSH defaults, text and unchanged behavior', async (t) => {
  const f = await fixture(t, { privilegedInlineWrites: true });
  const { context } = await f.open();
  const doc = await f.h.command(command('doc.put', { title: 'alpha', body: '汉'.repeat(10000), kind: 'note' }));
  const docId = doc.events[0].docId;
  await f.h.command(command('doc.put', { title: 'beta', body: 'small', kind: 'note' }));
  const made = await f.h.command(command('task.create', { title: 'task', description: '汉🙂'.repeat(30), acceptance: [{ text: 'check' }] }));
  const taskId = made.events[0].taskId;
  text(await f.call('project_board', { view: 'health', context }));
  // Compare the same authorized business actor, rather than erasing identity
  // fields from different actors' views.
  // Reads never attach an actor. Establish the compared actor with an explicit
  // business write, then use that same actor id for both transports.
  await f.call('project_task', { op: 'create', title: 'actor anchor', acceptance: [{ text: 'ok' }], context });
  f.exec.agent.id = Object.keys(f.h.state.bindings).find((id) => id.startsWith('mcp_'));
  assert.ok(f.exec.agent.id, 'the explicit write attached the compared actor');
  const cases = [
    { view: 'brief' }, { view: 'board' }, { view: 'task', taskId }, { view: 'plans' },
    { view: 'plan' }, { view: 'plan', planId: 'pln_missing' },
    { view: 'docs', query: 'alpha' }, { view: 'doc', docId, maxBytes: 4 }, { view: 'doc', docId },
    { view: 'events', limit: 101 }, { view: 'health' },
    { view: 'tasks' }, { view: 'task_overview', taskId }, { view: 'work_context', taskId },
    ...['description', 'acceptance', 'evidence', 'audit', 'timeline', 'operations', 'documents', 'intent'].map((section) => ({ view: 'task_detail', taskId, section })),
  ];
  for (const args of cases) {
    const request = { ...args, fresh: true };
    const value = await f.nativeCall('project_board', request);
    const nativeText = f.render('project_board', request, value).map((b) => b.text).join('\n');
    const remoteText = text(await f.call('project_board', { ...request, context }));
    if (args.view === 'health') {
      const health = [JSON.parse(nativeText), JSON.parse(remoteText)];
      // Real isolated audits happen at distinct wall-clock times. Keep every
      // field and compare all domain values, normalizing only those two times.
      for (const value of health) for (const field of ['snapshotAt', 'completedAt']) {
        assert.ok(Number.isFinite(Date.parse(value.evidenceAudit[field])));
        value.evidenceAudit[field] = '<audit invocation time>';
      }
      assert.deepEqual(...health);
    } else assert.equal(remoteText, nativeText, JSON.stringify(args));
  }
  assert.equal((await f.nativeCall('project_board', { view: 'plan', planId: 'pln_missing' })).plan, null);
  // DSH's existing document limits and event upper bound remain authoritative.
  assert.equal((await f.nativeCall('project_board', { view: 'doc', docId })).body.length, 10000);
  const repeated = { view: 'task', taskId };
  const nativeText = f.render('project_board', repeated, await f.nativeCall('project_board', repeated))[0].text;
  assert.equal(text(await f.call('project_board', { ...repeated, context })), nativeText);
  assert.match(nativeText, /unchanged since/);
  const covered = new Set(cases.map(({ view }) => view));
  assert.deepEqual([...covered].sort(), [...f.native.get('project_board').parameters.properties.view.enum].sort());
});

// 责任：两端只回放同一条已记录的旧 Git 来源身份，不执行 Git：body:null、deprecated/reverified 明确，无记录 404，旧绑定提示不能恢复字节。
test('legacy Git reads replay the same recorded identity on both transports without Git bytes', async t => {
  const root = temp(t);
  put(root, 'nested/inside.md', 'inside binding\n');
  const f = await fixture(t, { workspacePath: root });
  const { context } = await f.open();
  const registered = await f.h.command(command('doc.external.register', { title: 'Nested', relPath: 'nested/inside.md' }));
  const pinned = await bootstrapPin(f.h, registered.docId, { synthetic: true });
  const args = { op: 'get_fixed', docId: registered.docId, commitOid: pinned.fixed.commitOid, pathAtCommit: pinned.fixed.pathAtCommit };
  const value = await f.nativeCall('project_doc', args);
  assert.equal(value.body, null, 'historical bytes are never read back');
  assert.equal(value.availability, 'legacy-git-record-only');
  assert.equal(value.deprecated, true);
  assert.equal(value.reverified, false);
  assert.equal(value.hashDomain, 'git-blob-bytes');
  assert.deepEqual(value.fixed, pinned.fixed);
  assert.equal(text(await f.call('project_doc', { ...args, context })), f.render('project_doc', args, value)[0].text, 'both transports replay the identical record');

  const hinted = await f.nativeCall('project_doc', { ...args, bindingId: 'bnd_legacy_missing' });
  assert.deepEqual(hinted, value, 'a stale binding hint cannot restore external Git bytes');

  const missing = { op: 'get_fixed', docId: registered.docId, commitOid: 'c'.repeat(40), pathAtCommit: pinned.fixed.pathAtCommit };
  let nativeMissing;
  try { await f.nativeCall('project_doc', missing); } catch (e) { nativeMissing = e.boardFailure; }
  assert.equal(nativeMissing.code, 'not-found');
  assert.equal(error(await f.call('project_doc', { ...missing, context }), 'not-found').code, 'not-found');
});

// 责任：精读按 UTF-8 分页、版本钉住和显式过滤，禁止隐式扩展。
test('selected reads expose exact coverage, UTF-8 boundaries, revision guards and evidence filters', async (t) => {
  const f = await fixture(t);
  const { context } = await f.open();
  const description = '汉🙂'.repeat(20);
  text(await f.call('project_task', { op: 'create', title: 'Selective detail', description, acceptance: [{ text: 'complete' }], context }));
  const task = Object.values(f.h.state.tasks)[0];
  const args = { view: 'task_detail', taskId: task.id, section: 'description', maxBytes: 8, atRev: task.rev };
  let offset = 0, combined = '';
  do {
    const value = await f.nativeCall('project_board', { ...args, offset });
    const actual = text(await f.call('project_board', { ...args, offset, context }));
    assert.equal(actual, f.render('project_board', { ...args, offset }, value)[0].text);
    assert.ok(value.coverage.returnedBytes <= 8);
    assert.equal(value.content.includes('�'), false);
    combined += value.content;
    offset = value.coverage.nextOffset;
  } while (offset !== null);
  assert.equal(combined, description);
  error(await f.call('project_board', { ...args, offset: 1, context }), 'invalid-command');
  error(await f.call('project_board', { ...args, maxBytes: 24577, context }), 'invalid-command');
  text(await f.call('project_task', { op: 'update', taskId: task.id, expectedRev: task.rev, description: 'changed', context }));
  error(await f.call('project_board', { ...args, context }), 'stale-revision');
  const filtered = await f.nativeCall('project_board', { view: 'task_detail', taskId: task.id, section: 'evidence', kind: 'test', includeSuperseded: false });
  assert.equal(filtered.content, '[]');
  assert.equal(filtered.scope.kind, 'test');
  assert.equal(filtered.scope.includeSuperseded, false);
  assert.equal(filtered.coverage.truncated, false);
  const selected = await f.nativeCall('project_board', { view: 'task_detail', taskId: task.id, sections: ['audit', 'evidence'], kind: 'test' });
  assert.deepEqual(JSON.parse(selected.content), { audit: null, evidence: [] });
  error(await f.call('project_board', { view: 'task_detail', taskId: task.id, sections: ['audit', 'evidence', 'timeline', 'description'], context }), 'invalid-command');
});

// 责任：两端覆盖所有计划、文档和会话操作以及人工专属拒绝。
for (const channel of ['native', 'mcp']) test(channel + ' executes every plan and document operation', async (t) => {
  const f = await fixture(t);
  const { context } = await f.open();
  const seen = { project_plan: new Set(), project_doc: new Set(), project_session: new Set() };
  const invoke = async (name, args, denial) => {
    seen[name].add(args.op);
    if (channel === 'mcp') {
      const response = await f.call(name, { ...args, context });
      return denial ? error(response, denial) : text(response);
    }
    if (denial) return assert.rejects(f.nativeCall(name, args), { code: denial });
    const value = await f.nativeCall(name, args);
    return f.render(name, args, value);
  };
  for (const op of ['open', 'projects', 'init', 'checkpoint', 'handoff']) {
    await invoke('project_session', { op, projectId: f.h.id, note: 'Synthetic session record', nextActions: ['inspect evidence'] });
    if (['checkpoint', 'handoff'].includes(op)) {
      const event = f.h.store.commits.at(-1).events.find(e => e.type === 'session/' + op);
      assert.equal(event.data.note, 'Synthetic session record');
      assert.deepEqual(event.data.nextActions, ['inspect evidence']);
    }
  }
  assert.equal(Object.keys(f.h.state.tasks).length, 0, 'init creates no task');
  assert.equal(Object.keys(f.h.state.planHeads).length, 0, 'init creates no plan');
  await invoke('project_plan', { op: 'create', title: 'Plan', steps: [{ id: 'one', title: 'one', tasks: [] }] });
  const planId = Object.keys(f.h.state.planHeads)[0];
  assert.equal(f.h.state.planHeads[planId].status, 'draft');
  const plan = (op, extra = {}, denial) => invoke('project_plan', { op, planId, expectedRev: f.h.state.planHeads[planId].rev, ...extra }, denial);
  await plan('rename', { title: 'Renamed' });
  assert.equal(f.h.state.planHeads[planId].title, 'Renamed');
  await plan('publish');
  assert.equal(f.h.state.planHeads[planId].status, 'active');
  assert.equal(f.h.state.planHeads[planId].currentVersion, 1);
  await plan('revise', { baseVersion: 1, goal: 'Revised goal', steps: [{ id: 'one', title: 'one', tasks: [] }] });
  assert.equal(f.h.state.planHeads[planId].currentVersion, 2);
  assert.equal(f.h.state.plans[planId + '@2'].goal, 'Revised goal');
  assert.equal(f.h.state.plans[planId + '@1'].status, 'superseded');
  const made = await f.h.command(command('task.create', { title: 'adopted', acceptance: [{ text: 'ok' }] }));
  const taskId = made.events[0].taskId;
  const baseVersion = f.h.state.planHeads[planId].currentVersion;
  await plan('adopt', { baseVersion, stepId: 'one', taskIds: [taskId] });
  assert.deepEqual(f.h.state.tasks[taskId].planRef, { planId, version: 3, stepId: 'one' });
  assert.deepEqual(f.h.state.plans[planId + '@3'].steps[0].taskIds, [taskId]);
  await plan('release', { baseVersion: f.h.state.planHeads[planId].currentVersion, taskIds: [taskId] });
  assert.equal(f.h.state.tasks[taskId].planRef, null);
  assert.deepEqual(f.h.state.plans[planId + '@4'].steps[0].taskIds, []);
  await plan('focus', {}, 'forbidden-role');
  await plan('archive');
  assert.equal(f.h.state.planHeads[planId].status, 'archived');
  await plan('unarchive');
  assert.equal(f.h.state.planHeads[planId].status, 'active');
  fs.writeFileSync(path.join(f.wsDir, 'doc.md'), '# Synthetic document\n');
  await invoke('project_doc', { op: 'register', title: 'External', kind: 'note', relPath: 'doc.md' });
  const docId = Object.keys(f.h.state.docs)[0];
  assert.equal(f.h.state.docs[docId].locator.relPath, 'doc.md');
  assert.equal(f.h.state.docs[docId].source, 'external');
  await invoke('project_doc', { op: 'list' });
  await invoke('project_doc', { op: 'list_external', includeUnregistered: true });
  await invoke('project_doc', { op: 'inspect', docId, fresh: true, preview: true });
  await invoke('project_doc', { op: 'get', docId }, 'external-doc-operation-required');
  await invoke('project_doc', { op: 'put', title: 'Disabled inline', body: 'must not persist' }, 'inline-write-disabled');
  await invoke('project_doc', { op: 'link', docId, links: { taskIds: [taskId] } }, 'external-doc-operation-required');
  const meta = () => f.h.state.docs[docId].rev;
  await invoke('project_doc', { op: 'update_meta', docId, expectedMetaRev: meta(), title: 'Updated external' });
  assert.equal(f.h.state.docs[docId].title, 'Updated external');
  assert.equal(meta(), 2);
  fs.writeFileSync(path.join(f.wsDir, 'relocated.md'), '# Synthetic document\n');
  await invoke('project_doc', { op: 'relocate', docId, expectedMetaRev: meta(), relPath: 'relocated.md' });
  assert.equal(f.h.state.docs[docId].locator.relPath, 'relocated.md');
  assert.equal(meta(), 3);
  const observed = await f.nativeCall('project_doc', { op: 'inspect', docId, fresh: true });
  await invoke('project_doc', { op: 'confirm', docId, expectedMetaRev: meta(), expectedContentHash: observed.observation.contentHash });
  assert.equal(f.h.state.docs[docId].baseline.contentHash, observed.observation.contentHash);
  assert.equal(f.h.state.docs[docId].baselineInContext, true);
  assert.equal(meta(), 4);
  await invoke('project_doc', { op: 'get_fixed', docId, commitOid: 'a'.repeat(40), pathAtCommit: 'doc.md' }, 'not-found');
  // This fixture uses the legacy layout. Positive cases on the space layout
  // are exercised through both actual registrars in the P2 host test.
  for (const op of ['capture', 'history', 'read_version', 'compare']) {
    const version = op === 'read_version' || op === 'compare' ? { versionId: 'synthetic-retained-version' } : {};
    await invoke('project_doc', { op, docId, ...version }, 'space-home-unavailable');
  }
  // P4 succeeds in the owning-space host fixture only; legacy cannot read or write relations.
  const from = { kind: 'task', id: taskId, seq: 1, event: 0 };
  for (const args of [
    { op: 'relate', from, to: { kind: 'workspace-current', docId }, expectedRev: 1 },
    { op: 'unrelate', relationId: 'rel_fixture', expectedRev: 1 },
    { op: 'relations', from },
  ]) await invoke('project_doc', args, 'space-home-unavailable');
  // Projection requires an owning space; actual successful read/refresh on both
  // transports is exercised in the corresponding owning-space parity fixture.
  for (const op of ['discover', 'read_current', 'refresh_current']) {
    await invoke('project_doc', op === 'discover' ? {op} : {op,relPath:'relocated.md'}, 'project-forbidden');
  }
  await invoke('project_doc', { op: 'unregister', docId, expectedMetaRev: meta(), reason: 'End of synthetic workflow' });
  assert.equal(f.h.state.docs[docId].unregistered.reason, 'End of synthetic workflow');
  assert.equal(meta(), 5);
  for (const [name, operations] of Object.entries(seen)) assert.deepEqual([...operations].sort(), [...f.native.get(name).parameters.properties.op.enum].sort(), name + ': new ops require workflow cases');
});
