/**
 * 测试职责：冻结客户端 Markdown/图表/流程图、筛选分组、命令载荷与计划编辑的纯逻辑契约。
 * 典型流程：直接导入真实 ES 模块 → 输入合法/非法文本和任务/表单 fixture → 比较解析、几何与载荷。
 * 覆盖边界：覆盖 无 DOM 的可计算行为和安全链接规则；不覆盖浏览器视觉、真实宿主或网络。
 * 外部前置：无；不加载 React，不读取真实 localStorage。
 */
/**
 * Direct unit tests for the client pure-logic modules (M2-2).
 *
 * These import src/client/*.js as real ES modules: no bundle text scraping and
 * no React. Run with: node --test test/client/unit/logic.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { auditActorLabel, stateLabel, stateTone, errorText, warningText, reasonText, opLabel, planCanArchive, planCanFocus, taskCreatedId, evidenceObservation, DRIFT_WAIVER_LABELS } from '../../../src/client/model/labels.ts';
import { cx, clamp01, percentOf, ratioPercent, shortId, motionDurationMs, MOTION } from '../../../src/client/utils/format.ts';
import { isGate, cardHaystack, filterCards, hasActiveFilters } from '../../../src/client/model/filters.ts';
import { GROUP_MODES, GROUP_OPTIONS, groupTasks, normalizeGroupMode } from '../../../src/client/model/grouping.ts';
import { inlineRuns, splitTableRow, tableAlign, isTableStart, linkTarget, markdownBlocks, docDirty, docHeadings, matchDocText } from '../../../src/client/utils/markdown.ts';
import { parseChartSpec, chartOptions, chartLayout, chartScale, slicePath, CHART_TYPES, CHART_COLORS } from '../../../src/client/utils/chart.ts';
import { parseFlowSpec, flowLayout, flowTextWidth } from '../../../src/client/utils/flow.ts';
import { safeFileName } from '../../../src/client/utils/export.ts';
import { buildEvidence, commandBody, createTaskPayload, docLinkPayload, initialPreview } from '../../../src/client/model/payloads.ts';
import { normalizeView, defaultFilters, normalizeFilters } from '../../../src/client/model/storage.ts';
import {
  priorityRanks, planStepTitle, needYouCount, rankTier, planCatalog, planMeta,
  normalizeWorkspacePath, comparablePath, matchProjectByCwd,
  pickTaskSession, pickLatestSession,
} from '../../../src/client/model/selectors.ts';
import {
  planEditAddStep, planEditAddTask, planEditDiff, planEditPatchStep, planEditPatchTask,
  planEditPayload, planEditPublishPayload, planEditRemoveStep, planEditRemoveTask,
  planEditSeed, planEditSplitLines, planEditSplitList, planEditSteps,
} from '../../../src/client/model/plan-edit.ts';

const TICK = '\u0060';
const FENCE = TICK.repeat(3);

// ------------------------------------------------------------------ markdown

// 责任：混合 Markdown 文本须按标题/段落/引用/分割/无序及有序列表分块并保留列表起号。
test('markdownBlocks: headings, paragraph, quote, hr, list', () => {
  const blocks = markdownBlocks('# 一\n\n正文\n\n> 引用\n\n---\n\n- 甲\n- 乙\n\n1. 丙\n2. 丁');
  assert.deepEqual(blocks.map((block) => block.type), ['heading', 'paragraph', 'quote', 'hr', 'list', 'list']);
  assert.equal(blocks[0].level, 1);
  assert.equal(blocks[2].text, '引用');
  assert.deepEqual(blocks[4].items, ['甲', '乙']);
  assert.equal(blocks[5].ordered, true);
  assert.equal(blocks[5].start, 1);
});

// 责任：围栏代码须保留完整 info 与正文，未匹配行也必须前进一次避免死循环。
test('markdownBlocks: fenced code keeps the info string and never loops', () => {
  const blocks = markdownBlocks(FENCE + 'chart type=bar title=X\nA 1\nB 2\n' + FENCE);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'code');
  assert.equal(blocks[0].lang, 'chart');
  assert.equal(blocks[0].info, 'chart type=bar title=X');
  assert.equal(blocks[0].text, 'A 1\nB 2');
  // a line every branch declines is still consumed exactly once
  const stray = markdownBlocks('\u0060\u0060 stray');
  assert.equal(stray.length, 1);
  assert.equal(stray[0].type, 'paragraph');
  assert.equal(stray[0].text, '\u0060\u0060 stray');
});

// 责任：GFM 表格须保留对齐、补空单元格及转义竖线，列数不匹配不能误判表格。
test('markdownBlocks: GFM table with alignment, padding and escaped pipes', () => {
  const blocks = markdownBlocks('| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 |\n| x\\|y | 4 | 5 |');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'table');
  assert.deepEqual(blocks[0].align, ['left', 'center', 'right']);
  assert.deepEqual(blocks[0].header, ['a', 'b', 'c']);
  assert.deepEqual(blocks[0].rows[0], ['1', '2', '']);
  assert.deepEqual(blocks[0].rows[1], ['x|y', '4', '5']);
  // a header whose cell count differs from the delimiter row is not a table
  assert.equal(isTableStart(['a | b', '| --- |'], 0), false);
  assert.equal(isTableStart(['a | b', '| --- | --- |'], 0), true);
});

// 责任：拆表格行须忽略外侧竖线，非合法分隔行须返回 null。
test('splitTableRow / tableAlign ignore outer pipes and reject non-delimiters', () => {
  assert.deepEqual(splitTableRow('| a | b |'), ['a', 'b']);
  assert.deepEqual(splitTableRow('a|b'), ['a', 'b']);
  assert.deepEqual(tableAlign('| --- | :--: |'), ['left', 'center']);
  assert.equal(tableAlign('| a | --- |'), null);
});

// 责任：行内粗体/代码/链接须正确分段，javascript 和相对路径链接须拒绝。
test('markdownBlocks: inline runs and links', () => {
  const runs = inlineRuns('前 **粗** 中 ' + TICK + '码' + TICK + ' 后');
  assert.deepEqual(runs.map((run) => run.type), ['text', 'strong', 'text', 'code', 'text']);
  assert.equal(runs[1].text, '粗');
  assert.equal(runs[3].text, '码');
  const link = inlineRuns('见 [文档](https://example.com/x)')[1];
  assert.equal(link.type, 'link');
  assert.equal(link.href, 'https://example.com/x');
  assert.deepEqual(linkTarget('https://example.com/x'), { href: 'https://example.com/x', external: true });
  assert.deepEqual(linkTarget('mailto:a@b.c'), { href: 'mailto:a@b.c', external: false });
  assert.equal(linkTarget('javascript:alert(1)'), null);
  assert.equal(linkTarget('docs/a.md'), null);
});

// 责任：同稿不脏、改标题或切文档须变脏；目录保留标题顺序，搜索忽略大小写且长片段带省略号。
test('markdown helpers: docDirty / docHeadings / matchDocText', () => {
  assert.equal(docDirty({ docId: 'd1', title: 'T', body: 'B' }, { title: 'T', body: 'B' }, 'd1'), false);
  assert.equal(docDirty({ docId: 'd1', title: 'T', body: 'B' }, { title: 'T2', body: 'B' }, 'd1'), true);
  assert.equal(docDirty({ docId: 'd1' }, { title: '', body: '' }, 'd2'), true);
  assert.deepEqual(docHeadings(markdownBlocks('# A\n\n## B')), [
    { index: 0, level: 1, text: 'A' },
    { index: 1, level: 2, text: 'B' },
  ]);
  assert.deepEqual(matchDocText('abc', ''), { hit: true, snippet: '' });
  assert.equal(matchDocText('hello world', 'WORLD').hit, true);
  assert.equal(matchDocText('hello', 'nope').hit, false);
  assert.ok(matchDocText('x'.repeat(200) + 'needle', 'needle').snippet.startsWith('…'));
});

// --------------------------------------------------------------------- chart

// 责任：四类图表可解析，非法行/数值/类型必须报错，不能产生错误数据点。
test('chart: parseChartSpec accepts the four types and validates rows', () => {
  assert.deepEqual(CHART_TYPES, ['bar', 'line', 'pie', 'donut']);
  assert.ok(Array.isArray(CHART_COLORS) && CHART_COLORS.length >= 4);
  const bar = parseChartSpec('chart type=bar title="任务状态" unit=个', '待办 3\n就绪 4\n# 注释\n进行中 1');
  assert.equal(bar.ok, true);
  assert.deepEqual(bar.spec, {
    type: 'bar',
    title: '任务状态',
    unit: '个',
    items: [
      { label: '待办', value: 3 },
      { label: '就绪', value: 4 },
      { label: '进行中', value: 1 },
    ],
  });
  assert.equal(parseChartSpec('type=pie', 'A 1\nB 3').spec.type, 'pie');
  assert.equal(parseChartSpec('type=donut', 'A 1\nB 3').spec.type, 'donut');
  assert.equal(parseChartSpec('type=radar', 'A 1').ok, false);
  assert.equal(parseChartSpec('', '').ok, false);
  assert.equal(parseChartSpec('', '没有数字').ok, false);
  assert.equal(parseChartSpec('type=pie', 'A -1\nB 2').ok, false);
  assert.equal(parseChartSpec('type=pie', 'A 0').ok, false);
  assert.equal(parseChartSpec('', Array.from({ length: 25 }, (_, i) => '列' + i + ' ' + (i + 1)).join('\n')).ok, false);
  assert.deepEqual(chartOptions('type=bar title="x y"'), { type: 'bar', title: 'x y' });
});

// 责任：值 8 的柱须高于值 3，折线生成点；饼图份额和须为 1，环图必须有内半径。
test('chart: chartLayout geometry for bar, line and pie', () => {
  const spec = parseChartSpec('type=bar unit=个', 'A 3\nB 8').spec;
  const bar = chartLayout(spec);
  assert.equal(bar.kind, 'bar');
  assert.equal(bar.shapes.length, 2);
  assert.ok(bar.shapes[1].height > bar.shapes[0].height);
  assert.equal(bar.ticks.length, 5);
  assert.ok(bar.labels.every((label) => typeof label.text === 'string'));

  const line = chartLayout(parseChartSpec('type=line', 'A 1\nB 2').spec);
  assert.ok(line.shapes.every((shape) => shape.kind === 'point'));

  const pie = chartLayout(parseChartSpec('type=pie', 'A 1\nB 3').spec);
  assert.equal(pie.kind, 'pie');
  assert.equal(pie.slices.length, 2);
  assert.ok(Math.abs(pie.slices.reduce((sum, slice) => sum + slice.share, 0) - 1) < 1e-9);
  assert.ok(chartLayout(parseChartSpec('type=donut', 'A 1\nB 1').spec).inner > 0);
});

// 责任：图表数值轴须包含零，饼图扇形 path 须正确闭合。
test('chart: chartScale keeps zero in range and slicePath closes the arc', () => {
  const scale = chartScale(2, 6, 100);
  assert.equal(scale.lo, 0);
  assert.equal(scale.hi, 6);
  assert.equal(scale.at(0), 100);
  assert.equal(chartScale(0, 0, 100).hi, 1);
  const piePath = slicePath(10, 10, 5, 0, 0, Math.PI / 2);
  assert.ok(piePath.startsWith('M 10 10 L'));
  assert.ok(piePath.endsWith('Z'));
  const donutPath = slicePath(10, 10, 5, 2, 0, Math.PI / 2);
  assert.ok(donutPath.includes('A 5 5'));
  assert.ok(donutPath.includes('A 2 2'));
});

// ------------------------------------------------------------------- filters

const cards = [
  { id: 'tsk_a', title: '修复登录', state: 'ready', labels: [], priority: 100, updatedAt: '2026-01-01' },
  { id: 'tsk_b', title: '写文档', state: 'review', labels: ['gate:audit'], priority: 200, updatedAt: '2026-01-02' },
  { id: 'tsk_c', title: '上线', state: 'in_progress', requiresAudit: true, owner: { sessionId: 's1' }, planRef: { planId: 'p1', stepId: 's2' } },
];

// 责任：查询、状态、审计门和计划成员筛选须共同约束返回卡片。
test('filterCards: query, state, gate-only and plan membership', () => {
  assert.equal(filterCards(cards, {}).length, 3);
  assert.deepEqual(filterCards(cards, { query: '登录' }).map((card) => card.id), ['tsk_a']);
  assert.deepEqual(filterCards(cards, { query: 'S1' }).map((card) => card.id), ['tsk_c']);
  assert.deepEqual(filterCards(cards, { state: 'review' }).map((card) => card.id), ['tsk_b']);
  assert.deepEqual(filterCards(cards, { gateOnly: true }).map((card) => card.id), ['tsk_b', 'tsk_c']);
  assert.deepEqual(filterCards(cards, { plan: 'in' }).map((card) => card.id), ['tsk_c']);
  assert.deepEqual(filterCards(cards, { plan: 'out' }).map((card) => card.id), ['tsk_a', 'tsk_b']);
  assert.equal(filterCards(null, {}).length, 0);
  assert.equal(filterCards([null], {}).length, 0);
});

// 责任：审计门识别、卡片搜索文本及活跃过滤标志须覆盖标签和空条件。
test('isGate / cardHaystack / hasActiveFilters', () => {
  assert.equal(isGate({ requiresAudit: true }), true);
  assert.equal(isGate({ labels: ['gate:audit'] }), true);
  assert.equal(isGate({ labels: [] }), false);
  assert.equal(isGate(null), false);
  assert.equal(cardHaystack(cards[2]).includes('s1'), true);
  assert.equal(cardHaystack(cards[2]).includes('p1'), true);
  assert.equal(hasActiveFilters({}), false);
  assert.equal(hasActiveFilters({ query: '  ' }), false);
  assert.equal(hasActiveFilters({ gateOnly: true }), true);
  assert.equal(hasActiveFilters({ plan: 'out' }), true);
});

// -------------------------------------------------------------------- format

// 责任：合并 class 须去假值，比例越界夹到 0/1、除零返回 0，长 id 按长度加省略号。
test('cx / clamp01 / percentOf / ratioPercent / shortId', () => {
  assert.equal(cx('a', null, 'b', false, undefined, 'c'), 'a b c');
  assert.equal(cx(), '');
  assert.equal(clamp01(0.4), 0.4);
  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01(2), 1);
  assert.equal(clamp01('nope'), 0);
  assert.equal(percentOf(0.456), 46);
  assert.equal(percentOf(2), 100);
  assert.equal(ratioPercent(1, 4), 25);
  assert.equal(ratioPercent(1, 0), 0);
  assert.equal(shortId('tsk_0123456789abcdef', 10), 'tsk_012345…');
  assert.equal(shortId('short'), 'short');
  assert.equal(shortId(null), '');
});

// 责任：启用 reduced motion 时动画时长须收敛为零，默认仍使用配置时长。
test('motionDurationMs collapses under reduced motion', () => {
  assert.deepEqual(MOTION, { fast: 120, base: 180, slow: 240, flash: 300 });
  assert.equal(motionDurationMs('fast'), 120);
  assert.equal(motionDurationMs('unknown'), 180);
  assert.equal(motionDurationMs('fast', true), 0);
  assert.equal(motionDurationMs('unknown', false), 180);
});

// 责任：审计 actor 文案须区分 agent 自述、人工和未知身份，不能互相冒充。
test('audit labels distinguish self-declared agent, human acceptance and unknown identity', () => {
  assert.equal(auditActorLabel({ by: { kind: 'agent' } }), 'AI审计（自述）');
  assert.equal(auditActorLabel({ by: { kind: 'human' } }), '人类验收记录');
  assert.equal(auditActorLabel({}), '审计记录（身份未知）');
  assert.doesNotMatch(auditActorLabel({ by: { kind: 'agent' } }), /已核验|已人审/);
  assert.match(reasonText('not-independent'), /独立审计/);
  assert.match(reasonText('human only in review or to disable a gate'), /仅人类/);
});

// 责任：审计命令载荷须保留可选报告/flags/门值，不能为人工凭空添加必填报告。
test('audit command payload preserves optional report, flags and gate without inventing human requirements', () => {
  const view = { task: { id: 't', rev: 3 } };
  const audit = { report: 'self-declared report', checklist: [{ item: 'scope', ok: false, note: 'rework' }] };
  for (const op of ['verify', 'reject']) assert.deepEqual(commandBody(view, op, { audit }).audit, audit);
  assert.equal(Object.hasOwn(commandBody(view, 'verify'), 'audit'), false, 'human verify works without a report');
  assert.equal(Object.hasOwn(commandBody(view, 'verify'), 'refreshDrift'), false);
  assert.equal(commandBody(view, 'gate', { requiresAudit: true }).requiresAudit, true);
  assert.equal(commandBody(view, 'gate', { requiresAudit: false }).requiresAudit, false, 'human can disable gate');
});

// ------------------------------------------------------------------- labels

// 责任：状态/操作/错误字典未知值须回退原值，不能输出 undefined 或错误成功标签。
test('label dictionaries fall back to the raw value', () => {
  assert.equal(stateLabel('ready'), '就绪');
  assert.equal(stateLabel('wat'), 'wat');
  assert.equal(stateTone('done'), 'success');
  assert.equal(stateTone('wat'), 'muted');
  assert.equal(opLabel('submit'), '提交');
  assert.equal(reasonText('human only'), '仅人类可操作');
  assert.equal(reasonText(null), '当前不可用');
  assert.equal(errorText({ code: 'stale-revision', message: 'x' }), '版本已过期，请刷新后重试 [stale-revision]');
  assert.equal(errorText({ message: 'boom' }), 'boom');
  assert.equal(errorText(null), '请求失败');
  assert.equal(warningText('doc-drift: doc_x'), '文档漂移: doc_x');
  assert.equal(planCanArchive({ status: 'draft' }), true);
  assert.equal(planCanArchive({ status: 'archived' }), false);
  assert.equal(planCanFocus({ status: 'active', focus: false }), true);
  assert.equal(planCanFocus({ status: 'active', focus: true }), false);
});

// 责任：文件/doc 哈希须标为内容观测，command 必须标为自报材料。
test('evidenceObservation: content hashes are observations, commands are reports', () => {
  assert.deepEqual(evidenceObservation({ kind: 'file', verifiedAt: '2026-01-01T00:00:00Z' }), { label: '内容指纹已记录', tone: 'neutral' });
  assert.deepEqual(evidenceObservation({ kind: 'doc', verifiedAt: '2026-01-01T00:00:00Z', fixedState: 'pinned' }), { label: '内容指纹已记录', tone: 'neutral' });
  assert.deepEqual(evidenceObservation({ kind: 'doc', fixedState: 'current-only', fixedReason: 'no-git' }), { label: 'Git 不可观测', tone: 'muted' });
  assert.deepEqual(evidenceObservation({ kind: 'command' }), { label: '提交者自报', tone: 'neutral' });
  assert.deepEqual(evidenceObservation({ kind: 'test' }), { label: '提交者自报', tone: 'neutral' });
  assert.deepEqual(evidenceObservation({ kind: 'command', execution: { status: 'failed', exitCode: 1 } }), { label: '历史执行记录', tone: 'muted' });
  assert.equal(evidenceObservation({ kind: 'note', ref: 'n' }), null);
  assert.equal(evidenceObservation({ kind: 'file' }), null);
  assert.equal(evidenceObservation(null), null);
});

// 责任：可豁免漂移标签只能包含内容漂移，不能包含执行失败。
test('DRIFT_WAIVER_LABELS covers content drift only, never execution failures', () => {
  assert.deepEqual(Object.keys(DRIFT_WAIVER_LABELS).sort(), ['doc-drift', 'doc-missing', 'file-drift', 'file-missing']);
  assert.equal(DRIFT_WAIVER_LABELS['command-failed'], undefined);
  assert.equal(DRIFT_WAIVER_LABELS['execution-untrusted'], undefined);
});

// ----------------------------------------------------------------- selectors

// 责任：优先级排名须排除终态，同优先级按 updatedAt 稳定破同分。
test('priorityRanks ignores terminal states and breaks ties by updatedAt', () => {
  const ranks = priorityRanks([
    { id: 'a', state: 'ready', priority: 200, updatedAt: '2026-01-01' },
    { id: 'b', state: 'done', priority: 100 },
    { id: 'c', state: 'ready', priority: 100, updatedAt: '2026-01-02' },
    { id: 'd', state: 'canceled', priority: 50 },
    { id: 'e', state: 'ready', priority: 100, updatedAt: '2026-01-01' },
  ]);
  assert.deepEqual(ranks, { e: 1, c: 2, a: 3 });
});

// 责任：缺计划/步骤返回空标题，blocked/interrupted 与带门 review 按 id 去重后须计为 3 项待处理。
test('planStepTitle / needYouCount', () => {
  const plan = { steps: [{ id: 's1', title: '核心' }, { id: 's2', title: '宿主' }] };
  assert.equal(planStepTitle(plan, { stepId: 's2' }), '宿主');
  assert.equal(planStepTitle(plan, { stepId: 'nope' }), '');
  assert.equal(planStepTitle(null, { stepId: 's1' }), '');
  const board = {
    attention: { blocked: [{ id: 'x' }], interrupted: [{ id: 'y' }] },
    columns: { review: [{ id: 'x' }, { id: 'z', labels: ['gate:audit'] }, { id: 'w' }] },
  };
  assert.equal(needYouCount(board), 3);
  assert.equal(needYouCount(null), 0);
});

// P6: rank tier is the ONE threshold (rank 1-3); no component may re-compare.
// 责任：数值名次 1–3 返回 top，4、0、null、undefined 及字符串 '2' 均返回 rest。
test('rankTier is the single rank threshold', () => {
  assert.equal(rankTier(1), 'top');
  assert.equal(rankTier(3), 'top');
  assert.equal(rankTier(4), 'rest');
  assert.equal(rankTier(0), 'rest');
  assert.equal(rankTier(null), 'rest');
  assert.equal(rankTier(undefined), 'rest');
  assert.equal(rankTier('2'), 'rest', 'string ranks are not silently coerced');
});

// P6: plan name + step name for cards/rows, from board.plans + plans view data.
// 责任：计划目录/元信息须使用真实名称，缺失引用不能编造计划标题。
test('planCatalog / planMeta resolve names without inventing them', () => {
  const board = {
    plans: [
      { id: 'pln_a', title: '活跃计划', steps: [{ id: 's1', title: '第一步' }] },
      { id: 'pln_b', title: '另一计划', steps: [] },
    ],
    plan: { id: 'pln_focus', title: '聚焦计划', steps: [{ id: 's9', title: '收口' }] },
  };
  const allPlans = [
    { id: 'pln_a', title: '旧副本', steps: [{ id: 's1', title: '旧步骤' }] },
    { id: 'pln_arch', title: '归档计划', steps: [{ id: 's7', title: '历史' }] },
  ];
  const catalog = planCatalog(board, allPlans);
  assert.deepEqual(catalog.map((plan) => plan.id), ['pln_a', 'pln_b', 'pln_arch', 'pln_focus']);
  assert.equal(catalog[0].title, '活跃计划', 'board copy wins for the same plan id');
  assert.equal(catalog[0].steps[0].title, '第一步');
  assert.deepEqual(planMeta(catalog, { planId: 'pln_a', stepId: 's1' }), {
    key: 'plan:pln_a:s1', title: '活跃计划 · 第一步', planTitle: '活跃计划', stepTitle: '第一步', known: true,
  });
  assert.deepEqual(planMeta(catalog, { planId: 'pln_arch', stepId: 's7' }), {
    key: 'plan:pln_arch:s7', title: '归档计划 · 历史', planTitle: '归档计划', stepTitle: '历史', known: true,
  });
  assert.equal(planMeta(catalog, { planId: 'pln_a' }).title, '活跃计划');
  assert.deepEqual(planMeta(catalog, { planId: 'pln_unknown', stepId: 's1' }), {
    key: 'plan:pln_unknown:s1', title: '计划内', planTitle: '', stepTitle: '', known: false,
  });
  assert.deepEqual(planMeta(catalog, null), { key: 'out', title: '计划外', planTitle: '', stepTitle: '', known: false });
  assert.deepEqual(planCatalog(null, null), []);
  assert.deepEqual(planCatalog({}, []), []);
});

// P6: the new-task form payload is pure and enforces the contract surface.
// 责任：创建任务表单须校验必填并生成 task.create 形状，不能泄漏多余字段。
test('createTaskPayload: validation and task.create shape', () => {
  const missing = createTaskPayload({});
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.errors, ['标题必填', '至少写一条验收项']);
  assert.equal(missing.body, null);
  const badPriority = createTaskPayload({ title: '任务', acceptance: '一条', priority: '1.5' });
  assert.equal(badPriority.ok, false);
  assert.deepEqual(badPriority.errors, ['优先级必须是整数']);
  const minimal = createTaskPayload({ title: '  任务  ', acceptance: ' 第一条 \n\n 第二条 ' });
  assert.deepEqual(minimal, {
    ok: true,
    errors: [],
    body: { op: 'task.create', title: '任务', acceptance: [{ text: '第一条' }, { text: '第二条' }] },
  });
  const full = createTaskPayload({
    title: '任务', acceptance: 'a', description: ' 背景 ', priority: '20', requiresAudit: true,
  });
  assert.deepEqual(full.body, {
    op: 'task.create', title: '任务', acceptance: [{ text: 'a' }],
    description: '背景', priority: 20, requiresAudit: true,
  });
  assert.equal('planRef' in full.body, false, 'task.create never offers plan membership');
  assert.equal('deps' in minimal.body, false);
});

// 责任：创建结果只能从 task/created 事件提取任务 id，不能误取其他事件。
test('taskCreatedId reads the task/created event only', () => {
  assert.equal(taskCreatedId({ events: [{ type: 'task/created', data: { id: 'tsk_new' } }] }), 'tsk_new');
  assert.equal(taskCreatedId({ events: [{ type: 'task/updated', data: { id: 'tsk_x' } }] }), null);
  assert.equal(taskCreatedId({}), null);
  assert.equal(taskCreatedId(null), null);
});

// P7: the list can combine every filter, and grouping is render-only.
// 责任：同时启用 query/state/gate/plan 时须返回交集，不得按任一条件放宽。
test('filterCards combines query + state + gate + plan', () => {
  const cards = [
    { id: 'a', title: '计划内的登录', state: 'ready', planRef: { planId: 'p', stepId: 's1' }, labels: ['ui'] },
    { id: 'b', title: '计划外登录', state: 'ready', labels: ['gate:audit'] },
    { id: 'c', title: '计划内文档', state: 'review', planRef: { planId: 'p', stepId: 's2' } },
  ];
  assert.deepEqual(filterCards(cards, { plan: 'in', state: 'ready', query: '登录' }).map((card) => card.id), ['a']);
  assert.deepEqual(filterCards(cards, { plan: 'out', gateOnly: true }).map((card) => card.id), ['b']);
  assert.deepEqual(filterCards(cards, { plan: 'in', state: 'review', gateOnly: true }), []);
  assert.equal(hasActiveFilters({ plan: 'out', state: 'ready' }), true);
});

// 责任：状态分组须顺序稳定，标签多归属和计划步骤须按定义次序呈现。
test('groupTasks: status order, label multi-membership, plan-step order', () => {
  const tasks = [
    { id: 't1', title: '甲', state: 'ready', labels: ['ui', 'core'] },
    { id: 't2', title: '乙', state: 'done', labels: ['core'] },
    { id: 't3', title: '丙', state: 'blocked', labels: [] },
    { id: 't4', title: '丁', state: 'ready', planRef: { planId: 'p1', stepId: 's2' } },
    { id: 't5', title: '戊', state: 'ready', planRef: { planId: 'p1', stepId: 's1' } },
    { id: 't6', title: '己', state: 'ready' },
  ];
  const before = JSON.stringify(tasks);
  const plans = [{ id: 'p1', title: '计划一', steps: [{ id: 's1', title: '第一步' }, { id: 's2', title: '第二步' }] }];

  const status = groupTasks(tasks, 'status', plans);
  assert.deepEqual(status.map((group) => group.title), ['就绪', '阻塞', '已完成']);
  assert.deepEqual(status[0].items.map((task) => task.id), ['t1', 't4', 't5', 't6']);

  const labels = groupTasks(tasks, 'label', plans);
  assert.deepEqual(labels.map((group) => group.title), ['core', 'ui', '无标签']);
  assert.deepEqual(labels[0].items.map((task) => task.id), ['t1', 't2'], 'multi-label tasks appear in every label bucket');
  assert.deepEqual(labels[2].items.map((task) => task.id), ['t3', 't4', 't5', 't6']);

  const plan = groupTasks(tasks, 'plan', plans);
  assert.deepEqual(plan.map((group) => group.title), ['计划一 · 第一步', '计划一 · 第二步', '计划外']);
  assert.deepEqual(plan[0].items.map((task) => task.id), ['t5']);
  assert.deepEqual(plan[2].items.map((task) => task.id), ['t1', 't2', 't3', 't6']);

  assert.deepEqual(groupTasks(tasks, 'nope', plans), [], 'unknown mode keeps the flat list');
  assert.deepEqual(groupTasks(null, 'status', plans), []);
  assert.equal(JSON.stringify(tasks), before, 'grouping never mutates the task list');
  assert.deepEqual(tasks[0].labels, ['ui', 'core']);
});

// 责任：按计划分组须用提供目录，归档引用须安全降级而非丢任务。
test('groupTasks: plan axis uses the provided catalog and degrades for archived refs', () => {
  const tasks = [
    { id: 'a', state: 'ready', planRef: { planId: 'archived', stepId: 'old' } },
    { id: 'b', state: 'ready', planRef: { planId: 'active', stepId: 's1' } },
    { id: 'c', state: 'ready' },
  ];
  const catalog = [
    { id: 'active', title: '当前计划', steps: [{ id: 's1', title: '核心' }] },
    { id: 'archived', title: '归档计划', steps: [{ id: 'old', title: '历史' }] },
  ];
  const groups = groupTasks(tasks, 'plan', catalog);
  assert.deepEqual(groups.map((group) => group.title), ['当前计划 · 核心', '归档计划 · 历史', '计划外']);
  assert.equal(groupTasks([{ id: 'x', state: 'ready', planRef: { planId: 'missing' } }], 'plan', catalog)[0].title, '计划内');
});

// 责任：localStorage 筛选值损坏或类型不符时须回退安全默认值。
test('normalizeFilters: corrupt localStorage values fall back safely', () => {
  assert.deepEqual(defaultFilters(), { query: '', state: null, gateOnly: false, plan: null, group: 'none' });
  assert.deepEqual(normalizeFilters(null), defaultFilters());
  assert.deepEqual(normalizeFilters({ query: 'x', state: 'ready', gateOnly: true, plan: 'in', group: 'plan' }), {
    query: 'x', state: 'ready', gateOnly: true, plan: 'in', group: 'plan',
  });
  assert.deepEqual(normalizeFilters({ state: 'nope', plan: 'maybe', group: 'nope', gateOnly: 'yes', query: 4 }), {
    query: '', state: null, gateOnly: false, plan: null, group: 'none',
  });
  assert.deepEqual(normalizeFilters({ state: 'blocked', plan: 'out' }), {
    query: '', state: 'blocked', gateOnly: false, plan: 'out', group: 'none',
  });
  assert.deepEqual(GROUP_MODES, ['none', 'status', 'label', 'plan']);
  assert.equal(GROUP_OPTIONS.length, 4);
  assert.equal(normalizeGroupMode('plan'), 'plan');
  assert.equal(normalizeGroupMode('nope'), 'none');
});

// 责任：工作区路径须规范化分隔和大小写后匹配项目，不能错误匹配相似前缀。
test('workspace path normalization and project matching', () => {
  assert.equal(normalizeWorkspacePath('  D:\\SampleWorkspace\\demo\\  '), 'D:/SampleWorkspace/demo');
  assert.equal(normalizeWorkspacePath(null), '');
  assert.equal(comparablePath('D:\\SampleWorkspace\\DEMO'), 'd:/sampleworkspace/demo');
  assert.equal(comparablePath('/home/User/Repo'), '/home/User/Repo');
  const projects = [
    { id: 'p_root', workspacePath: 'D:/SampleWorkspace' },
    { id: 'p_child', workspacePath: 'D:/SampleWorkspace/demo' },
    { id: 'p_other', workspacePath: 'D:/elsewhere' },
  ];
  assert.deepEqual(matchProjectByCwd(projects, 'd:\\sampleworkspace\\DEMO\\'), { project: projects[1], exact: true });
  assert.deepEqual(matchProjectByCwd(projects, 'D:/SampleWorkspace/demo/sub/dir'), { project: projects[1], exact: false });
  // a sibling that merely shares the prefix is not an ancestor match
  assert.equal(matchProjectByCwd(projects, 'D:/SampleWorkspace2'), null);
  assert.deepEqual(matchProjectByCwd(projects, 'D:/SampleWorkspace/other'), { project: projects[0], exact: false });
  assert.equal(matchProjectByCwd(projects, ''), null);
  assert.equal(matchProjectByCwd(null, 'D:/x'), null);
});

// 责任：任务会话选择须优先 owner 再最新证据，一般会话选择须取最新有效会话。
test('session pickers prefer owner then newest evidence / newest session', () => {
  assert.deepEqual(pickTaskSession({ owner: { sessionId: 's1' }, evidence: [{ at: '2026-01-02', producedBy: { sessionId: 's2' } }] }), { sessionId: 's1', source: 'owner' });
  assert.deepEqual(pickTaskSession({ evidence: [{ at: '2025-01-01', producedBy: { sessionId: 's2' } }, { at: '2026-01-01', producedBy: { sessionId: 's3' } }] }), { sessionId: 's3', source: 'evidence' });
  assert.deepEqual(pickTaskSession(null), { sessionId: null, source: null });
  const byId = {
    s1: { cwd: 'D:/SampleWorkspace/demo', updatedAt: 1 },
    s2: { cwd: 'D:/SampleWorkspace/demo', updatedAt: 3 },
    s3: { cwd: 'D:/SampleWorkspace/demo', updatedAt: 9, origin: 'subagent' },
    s4: { cwd: 'D:/SampleWorkspace/demo', updatedAt: 9, blank: true },
    s5: { cwd: 'D:/elsewhere', updatedAt: 10 },
  };
  assert.deepEqual(pickLatestSession(byId, 'D:\\SampleWorkspace\\demo'), { sessionId: 's2', updatedAt: 3 });
  assert.equal(pickLatestSession(byId, ''), null);
  assert.equal(pickLatestSession(byId, 'D:/nope'), null);
});

// ------------------------------------------------------------------ payloads

// 责任：证据 ref 须 trim，命令带 rev/token，doc 链接去重且保留 planRefs，已有文档默认只读预览。
test('payload helpers build the documented shapes', () => {
  assert.deepEqual(buildEvidence({ kind: 'test', ref: '  smoke ', summary: '' }), { kind: 'test', ref: 'smoke', summary: '证据' });
  assert.deepEqual(buildEvidence({ ref: 'x', acceptanceId: 'a1' }), { kind: 'file', ref: 'x', summary: '证据', acceptanceId: 'a1' });
  const view = { task: { id: 't1', rev: 4 }, lease: { token: 7 } };
  assert.deepEqual(commandBody(view, 'submit', { summary: 'ok', ignored: undefined }), {
    op: 'task.submit',
    taskId: 't1',
    expected: { entityRev: 4 },
    fencingToken: 7,
    summary: 'ok',
  });
  assert.deepEqual(commandBody(null, 'create', null), { op: 'task.create' });
  assert.deepEqual(docLinkPayload({ planRefs: [{ planId: 'p', version: 1 }] }, ['a', 'a', '', 'b']), {
    taskIds: ['a', 'b'],
    planRefs: [{ planId: 'p', version: 1 }],
  });
  assert.deepEqual(docLinkPayload(null, null), { taskIds: [], planRefs: [] });
  assert.equal(initialPreview({ docId: 'd1' }), true);
  assert.equal(initialPreview({ docId: 'd1', preview: false }), false);
  assert.equal(initialPreview({}), false);
});

// 责任：保存的 list 视图须原样保留，未知 kanban 值须回退 board。
test('storage normalizers reject unknown values', () => {
  assert.equal(normalizeView('list'), 'list');
  assert.equal(normalizeView('kanban'), 'board');
});

// -------------------------------------------------------------------- flow

// 责任：流程图声明、默认标签、边和注释须解析成确定节点边集合。
test('parseFlowSpec: nodes, default labels, edges and comments', () => {
  const parsed = parseFlowSpec('a[起点]\n# note\nb\na -> b');
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.spec.nodes.map((node) => node.id), ['a', 'b']);
  assert.equal(parsed.spec.nodes[0].label, '起点');
  assert.equal(parsed.spec.nodes[1].label, 'b');
  assert.deepEqual(parsed.spec.edges, [{ from: 'a', to: 'b' }]);
});

// 责任：自环、未知节点、孤立节点和非法语法须失败，不能布局不完整图。
test('parseFlowSpec: self loop, unknown node, isolated node and bad syntax all fail', () => {
  const selfLoop = parseFlowSpec('a[x]\na -> a');
  assert.equal(selfLoop.ok, false);
  assert.match(selfLoop.error, /自环/);

  const unknown = parseFlowSpec('a[x]\na -> zz');
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /zz/);

  const isolated = parseFlowSpec('a[x]\nb[y]');
  assert.equal(isolated.ok, false);
  assert.match(isolated.error, /孤立/);

  const messy = parseFlowSpec('a -> ');
  assert.equal(messy.ok, false);
  assert.match(messy.error, /第 1 行/);
});

// 责任：重复边须去重，重复节点声明须拒绝而非覆盖旧定义。
test('parseFlowSpec: duplicate edges collapse, duplicate declarations fail', () => {
  const parsed = parseFlowSpec('a[x]\nb[y]\na -> b\na -> b');
  assert.equal(parsed.spec.edges.length, 1);
  const duplicate = parseFlowSpec('a[x]\na[y]\nb[z]\na -> b');
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error, /重复声明/);
});

// 责任：流程图分层须用最长路径，同层节点保持声明顺序。
test('flowLayout: longest-path layers, declaration order inside a layer', () => {
  const parsed = parseFlowSpec('a[起]\nb[一]\nc[二]\nd[末]\na -> b\na -> c\nb -> d\nc -> d');
  assert.equal(parsed.ok, true);
  const laid = flowLayout(parsed.spec);
  assert.equal(laid.ok, true);
  const byId = {};
  for (const node of laid.layout.nodes) byId[node.id] = node;
  assert.equal(byId.a.layer, 0);
  assert.equal(byId.b.layer, 1);
  assert.equal(byId.c.layer, 1);
  assert.equal(byId.d.layer, 2);
  assert.ok(byId.b.y < byId.c.y, 'same layer keeps declaration order');
  assert.ok(byId.a.x < byId.d.x, 'edges run left to right');
  assert.deepEqual(laid.layout.edges.map((edge) => edge.key), ['a->b', 'a->c', 'b->d', 'c->d']);
  assert.equal(laid.layout.layers, 3);
});

// 责任：有环流程图须明确拒绝，不得无限递归或循环。
test('flowLayout: a cycle is rejected instead of looping', () => {
  const parsed = parseFlowSpec('a[x]\nb[y]\nc[z]\na -> b\nb -> c\nc -> a');
  assert.equal(parsed.ok, true, 'parse only checks syntax; cycles surface in layout');
  const laid = flowLayout(parsed.spec);
  assert.equal(laid.ok, false);
  assert.match(laid.error, /环/);
});

// 责任：长标签和不同布局下图形须始终处于自己的 viewBox 范围内。
test('flowLayout: layout never overflows its own viewBox', () => {
  const laid = flowLayout(parseFlowSpec('a[一个相当长的节点标签]\nb[短]\na -> b').spec);
  const right = Math.max(...laid.layout.nodes.map((node) => node.x + node.w));
  const bottom = Math.max(...laid.layout.nodes.map((node) => node.y + node.h));
  assert.ok(laid.layout.width >= right);
  assert.ok(laid.layout.height >= bottom);
  assert.ok(flowTextWidth('标签') > flowTextWidth('ab'), 'CJK is wider than ASCII');
});

// ------------------------------------------------------------------ export

// 责任：导出文件名须保留可读名称但移除 Windows 不允许的字符和危险名字。
test('safeFileName: keeps readable names, strips everything Windows rejects', () => {
  assert.equal(safeFileName('设计 文档', 'doc_1'), '设计 文档.md');
  assert.equal(safeFileName('a/b:c*?', 'x'), 'a b c.md');
  assert.equal(safeFileName('  ..hidden..  ', 'x'), 'hidden.md');
  assert.equal(safeFileName('', 'doc_1'), 'doc_1.md');
  assert.equal(safeFileName(null, null), 'document.md');
  assert.equal(safeFileName('CON', 'x'), '_CON.md');
  assert.equal(safeFileName('x'.repeat(200), 'y'), 'x'.repeat(80) + '.md');
});

// ---------------------------------------------------------------- plan edit

// 责任：逗号/换行表单文本须正确拆分列表并清理空白。
test('planEditSplitList / planEditSplitLines parse comma and newline text', () => {
  assert.deepEqual(planEditSplitList(' a, b,,c '), ['a', 'b', 'c']);
  assert.deepEqual(planEditSplitList('ui，plan, 核心，核心'), ['ui', 'plan', '核心']);
  assert.deepEqual(planEditSplitList(''), []);
  assert.deepEqual(planEditSplitList(null), []);
  assert.deepEqual(planEditSplitLines('一\n\n 二 \r\n三\n'), ['一', '二', '三']);
  assert.deepEqual(planEditSplitLines('\n\n'), []);
  assert.deepEqual(planEditSplitLines(undefined), []);
});

const planEditForm = {
  steps: [
    {
      key: 's_1', id: 's1', title: '核心',
      tasks: [
        { key: 't_1', taskId: 'tsk_a', title: '状态机', description: 'd', priority: '200', weight: '2', deps: 'tsk_b, tsk_b', acceptance: '', labels: 'core, core', requiresAudit: true },
        { key: 't_2', taskId: '', title: '新任务', description: '', priority: '', weight: '', deps: 'tsk_a', acceptance: '验收一\n\n验收二', labels: '', requiresAudit: false },
      ],
    },
    { key: 's_2', id: '', title: '宿主', tasks: [] },
  ],
};

// 责任：计划步骤表单须生成 plan.revise 结构，正确保留任务引用与字段。
test('planEditSteps parses the form into the plan.revise payload', () => {
  const parsed = planEditSteps(planEditForm);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.steps, [
    {
      id: 's1', title: '核心',
      tasks: [
        { key: 't_1', taskId: 'tsk_a', title: '状态机', description: 'd', priority: 200, weight: 2, deps: ['tsk_b'], labels: ['core'], acceptance: [], requiresAudit: true },
        { key: 't_2', title: '新任务', description: '', priority: 100, weight: 1, deps: ['tsk_a'], labels: [], acceptance: [{ text: '验收一' }, { text: '验收二' }], requiresAudit: false },
      ],
    },
    { id: 's_2', title: '宿主', tasks: [] },
  ]);
});

// 责任：缺必填、类型错误和重复键的计划表单须拒绝，不能发送畸形步骤。
test('planEditSteps validates required fields, types and duplicates', () => {
  assert.equal(planEditSteps({ steps: [] }).ok, false);
  assert.match(planEditSteps({ steps: [] }).errors[0], /至少需要一个步骤/);
  const noTitle = planEditSteps({ steps: [{ key: 's', title: '', tasks: [] }] });
  assert.equal(noTitle.ok, false);
  assert.match(noTitle.errors[0], /缺少标题/);
  const newNoAcc = planEditSteps({ steps: [{ key: 's', title: 'x', tasks: [{ key: 't', title: '新', acceptance: '' }] }] });
  assert.equal(newNoAcc.ok, false);
  assert.match(newNoAcc.errors[0], /验收标准/);
  const badPriority = planEditSteps({ steps: [{ key: 's', title: 'x', tasks: [{ key: 't', title: '新', priority: '1.5', acceptance: 'a' }] }] });
  assert.equal(badPriority.ok, false);
  assert.match(badPriority.errors.join(''), /优先级/);
  const badWeight = planEditSteps({ steps: [{ key: 's', title: 'x', tasks: [{ key: 't', title: '新', weight: '0', acceptance: 'a' }] }] });
  assert.equal(badWeight.ok, false);
  assert.match(badWeight.errors.join(''), /权重/);
  const dupTask = planEditSteps({
    steps: [
      { key: 's1', title: '一', tasks: [{ key: 't1', taskId: 'tsk_x', title: 'a', acceptance: '' }] },
      { key: 's2', title: '二', tasks: [{ key: 't2', taskId: 'tsk_x', title: 'a', acceptance: '' }] },
    ],
  });
  assert.equal(dupTask.ok, false);
  assert.match(dupTask.errors.join(''), /多个步骤/);
  const dupKey = planEditSteps({
    steps: [{ key: 's', title: 'x', tasks: [
      { key: 't', title: 'a', acceptance: 'x' },
      { key: 't', title: 'b', acceptance: 'y' },
    ] }],
  });
  assert.equal(dupKey.ok, false);
  assert.match(dupKey.errors.join(''), /key 重复/);
  // Existing tasks may omit acceptance: mergeAcceptance inherits server-side.
  const existingNoAcc = planEditSteps({ steps: [{ key: 's', title: 'x', tasks: [{ key: 't', taskId: 'tsk_a', title: 'a', acceptance: '' }] }] });
  assert.equal(existingNoAcc.ok, true);
});

// 责任：计划 diff 按 taskId 统计增改删，并保留被移出任务标题供确认。
test('planEditDiff counts added/updated/removed by taskId and keeps orphan titles', () => {
  const oldSteps = [
    {
      id: 's1', title: '核心',
      tasks: [
        { key: 't_1', taskId: 'tsk_a', title: '状态机', description: 'd', priority: 200, weight: 2, deps: [], labels: ['core'], acceptance: [], requiresAudit: true },
        { key: 't_2', taskId: 'tsk_b', title: '被移除', description: '', priority: 100, weight: 1, deps: [], labels: [], acceptance: [], requiresAudit: false },
      ],
    },
    { id: 's2', title: '宿主', tasks: [{ key: 't_3', taskId: 'tsk_c', title: '路由', description: '', priority: 100, weight: 1, deps: [], labels: [], acceptance: [], requiresAudit: false }] },
  ];
  const newSteps = [
    {
      id: 's1', title: '核心',
      tasks: [
        { key: 't_1', taskId: 'tsk_a', title: '状态机', description: 'd', priority: 200, weight: 2, deps: [], labels: ['core'], acceptance: [], requiresAudit: true },
        { key: 't_9', title: '新增任务', description: '', priority: 100, weight: 1, deps: [], labels: [], acceptance: [{ text: 'a' }], requiresAudit: false },
      ],
    },
    { id: 's2', title: '宿主与路由', tasks: [{ key: 't_3', taskId: 'tsk_c', title: '路由', description: '重写', priority: 120, weight: 1, deps: [], labels: [], acceptance: [], requiresAudit: false }] },
  ];
  assert.deepEqual(planEditDiff(oldSteps, newSteps), {
    added: 1, updated: 1, removed: 1,
    removedTasks: [{ taskId: 'tsk_b', title: '被移除' }],
    stepsAdded: 0, stepsRemoved: 0, stepsChanged: 1, changed: true,
  });
  assert.equal(planEditDiff(oldSteps, oldSteps).changed, false, 'identical payload diffs clean');
  assert.equal(planEditDiff([], []).changed, false);
  assert.equal(planEditDiff([], newSteps).added, 3, 'against an empty base every task is new');
  // Drafts match by plan-local key: dropping a key-only task is a removal
  // without any orphan title (no real task exists yet).
  const draftOld = [{ id: 's1', title: 'x', tasks: [{ key: 't_1', title: '甲', description: '', priority: 100, weight: 1, deps: [], labels: [], acceptance: [{ text: 'a' }], requiresAudit: false }] }];
  const draftNew = [{ id: 's1', title: 'x', tasks: [] }];
  const draftDiff = planEditDiff(draftOld, draftNew);
  assert.equal(draftDiff.removed, 1);
  assert.deepEqual(draftDiff.removedTasks, []);
  // Moving a task across steps counts as an update (planRef.stepId changes).
  const movedNew = [
    { id: 's1', title: '核心', tasks: [oldSteps[0].tasks[1]] },
    { id: 's2', title: '宿主', tasks: [oldSteps[0].tasks[0], oldSteps[1].tasks[0]] },
  ];
  assert.equal(planEditDiff(oldSteps, movedNew).updated, 1, 'tsk_a moved from s1 into s2');
});

// 责任：修订/发布载荷须带正确 CAS 和 op，不能把草案版本与活动 baseVersion 混淆。
test('planEditPayload / planEditPublishPayload build the CAS command bodies', () => {
  const steps = [{ id: 's1', title: 'x', tasks: [] }];
  assert.deepEqual(planEditPayload({ id: 'pln_a', status: 'active', currentVersion: 3, rev: 9 }, steps), {
    op: 'plan.revise', planId: 'pln_a', baseVersion: 3, steps,
  });
  assert.deepEqual(planEditPayload({ id: 'pln_d', status: 'draft', rev: 5, currentVersion: 0 }, steps), {
    op: 'plan.revise', planId: 'pln_d', expected: { entityRev: 5 }, steps,
  });
  assert.deepEqual(planEditPublishPayload({ id: 'pln_d', rev: 5 }), {
    op: 'plan.publish', planId: 'pln_d', expected: { entityRev: 5 },
  });
});

// 责任：计划编辑 seed 须补全任务，后续增删改返回新表单而非原地污染。
test('planEditSeed hydrates full tasks; mutations return new forms', () => {
  const steps = [{ id: 's1', title: '核心', tasks: [{ id: 'tsk_a', title: '状态机', state: 'ready', labels: ['core'], priority: 200 }] }];
  const byId = { tsk_a: { id: 'tsk_a', title: '状态机', description: 'd', priority: 200, weight: 3, labels: ['core'], requiresAudit: false, deps: ['tsk_b'], acceptance: [{ text: '验收一' }] } };
  const seeded = planEditSeed(steps, byId);
  assert.equal(seeded.steps.length, 1);
  const task = seeded.steps[0].tasks[0];
  assert.equal(task.taskId, 'tsk_a');
  assert.equal(task.description, 'd');
  assert.equal(task.weight, '3');
  assert.equal(task.deps, 'tsk_b');
  assert.equal(task.acceptance, '验收一');
  assert.equal(task.labels, 'core');
  const withStep = planEditAddStep(seeded);
  assert.equal(withStep.steps.length, 2);
  assert.equal(seeded.steps.length, 1, 'mutations return new forms');
  assert.equal(planEditPatchStep(seeded, seeded.steps[0].key, { title: '核心 v2' }).steps[0].title, '核心 v2');
  const withTask = planEditAddTask(seeded, seeded.steps[0].key);
  assert.equal(withTask.steps[0].tasks.length, 2);
  assert.equal(withTask.steps[0].tasks[1].taskId, '', 'new tasks start without a taskId');
  const newTask = withTask.steps[0].tasks[1];
  assert.equal(planEditPatchTask(withTask, seeded.steps[0].key, newTask.key, { title: '新增' }).steps[0].tasks[1].title, '新增');
  assert.equal(planEditRemoveTask(withTask, seeded.steps[0].key, newTask.key).steps[0].tasks.length, 1);
  assert.equal(planEditRemoveStep(withStep, seeded.steps[0].key).steps.length, 1, 'removing the last step leaves one placeholder');
  assert.equal(planEditSeed([], null).steps.length, 1, 'an empty plan seeds one blank step');
  assert.equal(planEditSteps(planEditSeed(steps, byId)).ok, true, 'a seeded form round-trips to a valid payload');
});

// 责任：仅重排或改优先级保存时须保留原 requiredKinds，不得悄悄降低验收要求。
test('plan editor preserves unchanged requiredKinds through reordering and priority-only saves', () => {
  const tasks = {
    tsk_a: { id: 'tsk_a', title: 'A', acceptance: [{ text: 'original', requiredKinds: ['file', 'test'] }, { text: 'second', requiredKinds: ['doc'] }] },
    tsk_b: { id: 'tsk_b', title: 'B', acceptance: [{ text: 'other', requiredKinds: ['note'] }] },
  };
  const seeded = planEditSeed([{ id: 's', title: 'step', tasks: [{ id: 'tsk_a' }, { id: 'tsk_b' }] }], tasks);
  const original = planEditSteps(seeded).steps;
  assert.deepEqual(original[0].tasks[0].acceptance, tasks.tsk_a.acceptance);
  assert.notEqual(seeded.steps[0].tasks[0].acceptanceOriginal[0].requiredKinds, tasks.tsk_a.acceptance[0].requiredKinds, 'seed keeps an independent metadata snapshot');
  const reordered = { steps: seeded.steps.map(step => ({ ...step, tasks: step.tasks.slice().reverse() })) };
  const saved = planEditSteps(reordered).steps;
  assert.deepEqual(saved[0].tasks[1].acceptance, tasks.tsk_a.acceptance);
  assert.equal(planEditDiff(original, saved).changed, false, 'task ordering does not create an acceptance change');
  const criterionOrder = planEditPatchTask(seeded, seeded.steps[0].key, seeded.steps[0].tasks[0].key, { acceptance: 'second\noriginal' });
  const criterionSaved = planEditSteps(criterionOrder).steps;
  assert.deepEqual(criterionSaved[0].tasks[0].acceptance, tasks.tsk_a.acceptance.slice().reverse());
  assert.equal(planEditDiff(original, criterionSaved).changed, false, 'unchanged criterion text keeps its own kind requirements despite reordering');
  const priority = planEditPatchTask(seeded, seeded.steps[0].key, seeded.steps[0].tasks[0].key, { priority: '7' });
  const prioritySaved = planEditSteps(priority).steps[0].tasks[0];
  assert.equal(prioritySaved.priority, 7);
  assert.deepEqual(prioritySaved.acceptance, tasks.tsk_a.acceptance);
  assert.equal(Object.hasOwn(prioritySaved, 'acceptanceOriginal'), false, 'editor-only metadata does not enter the API payload');
  const edited = planEditPatchTask(seeded, seeded.steps[0].key, seeded.steps[0].tasks[0].key, { acceptance: 'edited\nsecond\nnew criterion' });
  const editedSaved = planEditSteps(edited).steps;
  assert.deepEqual(editedSaved[0].tasks[0].acceptance, [{ text: 'edited' }, { text: 'second', requiredKinds: ['doc'] }, { text: 'new criterion' }]);
  assert.equal(planEditDiff(original, editedSaved).changed, true, 'edited/new criterion text is a real scope change');
});

// 责任：草案 seed 须直接保留定义和 key，不能为尚未物化任务调用 getTask。
test('planEditSeed keeps draft task definitions and keys (no getTask)', () => {
  const steps = [{
    id: 's1', title: '草稿',
    tasks: [{
      key: 't_keep', title: '甲', description: 'd', priority: 150, weight: 2,
      deps: ['t_dep'], labels: ['core'], acceptance: [{ text: '验收一' }, { text: '验收二' }],
      requiresAudit: true,
    }],
  }];
  const seeded = planEditSeed(steps, null);
  const task = seeded.steps[0].tasks[0];
  assert.equal(task.key, 't_keep', 'draft task key is preserved');
  assert.equal(task.taskId, '', 'draft tasks have no taskId');
  assert.equal(task.description, 'd');
  assert.equal(task.priority, '150');
  assert.equal(task.weight, '2');
  assert.equal(task.deps, 't_dep');
  assert.equal(task.acceptance, '验收一\n验收二');
  assert.equal(task.labels, 'core');
  assert.equal(task.requiresAudit, true);
  const parsed = planEditSteps(seeded);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.steps[0].tasks[0], {
    key: 't_keep', title: '甲', description: 'd', priority: 150, weight: 2,
    deps: ['t_dep'], labels: ['core'], acceptance: [{ text: '验收一' }, { text: '验收二' }],
    requiresAudit: true,
  });
  assert.equal(parsed.steps[0].tasks[0].taskId, undefined);
  const withTask = planEditAddTask(seeded, seeded.steps[0].key);
  assert.notEqual(withTask.steps[0].tasks[1].key, 't_keep', 'new draft task key does not collide');
});
