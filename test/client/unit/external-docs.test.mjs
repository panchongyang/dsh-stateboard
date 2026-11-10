/**
 * 测试职责：保证外置文档 UI 的状态维度、写载荷和乐观并发草稿始终 fail closed。
 * 典型流程：合成文档/观测/草稿并运行 hook fixture → 生成展示/载荷或列表刷新 → 对照只读与版本栅栏。
 * 覆盖边界：覆盖 纯逻辑和轻量 hook 的 schema/竞态守卫；不覆盖真实 React DOM、网络或视觉。
 * 外部前置：部分 hook 用例需要 tools/build 的 esbuild，缺少时显式 skip；其余无依赖。
 */
/**
 * Pure-logic tests for the external document UI (D4): status dimensions,
 * unavailable-state copy, preview notices, write payloads and error mapping.
 * Pure cases import real model modules; hook cases bundle the real page container
 * with a synthetic React store and mocked transport responses (no live service).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AVAILABILITY_COPY, EXTERNAL_SCHEMA_VERSION, availabilityFromCode, availabilityView, baselineSummary,
  confirmBlock, confirmationView, findRow, formatBytes, gitView, inspectTargets, isMarkdownPath, knownBindingIds,
  mergeDocRows, observedStamp, previewState, rowHaystack, statusDimensions, workspaceSource, writeBlock,
} from '../../../src/client/model/external-docs.ts';
import {
  confirmPayload, externalErrorText, externalErrorView, metaPayload, registerPayload, relPathProblem,
  relocatePayload, targetErrorView, unregisterPayload,
} from '../../../src/client/model/external-payloads.ts';

const HASH = 'a'.repeat(64);
const AVAILABILITIES = [
  'readable', 'missing', 'root_unavailable', 'missing_binding', 'permission_denied', 'outside_root',
  'security_rejected', 'not_regular', 'oversize', 'unsupported_format', 'undecodable', 'unstable',
];

function record(extra) {
  return Object.assign({
    id: 'doc_1', source: 'external', rev: 4, title: '设计稿', kind: 'design', status: 'in_review',
    locator: { bindingId: 'bnd_main', relPath: 'docs/design.md' },
    links: { taskIds: ['tsk_1'], planRefs: [{ planId: 'pln_1', version: 2 }] },
    baseline: null, baselineInContext: false, unregistered: null,
  }, extra);
}

function view(extra) {
  const doc = (extra && extra.doc) || record();
  return Object.assign({
    schemaVersion: 1, doc, metaRev: doc.rev, projectRev: 90, unregistered: false,
    availability: 'readable', code: null,
    observation: {
      observedAt: '2026-11-02T10:00:00.000Z', cached: false,
      context: { bindingId: 'bnd_main', root: 'D:\\ws', relPath: 'docs/design.md', role: 'main' },
      contentHash: HASH, size: 12, previewable: true, detail: null,
      preview: { text: 'hello', truncated: false, totalBytes: 5 },
    },
    confirmation: { state: 'unconfirmed', baseline: null },
    git: { state: 'committed' },
  }, extra);
}

// 责任：每个 availability 须有可执行提示，缺文件不能擅自断言删除或换分支。
test('availability copy covers every enum value, never claims deletion or a branch change', () => {
  for (const name of AVAILABILITIES) {
    const copy = AVAILABILITY_COPY[name];
    assert.ok(copy && copy.label, name + ' has a label');
    if (name === 'readable') continue;
    assert.ok(copy.title && copy.hint, name + ' has actionable copy');
    assert.ok(!/已被?删除|已删除|切换了分支|换了分支|分支已/.test(copy.title + copy.hint), name + ' must not guess a cause');
  }
  assert.match(AVAILABILITY_COPY.missing.hint, /无法判断原因/);
  assert.match(AVAILABILITY_COPY.missing.hint, /不会删除任何文件/);
});

// 责任：全部契约错误码须映射对应 availability，未知或缺失码返回 null。
test('availabilityFromCode maps every contract code to its availability', () => {
  const pairs = {
    'file-missing': 'missing', 'root-unavailable': 'root_unavailable', 'missing-binding': 'missing_binding',
    'permission-denied': 'permission_denied', 'outside-root': 'outside_root', 'security-rejected': 'security_rejected',
    'not-regular': 'not_regular', oversize: 'oversize', 'unsupported-format': 'unsupported_format',
    undecodable: 'undecodable', unstable: 'unstable',
  };
  for (const [code, availability] of Object.entries(pairs)) assert.equal(availabilityFromCode(code), availability);
  assert.equal(availabilityFromCode('nope'), null);
  assert.equal(availabilityFromCode(undefined), null);
});

// 责任：未知可用性须降级只读，未观测与已注销必须分别显示。
test('availabilityView: unknown values degrade to read-only copy, tombstones and unobserved are distinct', () => {
  assert.equal(availabilityView(null).label, '未观测');
  assert.equal(availabilityView({ unregistered: true }).label, '已解除登记');
  const unknown = availabilityView({ availability: 'future_thing' });
  assert.equal(unknown.label, '未知可用性');
  assert.match(unknown.title, /future_thing/);
  const missing = availabilityView({ availability: 'missing', code: 'file-missing' });
  assert.equal(missing.code, 'file-missing');
  assert.equal(missing.tone, 'warn');
});

// 责任：文件不可用时仍须保留管理/确认/Git 四维信息，不能只显示一个失败状态。
test('statusDimensions keeps four separate dimensions and an unavailable file does not hide the others', () => {
  const unavailable = view({
    availability: 'missing', code: 'file-missing',
    observation: { observedAt: 't', cached: false, context: { bindingId: 'bnd_main', root: 'D:\\ws', relPath: 'x', role: 'main' }, contentHash: null, size: null, previewable: false, detail: null },
    confirmation: { state: 'not_comparable', reason: 'no-complete-hash', baseline: {} },
    git: null,
  });
  const dims = statusDimensions(null, unavailable);
  assert.deepEqual(dims.map((d) => d.key), ['management', 'availability', 'confirmation', 'git']);
  assert.equal(dims[0].label, '评审中');
  assert.equal(dims[1].label, '路径不存在');
  assert.equal(dims[2].label, '无法比较');
  assert.equal(dims[2].reason, '这次观测没有拿到完整内容 hash');
  assert.equal(dims[3].label, '未观测 Git');
  assert.equal(new Set(dims.map((d) => d.label)).size, 4, 'no collapsed ok/broken flag');
});

// 责任：从未 inspect 时只显示登记的管理状态，不能编造其他维度观测。
test('statusDimensions before any observation shows the record status only', () => {
  const dims = statusDimensions(record(), null);
  assert.equal(dims[0].label, '评审中');
  assert.equal(dims[1].label, '未观测');
  assert.equal(dims[2].label, '未观测');
});

// 责任：所有确认和 Git 状态须映射清晰标签，未知值不能冒充可信成功。
test('confirmationView and gitView label every state', () => {
  assert.equal(confirmationView({ state: 'matches_baseline' }).label, '与确认版本一致');
  assert.equal(confirmationView({ state: 'changed_since_confirm' }).label, '确认后有改动');
  assert.equal(confirmationView({ state: 'not_comparable', reason: 'relocated' }).reason, '重定位后还没有在新位置重新确认');
  assert.equal(gitView({ state: 'modified', staged: true, unstaged: true }).detail, '已暂存 · 未暂存');
  assert.match(gitView({ state: 'git_unavailable', detail: 'unsupported-content-transform', lfs: true }).detail, /filter\/LFS.*LFS/);
  assert.equal(gitView({ state: 'not_a_repo' }).label, '不在 Git 仓库中');
});

// 责任：截断预览须说明已显示字节和总字节，不能声称展示完整正文。
test('previewState: truncated names shown and total bytes and refuses to claim a full read', () => {
  const text = 'a'.repeat(10);
  const state = previewState(view({ observation: Object.assign({}, view().observation, { preview: { text, truncated: true, totalBytes: 5000 } }) }));
  assert.equal(state.kind, 'text');
  assert.equal(state.truncated, true);
  assert.equal(state.shownBytes, 10);
  assert.match(state.notice, /预览已截断/);
  assert.match(state.notice, /10 字节/);
  assert.match(state.notice, /4\.9 KiB/);
  assert.match(state.notice, /不能据此认为已读完全文/);
});

// 责任：中文预览已显示长度须按 UTF-8 字节计算，不能拿字符数替代。
test('previewState: shown bytes are UTF-8 bytes, not characters', () => {
  const state = previewState(view({ observation: Object.assign({}, view().observation, { preview: { text: '中文', truncated: true, totalBytes: 99 } }) }));
  assert.equal(state.shownBytes, 6);
});

// 责任：完整预览不提示截断，不支持预览的文件不能渲染成空正文成功。
test('previewState: a complete preview has no notice; non-previewable never renders as an empty body', () => {
  const full = previewState(view());
  assert.equal(full.kind, 'text');
  assert.equal(full.truncated, false);
  assert.equal(full.notice, '');
  const binary = previewState(view({
    availability: 'unsupported_format', code: 'unsupported-format',
    observation: Object.assign({}, view().observation, { previewable: false, detail: 'extension', preview: null }),
  }));
  assert.equal(binary.kind, 'not-previewable');
  assert.equal(binary.text, undefined);
  assert.match(binary.notice, /不代表文件为空/);
  assert.match(binary.notice, /扩展名/);
});

// 责任：不可用、注销或尚未加载时 preview 不得携带旧 body。
test('previewState: unavailable, unregistered and unloaded states carry no body', () => {
  const missing = previewState(view({ availability: 'missing', code: 'file-missing' }));
  assert.equal(missing.kind, 'unavailable');
  assert.match(missing.notice, /没有可显示的正文/);
  assert.equal(previewState(view({ unregistered: true })).kind, 'unregistered');
  assert.match(previewState(view({ unregistered: true })).notice, /没有被删除/);
  assert.equal(previewState(null).kind, 'not-loaded');
  const noPreview = previewState(view({ observation: Object.assign({}, view().observation, { preview: undefined }) }));
  assert.equal(noPreview.kind, 'not-loaded');
});

// 责任：oversize 提示须渲染具体大小，不能把原始 JSON 当用户文案。
test('oversize detail is rendered with sizes, not as raw JSON', () => {
  const state = previewState(view({
    availability: 'oversize', code: 'oversize',
    observation: Object.assign({}, view().observation, { previewable: false, contentHash: null, detail: { size: 20 * 1024 * 1024, maxBytes: 16 * 1024 * 1024 } }),
  }));
  assert.equal(state.kind, 'unavailable');
  assert.equal(formatBytes(20 * 1024 * 1024), '20 MiB');
});

// 责任：来源须用 observation 的 binding/root/role，不能用当前会话 cwd 猜测。
test('workspaceSource reports binding, root and role from the observation, never the session cwd', () => {
  const source = workspaceSource(record(), view());
  assert.deepEqual(source, { bindingId: 'bnd_main', relPath: 'docs/design.md', root: 'D:\\ws', role: '主工作区', observed: true });
  const worktree = workspaceSource(record(), view({ observation: Object.assign({}, view().observation, { context: { bindingId: 'bnd_wt', root: 'D:\\wt', relPath: 'docs/design.md', role: 'worktree' } }) }));
  assert.equal(worktree.role, '工作树');
  const cold = workspaceSource(record(), null);
  assert.equal(cold.observed, false);
  assert.equal(cold.root, null);
  assert.equal(cold.bindingId, 'bnd_main');
});

// 责任：观测时间标记须明确区分缓存和 fresh 读取。
test('observedStamp distinguishes cached from fresh reads', () => {
  assert.match(observedStamp(view()), /刚刚读取 · 观测于 2026-11-02/);
  assert.match(observedStamp(view({ observation: Object.assign({}, view().observation, { cached: true }) })), /缓存结果/);
  assert.equal(observedStamp(view({ unregistered: true, observation: null })), '');
});

// 责任：写操作与 confirm 的阻止条件须正确区分，只读或不完整观测不能放行。
test('writeBlock / confirmBlock gate writes and confirmation', () => {
  assert.equal(writeBlock(view()), '');
  assert.match(writeBlock(null), /尚未观测/);
  assert.match(writeBlock(view({ unregistered: true })), /已解除登记/);
  assert.match(writeBlock(view({ schemaVersion: 2 })), /schemaVersion 2.*只读/);
  assert.equal(EXTERNAL_SCHEMA_VERSION, 1);
  assert.equal(confirmBlock(view()), '');
  assert.match(confirmBlock(view({ observation: Object.assign({}, view().observation, { contentHash: null }) })), /没有完整内容 hash/);
  assert.match(confirmBlock(view({ confirmation: { state: 'matches_baseline', baseline: {} } })), /已与确认版本一致/);
});

// 责任：基线摘要须保留历史确认信息，跨上下文时明确标出不能直接比较。
test('baselineSummary keeps the baseline visible and flags an out-of-context one', () => {
  assert.equal(baselineSummary(record()), null);
  const base = { domain: 'workspace-bytes', contentHash: HASH, bindingId: 'bnd_main', relPath: 'docs/design.md', confirmedAt: '2026-11-01', confirmedBy: { kind: 'human', via: 'web' } };
  const summary = baselineSummary(record({ baseline: base, baselineInContext: false }));
  assert.equal(summary.hash, HASH);
  assert.equal(summary.confirmedBy, 'human/web');
  assert.equal(summary.inContext, false);
  assert.ok(summary.shortHash.length < HASH.length);
  assert.equal(baselineSummary(record({ baseline: base, baselineInContext: true })).inContext, true);
});

// 责任：合并文档列表须每 id 一行，剔除 /docs 中重复外置项但保留 tombstone。
test('mergeDocRows lists each record once, external rows from /docs are dropped, tombstones kept', () => {
  const rows = mergeDocRows(
    [{ id: 'doc_i', title: 'a', updatedAt: '2026-01-01' }, { id: 'doc_1', source: 'external', title: 'dup', updatedAt: '2026-01-01' }],
    [record({ updatedAt: '2026-02-01' }), record({ id: 'doc_2', unregistered: { at: 't' }, updatedAt: '2026-03-01' })],
  );
  assert.deepEqual(rows.map((r) => r.id), ['doc_2', 'doc_1', 'doc_i']);
  assert.deepEqual(rows.map((r) => r.source), ['external', 'external', 'inline']);
  assert.equal(rows.find((r) => r.id === 'doc_1').title, '设计稿');
  assert.deepEqual(inspectTargets(rows).map((r) => r.id), ['doc_1'], 'tombstones are not re-observed');
  assert.equal(findRow(rows, 'doc_i').source, 'inline');
  assert.equal(findRow(rows, 'nope'), null);
});

// 责任：搜索 haystack 须含标题、id、类型和 locator，不能遗漏路径关键字。
test('rowHaystack searches title, id, kind and locator', () => {
  const text = rowHaystack(record());
  for (const part of ['设计稿', 'doc_1', 'design', 'docs/design.md', 'bnd_main']) assert.ok(text.includes(part.toLowerCase()), part);
  assert.deepEqual(knownBindingIds([record(), record({ id: 'doc_2', locator: { bindingId: 'bnd_wt', relPath: 'a.md' } }), record({ id: 'doc_3' })]), ['bnd_main', 'bnd_wt']);
  assert.equal(isMarkdownPath('docs/a.MD'), true);
  assert.equal(isMarkdownPath('a.txt'), false);
});

// 责任：登记载荷须校验必填和安全相对路径，只发送白名单字段。
test('registerPayload: required fields, lexical path checks, only whitelisted keys', () => {
  assert.match(registerPayload({ title: ' ', relPath: 'a.md' }).error, /标题/);
  assert.match(registerPayload({ title: 't', relPath: '' }).error, /相对路径/);
  assert.match(registerPayload({ title: 't', relPath: 'a\\b.md' }).error, /\//);
  assert.match(registerPayload({ title: 't', relPath: '/etc/x' }).error, /绝对路径/);
  assert.match(registerPayload({ title: 't', relPath: 'C:/x.md' }).error, /绝对路径/);
  assert.match(registerPayload({ title: 't', relPath: 'a/../b.md' }).error, /\.\./);
  assert.equal(relPathProblem('docs/ok.md'), '');
  const minimal = registerPayload({ title: ' t ', relPath: 'docs/a.md' });
  assert.deepEqual(minimal.body, { title: 't', kind: 'note', relPath: 'docs/a.md' });
  const full = registerPayload({ title: 't', kind: 'spec', relPath: 'a.md', bindingId: ' bnd_x ', taskIds: ['tsk_1', 'tsk_1'] });
  assert.deepEqual(full.body, { title: 't', kind: 'spec', relPath: 'a.md', bindingId: 'bnd_x', links: { taskIds: ['tsk_1'], planRefs: [] } });
  const allowed = new Set(['title', 'kind', 'bindingId', 'relPath', 'links']);
  assert.ok(Object.keys(full.body).every((key) => allowed.has(key)));
});

// 责任：元数据载荷只发变化字段与草稿 expectedMetaRev，非法状态迁移必须拒绝。
test('metaPayload sends only changed fields plus expectedMetaRev and checks transitions', () => {
  const v = view();
  assert.match(metaPayload(v, { title: '设计稿', kind: 'design', status: 'in_review', taskIds: ['tsk_1'] }).error, /没有改动/);
  assert.deepEqual(metaPayload(v, { title: '新名', kind: 'design', status: 'in_review', taskIds: ['tsk_1'] }).body, { expectedMetaRev: 4, title: '新名' });
  assert.deepEqual(metaPayload(v, { title: '设计稿', kind: 'spec', status: 'in_review' }).body, { expectedMetaRev: 4, kind: 'spec' });
  const linked = metaPayload(v, { title: '设计稿', taskIds: ['tsk_1', 'tsk_2'] });
  assert.deepEqual(linked.body.links, { taskIds: ['tsk_1', 'tsk_2'], planRefs: [{ planId: 'pln_1', version: 2 }] });
  assert.deepEqual(metaPayload(v, { title: '设计稿', status: 'adopted', reason: '评审通过' }).body, { expectedMetaRev: 4, status: 'adopted', reason: '评审通过' });
  assert.match(metaPayload(v, { title: '设计稿', status: 'bogus' }).error, /不能从/);
  assert.match(metaPayload(v, { title: ' ' }).error, /标题不能为空/);
  const archived = view({ doc: record({ status: 'archived' }) });
  assert.match(metaPayload(archived, { title: '设计稿', status: 'draft' }).error, /需要填写原因/);
  assert.equal(metaPayload(archived, { title: '设计稿', status: 'draft', reason: '重启' }).body.status, 'draft');
  assert.match(metaPayload(view({ unregistered: true }), { title: 'x' }).error, /已解除登记/);
});

// 责任：重定位只发变更的路径或绑定，无变化时须拒绝空写。
test('relocatePayload sends only the changed half and rejects a no-op', () => {
  const v = view();
  assert.match(relocatePayload(v, { bindingId: 'bnd_main', relPath: 'docs/design.md' }).error, /位置没有变化/);
  assert.deepEqual(relocatePayload(v, { bindingId: 'bnd_main', relPath: 'docs/new.md' }).body, { expectedMetaRev: 4, relPath: 'docs/new.md' });
  assert.deepEqual(relocatePayload(v, { bindingId: 'bnd_wt', relPath: 'docs/design.md' }).body, { expectedMetaRev: 4, bindingId: 'bnd_wt' });
  assert.deepEqual(relocatePayload(v, { bindingId: 'bnd_wt', relPath: 'x.md' }).body, { expectedMetaRev: 4, bindingId: 'bnd_wt', relPath: 'x.md' });
  assert.match(relocatePayload(v, { relPath: '../x' }).error, /\.\./);
});

// 责任：确认载荷须带 metaRev/完整 hash，截断场景需明确确认而不能默认放行。
test('confirmPayload carries expectedMetaRev and expectedContentHash and gates on truncation', () => {
  const v = view();
  assert.deepEqual(confirmPayload(v, false).body, { expectedMetaRev: 4, expectedContentHash: HASH });
  const truncated = view({ observation: Object.assign({}, v.observation, { preview: { text: 'ab', truncated: true, totalBytes: 99 } }) });
  assert.match(confirmPayload(truncated, false).error, /预览已截断/);
  assert.deepEqual(confirmPayload(truncated, true).body, { expectedMetaRev: 4, expectedContentHash: HASH });
  const noHash = view({ availability: 'oversize', code: 'oversize', observation: Object.assign({}, v.observation, { contentHash: null, previewable: false }) });
  assert.match(confirmPayload(noHash, true).error, /无法确认/);
  assert.match(confirmPayload(view({ unregistered: true }), true).error, /已解除登记/);
  assert.match(confirmPayload(null, true).error, /尚未观测/);
});

// 责任：注销 reason 可省略，载荷仍须保留并发版本守卫。
test('unregisterPayload keeps the reason optional', () => {
  assert.deepEqual(unregisterPayload(view(), '').body, { expectedMetaRev: 4 });
  assert.deepEqual(unregisterPayload(view(), ' 不再需要 ').body, { expectedMetaRev: 4, reason: '不再需要' });
  assert.match(unregisterPayload(view({ unregistered: true }), '').error, /已解除登记/);
});

// 责任：stale-revision 须提示重新读取，不能自动重放旧写请求。
test('externalErrorView: stale-revision asks for a re-read and never replays', () => {
  const meta = externalErrorView({ code: 'stale-revision', details: { currentMetaRev: 7 } });
  assert.equal(meta.action, 'reinspect');
  assert.match(meta.message, /重新读取后再重试/);
  assert.match(meta.message, /metaRev 7/);
  const content = externalErrorView({ code: 'stale-revision', details: { currentContentHash: HASH } });
  assert.equal(content.action, 'reinspect');
  assert.match(content.message, /内容在上次观测之后变了/);
});

// 责任：旧操作打到外置记录须指向外置面板，各 availability 错误给明确下一步。
test('externalErrorView: operation-required points at the external panel; availability codes explain the next step', () => {
  const required = externalErrorView({ code: 'external-doc-operation-required' });
  assert.equal(required.action, 'use-external');
  assert.match(required.message, /外置文档面板/);
  const missing = externalErrorView({ code: 'file-missing' });
  assert.match(missing.message, /路径不存在|没有这个路径/);
  assert.equal(missing.action, 'reinspect');
  assert.equal(externalErrorView({ code: 'illegal-transition' }).action, 'reinspect');
  assert.match(externalErrorView({ code: 'missing-binding' }).message, /bindingId/);
  assert.match(externalErrorView({ code: 'bindings-unreadable' }).message, /稍后重试/);
  assert.equal(externalErrorView({ message: 'boom' }).message, 'boom');
  assert.equal(externalErrorText({ code: 'x', message: 'boom' }), 'boom [x]');
});

// 责任：登记/重定位目标被拒时须解释目标问题，不能循环建议再重定位。
test('targetErrorView explains a rejected register/relocate target without suggesting relocate again', () => {
  const view1 = targetErrorView({ code: 'file-missing' });
  assert.equal(view1.action, null);
  assert.match(view1.message, /此刻存在的普通文件/);
  assert.ok(!/重定位/.test(view1.message));
  assert.equal(targetErrorView({ code: 'stale-revision', details: { currentMetaRev: 2 } }).action, 'reinspect');
});
// ---------------------------------------------------------------- review fixes

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PENDING_LIST_SCHEMA, ackMatches, currentRecord, guardForm, nextListSchema, observationKey, schemaBlock, usableView,
} from '../../../src/client/model/external-docs.ts';

// 责任：两个页面分别持 rev4/rev5 时旧草稿须仍发送 rev4，禁止偷偷用最新版本绕过 CAS。
test('MAJOR-1 two pages: a draft opened on rev 4 is never submitted with the newer rev 5', () => {
  const opened = view();
  const mode = { name: 'meta', metaRev: opened.metaRev, hash: HASH };
  const draft = { title: 'old', kind: 'design', status: 'draft' };
  const other = view({ doc: record({ rev: 5, title: 'new', status: 'in_review' }), metaRev: 5 });
  assert.equal(guardForm(mode, opened), '');
  assert.match(guardForm(mode, other), /登记信息已变化（metaRev 4 → 5），表单已关闭.*草稿没有提交/);
  const stale = metaPayload(other, draft, { baseRev: mode.metaRev });
  assert.equal(stale.body, undefined, 'no body is built from the stale draft');
  assert.match(stale.error, /草稿没有提交/);
  for (const result of [
    relocatePayload(other, { relPath: 'docs/x.md' }, { baseRev: 4 }),
    unregisterPayload(other, '', { baseRev: 4 }),
    confirmPayload(other, true, { baseRev: 4 }),
  ]) {
    assert.equal(result.body, undefined);
    assert.match(result.error, /登记信息已变化/);
  }
  assert.deepEqual(metaPayload(opened, { title: '改', kind: 'design', status: 'adopted', reason: '通过' }, { baseRev: 4 }).body, { expectedMetaRev: 4, title: '改', status: 'adopted', reason: '通过' });
});

// 责任：确认表单打开后 hash 改变须关闭并废除旧截断确认，不能沿用旧授权。
test('MAJOR-1 confirm: the form closes and the truncation ack is void when the file hash changes', () => {
  const truncatedObs = (hash) => Object.assign({}, view().observation, { contentHash: hash, preview: { text: 'ab', truncated: true, totalBytes: 99 } });
  const first = view({ observation: truncatedObs(HASH) });
  const changed = view({ observation: truncatedObs('c'.repeat(64)) });
  const mode = { name: 'confirm', metaRev: 4, hash: HASH };
  assert.equal(guardForm(mode, first), '');
  assert.match(guardForm(mode, changed), /文件内容已变化/);
  assert.match(confirmPayload(changed, true, { baseRev: 4, baseHash: HASH }).error, /文件内容已变化/);
  assert.equal(ackMatches(HASH, first), true);
  assert.equal(ackMatches(HASH, changed), false, 'an ack given for one hash does not carry to another');
  assert.equal(ackMatches(null, first), false);
  assert.match(confirmPayload(first, ackMatches('c'.repeat(64), first), { baseRev: 4, baseHash: HASH }).error, /预览已截断/);
  assert.equal(confirmPayload(first, ackMatches(HASH, first), { baseRev: 4, baseHash: HASH }).body.expectedContentHash, HASH);
  assert.match(guardForm({ name: 'meta', metaRev: 4 }, view({ unregistered: true })), /已被解除/);
});

// 责任：列表每次 reload 须改变 observationKey，注销行不参加 inspect 目标。
test('MAJOR-2 observationKey changes with every list reload and ignores tombstones', () => {
  const rows = mergeDocRows([], [record(), record({ id: 'doc_2', unregistered: { at: 't' } })]);
  assert.equal(observationKey(rows, 1), observationKey(rows, 1));
  assert.notEqual(observationKey(rows, 1), observationKey(rows, 2), 'same rev, new reload => new key');
  assert.ok(!observationKey(rows, 1).includes('doc_2'));
  assert.notEqual(observationKey(rows, 1), observationKey(mergeDocRows([], [record({ rev: 5 })]), 1));
});

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
let esbuild = null;
try { esbuild = createRequire(path.join(REPO, 'tools', 'build', 'package.json'))('esbuild'); } catch { esbuild = null; }

const REACT_STUB = `
const store = globalThis.__hookStore;
export default {
  createContext(value) { return { value, Provider: 'context-provider' }; },
  useContext(context) { return context.value; },
  useCallback(fn) { return fn; },
  createElement(type, props, ...children) { return { type, props: props || {}, children }; },
  useState(initial) {
    const k = store.stateIndex++;
    if (!(k in store.slots)) store.slots[k] = typeof initial === 'function' ? initial() : initial;
    return [store.slots[k], (v) => { store.slots[k] = typeof v === 'function' ? v(store.slots[k]) : v; }];
  },
  useEffect(fn, deps) {
    const k = store.effectIndex++;
    const prev = store.deps[k];
    const changed = !prev || !deps || deps.some((d, i) => !Object.is(d, prev[i]));
    store.deps[k] = deps;
    if (changed) store.pending.push(fn);
  },
  useRef(v) { return { current: v === undefined ? null : v }; },
};`;

// 责任：hook 列表版本变化时即使行字段未变也须重新 inspect。
test('MAJOR-2 hook: a reload (version change) issues new inspect requests for unchanged rows', { skip: esbuild ? false : 'esbuild is not installed (npm --prefix tools/build install)' }, async () => {
  const built = await esbuild.build({
    stdin: { contents: "export { useExternalObservations } from './src/client/pages/doc-list.tsx';", resolveDir: REPO, loader: 'js' },
    bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'error',
    plugins: [{ name: 'react-stub', setup(build) {
      build.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'stub' }));
      build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: REACT_STUB, loader: 'js' }));
    } }],
  });
  const store = globalThis.__hookStore = { slots: [], deps: [], pending: [], stateIndex: 0, effectIndex: 0 };
  const urls = [];
  const realFetch = globalThis.fetch;
  globalThis.__PROJECT_BOARD__ = { token: 't', base: 'http://x' };
  globalThis.fetch = async (url) => { urls.push(String(url)); return { ok: true, statusText: 'OK', text: async () => JSON.stringify({ ok: true, schemaVersion: 1, doc: record(), metaRev: 4 }) }; };
  try {
    const mod = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
    const rows = mergeDocRows([], [record(), record({ id: 'doc_2', unregistered: { at: 't' } })]);
    const render = async (version) => {
      store.stateIndex = 0; store.effectIndex = 0;
      mod.useExternalObservations('prj_1', rows, version);
      const run = store.pending.splice(0);
      run.forEach((fn) => fn());
      await new Promise((resolve) => setTimeout(resolve, 20));
    };
    await render(1);
    assert.equal(urls.length, 1, 'first load inspects the live row only');
    await render(1);
    assert.equal(urls.length, 1, 'a re-render without a reload does not re-inspect');
    await render(2);
    assert.equal(urls.length, 2, 'a list reload re-inspects although id:rev is unchanged');
    assert.ok(urls.every((url) => url.includes('/docs/external/doc_1') && !url.includes('doc_2')));
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.__PROJECT_BOARD__;
    delete globalThis.__hookStore;
  }
});

// 责任：未知列表 schemaVersion 须使整个外置面板只读，不能部分写入。
test('MAJOR-3 unknown list schemaVersion makes the whole external panel read-only', () => {
  const v2 = { version: 2 };
  assert.equal(schemaBlock(null), '');
  assert.equal(schemaBlock({ version: 1 }), '');
  assert.match(schemaBlock(v2), /schemaVersion 是 2.*只读/);
  assert.match(schemaBlock({ version: undefined }), /schemaVersion 是 undefined/);
  assert.match(writeBlock(view(), v2), /只读/);
  assert.match(confirmBlock(view(), v2), /只读/);
  assert.match(registerPayload({ title: 't', relPath: 'a.md' }, { listSchema: v2 }).error, /只读/);
  assert.deepEqual(registerPayload({ title: 't', relPath: 'a.md' }, { listSchema: { version: 1 } }).body, { title: 't', kind: 'note', relPath: 'a.md' });
  for (const result of [
    metaPayload(view(), { title: 'x' }, { listSchema: v2 }),
    relocatePayload(view(), { relPath: 'x.md' }, { listSchema: v2 }),
    confirmPayload(view(), true, { listSchema: v2 }),
    unregisterPayload(view(), '', { listSchema: v2 }),
  ]) {
    assert.equal(result.body, undefined);
    assert.match(result.error, /只读/);
  }
  assert.match(guardForm({ name: 'meta', metaRev: 4 }, view(), v2), /只读/, 'an open form closes when the list turns read-only');
});

// 责任：注销状态以最新列表行优先，旧 inspect 或缺 inspect 不能复活记录。
test('MINOR-1 tombstones come from the newest row, not an older inspect or a missing one', () => {
  const tomb = record({ rev: 6, status: 'archived', unregistered: { at: 't', by: 'x', reason: 'r' } });
  const first = statusDimensions(tomb, null);
  assert.equal(first[1].label, '已解除登记', 'first load, never inspected');
  assert.equal(first[0].label, '已归档');
  const olderView = view();
  const afterOtherPage = statusDimensions(tomb, olderView);
  assert.equal(afterOtherPage[1].label, '已解除登记', 'a stale readable inspect must not win');
  assert.equal(afterOtherPage[0].label, '已归档', 'management comes from the row');
  assert.equal(afterOtherPage[2].label, '未观测');
  assert.equal(afterOtherPage[3].label, '未观测 Git');
  assert.equal(availabilityView(olderView, tomb).label, '已解除登记');
  assert.equal(availabilityView(olderView).label, '可读', 'single-argument form is unchanged');
  assert.equal(currentRecord(tomb, olderView), tomb);
  assert.equal(usableView(tomb, olderView), null);
  const tombView = view({ doc: tomb, metaRev: 6, unregistered: true, availability: null, observation: null, confirmation: { state: 'not_comparable', reason: 'unregistered', baseline: {} } });
  assert.equal(usableView(tomb, tombView), tombView);
  assert.equal(statusDimensions(tomb, tombView)[2].reason, '文档已解除登记');
});

// 责任：更新的活记录也须使旧 inspect 失效，不继续展示陈旧确认。
test('MINOR-1 a newer live row also invalidates an older inspect', () => {
  const row = record({ rev: 5, status: 'adopted' });
  const dims = statusDimensions(row, view());
  assert.equal(dims[0].label, '已采纳');
  assert.equal(dims[1].label, '未观测', 'the old observation predates this registration revision');
  assert.equal(statusDimensions(record(), view())[1].label, '可读');
});

// 责任：只有成功且 schemaVersion 恰为 1 的列表响应可解锁，未知或失败不能恢复写入。
test('FAIL-CLOSED nextListSchema: only a successful response of exactly 1 unlocks writes', () => {
  const v2 = nextListSchema(PENDING_LIST_SCHEMA, { ok: true, schemaVersion: 2 });
  assert.match(schemaBlock(v2), /只读/);
  assert.equal(nextListSchema(v2, { ok: false, reason: new Error('boom') }), v2, 'a failed refresh keeps the read-only value');
  assert.match(schemaBlock(nextListSchema(v2, { ok: false })), /schemaVersion 是 2/);
  assert.match(schemaBlock(PENDING_LIST_SCHEMA), /还没有收到/, 'never loaded => read-only, not writable by default');
  assert.match(schemaBlock(nextListSchema(null, { ok: false })), /还没有收到/);
  assert.match(schemaBlock(nextListSchema(PENDING_LIST_SCHEMA, { ok: true, schemaVersion: undefined })), /只读/);
  const v1 = nextListSchema(v2, { ok: true, schemaVersion: 1 });
  assert.equal(schemaBlock(v1), '');
  assert.equal(nextListSchema(v1, { ok: false }), v1, 'a failed refresh keeps a known-good 1');
});

// 责任：hook 从 schema2 经过刷新失败须持续只读，直到成功 schema1 才恢复写。
test('FAIL-CLOSED hook: schemaVersion 2 -> failed refresh stays read-only -> successful 1 restores writes', { skip: esbuild ? false : 'esbuild is not installed (npm --prefix tools/build install)' }, async () => {
  const built = await esbuild.build({
    stdin: { contents: "export { useDocRows } from './src/client/pages/doc-list.tsx';", resolveDir: REPO, loader: 'js' },
    bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'error',
    plugins: [{ name: 'react-stub', setup(build) {
      build.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'stub' }));
      build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: REACT_STUB, loader: 'js' }));
    } }],
  });
  const store = globalThis.__hookStore = { slots: [], deps: [], pending: [], stateIndex: 0, effectIndex: 0 };
  const realFetch = globalThis.fetch;
  let externalList = { status: 200, schemaVersion: 2 };
  globalThis.__PROJECT_BOARD__ = { token: 't', base: 'http://x' };
  globalThis.fetch = async (url) => {
    const external = String(url).includes('/docs/external');
    if (external && externalList.status !== 200) return { ok: false, status: externalList.status, statusText: 'err', text: async () => JSON.stringify({ ok: false, error: { code: 'internal', message: 'down' } }) };
    const body = external ? { ok: true, schemaVersion: externalList.schemaVersion, docs: [record()] } : { ok: true, docs: [] };
    return { ok: true, statusText: 'OK', text: async () => JSON.stringify(body) };
  };
  try {
    const mod = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
    const render = () => { store.stateIndex = 0; store.effectIndex = 0; return mod.useDocRows('prj_1'); };
    const writes = (list) => {
      const listSchema = list.externalSchema;
      const v = view();
      return {
        register: registerPayload({ title: 't', relPath: 'a.md' }, { listSchema }),
        meta: metaPayload(v, { title: 'x' }, { listSchema }),
        relocate: relocatePayload(v, { relPath: 'x.md' }, { listSchema }),
        confirm: confirmPayload(v, true, { listSchema }),
        unregister: unregisterPayload(v, '', { listSchema }),
        action: writeBlock(v, listSchema),
        confirmButton: confirmBlock(v, listSchema),
      };
    };
    const blocked = (w) => Object.entries(w).every(([key, value]) => (typeof value === 'string' ? /只读|还没有收到/.test(value) : (value.body === undefined && /只读|还没有收到/.test(value.error))));

    assert.match(schemaBlock(render().externalSchema), /还没有收到/, 'before the first response');
    await render().reload();
    assert.ok(blocked(writes(render())), 'schemaVersion 2 => register and all four write actions are blocked');
    assert.match(schemaBlock(render().externalSchema), /schemaVersion 是 2/);

    externalList = { status: 503 };
    await render().reload();
    const afterFailure = render();
    assert.ok(afterFailure.error, 'the failure is surfaced');
    assert.match(schemaBlock(afterFailure.externalSchema), /schemaVersion 是 2/, 'the last known value is kept');
    assert.ok(blocked(writes(afterFailure)), 'still read-only after a failed refresh');

    externalList = { status: 200, schemaVersion: 1 };
    await render().reload();
    const restored = render();
    assert.equal(schemaBlock(restored.externalSchema), '');
    const w = writes(restored);
    assert.deepEqual(w.register.body, { title: 't', kind: 'note', relPath: 'a.md' });
    assert.equal(w.meta.body.expectedMetaRev, 4);
    assert.equal(w.relocate.body.expectedMetaRev, 4);
    assert.equal(w.confirm.body.expectedContentHash, HASH);
    assert.equal(w.unregister.body.expectedMetaRev, 4);
    assert.equal(w.action, '');
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.__PROJECT_BOARD__;
    delete globalThis.__hookStore;
  }
});
