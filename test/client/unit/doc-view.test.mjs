/**
 * 测试职责：约束文档列表的单一提醒信号、分组/筛选与默认信息层级。
 * 典型流程：合成登记行和观测 → 调用纯展示选择器 → 对照标签、分组、确认入口与折叠字段。
 * 覆盖边界：覆盖 显示逻辑及文案选择；不覆盖 React DOM、视觉布局或真实 HTTP。
 * 外部前置：无；直接导入客户端纯 ES 模块。
 */
/**
 * Pure display-selection tests for the docs page (doc-view.js): the single
 * row signal, filters, folder grouping, the one-line status, the banner,
 * when "confirm" is offered and which fields go to the folded section.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DOC_FILTERS, attentionNotice, confirmOffer, filterCounts, filterMatches, groupDocRows, headerMeta,
  rowSignal, rowSubline, shortDate, splitRelPath, statusLine, technicalSections,
} from '../../../src/client/model/doc-view.ts';

const HASH = 'b'.repeat(64);
const NOW = '2026-11-04T12:00:00.000Z';
const UNREADABLE = [
  'missing', 'root_unavailable', 'missing_binding', 'permission_denied', 'outside_root',
  'security_rejected', 'not_regular', 'oversize', 'undecodable', 'unstable',
];

function record(extra) {
  return Object.assign({
    id: 'doc_1', source: 'external', rev: 3, title: '外置文档登记', kind: 'spec', status: 'draft',
    locator: { bindingId: 'bnd_main', relPath: 'docs/specs/EXTERNAL-DOCS.md' },
    links: { taskIds: [], planRefs: [] }, baseline: null, baselineInContext: false, unregistered: null,
    updatedAt: '2026-11-03T08:05:00.000Z',
  }, extra);
}

function view(extra, doc) {
  const rec = doc || record();
  return Object.assign({
    schemaVersion: 1, doc: rec, metaRev: rec.rev, unregistered: false, availability: 'readable', code: null,
    observation: {
      observedAt: '2026-11-04T11:00:00.000Z', cached: true,
      context: { bindingId: 'bnd_main', root: 'D:\\ws', relPath: rec.locator.relPath, role: 'main' },
      contentHash: HASH, size: 10, previewable: true, detail: null,
    },
    confirmation: { state: 'unconfirmed', baseline: null },
    git: { state: 'ignored' },
  }, extra);
}

const confirmed = record({
  baseline: { contentHash: HASH, bindingId: 'bnd_main', relPath: 'docs/specs/EXTERNAL-DOCS.md', confirmedAt: '2026-11-04T06:04:10.000Z', confirmedBy: { kind: 'human', via: 'web' } },
  baselineInContext: true,
});

// 责任：同年日期须省略年份，跨年保留年份，非法/空日期须安全返回。
test('shortDate drops the year within the same year and keeps it otherwise', () => {
  assert.equal(shortDate('2026-11-03T08:05:00.000Z', NOW).length, 5);
  assert.match(shortDate('2025-01-02T08:05:00.000Z', NOW), /^2025-01-0\d$/);
  assert.match(shortDate('2026-11-03T08:05:00.000Z', NOW, true), /^11-0\d \d\d:\d\d$/);
  assert.equal(shortDate('', NOW), '');
  assert.equal(shortDate('not a date', NOW), 'not a date');
});

// 责任：拆分相对路径须分开目录和文件名，根文件及 undefined 有明确空目录/空名。
test('splitRelPath separates folder and file name', () => {
  assert.deepEqual(splitRelPath('private/docs/notes/a.md'), { dir: 'private/docs/notes', name: 'a.md' });
  assert.deepEqual(splitRelPath('README.md'), { dir: '', name: 'README.md' });
  assert.deepEqual(splitRelPath(undefined), { dir: '', name: '' });
});

// 责任：普通未确认/匹配行须安静，内容改变或定位变化才给醒目提醒且保留读屏文案。
test('row signal: quiet for the common cases, loud only when a person must act', () => {
  assert.equal(rowSignal({ id: 'doc_i', source: 'inline', title: 'x' }).key, 'inline');
  assert.equal(rowSignal(record(), null).key, 'unobserved');
  const unconfirmed = rowSignal(record(), view());
  assert.equal(unconfirmed.key, 'unconfirmed');
  assert.equal(unconfirmed.label, '', 'unconfirmed rows stay quiet');
  assert.equal(unconfirmed.attention, false);
  assert.equal(unconfirmed.srText, '未确认', 'screen readers still hear the state');
  const matched = rowSignal(confirmed, view({ confirmation: { state: 'matches_baseline' } }, confirmed));
  assert.equal(matched.key, 'matched');
  assert.equal(matched.label, '');
  const changed = rowSignal(confirmed, view({ confirmation: { state: 'changed_since_confirm' } }, confirmed));
  assert.deepEqual([changed.key, changed.label, changed.attention], ['changed', '已改动', true]);
  const relocated = rowSignal(record(), view({ confirmation: { state: 'not_comparable', reason: 'relocated' } }));
  assert.deepEqual([relocated.key, relocated.attention], ['reconfirm', true]);
  assert.match(relocated.srText, /重定位/);
});

// 责任：所有不可读分类须有各自提醒，越界是 danger，未知分类须保守视为不可读。
test('row signal: every unreadable availability is an attention signal with its own label', () => {
  for (const availability of UNREADABLE) {
    const signal = rowSignal(record(), view({ availability, code: 'x', confirmation: { state: 'not_comparable', reason: 'no-complete-hash' } }));
    assert.equal(signal.key, 'unreadable', availability);
    assert.equal(signal.attention, true, availability);
    assert.ok(signal.label && signal.label !== '可读', availability);
    assert.ok(['warn', 'danger'].includes(signal.tone), availability);
  }
  assert.equal(rowSignal(record(), view({ availability: 'outside_root' })).tone, 'danger');
  assert.equal(rowSignal(record(), view({ availability: 'unsupported_format' })).key, 'unconfirmed', 'unsupported format is still confirmable');
  assert.equal(rowSignal(record(), view({ availability: 'brand_new_value' })).key, 'unreadable', 'unknown values are treated as unreadable');
});

// 责任：注销 tombstone 须压过旧观测，新元数据版本不得沿用旧 inspect 结论。
test('row signal: tombstones win over stale observations, and older observations are ignored', () => {
  const tomb = record({ rev: 4, unregistered: { at: NOW, by: 'human', reason: '' } });
  assert.equal(rowSignal(tomb, view()).key, 'tomb', 'an old live observation does not revive a tombstone');
  const newer = record({ rev: 5 });
  assert.equal(rowSignal(newer, view({ confirmation: { state: 'changed_since_confirm' } })).key, 'unobserved', 'an observation older than the record says nothing');
});

// 责任：混合未确认、改动、缺文件、注销与内嵌五行时，计数须为 all=5/attention=2/unconfirmed=1/tomb=1。
test('filters and counts agree with the row signal', () => {
  assert.deepEqual(DOC_FILTERS.map((f) => f.key), ['all', 'attention', 'unconfirmed', 'tomb']);
  const rows = [
    record({ id: 'a' }),
    Object.assign({}, confirmed, { id: 'b' }),
    Object.assign({}, confirmed, { id: 'c' }),
    record({ id: 'd', unregistered: { at: NOW } }),
    { id: 'e', source: 'inline', title: 'inline', kind: 'note', rev: 1 },
  ];
  const views = {
    a: view({ doc: rows[0] }),
    b: view({ doc: rows[1], confirmation: { state: 'changed_since_confirm' } }),
    c: view({ doc: rows[2], availability: 'missing', code: 'file-missing' }),
  };
  assert.deepEqual(filterCounts(rows, views), { all: 5, attention: 2, unconfirmed: 1, tomb: 1 });
  assert.equal(filterMatches('all', rowSignal(rows[4])), true);
  assert.equal(filterMatches('attention', rowSignal(rows[4])), false);
  assert.equal(filterMatches(undefined, null), true);
});

// 责任：按文件夹分组须保持最近更新时间顺序，注销行沉底且单绑定不重复显示机器 id。
test('groupDocRows groups by folder, keeps recency order and sinks tombstones', () => {
  const rows = [
    record({ id: 'n1', locator: { bindingId: 'bnd_main', relPath: 'private/docs/notes/d9.md' } }),
    record({ id: 's1', locator: { bindingId: 'bnd_main', relPath: 'docs/specs/A.md' }, unregistered: { at: NOW } }),
    { id: 'i1', source: 'inline', title: '档案', kind: 'note', rev: 2 },
    record({ id: 's2', locator: { bindingId: 'bnd_main', relPath: 'docs/specs/B.md' } }),
    record({ id: 'r1', locator: { bindingId: 'bnd_main', relPath: 'README.md' } }),
  ];
  const groups = groupDocRows(rows);
  assert.deepEqual(groups.map((g) => g.label), ['private/docs/notes', 'docs/specs', '看板内嵌', '（根目录）']);
  assert.deepEqual(groups[1].rows.map((r) => r.id), ['s2', 's1'], 'tombstone sinks to the end of its group');
  assert.ok(!groups.some((g) => /bnd_/.test(g.label)), 'a single binding is not repeated in group labels');
  assert.deepEqual(groupDocRows([]), []);
});

// 责任：两个绑定即使目录同名也须分组隔离，不能混成同一来源。
test('groupDocRows keeps two bindings apart even for the same folder', () => {
  const rows = [
    record({ id: 'a', locator: { bindingId: 'bnd_main', relPath: 'docs/a.md' } }),
    record({ id: 'b', locator: { bindingId: 'bnd_worktree_long_identifier', relPath: 'docs/a.md' } }),
  ];
  const groups = groupDocRows(rows);
  assert.equal(groups.length, 2);
  assert.ok(groups.every((g) => g.label.startsWith('docs · ')));
});

// 责任：外置行副标题须显示文件名，内嵌行显示类型和版本。
test('rowSubline shows the file name for external docs and kind + revision for inline ones', () => {
  assert.equal(rowSubline(record()), 'EXTERNAL-DOCS.md');
  assert.match(rowSubline({ source: 'inline', kind: 'note', rev: 4 }), /修订 4/);
});

// 责任：文档头元信息须有路径/类型/状态/时间，但不暴露 docId、bindingId 或 metaRev。
test('headerMeta lists path, kind, status and update time but no machine ids', () => {
  const parts = headerMeta(record(), NOW);
  assert.deepEqual(parts.map((p) => p.key), ['path', 'kind', 'status', 'updated']);
  assert.equal(parts[0].mono, true);
  assert.ok(!parts.some((p) => /doc_1|bnd_main|metaRev/.test(p.text)));
});

// 责任：状态行须分开可用性和确认状态，仅在有用时显示 Git 维度。
test('statusLine: availability and confirmation stay two parts; Git only when it matters', () => {
  const ok = statusLine(confirmed, view({ confirmation: { state: 'matches_baseline' } }, confirmed), NOW);
  assert.deepEqual(ok.parts.map((p) => p.key), ['availability', 'confirmation']);
  assert.deepEqual(ok.parts.map((p) => p.label), ['可读', '已确认，内容未变']);
  assert.equal(ok.parts[0].tone, 'success');
  assert.ok(ok.parts[1].detail, 'shows when it was confirmed');
  assert.equal(ok.git, null, 'ignored is not worth a mention by default');
  const modified = statusLine(record(), view({ git: { state: 'modified', unstaged: true } }));
  assert.match(modified.git.label, /未提交/);
  assert.equal(statusLine(record(), view({ git: { state: 'committed' } })).git, null);
  const changed = statusLine(confirmed, view({ confirmation: { state: 'changed_since_confirm' } }, confirmed), NOW);
  assert.equal(changed.parts[1].label, '确认后有改动');
  assert.match(changed.parts[1].detail, /上次确认/);
  const relocated = statusLine(record(), view({ confirmation: { state: 'not_comparable', reason: 'relocated' } }));
  assert.equal(relocated.parts[1].label, '需重新确认');
  const missing = statusLine(confirmed, view({ availability: 'missing', code: 'file-missing', git: null, confirmation: { state: 'not_comparable', reason: 'no-complete-hash' } }, confirmed), NOW);
  assert.deepEqual(missing.parts.map((p) => p.label), ['路径不存在', '确认无法比较']);
  assert.equal(statusLine(record(), null).parts[0].label, '尚未观测');
  assert.equal(statusLine(record({ unregistered: { at: NOW } }), view()).parts[0].key, 'tomb');
});

// 责任：普通文档无需 banner，异常文档须给补救提示且不能猜测已删除或换分支。
test('attentionNotice: nothing for normal docs, a remedy banner for the rest', () => {
  assert.equal(attentionNotice(record(), view()), null, 'unconfirmed alone is not a banner');
  assert.equal(attentionNotice(confirmed, view({ confirmation: { state: 'matches_baseline' } }, confirmed)), null);
  const changed = attentionNotice(confirmed, view({ confirmation: { state: 'changed_since_confirm' } }, confirmed));
  assert.equal(changed.kind, 'changed');
  assert.match(changed.hint, /确认当前内容/);
  assert.match(changed.hint, /不影响阅读/);
  const reconfirm = attentionNotice(record(), view({ confirmation: { state: 'not_comparable', reason: 'relocated' } }));
  assert.equal(reconfirm.kind, 'reconfirm');
  for (const availability of UNREADABLE) {
    const notice = attentionNotice(record(), view({ availability, code: 'x' }));
    assert.equal(notice.kind, 'unavailable', availability);
    assert.deepEqual(notice.actions, ['reinspect', 'relocate', 'unregister'], availability);
    assert.ok(notice.hint, availability);
    assert.ok(!/已被?删除|换了分支/.test(notice.title + notice.hint), availability);
  }
  const tomb = attentionNotice(record({ unregistered: { at: NOW } }), view());
  assert.equal(tomb.kind, 'tomb');
  assert.match(tomb.hint, /没有被删除/);
  assert.equal(attentionNotice(record(), null), null);
});

// 责任：确认按钮仅在可确认且有实际价值时出现，不能对不可读或已匹配状态误导操作。
test('confirmOffer: shown only when confirming is possible and useful', () => {
  const listOk = { version: 1 };
  assert.deepEqual(confirmOffer(view(), listOk), { show: true, reason: '' });
  assert.equal(confirmOffer(view({ confirmation: { state: 'changed_since_confirm' } }), listOk).show, true);
  assert.equal(confirmOffer(view({ confirmation: { state: 'not_comparable', reason: 'relocated' } }), listOk).show, true);
  assert.equal(confirmOffer(view({ confirmation: { state: 'matches_baseline' } }), listOk).show, false, 'no repeat of "already matching"');
  const noHash = view({ availability: 'oversize', observation: Object.assign({}, view().observation, { contentHash: null }) });
  assert.equal(confirmOffer(noHash, listOk).show, false, 'the banner explains why instead');
  assert.equal(confirmOffer(view({ availability: 'unsupported_format' }), listOk).show, true);
  assert.equal(confirmOffer(view({ unregistered: true }), listOk).show, false);
  assert.equal(confirmOffer(null, listOk).show, false);
  const readOnly = confirmOffer(view(), { version: 2 });
  assert.equal(readOnly.show, true, 'read-only keeps the button visible');
  assert.match(readOnly.reason, /只读/);
});

// 责任：默认界面省略的技术字段须完整进入折叠区，不得直接丢诊断。
test('technicalSections carries every field the default view leaves out', () => {
  const sections = technicalSections(confirmed, view({ code: null, git: { state: 'ignored' } }, confirmed), NOW);
  assert.deepEqual(sections.map((s) => s.key), ['source', 'baseline', 'git', 'ids']);
  const text = JSON.stringify(sections);
  for (const needle of ['bnd_main', 'D:\\\\ws', '主工作区', 'docs/specs/EXTERNAL-DOCS.md', '缓存结果', 'doc_1', 'metaRev', '已忽略', '.gitignore', 'human/web']) {
    assert.ok(text.includes(needle), 'technical section carries ' + needle);
  }
  const baselineRow = sections[1].rows.find((row) => row.label === '内容 hash');
  assert.equal(baselineRow.title, HASH, 'the full hash is one hover away');
  assert.equal(sections[1].note, '', 'an in-context baseline needs no audit note');
  const unconfirmed = technicalSections(record(), null, NOW);
  assert.equal(unconfirmed[1].rows.length, 0);
  assert.match(unconfirmed[1].note, /还没有确认/);
  assert.equal(unconfirmed[0].rows[3].value, '尚未观测');
  const missing = technicalSections(record(), view({ availability: 'missing', code: 'file-missing', git: null }));
  assert.ok(missing[3].rows.some((row) => row.value === 'file-missing'), 'the raw result code is kept for diagnosis');
});
