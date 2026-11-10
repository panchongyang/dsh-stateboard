/**
 * 测试职责：冻结 bundle 中纯逻辑的行为，逐 section 独立失败。
 * 典型流程：读取真实 bundle → 构造独立离线替身 → 逐段断言契约。
 * 覆盖边界：覆盖 出货产物的离线契约；不覆盖真实 DOM、浏览器视觉、网络或宿主会话。
 * 外部前置：需要仓库现有客户端构建产物；不启动浏览器。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadClientBundle } from '../../helpers/client-bundle-fixture.mjs';

// 责任：筛选状态须可经 localStorage 往返，非法枚举和坏 JSON 必须安全回默认。（原 L215-225）
test("logic L215: 筛选状态须可经 localStorage 往返，非法枚举和坏 JSON 必须安全回默认。", (context) => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  context.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  });
  const __store = new Map();
  globalThis.localStorage = { getItem: (k) => (__store.has(k) ? __store.get(k) : null), setItem: (k, v) => { __store.set(k, String(v)); }, removeItem: (k) => { __store.delete(k); } };
  // 分段职责：筛选状态须可经 localStorage 往返，非法枚举和坏 JSON 必须安全回默认。
  // filter state round-trips through localStorage and corrupt values fall back (P7)
  assert.deepEqual(t.readFilters(), { query: '', state: null, gateOnly: false, plan: null, group: 'none' });
  t.saveFilters({ query: ' 登录 ', state: 'ready', gateOnly: true, plan: 'in', group: 'plan' });
  assert.deepEqual(t.readFilters(), { query: ' 登录 ', state: 'ready', gateOnly: true, plan: 'in', group: 'plan' }, 'filters survive a localStorage round-trip');
  t.saveFilters({ state: 'nope', plan: 'maybe', group: 'nope', gateOnly: 'yes' });
  assert.deepEqual(t.readFilters(), { query: '', state: null, gateOnly: false, plan: null, group: 'none' }, 'unknown stored filters fall back');
  __store.set('projectBoard.filters', '{not json');
  assert.deepEqual(t.readFilters(), { query: '', state: null, gateOnly: false, plan: null, group: 'none' }, 'corrupt JSON falls back');
  delete globalThis.localStorage;
});

// 责任：下一操作按任务状态及 allowedOps 推导，终态和 backlog 不凭数组顺序猜动作。（原 L226-235）
test("logic L226: 下一操作按任务状态及 allowedOps 推导，终态和 backlog 不凭数组顺序猜动作。", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;

  // 分段职责：下一操作按任务状态及 allowedOps 推导，终态和 backlog 不凭数组顺序猜动作。
  // next action is derived from state, not from op array order (P3)
  assert.equal(t.nextActionFor({ state: 'ready' }, [{ op: 'claim', enabled: true }]).op, 'claim');
  assert.equal(t.nextActionFor({ state: 'in_progress' }, [{ op: 'submit', enabled: true }, { op: 'block', enabled: true }]).op, 'submit');
  assert.equal(t.nextActionFor({ state: 'in_progress' }, [{ op: 'submit', enabled: false }, { op: 'block', enabled: true }]).op, 'block');
  assert.equal(t.nextActionFor({ state: 'review' }, [{ op: 'verify', enabled: true }, { op: 'reject', enabled: true }]).op, 'verify');
  assert.equal(t.nextActionFor({ state: 'blocked' }, [{ op: 'unblock', enabled: true }]).op, 'unblock');
  assert.equal(t.nextActionFor({ state: 'interrupted' }, [{ op: 'reconcile', enabled: true }]).op, 'reconcile');
  assert.equal(t.nextActionFor({ state: 'backlog' }, []), null, 'backlog has no next action');
  assert.equal(t.nextActionFor({ state: 'done' }, [{ op: 'reopen', enabled: true }]), null, 'terminal states do not offer a next action');
});

// 责任：排名仅含活动任务，同优先级按更新时间破同分。（原 L236-253）
test("logic L236: 排名仅含活动任务，同优先级按更新时间破同分。", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;

  // 分段职责：排名仅含活动任务，同优先级按更新时间破同分。
  // priority ranks: active only, ties broken by updatedAt (P5)
  const ranked = t.priorityRanks([
    { id: 'a', state: 'ready', priority: 200, updatedAt: '2026-01-01' },
    { id: 'b', state: 'done', priority: 100, updatedAt: '2026-01-01' },
    { id: 'c', state: 'ready', priority: 100, updatedAt: '2026-01-02' },
    { id: 'd', state: 'canceled', priority: 50 },
  ]);
  assert.equal(ranked.c, 1, 'lower number first');
  assert.equal(ranked.a, 2);
  assert.equal(ranked.b, undefined, 'done tasks never rank');
  assert.equal(ranked.d, undefined, 'canceled tasks never rank');
  const tie = t.priorityRanks([
    { id: 'x', state: 'ready', priority: 100, updatedAt: '2026-01-02' },
    { id: 'y', state: 'ready', priority: 100, updatedAt: '2026-01-01' },
  ]);
  assert.equal(tie.y, 1, 'same priority falls back to older updatedAt');
  assert.equal(tie.x, 2);
});

// 责任：按步骤 id 查真实标题，缺计划/步骤/引用须降级空串。（原 L254-261）
test("logic L254: 按步骤 id 查真实标题，缺计划/步骤/引用须降级空串。", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;

  // 分段职责：按步骤 id 查真实标题，缺计划/步骤/引用须降级空串。
  // plan step titles: id -> title; missing plan or step degrades to '' (P5)
  const planFixture = { steps: [{ id: 's1', title: '核心' }, { id: 's2', title: '宿主' }] };
  assert.equal(t.planStepTitle(planFixture, { stepId: 's2' }), '宿主');
  assert.equal(t.planStepTitle(planFixture, { stepId: 'nope' }), '');
  assert.equal(t.planStepTitle(planFixture, null), '');
  assert.equal(t.planStepTitle(null, { stepId: 's1' }), '');
  assert.equal(t.planStepTitle({ steps: [] }, { stepId: 's1' }), '');
});

// 责任：计划状态须映射中文标签和色调，未知状态使用中性色。（原 L262-270）
test("logic L262: 计划状态须映射中文标签和色调，未知状态使用中性色。", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;

  // 分段职责：计划状态须映射中文标签和色调，未知状态使用中性色。
  // plan management (U1): status labels/tones for the three head states
  assert.equal(t.planStatusLabel('draft'), '草稿');
  assert.equal(t.planStatusLabel('active'), '进行中');
  assert.equal(t.planStatusLabel('archived'), '已归档');
  assert.equal(t.planStatusTone('active'), 'success');
  assert.equal(t.planStatusTone('draft'), 'accent');
  assert.equal(t.planStatusTone('archived'), 'muted');
  assert.equal(t.planStatusTone('nope'), 'neutral');
});

// 责任：计划摘要按 active/draft/archived 排序，同状态按最近更新，空输入安全返回。（原 L271-281）
test("logic L271: 计划摘要按 active/draft/archived 排序，同状态按最近更新，空输入安全返回。", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;

  // 分段职责：计划摘要按 active/draft/archived 排序，同状态按最近更新，空输入安全返回。
  // plan summaries sort active -> draft -> archived, ties by updatedAt desc (U1)
  const summaries = [
    { id: 'p_old_active', status: 'active', updatedAt: '2026-01-01' },
    { id: 'p_arch', status: 'archived', updatedAt: '2026-02-01' },
    { id: 'p_draft', status: 'draft', updatedAt: '2026-03-01' },
    { id: 'p_new_active', status: 'active', updatedAt: '2026-04-01' },
  ];
  assert.deepEqual(t.sortPlanSummaries(summaries).map((p) => p.id), ['p_new_active', 'p_old_active', 'p_draft', 'p_arch']);
  assert.deepEqual(t.sortPlanSummaries([]), []);
  assert.equal(t.sortPlanSummaries(null).length, 0);
});

// 责任：新草案 id 只能来自 plan/created，更新事件和空结果不能误认创建。（原 L282-287）
test("logic L282: 新草案 id 只能来自 plan/created，更新事件和空结果不能误认创建。", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;

  // 分段职责：新草案 id 只能来自 plan/created，更新事件和空结果不能误认创建。
  // the create result carries the new draft id on plan/created (U1)
  assert.equal(t.planCreatedId({ events: [{ type: 'plan/created', data: { id: 'pln_new' } }] }), 'pln_new');
  assert.equal(t.planCreatedId({ events: [{ type: 'plan/updated', data: { id: 'pln_other' } }] }), null);
  assert.equal(t.planCreatedId({}), null);
  assert.equal(t.planCreatedId(null), null);
});

// 责任：计划操作入口须按 head 状态及 focus 决定，归档计划只读。（原 L288-301）
test("logic L288: 计划操作入口须按 head 状态及 focus 决定，归档计划只读。", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;

  // 分段职责：计划操作入口须按 head 状态及 focus 决定，归档计划只读。
  // action availability derives from head status and focus (U1)
  assert.equal(t.planCanFocus({ status: 'active', focus: false }), true);
  assert.equal(t.planCanFocus({ status: 'active', focus: true }), false, 'focused plan cannot be focused again');
  assert.equal(t.planCanFocus({ status: 'draft' }), false, 'draft cannot be focused');
  assert.equal(t.planCanFocus({ status: 'archived' }), false, 'archived cannot be focused');
  assert.equal(t.planCanArchive({ status: 'active' }), true);
  assert.equal(t.planCanArchive({ status: 'draft' }), true);
  assert.equal(t.planCanArchive({ status: 'archived' }), false);
  assert.equal(t.planCanUnarchive({ status: 'archived' }), true);
  assert.equal(t.planCanUnarchive({ status: 'active' }), false);
  assert.equal(t.planCanEdit({ status: 'active' }), true);
  assert.equal(t.planCanEdit({ status: 'draft' }), true);
  assert.equal(t.planCanEdit({ status: 'archived' }), false, 'archived plans are read-only');
});

// 责任：编辑表单解析须保留既有 taskId、正确 CAS，并将移出任务列入 orphan 提示。（原 L302-329）
test("logic L302: 编辑表单解析须保留既有 taskId、正确 CAS，并将移出任务列入 orphan 提示。", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;

  // 分段职责：编辑表单解析须保留既有 taskId、正确 CAS，并将移出任务列入 orphan 提示。
  // plan editor (U2): comma/newline parsing, payload, diff and orphan accounting
  assert.deepEqual(t.planEditSplitList(' a, b,,c '), ['a', 'b', 'c']);
  assert.deepEqual(t.planEditSplitList('ui，plan，核心'), ['ui', 'plan', '核心']);
  assert.deepEqual(t.planEditSplitLines('一\n\n 二 \r\n三'), ['一', '二', '三']);
  const editForm = {
    steps: [{ key: 's_1', id: 's1', title: '核心', tasks: [
      { key: 't_1', taskId: 'tsk_a', title: '状态机', description: 'd', priority: '200', weight: '2', deps: '', acceptance: '', labels: 'core', requiresAudit: true },
      { key: 't_2', taskId: '', title: '新任务', description: '', priority: '', weight: '', deps: '', acceptance: '验收一\n验收二', labels: '', requiresAudit: false },
    ] }],
  };
  const editParsed = t.planEditSteps(editForm);
  assert.equal(editParsed.ok, true);
  assert.equal(editParsed.steps[0].tasks[0].taskId, 'tsk_a', 'existing tasks keep their taskId');
  assert.equal(editParsed.steps[0].tasks[0].priority, 200);
  assert.deepEqual(editParsed.steps[0].tasks[0].deps, []);
  assert.equal('taskId' in editParsed.steps[0].tasks[1], false, 'new tasks carry only the plan-local key');
  assert.deepEqual(editParsed.steps[0].tasks[1].acceptance, [{ text: '验收一' }, { text: '验收二' }]);
  assert.equal(t.planEditSteps({ steps: [] }).ok, false);
  assert.deepEqual(t.planEditPayload({ id: 'pln_1', status: 'active', currentVersion: 3 }, editParsed.steps), { op: 'plan.revise', planId: 'pln_1', baseVersion: 3, steps: editParsed.steps });
  assert.deepEqual(t.planEditPayload({ id: 'pln_2', status: 'draft', rev: 5 }, editParsed.steps), { op: 'plan.revise', planId: 'pln_2', expected: { entityRev: 5 }, steps: editParsed.steps });
  assert.deepEqual(t.planEditPublishPayload({ id: 'pln_2', rev: 5 }), { op: 'plan.publish', planId: 'pln_2', expected: { entityRev: 5 } });
  assert.equal(t.planEditDiff(editParsed.steps, editParsed.steps).changed, false, 'an identical payload diffs clean');
  const editDropped = t.planEditDiff(editParsed.steps, [{ id: 's1', title: '核心', tasks: [editParsed.steps[0].tasks[0]] }]);
  assert.equal(editDropped.removed, 1);
  assert.deepEqual(editDropped.removedTasks, [], 'key-only tasks are removed without orphan titles');
  const editOrphan = t.planEditDiff(editParsed.steps, [{ id: 's1', title: '核心', tasks: [editParsed.steps[0].tasks[1]] }]);
  assert.deepEqual(editOrphan.removedTasks, [{ taskId: 'tsk_a', title: '状态机' }], 'dropped existing tasks surface for the orphan warning');
});

// 责任：需要你计数合并审计 review/blocked/interrupted，重复任务只能计一次。（原 L330-339）
test("logic L330: 需要你计数合并审计 review/blocked/interrupted，重复任务只能计一次。", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;

  // 分段职责：需要你计数合并审计 review/blocked/interrupted，重复任务只能计一次。
  // need-you: gated review + blocked + interrupted, each task once (P5)
  const needBoard = {
    columns: { review: [{ id: 'r1', requiresAudit: true }, { id: 'r2' }] },
    attention: { blocked: [{ id: 'b1' }], interrupted: [{ id: 'i1' }, { id: 'b1' }] },
  };
  assert.equal(t.needYouCount(needBoard), 3);
  assert.equal(t.needYouCount(null), 0);
  assert.equal(t.needYouCount({ columns: {}, attention: {} }), 0);
  assert.equal(t.normalizeView('list'), 'list');
});

// 责任：纯函数动效时长须与 CSS token 一致，reduced-motion 返回零。（原 L340-352）
test("logic L340: 纯函数动效时长须与 CSS token 一致，reduced-motion 返回零。", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;

  // 分段职责：纯函数动效时长须与 CSS token 一致，reduced-motion 返回零。
  // motion tiers collapse to zero under reduced motion (P4)
  assert.equal(t.motionDurationMs('fast'), 120);
  assert.equal(t.motionDurationMs('base'), 180);
  assert.equal(t.motionDurationMs('slow'), 240);
  assert.equal(t.motionDurationMs('flash'), 300);
  assert.equal(t.motionDurationMs('nope'), 180, 'unknown tier falls back to base');
  assert.equal(t.motionDurationMs('base', true), 0, 'reduced motion collapses the delay');
  assert.deepEqual(t.MOTION, { fast: 120, base: 180, slow: 240, flash: 300 });
  assert.equal(t.normalizeView('board'), 'board');
  assert.equal(t.normalizeView('nope'), 'board', 'unknown view falls back to board');
  assert.ok(t, 'pure helpers exported for tests');
});

// 责任：卡片搜索和状态/门/计划筛选须准确，空白查询不算活跃条件。（原 L353-374）
test("logic L353: 卡片搜索和状态/门/计划筛选须准确，空白查询不算活跃条件。", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;

  // 分段职责：卡片搜索和状态/门/计划筛选须准确，空白查询不算活跃条件。
  const cards = [
    { id: 'tsk_a', title: '回调路由', state: 'ready', labels: ['ui'], acceptance: { met: 0, total: 2 }, evidenceCount: 0 },
    { id: 'tsk_b', title: '补 401 测试', state: 'in_progress', labels: ['gate:audit'], acceptance: { met: 1, total: 2 }, evidenceCount: 3, owner: { sessionId: 'session-abcdef123456' } },
    { id: 'tsk_c', title: '文档排版', state: 'review', requiresAudit: true, acceptance: { met: 2, total: 2 }, evidenceCount: 1 },
    { id: 'tsk_d', title: '崩溃对账', state: 'done', blocked: { code: 'external-dependency', note: '等上游' } },
  ];
  assert.deepEqual(t.filterCards(cards, {}).map((c) => c.id), ['tsk_a', 'tsk_b', 'tsk_c', 'tsk_d']);
  assert.deepEqual(t.filterCards(cards, { state: 'ready' }).map((c) => c.id), ['tsk_a']);
  assert.deepEqual(t.filterCards(cards, { gateOnly: true }).map((c) => c.id), ['tsk_b', 'tsk_c']);
  assert.deepEqual(t.filterCards(cards, { query: '测试' }).map((c) => c.id), ['tsk_b']);
  assert.deepEqual(t.filterCards(cards, { query: 'session-abcdef' }).map((c) => c.id), ['tsk_b']);
  assert.deepEqual(t.filterCards(cards, { query: '上游' }).map((c) => c.id), ['tsk_d']);
  assert.deepEqual(t.filterCards(cards, { query: 'TSK_C' }).map((c) => c.id), ['tsk_c']);
  assert.deepEqual(t.filterCards(cards, { query: '不存在' }), []);
  assert.equal(t.hasActiveFilters({}), false);
  assert.equal(t.hasActiveFilters({ query: '  ' }), false);
  assert.equal(t.hasActiveFilters({ gateOnly: true }), true);
  assert.deepEqual(t.filterCards([{ id: 'p1', planRef: { stepId: 's1' } }, { id: 'p2' }], { plan: 'in' }).map((c) => c.id), ['p1']);
  assert.deepEqual(t.filterCards([{ id: 'p1', planRef: { stepId: 's1' } }, { id: 'p2' }], { plan: 'out' }).map((c) => c.id), ['p2']);
  assert.equal(t.hasActiveFilters({ plan: 'in' }), true, 'plan filter counts as active');
});

// 责任：工作区匹配优先精确再最近祖先，Windows 大小写归一但相似兄弟前缀不得误匹配。（原 L375-395）
test("logic L375: 工作区匹配优先精确再最近祖先，Windows 大小写归一但相似兄弟前缀不得误匹配。", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;

  // 分段职责：工作区匹配优先精确再最近祖先，Windows 大小写归一但相似兄弟前缀不得误匹配。
  // workspace -> project resolution (exact wins, then nearest ancestor)
  const projects = [
    { id: 'p_root', workspacePath: 'D:\\SampleWorkspace\\示例集合' },
    { id: 'p_repo', workspacePath: 'd:/SampleWorkspace/示例集合/dsh-project-board' },
    { id: 'p_other', workspacePath: 'D:\\SampleWorkspace\\辅助项目' },
  ];
  assert.equal(t.matchProjectByCwd(projects, 'D:\\SampleWorkspace\\示例集合\\dsh-project-board').project.id, 'p_repo');
  assert.equal(t.matchProjectByCwd(projects, 'D:\\SampleWorkspace\\示例集合\\dsh-project-board\\').exact, true);
  assert.equal(t.matchProjectByCwd(projects, 'D:\\SampleWorkspace\\示例集合\\dsh-project-board\\lib').project.id, 'p_repo');
  assert.equal(t.matchProjectByCwd(projects, 'd:\\sampleworkspace\\示例集合\\dsh-project-board').project.id, 'p_repo');
  assert.equal(t.matchProjectByCwd(projects, 'D:\\SampleWorkspace\\示例集合\\sub').project.id, 'p_root');
  assert.equal(t.matchProjectByCwd(projects, 'D:\\SampleWorkspace\\示例集合\\sub').exact, false);
  assert.equal(t.matchProjectByCwd(projects, 'D:\\SampleWorkspace\\示例集合2'), null, 'sibling prefix is not an ancestor');
  assert.equal(t.matchProjectByCwd(projects, 'D:\\SampleWorkspace\\辅助项目x'), null);
  assert.equal(t.matchProjectByCwd(projects, ''), null);
  assert.equal(t.matchProjectByCwd(null, 'D:\\x'), null);
  assert.equal(t.normalizeWorkspacePath('D:\\A\\B\\'), 'D:/A/B');
  assert.equal(t.comparablePath('D:\\A\\B'), 'd:/a/b');
  assert.equal(t.comparablePath('/home/Me/Repo'), '/home/Me/Repo', 'posix paths stay case-sensitive');
});

// 责任：挂载前的跳转请求须留存，消费后不能再次返回。（原 L396-401）
test("logic L396: 挂载前的跳转请求须留存，消费后不能再次返回。", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;

  // 分段职责：挂载前的跳转请求须留存，消费后不能再次返回。
  // the jump request survives until the board page mounts
  t.requestBoardJump('D:\\SampleWorkspace\\示例集合');
  assert.equal(t.consumePendingJump(), 'D:\\SampleWorkspace\\示例集合');
  assert.equal(t.consumePendingJump(), null, 'jump is consumed once');
});

// 责任：已有文档默认只读预览，只有显式 preview:false 或新文档才进入编辑。（原 L402-408）
test("logic L402: 已有文档默认只读预览，只有显式 preview:false 或新文档才进入编辑。", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;

  // 分段职责：已有文档默认只读预览，只有显式 preview:false 或新文档才进入编辑。
  // docs open in read mode; the editor is explicit
  assert.equal(t.initialPreview({ docId: 'doc_1' }), true);
  assert.equal(t.initialPreview({ docId: 'doc_1', preview: false }), false);
  assert.equal(t.initialPreview({}), false);
  assert.equal(t.initialPreview(null), false);
});

// 责任：任务跳会话优先租约 owner，无 owner 再选最新证据生产者，缺身份返回空。（原 L409-420）
test("logic L409: 任务跳会话优先租约 owner，无 owner 再选最新证据生产者，缺身份返回空。", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;

  // 分段职责：任务跳会话优先租约 owner，无 owner 再选最新证据生产者，缺身份返回空。
  // task -> session: lease owner first, then the newest evidence producer
  assert.deepEqual(t.pickTaskSession({ owner: { sessionId: 's1' }, evidence: [{ at: '2026-01-02', producedBy: { sessionId: 's2' } }] }), { sessionId: 's1', source: 'owner' });
  assert.deepEqual(t.pickTaskSession({
    evidence: [
      { at: '2026-01-01', producedBy: { sessionId: 's2' } },
      { at: '2026-01-03', producedBy: { sessionId: 's3' } },
    ],
  }), { sessionId: 's3', source: 'evidence' });
  assert.deepEqual(t.pickTaskSession({ evidence: [{ at: '2026-01-01' }] }), { sessionId: null, source: null });
  assert.deepEqual(t.pickTaskSession(null), { sessionId: null, source: null });
});

// 责任：工作区会话选择须归一化路径并排除空白和子代理，取最新有效会话。（原 L421-434）
test("logic L421: 工作区会话选择须归一化路径并排除空白和子代理，取最新有效会话。", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;

  // 分段职责：工作区会话选择须归一化路径并排除空白和子代理，取最新有效会话。
  // workspace -> newest session: skip blank and subagent rows, normalise the path
  const sessionRows = {
    a: { cwd: 'D:\\SampleWorkspace\\示例集合', updatedAt: 5 },
    b: { cwd: 'd:/sampleworkspace/示例集合/', updatedAt: 9 },
    c: { cwd: 'D:\\SampleWorkspace\\示例集合', updatedAt: 12, blank: true },
    d: { cwd: 'D:\\SampleWorkspace\\示例集合', updatedAt: 15, origin: 'subagent' },
    e: { cwd: 'D:\\SampleWorkspace\\辅助项目', updatedAt: 20 },
  };
  assert.deepEqual(t.pickLatestSession(sessionRows, 'D:\\SampleWorkspace\\示例集合'), { sessionId: 'b', updatedAt: 9 });
  assert.equal(t.pickLatestSession(sessionRows, 'D:\\nope'), null);
  assert.equal(t.pickLatestSession({}, 'D:\\SampleWorkspace\\示例集合'), null);
  assert.equal(t.pickLatestSession(null, 'D:\\SampleWorkspace\\示例集合'), null);
});

// 责任：更新任务关联须去重且保留原 planRefs，不能因整包替换丢计划链接。（原 L435-442）
test("logic L435: 更新任务关联须去重且保留原 planRefs，不能因整包替换丢计划链接。", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;

  // 分段职责：更新任务关联须去重且保留原 planRefs，不能因整包替换丢计划链接。
  // doc.link replaces links wholesale: planRefs must survive an edit
  assert.deepEqual(
    t.docLinkPayload({ taskIds: ['a'], planRefs: [{ planId: 'pln_1', version: 2 }] }, ['a', 'b', 'b']),
    { taskIds: ['a', 'b'], planRefs: [{ planId: 'pln_1', version: 2 }] },
  );
  assert.deepEqual(t.docLinkPayload(null, ['x']), { taskIds: ['x'], planRefs: [] });
});

// 责任：正文搜索须大小写无关且所有关键字匹配，命中片段保留原文字并有界截断。（原 L443-455）
test("logic L443: 正文搜索须大小写无关且所有关键字匹配，命中片段保留原文字并有界截断。", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;

  // 分段职责：正文搜索须大小写无关且所有关键字匹配，命中片段保留原文字并有界截断。
  // body search: case-insensitive AND across keywords, snippet around the first hit
  assert.deepEqual(t.matchDocText('Hello World', ''), { hit: true, snippet: '' });
  const bodyHit = t.matchDocText('第一行\n带 MySQL 的说明', 'mysql');
  assert.equal(bodyHit.hit, true);
  assert.ok(bodyHit.snippet.includes('MySQL'), 'snippet keeps original casing');
  assert.equal(t.matchDocText('alpha beta', 'alpha gamma').hit, false, 'all keywords must match');
  assert.equal(t.matchDocText('Alpha', 'ALPHA').hit, true);
  const longBody = 'x'.repeat(120) + 'needle' + 'y'.repeat(200);
  const longHit = t.matchDocText(longBody, 'needle');
  assert.equal(longHit.hit, true);
  assert.ok(longHit.snippet.startsWith('…') && longHit.snippet.endsWith('…'), 'snippet is clipped on both sides');
});

// 责任：目录只提取标题块且保持文档顺序，空正文目录为空。（原 L456-462）
test("logic L456: 目录只提取标题块且保持文档顺序，空正文目录为空。", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;

  // 分段职责：目录只提取标题块且保持文档顺序，空正文目录为空。
  // TOC: heading blocks only, in document order
  const toc = t.docHeadings(t.markdownBlocks('# 一\n\n正文\n\n## 二\n\n### 三'));
  assert.deepEqual(toc.map((item) => item.level), [1, 2, 3]);
  assert.deepEqual(toc.map((item) => item.text), ['一', '二', '三']);
  assert.deepEqual(t.docHeadings([]), []);
});

// 责任：文档 id/title/kind/body 任一变化都须触发草稿脏标记，未改新稿保持干净。（原 L463-472）
test("logic L463: 文档 id/title/kind/body 任一变化都须触发草稿脏标记，未改新稿保持干净。", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;

  // 分段职责：文档 id/title/kind/body 任一变化都须触发草稿脏标记，未改新稿保持干净。
  // dirty guard: any of id/title/kind/body drifting makes the draft dirty
  const savedDoc = { title: 'T', kind: 'note', body: 'B', docId: 'doc_1' };
  assert.equal(t.docDirty(savedDoc, { title: 'T', kind: 'note', body: 'B' }, 'doc_1'), false);
  assert.equal(t.docDirty(savedDoc, { title: 'T2', kind: 'note', body: 'B' }, 'doc_1'), true);
  assert.equal(t.docDirty(savedDoc, { title: 'T', kind: 'spec', body: 'B' }, 'doc_1'), true);
  assert.equal(t.docDirty(savedDoc, { title: 'T', kind: 'note', body: 'B2' }, 'doc_1'), true);
  assert.equal(t.docDirty(savedDoc, { title: 'T', kind: 'note', body: 'B' }, 'doc_2'), true, 'switching documents counts as dirty');
  assert.equal(t.docDirty({ title: '', kind: 'note', body: '', docId: null }, { title: '', kind: 'note', body: '' }, null), false, 'untouched new doc is clean');
});

// 责任：代码围栏须保留语言和正文，供标签和复制栏使用。（原 L473-479）
test("logic L473: 代码围栏须保留语言和正文，供标签和复制栏使用。", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;

  // 分段职责：代码围栏须保留语言和正文，供标签和复制栏使用。
  // code fences keep the language for the label/copy bar
  const codeBlock = t.markdownBlocks('\u0060\u0060\u0060js\nconst a = 1;\n\u0060\u0060\u0060');
  assert.equal(codeBlock[0].type, 'code');
  assert.equal(codeBlock[0].lang, 'js');
  assert.equal(codeBlock[0].text, 'const a = 1;');
});

// 责任：比例计算须夹在合法范围并处理除零，状态色调和审计门识别保持安全回退。（原 L480-494）
test("logic L480: 比例计算须夹在合法范围并处理除零，状态色调和审计门识别保持安全回退。", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;

  // 分段职责：比例计算须夹在合法范围并处理除零，状态色调和审计门识别保持安全回退。
  assert.equal(t.percentOf(0.8), 80);
  assert.equal(t.percentOf(-1), 0);
  assert.equal(t.percentOf(2), 100);
  assert.equal(t.percentOf('nope'), 0);
  assert.equal(t.ratioPercent(1, 4), 25);
  assert.equal(t.ratioPercent(1, 0), 0);

  assert.equal(t.stateTone('review'), 'violet');
  assert.equal(t.stateTone('blocked'), 'danger');
  assert.equal(t.stateTone('unknown'), 'muted');
  assert.equal(t.isGate({ requiresAudit: true }), true);
  assert.equal(t.isGate({ labels: ['gate:audit'] }), true);
  assert.equal(t.isGate({ labels: ['ui'] }), false);
});

// 责任：证据载荷须 trim ref、保留验收点；命令体只在确有租约时携带 fencingToken。（原 L495-511）
test("logic L495: 证据载荷须 trim ref、保留验收点；命令体只在确有租约时携带 fencingToken。", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;

  // 分段职责：证据载荷须 trim ref、保留验收点；命令体只在确有租约时携带 fencingToken。
  assert.deepEqual(t.buildEvidence({ kind: 'file', ref: '  lib/client.js ', summary: '' }), {
    kind: 'file', ref: 'lib/client.js', summary: '证据',
  });
  assert.equal(t.buildEvidence({ kind: 'doc', ref: 'doc_x@2', acceptanceId: 'acc_1' }).acceptanceId, 'acc_1');
  assert.equal('acceptanceId' in t.buildEvidence({ kind: 'note', ref: 'n' }), false);

  const view = { task: { id: 'tsk_a', rev: 7 }, lease: { token: 42 } };
  assert.deepEqual(t.commandBody(view, 'submit', { note: undefined, evidence: [{ kind: 'note', ref: 'n', summary: 's' }] }), {
    op: 'task.submit',
    taskId: 'tsk_a',
    expected: { entityRev: 7 },
    fencingToken: 42,
    evidence: [{ kind: 'note', ref: 'n', summary: 's' }],
  });
  assert.equal('fencingToken' in t.commandBody({ task: { id: 'x', rev: 1 } }, 'verify'), false);
});

// 责任：混合 Markdown 须正确分块并保留列表、代码语言及正文。（原 L512-539）
test("logic L512: 混合 Markdown 须正确分块并保留列表、代码语言及正文。", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;
  const TICK = '\u0060';
  const FENCE = TICK.repeat(3);

  // 分段职责：混合 Markdown 须正确分块并保留列表、代码语言及正文。
  // markdown: headings / lists / fences / quotes / paragraphs / inline
  const docBody = [
    '# 标题',
    '',
    '一段 **加粗** 和 ' + TICK + '代码' + TICK + ' 文本。',
    '',
    '- 一',
    '- 二',
    '',
    '1. 有序',
    '',
    '> 引用',
    '',
    FENCE + 'js',
    'const a = 1;',
    FENCE,
  ].join('\n');
  const blocks = t.markdownBlocks(docBody);
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'paragraph', 'list', 'list', 'quote', 'code']);
  assert.equal(blocks[0].level, 1);
  assert.equal(blocks[1].text, '一段 **加粗** 和 ' + TICK + '代码' + TICK + ' 文本。');
  assert.deepEqual(blocks[2].items, ['一', '二']);
  assert.equal(blocks[3].ordered, true);
  assert.equal(blocks[4].text, '引用');
  assert.equal(blocks[5].lang, 'js');
  assert.equal(blocks[5].text, 'const a = 1;');
});

// 责任：带 chart/flow 属性的围栏必须识别为代码并前进，防止解析死循环。（原 L540-550）
test("logic L540: 带 chart/flow 属性的围栏必须识别为代码并前进，防止解析死循环。", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;
  const TICK = '\u0060';
  const FENCE = TICK.repeat(3);

  // 分段职责：带 chart/flow 属性的围栏必须识别为代码并前进，防止解析死循环。
  // regression: a fence with an attribute info string (chart/flow DSL). Before
  // the fix it fell through to the paragraph branch, which refused to consume
  // the line, so markdownBlocks spun forever and froze the docs page.
  const attrFence = t.markdownBlocks([FENCE + 'chart type=bar title=state', 'A 1', FENCE].join('\n'));
  assert.equal(attrFence.length, 1);
  assert.equal(attrFence[0].type, 'code');
  assert.equal(attrFence[0].lang, 'chart');
  assert.equal(attrFence[0].info, 'chart type=bar title=state');
  assert.equal(attrFence[0].text, 'A 1');
});

// 责任：未闭合围栏仍输出一个代码块，不得无界扫描。（原 L551-557）
test("logic L551: 未闭合围栏仍输出一个代码块，不得无界扫描。", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;
  const TICK = '\u0060';
  const FENCE = TICK.repeat(3);

  // 分段职责：未闭合围栏仍输出一个代码块，不得无界扫描。
  // an unterminated fence still yields one block instead of scanning forever
  const openFence = t.markdownBlocks([FENCE + 'js', 'const a = 1;'].join('\n'));
  assert.equal(openFence.length, 1);
  assert.equal(openFence[0].lang, 'js');
  assert.equal(openFence[0].text, 'const a = 1;');
});

// 责任：裸围栏及更长围栏须可解析并保留语言与正文。（原 L558-568）
test("logic L558: 裸围栏及更长围栏须可解析并保留语言与正文。", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;
  const TICK = '\u0060';
  const FENCE = TICK.repeat(3);

  // 分段职责：裸围栏及更长围栏须可解析并保留语言与正文。
  // bare fence and a longer fence run stay parseable
  const bareFence = t.markdownBlocks([FENCE, 'x', FENCE].join('\n'));
  assert.equal(bareFence.length, 1);
  assert.equal(bareFence[0].lang, '');
  assert.equal(bareFence[0].text, 'x');
  const longFence = t.markdownBlocks([TICK.repeat(4) + 'js', 'y', TICK.repeat(4)].join('\n'));
  assert.equal(longFence.length, 1);
  assert.equal(longFence[0].lang, 'js');
  assert.equal(longFence[0].text, 'y');
});

// 责任：未识别行也须恰好消费，异常输入不能卡住解析器。（原 L569-575）
test("logic L569: 未识别行也须恰好消费，异常输入不能卡住解析器。", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;
  const TICK = '\u0060';
  const FENCE = TICK.repeat(3);

  // 分段职责：未识别行也须恰好消费，异常输入不能卡住解析器。
  // safety net: unrecognised lines are consumed once instead of stalling
  const oddLines = t.markdownBlocks(['#####', '| a | b |', FENCE + 'a b', 'z'].join('\n'));
  assert.equal(oddLines.length, 2);
  assert.equal(oddLines[0].type, 'paragraph');
  assert.equal(oddLines[1].type, 'code');
});

// 责任：表格须保留对齐、行内语法和转义竖线，不能误拆单元格。（原 L576-592）
test("logic L576: 表格须保留对齐、行内语法和转义竖线，不能误拆单元格。", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;
  const TICK = '\u0060';

  // 分段职责：表格须保留对齐、行内语法和转义竖线，不能误拆单元格。
  // tables: alignment, inline cells, escaped pipes, and non-table paragraphs
  const tableBody = [
    '| 名称 | 数量 | 备注 |',
    '| :--- | ---: | :---: |',
    '| **a** | 12 | ' + TICK + 'x' + TICK + ' |',
    '| a \\| b | 3 |  |',
  ].join('\n');
  const table = t.markdownBlocks(tableBody);
  assert.equal(table.length, 1);
  assert.equal(table[0].type, 'table');
  assert.deepEqual(table[0].align, ['left', 'right', 'center']);
  assert.deepEqual(table[0].header, ['名称', '数量', '备注']);
  assert.equal(table[0].rows.length, 2);
  assert.deepEqual(table[0].rows[0], ['**a**', '12', TICK + 'x' + TICK]);
  assert.equal(table[0].rows[1][0], 'a | b');
});

// 责任：短表格分隔符合法，但列数不匹配须回到普通段落。（原 L593-600）
test("logic L593: 短表格分隔符合法，但列数不匹配须回到普通段落。", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;

  // 分段职责：短表格分隔符合法，但列数不匹配须回到普通段落。
  // short delimiters (":--") are valid, but a cell-count mismatch is not a table
  const shortTable = t.markdownBlocks(['| a | b |', '| :-- | --: |', '| 1 | 2 |'].join('\n'));
  assert.equal(shortTable[0].type, 'table');
  assert.deepEqual(shortTable[0].align, ['left', 'right']);
  const mismatch = t.markdownBlocks(['a | b', '---'].join('\n'));
  assert.equal(mismatch[0].type, 'paragraph');
});

// 责任：没有合法分隔行的竖线文本只能是段落，不能误判表格。（原 L601-606）
test("logic L601: 没有合法分隔行的竖线文本只能是段落，不能误判表格。", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;

  // 分段职责：没有合法分隔行的竖线文本只能是段落，不能误判表格。
  // a pipe paragraph without a delimiter row stays a paragraph
  const notTable = t.markdownBlocks('a | b\nc | d');
  assert.equal(notTable.length, 1);
  assert.equal(notTable[0].type, 'paragraph');
});

// 责任：分割线须单独分块，有序列表须保留起始编号和项目文本。（原 L607-614）
test("logic L607: 分割线须单独分块，有序列表须保留起始编号和项目文本。", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;

  // 分段职责：分割线须单独分块，有序列表须保留起始编号和项目文本。
  // horizontal rule and ordered list start
  assert.deepEqual(t.markdownBlocks('前文\n\n---\n\n后文').map((b) => b.type), ['paragraph', 'hr', 'paragraph']);
  const ordered = t.markdownBlocks('3. 第三\n4. 第四');
  assert.equal(ordered[0].ordered, true);
  assert.equal(ordered[0].start, 3);
  assert.deepEqual(ordered[0].items, ['第三', '第四']);
});

// 责任：仅 http(s)/mailto 可点击，脚本和相对链接必须保持惰性。（原 L615-621）
test("logic L615: 仅 http(s)/mailto 可点击，脚本和相对链接必须保持惰性。", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;

  // 分段职责：仅 http(s)/mailto 可点击，脚本和相对链接必须保持惰性。
  // links: only http(s)/mailto are clickable, everything else stays inert
  assert.equal(t.linkTarget('https://example.com/x').external, true);
  assert.equal(t.linkTarget('http://example.com').href, 'http://example.com');
  assert.equal(t.linkTarget('mailto:a@b.c').external, false);
  assert.equal(t.linkTarget('javascript:alert(1)'), null);
  assert.equal(t.linkTarget('docs/a.md'), null);
});

// 责任：图表 DSL 须解析、布局并渲染可访问 SVG，非法图表回退错误和原代码。（原 L658-682）
test("chart parsing and layout", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;

  // 分段职责：图表 DSL 须解析、布局并渲染可访问 SVG，非法图表回退错误和原代码。
  // chart DSL: parse -> layout -> SVG, with a graceful fallback
  const chartSpec = t.parseChartSpec('chart type=bar title="任务状态" unit=个', '待办 3\n就绪 4\n进行中 1');
  assert.equal(chartSpec.ok, true);
  assert.equal(chartSpec.spec.type, 'bar');
  assert.equal(chartSpec.spec.title, '任务状态');
  assert.equal(chartSpec.spec.unit, '个');
  assert.deepEqual(chartSpec.spec.items.map((item) => item.value), [3, 4, 1]);
  assert.equal(t.parseChartSpec('chart type=pie', 'A 1\nB 3').ok, true);
  assert.equal(t.parseChartSpec('chart type=donut', 'A 1\nB 3').ok, true);
  assert.equal(t.parseChartSpec('chart type=radar', 'A 1').ok, false);
  assert.equal(t.parseChartSpec('chart type=bar', '').ok, false);
  assert.equal(t.parseChartSpec('chart type=bar', '没有数字').ok, false);
  assert.equal(t.parseChartSpec('chart type=pie', 'A -1\nB 2').ok, false);
  assert.equal(t.parseChartSpec('chart', '进行 中 2').spec.items[0].label, '进行 中');
  const manyRows = Array.from({ length: 25 }, (_, i) => '列' + i + ' ' + (i + 1)).join('\n');
  assert.equal(t.parseChartSpec('chart', manyRows).ok, false);
  const chartBarLayout = t.chartLayout(chartSpec.spec);
  assert.equal(chartBarLayout.shapes.length, 3);
  assert.ok(chartBarLayout.shapes[1].height > chartBarLayout.shapes[0].height);
  const chartNeg = t.parseChartSpec('chart type=bar', 'A -2\nB 3');
  assert.equal(chartNeg.ok, true);
  const chartNegLayout = t.chartLayout(chartNeg.spec);
  assert.ok(Math.abs(chartNegLayout.shapes[0].y - chartNegLayout.zero) < 0.01);
  assert.ok(chartNegLayout.shapes[0].height > 0);
});

// 责任：校验行内粗体、代码及链接的解析类型和内容。（原 L697-703）
test("inline runs", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;
  const TICK = '\u0060';

  const runs = t.inlineRuns('前 **粗** 中 ' + TICK + '码' + TICK + ' 后');
  assert.deepEqual(runs.map((r) => r.type), ['text', 'strong', 'text', 'code', 'text']);
  assert.equal(runs[1].text, '粗');
  assert.equal(runs[3].text, '码');
  const linkRuns = t.inlineRuns('见 [文档](https://example.com/x)');
  assert.equal(linkRuns[1].type, 'link');
  assert.equal(linkRuns[1].href, 'https://example.com/x');
});

// 责任：原始 HTML 必须作为普通文本保留，不能进入可执行 HTML 路径。（原 L705-710）
test("inert raw HTML", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;

  // 分段职责：原始 HTML 必须作为普通文本保留，不能进入可执行 HTML 路径。
  // html in markdown must stay inert (no raw HTML path in the renderer)
  const hostile = t.markdownBlocks('<img src=x onerror=alert(1)>');
  assert.equal(hostile.length, 1);
  assert.equal(hostile[0].type, 'paragraph');
  assert.equal(hostile[0].text, '<img src=x onerror=alert(1)>');
});

// 责任：错误、warning、权限理由及短 id 须映射成稳定可读文案。（原 L712-716）
test("readable errors and identifiers", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;

  // 分段职责：错误、warning、权限理由及短 id 须映射成稳定可读文案。
  assert.equal(t.warningText('doc-drift: doc_x'), '文档漂移: doc_x');
  assert.equal(t.errorText({ code: 'stale-revision', message: 'x' }), '版本已过期，请刷新后重试 [stale-revision]');
  assert.equal(t.reasonText('human only'), '仅人类可操作');
  assert.equal(t.shortId('tsk_0123456789abcdef', 10), 'tsk_012345…');
});

// 责任：校验排名强调仅覆盖前三名，非法排名使用普通层级。（原 L799-803）
test("rank emphasis tiers", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;

  assert.equal(t.rankTier(1), 'top');
  assert.equal(t.rankTier(3), 'top');
  assert.equal(t.rankTier(4), 'rest', 'rank 4 leaves the emphasis tier');
  assert.equal(t.rankTier(null), 'rest');
  assert.equal(t.rankTier(0), 'rest');
});

// 责任：计划目录去重时 board 副本优先，未知计划只能诚实降级“计划内”。（原 L805-817）
test("plan catalog and honest fallback", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;

  // 分段职责：计划目录去重时 board 副本优先，未知计划只能诚实降级“计划内”。
  // P6: plan catalog resolves the plan copy on cards, dedupes board + /plans, and
  // degrades to 计划内 for a plan the client has never seen.
  const p6Catalog = t.planCatalog(
    { plans: [{ id: 'pln_a', title: '活跃计划', steps: [{ id: 's1', title: '第一步' }] }], plan: { id: 'pln_focus', title: '聚焦计划', steps: [] } },
    [{ id: 'pln_a', title: '旧副本', steps: [] }, { id: 'pln_b', title: '归档计划', steps: [{ id: 's9', title: '收口' }] }],
  );
  assert.deepEqual(p6Catalog.map((plan) => plan.id), ['pln_a', 'pln_b', 'pln_focus'], 'board copy wins over the plans view; the focused plan is kept as the last fallback');
  assert.deepEqual(t.planMeta(p6Catalog, { planId: 'pln_b', stepId: 's9' }), {
    key: 'plan:pln_b:s9', title: '归档计划 · 收口', planTitle: '归档计划', stepTitle: '收口', known: true,
  });
  assert.equal(t.planMeta(p6Catalog, { planId: 'pln_missing' }).title, '计划内', 'unknown plans stay honest instead of inventing a name');
  assert.deepEqual(t.planMeta(p6Catalog, null), { key: 'out', title: '计划外', planTitle: '', stepTitle: '', known: false });
});

// 责任：多计划列表排序不得受 focus 改序，须传递所有计划和焦点并让搜索命中计划 id。（原 L1064-1078）
test("multi-plan sort", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;

  // 分段职责：多计划列表排序不得受 focus 改序，须传递所有计划和焦点并让搜索命中计划 id。
  // multi-plan list / focus / filtering (T1): the pure sort keeps archived last
  // and never reorders by focus, the plans page passes the sorted list and the
  // focused head into its view, and plan ids are part of the search haystack
  const multiSummaries = [
    { id: 'p_arch_new', title: '归档计划', status: 'archived', updatedAt: '2026-10-26T10:00:00Z', focus: false },
    { id: 'p_draft', title: '草稿计划', status: 'draft', updatedAt: '2026-10-25T10:00:00Z', focus: false },
    { id: 'p_act_old', title: '旧计划', status: 'active', updatedAt: '2026-10-24T10:00:00Z', focus: false },
    { id: 'p_act_new', title: '演示计划', status: 'active', updatedAt: '2026-10-26T09:00:00Z', focus: true },
  ];
  assert.deepEqual(
    t.sortPlanSummaries(multiSummaries).map((plan) => plan.id),
    ['p_act_new', 'p_act_old', 'p_draft', 'p_arch_new'],
    'focus never reorders; archived stays last even with the newest updatedAt',
  );
});

// 责任：校验卡片搜索能够命中关联计划 id。（原 L1109-1109）
test("plan id search", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;

  assert.deepEqual(t.filterCards([{ id: 'p1', title: 'x', planRef: { planId: 'pln_zz' } }, { id: 'p2', title: 'x' }], { query: 'pln_zz' }).map((card) => card.id), ['p1'], 'plan id is part of the card search haystack');
});
