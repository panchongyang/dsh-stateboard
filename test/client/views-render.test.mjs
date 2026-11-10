/**
 * 测试职责：冻结离线组件树及页面接线，逐 section 独立失败。
 * 典型流程：读取真实 bundle → 构造独立离线替身 → 逐段断言契约。
 * 覆盖边界：覆盖 出货产物的离线契约；不覆盖真实 DOM、浏览器视觉、网络或宿主会话。
 * 外部前置：需要仓库现有客户端构建产物；不启动浏览器。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadClientBundle, flattenTree, nodeText, cardsFixture, editFixture, tableFixture, multiSummariesFixture } from '../helpers/client-bundle-fixture.mjs';

// 责任：Markdown 通过真实 React 元素表示表格/链接/任务框，不得用 innerHTML。（原 L623-624、L640-655）
test("markdown elements and inert links", () => {
  const { exportsValue } = loadClientBundle();
  const tableBody = tableFixture();
  // 分段职责：Markdown 通过真实 React 元素表示表格/链接/任务框，不得用 innerHTML。
  // rendering: table/link/task-list/hr map to real elements (no innerHTML)
  const mdUi = exportsValue.__ui;
  const rendered = flattenTree(mdUi.Markdown({ body: tableBody + '\n\n---\n\n- [x] 完成\n- [ ] 未完成\n\n见 [文档](https://example.com/x)' }), []);
  const tags = rendered.map((node) => node.type);
  assert.ok(tags.includes('table') && tags.includes('thead') && tags.includes('td'));
  assert.ok(tags.includes('hr'));
  const linkNode = rendered.filter((node) => node.type === 'a')[0];
  assert.equal(linkNode.props.href, 'https://example.com/x');
  assert.equal(linkNode.props.target, '_blank');
  assert.equal(linkNode.props.rel, 'noopener noreferrer');
  const checks = rendered.filter((node) => node.type === 'input');
  assert.equal(checks.length, 2);
  assert.equal(checks[0].props.checked, true);
  assert.equal(checks[1].props.checked, false);
  const inert = flattenTree(mdUi.Markdown({ body: '[x](javascript:alert(1))' }), []);
  assert.equal(inert.filter((node) => node.type === 'a').length, 0);
  assert.ok(inert.some((node) => String(node.props && node.props.className || '').includes('pb-md__link--inert')));
});

// 责任：图表 DSL 须解析、布局并渲染可访问 SVG，非法图表回退错误和原代码。（原 L683-696）
test("chart rendering and accessible fallback", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;
  const TICK = '\u0060';
  const FENCE = TICK.repeat(3);
  const mdUi = exportsValue.__ui;
  const chartMd = flattenTree(mdUi.Markdown({ body: [FENCE + 'chart type=bar title=任务状态', '待办 3', '就绪 4', FENCE].join('\n') }), []);
  const chartNode = chartMd.filter((node) => node.type === t.chartView)[0];
  assert.ok(chartNode, 'chart fence routes to ChartView');
  const chartTree = flattenTree(t.chartView(chartNode.props), []);
  const chartSvg = chartTree.filter((node) => node.type === 'svg')[0];
  assert.equal(chartSvg.props.role, 'img');
  assert.ok(String(chartSvg.props['aria-label']).includes('待办 3'));
  assert.ok(chartTree.some((node) => node.type === 'table' && String(node.props.className).includes('pb-chart__sr')));
  assert.ok(chartTree.some((node) => String(node.props.className).includes('pb-chart__bar')));
  const chartPie = flattenTree(t.chartView({ info: 'chart type=pie', text: 'A 1\nB 3' }), []);
  assert.ok(chartPie.some((node) => String(node.props.className).includes('pb-chart__slice')));
  const chartBad = flattenTree(t.chartView({ info: 'chart type=radar', text: 'A 1' }), []);
  assert.ok(chartBad.some((node) => node.props.className === 'pb-chart__error'));
  assert.ok(chartBad.some((node) => node.type === 'pre'));
});

// 责任：无 DOM 执行看板树须成功，保留五列、两个统计块和全局排名接线。（原 L740-767）
test("board columns statistics and ranking", () => {
  const { exportsValue } = loadClientBundle();
  const ui = exportsValue.__ui;
  const cards = cardsFixture();
  // 分段职责：无 DOM 执行看板树须成功，保留五列、两个统计块和全局排名接线。
  // rendering the tree without a DOM must not throw (hooks are stubbed, no effects)
  const boardTree = ui.BoardView({
    board: {
      project: { id: 'prj_x', name: '演示', phase: 'active', workspacePath: 'D:/SampleWorkspace/demo' },
      rev: 12,
      counts: { total: 2, ready: 1, inProgress: 0, review: 1, done: 0, blocked: 0, interrupted: 0, percent: 0.5, verifiedPercent: 0, weightTotal: 2, weightDone: 1 },
      columns: { backlog: [], ready: [cards[0]], in_progress: [], review: [cards[2]], done: [] },
      attention: { blocked: [], interrupted: [] },
    },
    filters: {},
    onOpen() {},
  });
  assert.equal(boardTree.type, 'div');
  const boardNodes = flattenTree(boardTree, []);
  const statTiles = boardNodes.filter((node) => typeof node.type === 'function' && node.type.name === 'StatTile');
  assert.deepEqual(statTiles.map((node) => node.props.label), ['需要你', '完成度'], 'board header keeps only two tiles');
  const columnNodes = boardNodes.filter((node) => typeof node.type === 'function' && node.type.name === 'BoardColumn');
  assert.equal(columnNodes.length, 5, 'one section per board column');
  assert.deepEqual(columnNodes[0].props.ranks, { tsk_a: 1, tsk_c: 2 }, 'columns carry the global priority ranks');
  assert.deepEqual(columnNodes[0].props.plans, [], 'no plan data degrades to an empty catalog without throwing');
  const readyColumn = ui.BoardColumn({ column: { key: 'ready', label: '就绪', hint: '可领取' }, cards: [cards[0]], ranks: { tsk_a: 3 }, plans: [], onOpen() {} });
  const readyCard = flattenTree(readyColumn, []).filter((node) => typeof node.type === 'function' && node.type.name === 'TaskCard')[0];
  assert.equal(readyCard.props.rank, 3, 'cards carry the global priority rank');
  const rankBadge = flattenTree(ui.TaskCard({ card: cards[0], rank: 2, plans: [], onOpen() {} }), [])
    .filter((node) => typeof node.type === 'function' && node.type.name === 'Badge')
    .map((node) => node.children.join(''));
  assert.ok(rankBadge.includes('#2'), 'card renders the rank badge');
});

// 责任：卡片仅保留标题与一行元信息，不能泄漏机器 id/owner/版本或塞回进度条。（原 L769-798）
test("minimal task card metadata", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;
  const ui = exportsValue.__ui;
  const cards = cardsFixture();
  // 分段职责：卡片仅保留标题与一行元信息，不能泄漏机器 id/owner/版本或塞回进度条。
  // P6: the card is title + one meta line only. No state badge, id, plan version,
  // owner/session, evidence count, or progress bar.
  const p6Card = ui.TaskCard({
    card: Object.assign({}, cards[1], {
      owner: { sessionId: 'session-c29cefbf-e3b6-4431-94cf-43294903eb36' },
      evidenceCount: 4,
      planRef: { planId: 'pln_demo', version: 4, stepId: 's1' },
      acceptance: { met: 1, total: 2 },
    }),
    rank: 2,
    plans: t.planCatalog(null, [{ id: 'pln_demo', title: '演示计划', steps: [{ id: 's1', title: '核心' }] }]),
    onOpen() {},
  });
  const p6Nodes = flattenTree(p6Card, []);
  const p6Text = nodeText(p6Card);
  assert.ok(!p6Text.includes('tsk_'), 'card meta never prints the task id');
  assert.ok(!p6Text.includes('v4'), 'card meta never prints the plan version');
  assert.ok(!p6Text.includes('session-'), 'card meta never prints the session id');
  assert.ok(!p6Text.includes('未领取'), 'card meta never prints the owner placeholder');
  assert.ok(!p6Nodes.some((node) => typeof node.type === 'function' && node.type.name === 'ProgressBar'), 'card has no progress bar');
  const p6Badges = p6Nodes.filter((node) => typeof node.type === 'function' && node.type.name === 'Badge');
  assert.deepEqual(p6Badges.map((node) => node.children.join('')), ['#2', '需审计'], 'only rank and audit-gate badges survive');
  const cardMeta = p6Nodes.find((node) => node.type === 'div' && String(node.props && node.props.className || '') === 'pb-card__meta');
  const cardMetaText = nodeText(cardMeta);
  assert.ok(cardMetaText.includes('1/2'), 'meta carries the acceptance ratio');
  const cardPlan = p6Nodes.find((node) => typeof node.type === 'function' && node.type.name === 'CardPlanLabel');
  assert.equal(cardPlan.props.meta.title, '演示计划 · 核心', 'meta keeps plan name and step name');
  assert.equal(cardPlan.props.meta.planTitle, '演示计划');
  assert.equal(cardPlan.props.meta.stepTitle, '核心');
});

// 责任：列表须用状态文字而非仅色点，并显示具体计划步骤或计划外。（原 L819-838）
test("list state and plan labels", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;
  const ui = exportsValue.__ui;
  const cards = cardsFixture();
  // 分段职责：列表须用状态文字而非仅色点，并显示具体计划步骤或计划外。
  // list rows carry the state as words, not just a coloured dot (R1) and say whether the
  // task sits inside the current plan (R2)
  const listRows = cards.slice(0, 3).map((card) => flattenTree(ui.TaskRow({ card: card, ranks: t.priorityRanks(cards), plans: [], onOpen() {} }), []));
  const rowStates = listRows
    .map((nodes) => nodes.filter((node) => typeof node.type === 'function' && String(node.props && node.props.className || '').includes('pb-row__state')).map((node) => node.children.join('')))
    .reduce((all, list) => all.concat(list), []);
  assert.deepEqual(rowStates, ['就绪', '进行中', '评审中'], 'active rows show state text');
  const planCards = [
    { id: 'x1', title: '计划内任务', state: 'ready', planRef: { planId: 'pln_p', version: 1, stepId: 's1' } },
    { id: 'x2', title: '临时插入', state: 'ready' },
  ];
  const planRanks = t.priorityRanks(planCards);
  const planTexts = planCards.map((card) => flattenTree(ui.TaskRow({
    card: card,
    ranks: planRanks,
    plans: [{ id: 'pln_p', title: '示例计划', steps: [{ id: 's1', title: '核心' }] }],
    onOpen() {},
  }), []).filter((node) => node.type === 'span' && String(node.props && node.props.className || '').includes('pb-row__plan')).map((node) => node.children.join(''))[0]);
  assert.deepEqual(planTexts, ['示例计划 · 核心', '计划外'], 'rows say plan name + step, or out-of-plan');
});

// 责任：分组切换必须改变实际列表树，多标签任务可进入多个桶。（原 L840-864）
test("grouped list tree", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;
  const ui = exportsValue.__ui;

  // 分段职责：分组切换必须改变实际列表树，多标签任务可进入多个桶。
  // P7: grouped list renders buckets from the same filtered set; grouping itself
  // is covered by unit tests, this asserts the switch actually changes the tree.
  const groupTasksFixture = [
    { id: 'g1', title: '计划内甲', state: 'ready', labels: ['ui', 'core'], planRef: { planId: 'pln_p', version: 1, stepId: 's1' } },
    { id: 'g2', title: '计划外乙', state: 'review', labels: ['core'] },
    { id: 'g3', title: '已完成丙', state: 'done' },
  ];
  const groupRanks = t.priorityRanks(groupTasksFixture);
  const groupPlans = [{ id: 'pln_p', title: '示例计划', steps: [{ id: 's1', title: '核心' }] }];
  function groupedTitles(mode) {
    return flattenTree(ui.TaskList({
      tasks: groupTasksFixture, ranks: groupRanks, filters: { group: mode }, plans: groupPlans, onOpen() {},
    }), [])
      .filter((node) => String(node.props && node.props.className || '') === 'pb-group__title')
      .map((node) => node.children.join(''));
  }
  assert.deepEqual(groupedTitles('status'), ['就绪', '评审中', '已完成']);
  assert.deepEqual(groupedTitles('label'), ['core', 'ui', '无标签']);
  assert.deepEqual(groupedTitles('plan'), ['示例计划 · 核心', '计划外']);
  assert.deepEqual(groupedTitles('none'), [], 'flat mode keeps the done fold instead of buckets');
  const groupedRowCount = flattenTree(ui.TaskList({
    tasks: groupTasksFixture, ranks: groupRanks, filters: { group: 'label' }, plans: groupPlans, onOpen() {},
  }), []).filter((node) => typeof node.type === 'function' && node.type.name === 'TaskRow').length;
  assert.equal(groupedRowCount, 4, 'multi-label tasks appear in each matching bucket');
});

// 责任：任务抽屉须接 Drawer 外壳和关闭回调，toast 退出类与页面主按钮状态须正确。（原 L866-901）
test("drawer toast and primary actions", () => {
  const { exportsValue } = loadClientBundle();
  const ui = exportsValue.__ui;

  // 分段职责：任务抽屉须接 Drawer 外壳和关闭回调，toast 退出类与页面主按钮状态须正确。
  const drawerTree = ui.TaskDrawer({
    projectId: 'prj_x',
    taskId: 'tsk_b',
    initial: {
      view: {
        task: { id: 'tsk_b', rev: 3, title: '补 401 测试', state: 'in_progress', priority: 100, weight: 1, acceptance: [] },
        acceptance: [{ id: 'acc_1', text: '测试通过', met: false, requiredKinds: ['test'] }],
        evidence: [],
        timeline: [{ seq: 3, type: 'task/claimed', actor: { kind: 'agent' } }],
        allowedOps: [{ op: 'submit', enabled: false, reason: 'task is not in progress' }],
        lease: { token: 5 },
      },
    },
    onClose() {},
  });
  assert.equal(typeof drawerTree.type, 'function', 'drawer renders through the Drawer component');
  assert.equal(typeof drawerTree.props.onClose, 'function');
  const toastLeaving = flattenTree(ui.ToastHost({ toasts: [{ id: 't1', tone: 'info', text: '提示', leaving: true }] }), []);
  assert.ok(
    toastLeaving.some((node) => String(node.props && node.props.className || '').includes('pb-toast--leaving')),
    'a dismissed toast keeps its leaving class while it animates out',
  );
  const headerBase = { project: null, projects: [], projectId: '', filters: {}, query: '' };
  function headerButtons(extra) {
    return flattenTree(ui.AppHeader(Object.assign({}, headerBase, extra)), [])
      .filter((node) => typeof node.type === 'function' && node.type.name === 'Button')
      .map((node) => ({ label: (node.children || []).join(''), variant: node.props.variant, disabled: node.props.disabled }));
  }
  assert.equal(headerButtons({}).find((item) => item.label === '新建项目').variant, 'primary', 'no project: the screen has one filled primary');
  assert.equal(headerButtons({ drawerOpen: true }).find((item) => item.label === '新建项目').variant, 'primary', 'without a project the drawer does not invent a task entry');
  const projectHeader = headerButtons({ project: { id: 'prj_x', name: '演示', phase: 'active', readOnly: false } });
  assert.equal(projectHeader.find((item) => item.label === '新建任务').variant, 'primary', 'with a project the page primary is 新建任务');
  assert.equal(projectHeader.find((item) => item.label === '新建项目').variant, 'secondary', 'project creation is demoted');
  const readOnlyHeader = headerButtons({ project: { id: 'prj_x', name: '演示', phase: 'active', readOnly: true } });
  assert.equal(readOnlyHeader.find((item) => item.label === '新建任务').disabled, true, 'read-only projects cannot open task.create');
});

// 责任：看板/列表切换仅在 board tab 出现，文档/计划/健康/无项目/创建态隐藏。（原 L903-918）
test("board view switch visibility", () => {
  const { exportsValue } = loadClientBundle();
  const ui = exportsValue.__ui;
  const headerBase = { project: null, projects: [], projectId: '', filters: {}, query: '' };
  // 分段职责：看板/列表切换仅在 board tab 出现，文档/计划/健康/无项目/创建态隐藏。
  // The board/list switch belongs to the board tab: docs/plan/health, the
  // no-project screen, and the project-creation form must not render it.
  const demoHeaderProject = { id: 'prj_x', name: '演示', phase: 'active' };
  function viewSwitchNode(extra) {
    return flattenTree(ui.AppHeader(Object.assign({}, headerBase, extra)), [])
      .find((node) => String(node.props && node.props.className || '') === 'pb-viewswitch');
  }
  const boardSwitch = viewSwitchNode({ project: demoHeaderProject, tab: 'board', onView() {} });
  assert.ok(boardSwitch, 'board tab keeps the board/list switch');
  assert.deepEqual((boardSwitch.children || []).map((node) => node.children.join('')), ['看板', '列表', '推进']);
  assert.equal(viewSwitchNode({ project: demoHeaderProject, tab: 'docs', onView() {} }), undefined, 'docs tab hides the board/list switch');
  assert.equal(viewSwitchNode({ project: demoHeaderProject, tab: 'plan', onView() {} }), undefined, 'plan tab hides the board/list switch');
  assert.equal(viewSwitchNode({ project: demoHeaderProject, tab: 'health', onView() {} }), undefined, 'health tab hides the board/list switch');
  assert.equal(viewSwitchNode({ project: null, tab: 'board', onView() {} }), undefined, 'no project hides the board/list switch');
  assert.equal(viewSwitchNode({ project: demoHeaderProject, tab: 'board', creating: true, onView() {} }), undefined, 'creating a project hides the board/list switch');
});

// 责任：直达链接解析推进视图、项目与焦点，未知视图仍回退。
test('direct board links accept a Flow view and task focus', () => {
  const { readBoardLink, normalizeView } = loadClientBundle().exportsValue.__test;
  const read = (search, hash = '') => ({ ...readBoardLink({ search, hash }) });
  assert.deepEqual(read('?view=flow&project=prj_sample'), { view: 'flow', focus: null, projectId: 'prj_sample' });
  assert.deepEqual(read('', '#focus=tsk_sample'), { view: 'flow', focus: 'tsk_sample', projectId: null });
  assert.deepEqual(read('?view=list', '#focus=tsk_sample'), { view: 'list', focus: null, projectId: null });
  assert.deepEqual(read('?view=bad', '#host-panel'), { view: null, focus: null, projectId: null });
  assert.equal(normalizeView(null), 'board');
});

// 责任：进行中与待处理各有入口，会话标题缺失时可区分短 ID。
test('Flow exposes separate task groups and renders host session titles', () => {
  const { __ui: ui } = loadClientBundle().exportsValue;
  const running = Array.from({ length: 8 }, (_, index) => ({
    id: 'work-' + index, title: '工作 ' + index, state: 'in_progress',
    owner: { sessionId: ['session-001', 'session-002', 'session-003'][index % 3] },
    intent: { summary: '核对场景 ' + index },
  }));
  const board = {
    project: { policy: { maxInProgress: 10 } },
    columns: {
      in_progress: running,
      review: [{ id: 'manual', state: 'review' }, { id: 'audit', state: 'review', requiresAudit: true }],
    },
    attention: { blocked: [{ id: 'blocked', state: 'blocked' }] },
  };
  const flow = ui.FlowView({ board, sessions: { 'session-001': { title: '安装流程' }, 'session-003': { title: '  文档交付  ' } } });
  const now = flow.children[0];
  const nodes = flattenTree(now.type(now.props), []);
  const counts = nodes.filter((node) => node.props['aria-haspopup'] === 'dialog').map((node) => nodeText(node));
  assert.deepEqual(counts, ['进行中| |8 / 10', '待验收| |1', '待审计| |1', '异常| |1']);
  const previews = nodes.filter((node) => node.type?.name === 'NowPreview');
  assert.deepEqual(previews[0].props.tasks.map((task) => task.id).join(','), 'work-0,work-1,work-2');
  assert.ok(previews[1].props.tasks.every((task) => task.state !== 'in_progress'));
  const cards = previews[0].type(previews[0].props).children[0];
  const owners = cards.map((card) => flattenTree(card.type(card.props), []).find((node) => node.props.className === 'pb-flow__task-owner'));
  assert.deepEqual(owners.map((node) => nodeText(node)).join(','), '安装流程,会话 session-002,文档交付');
});

// 责任：只有列表视图展示分组切换，活动筛选要有清除入口。（原 L920-940）
test("list grouping and clear filters", () => {
  const { exportsValue } = loadClientBundle();
  const ui = exportsValue.__ui;

  // 分段职责：只有列表视图展示分组切换，活动筛选要有清除入口。
  // P7: the header exposes the grouping switch only in list view, and an active
  // filter set gets a one-click clear.
  const listHeaderNodes = flattenTree(ui.AppHeader({
    project: { id: 'prj_x', name: '演示', phase: 'active' }, projects: [], projectId: 'prj_x',
    tab: 'board', view: 'list', showFilters: true,
    query: '', filters: { query: '', state: null, gateOnly: false, plan: 'in', group: 'status' },
    onView() {}, onGroup() {}, onClearFilters() {},
  }), []);
  const groupSelect = listHeaderNodes.find((node) => typeof node.type === 'function' && node.type.name === 'Select' && node.props.ariaLabel === '分组方式');
  assert.ok(groupSelect, 'list view renders the grouping select');
  assert.equal(groupSelect.props.value, 'status');
  assert.deepEqual(groupSelect.props.options.map((option) => option.value), ['none', 'status', 'label', 'plan']);
  const clearFilter = listHeaderNodes.find((node) => String(node.props && node.props.className || '') === 'pb-filter-clear');
  assert.ok(clearFilter && (clearFilter.children || []).join('') === '清除筛选', 'active filters get a clear action');
  const boardHeaderNodes = flattenTree(ui.AppHeader({
    project: { id: 'prj_x', name: '演示', phase: 'active' }, projects: [], projectId: 'prj_x',
    tab: 'board', view: 'board', showFilters: true,
    query: '', filters: { query: '', state: null, gateOnly: false, plan: null, group: 'none' }, onView() {},
  }), []);
  assert.equal(boardHeaderNodes.some((node) => typeof node.type === 'function' && node.type.name === 'Select' && node.props.ariaLabel === '分组方式'), false, 'board view has no grouping switch');
  const flowHeaderNodes = flattenTree(ui.AppHeader({
    project: { id: 'prj_x', name: '演示' }, tab: 'board', view: 'flow', showFilters: true,
    query: '安装', filters: { state: 'ready', plan: 'in' }, onView() {},
  }), []);
  assert.ok(flowHeaderNodes.some((node) => node.type === 'input' && node.props.value === '安装'));
  assert.ok(flowHeaderNodes.some((node) => node.props['aria-pressed'] === true && node.children.join('') === '推进'));
  assert.ok(!flowHeaderNodes.some((node) => node.props.className === 'pb-filter-chips'));
});

// 责任：布局须保留 keyed tabpanel、抽屉打开状态及 Drawer 层结构。（原 L942-956）
test("layout and drawer shell", () => {
  const { exportsValue } = loadClientBundle();
  const ui = exportsValue.__ui;

  // 分段职责：布局须保留 keyed tabpanel、抽屉打开状态及 Drawer 层结构。
  const layoutTree = ui.AppLayout({ tab: 'plan', children: 'content', toasts: [], drawer: 'drawer-node' });
  const layoutNodes = flattenTree(layoutTree, []);
  assert.ok(
    layoutNodes.some((node) => node && node.props && node.props.className === 'pb-tabpanel'),
    'tab content rides in a keyed panel so a tab switch can transition',
  );
  assert.ok(
    layoutNodes.some((node) => node && node.props && node.props.drawerOpen === true),
    'layout tells the header a drawer is open',
  );

  const drawerShell = ui.Drawer({ titleId: 'pb-task-drawer-title', head: 'x', onClose() {} });
  assert.equal(drawerShell.type, 'div');
  assert.equal(drawerShell.props.className, 'pb-drawer-layer');
});

// 责任：新任务抽屉须包含必填验收、审计开关和计划外说明，空标题/只读时禁提交。（原 L958-978）
test("new task drawer and docs pane", () => {
  const { exportsValue } = loadClientBundle();
  const ui = exportsValue.__ui;

  // 分段职责：新任务抽屉须包含必填验收、审计开关和计划外说明，空标题/只读时禁提交。
  // P6: the new-task drawer exists, starts disabled, and never offers plan membership.
  const createTree = ui.NewTaskDrawer({ projectId: 'prj_x', onClose() {}, onCreated() {}, notify() {} });
  const createNodes = flattenTree(createTree, []);
  const createInputs = createNodes.filter((node) => typeof node.type === 'function' && node.type.name === 'Input').map((node) => node.props.label);
  const createTextareas = createNodes.filter((node) => typeof node.type === 'function' && node.type.name === 'Textarea').map((node) => node.props.label);
  assert.deepEqual(createInputs, ['标题', '优先级']);
  assert.deepEqual(createTextareas, ['验收项', '描述']);
  assert.ok(createNodes.some((node) => typeof node.type === 'function' && node.type.name === 'Switch' && node.props.label === '完成后需审计'));
  const createHint = createNodes.find((node) => node.type === 'p' && String(node.props && node.props.className || '') === 'pb-hint');
  assert.ok(nodeText(createHint).includes('project_plan adopt'), 'the drawer explains how a task joins a plan');
  const createButtons = createNodes.filter((node) => typeof node.type === 'function' && node.type.name === 'Button');
  const createSubmit = createButtons.find((node) => (node.children || []).join('') === '创建任务');
  assert.equal(createSubmit.props.disabled, true, 'submit is disabled until a title exists');
  assert.equal(createSubmit.props.variant, 'primary');
  const readOnlyCreate = flattenTree(ui.NewTaskDrawer({ projectId: 'prj_x', readOnly: true, onClose() {}, onCreated() {}, notify() {} }), []);
  const readOnlyError = readOnlyCreate.find((node) => typeof node.type === 'function' && node.type.name === 'ErrorState');
  assert.ok(readOnlyError && readOnlyError.props.message.includes('只读'), 'read-only projects explain why creation is blocked');

  const docsTree = ui.DocsPane({ projectId: 'prj_x', initial: { docs: [], docId: null } });
  assert.equal(docsTree.type, 'div');
});

// 责任：外置面板未观测时仍须有标题路径、提示、链接和折叠技术信息，默认头部隐藏机器 id。（原 L980-1000）
test("external document panel", () => {
  const { exportsValue } = loadClientBundle();
  const ui = exportsValue.__ui;

  // 分段职责：外置面板未观测时仍须有标题路径、提示、链接和折叠技术信息，默认头部隐藏机器 id。
  // external document panel: header, status, notice, links and the folded technical section before any observation
  const extTree = ui.ExternalDocPanel({
    projectId: 'prj_x', docId: 'doc_ext', tasks: [], bindingIds: [], notify() {}, remember() {}, onChanged() {}, onBack() {},
    row: { id: 'doc_ext', title: '外置设计稿', kind: 'design', status: 'draft', rev: 2, locator: { bindingId: 'bnd_main', relPath: 'docs/a.md' }, links: { taskIds: [], planRefs: [] }, baseline: null },
  });
  assert.equal(extTree.type, 'section');
  const extNodes = flattenTree(extTree, []);
  const extParts = extNodes.filter((node) => typeof node.type === 'function').map((node) => node.type.name);
  for (const part of ['Header', 'Notice', 'Links', 'TechDetails']) assert.ok(extParts.includes(part), 'panel renders ' + part);
  const extHeaderNode = extNodes.find((node) => typeof node.type === 'function' && node.type.name === 'Header');
  const extHeader = flattenTree(extHeaderNode.type(extHeaderNode.props), []);
  const extHeaderText = nodeText(extHeader[0]);
  assert.ok(extHeaderText.includes('外置设计稿') && extHeaderText.includes('docs/a.md'), 'header shows the title and path');
  assert.ok(!/bnd_main|metaRev|doc_ext/.test(extHeaderText), 'header keeps binding, metaRev and doc id out of the default view');
  assert.ok(extHeader.some((node) => typeof node.type === 'function' && node.type.name === 'Button' && nodeText(node) === '重新读取文件'), 'fresh re-read button exists');
  const extTechNode = extNodes.find((node) => typeof node.type === 'function' && node.type.name === 'TechDetails');
  const extTech = extTechNode.type(extTechNode.props);
  assert.equal(extTech.type, 'details', 'technical fields sit in a native disclosure');
  const extTechText = nodeText(extTech);
  for (const word of ['读取来源', '确认基线', 'Git', 'bnd_main', 'doc_ext']) assert.ok(extTechText.includes(word), 'technical section carries ' + word);
});

// 责任：计划编辑器须渲染步骤/差异/冲突条，移出任务提示 orphaned 不删除，草案可发布。（原 L1002-1062）
test("plan editor diff conflict and publish", () => {
  const { exportsValue } = loadClientBundle();
  const t = exportsValue.__test;
  const ui = exportsValue.__ui;
  const { editForm, editParsed } = editFixture(t);
  // 分段职责：计划编辑器须渲染步骤/差异/冲突条，移出任务提示 orphaned 不删除，草案可发布。
  // plan editor (U2): the view renders the step list, fields and the diff panel
  const editPane = ui.PlanEditPane({
    summary: { id: 'pln_1', title: '演示计划', status: 'active', rev: 2, currentVersion: 1 },
    isDraft: false,
    form: editForm,
    parsed: editParsed,
    diff: t.planEditDiff(editParsed.steps, editParsed.steps),
    conflict: false,
    confirming: true,
    publishConfirm: false,
    busy: false,
    error: null,
    onForm() {}, onCancel() {}, onSave() {}, onPublish() {}, onConfirm() {}, onCloseConfirm() {}, onReload() {}, onKeepEditing() {},
  });
  assert.equal(editPane.type, 'div');
  const editNodes = flattenTree(editPane, []);
  assert.ok(editNodes.some((node) => String(node.props && node.props.className || '').includes('pb-plan-editor__steps')), 'editor renders the step list');
  assert.ok(editNodes.some((node) => typeof node.type === 'function' && node.type.name === 'PlanEditStep'), 'editor renders one step card per step');
  assert.ok(editNodes.some((node) => typeof node.type === 'function' && node.type.name === 'PlanEditDiffPanel'), 'confirming renders the diff panel');
  const editConflictTree = flattenTree(ui.PlanEditPane({
    summary: { id: 'pln_1', title: '演示计划', status: 'active', rev: 2, currentVersion: 1 },
    isDraft: false,
    form: editForm,
    parsed: editParsed,
    diff: t.planEditDiff(editParsed.steps, editParsed.steps),
    conflict: true,
    confirming: false,
    publishConfirm: false,
    busy: false,
    error: null,
    onForm() {}, onCancel() {}, onSave() {}, onPublish() {}, onConfirm() {}, onCloseConfirm() {}, onReload() {}, onKeepEditing() {},
  }), []);
  assert.ok(editConflictTree.some((node) => String(node.props && node.props.className || '').includes('pb-plan-editor__conflict')), 'conflict renders the reload/keep bar');
  const orphanTree = flattenTree(ui.PlanEditDiffPanel({
    diff: { added: 0, updated: 0, removed: 1, removedTasks: [{ taskId: 'tsk_x', title: '被移除的任务' }], stepsAdded: 0, stepsRemoved: 0, stepsChanged: 0, changed: true },
    publish: false,
    busy: false,
    onConfirm() {}, onClose() {},
  }), []);
  const orphanTitles = orphanTree.filter((node) => String(node.props && node.props.className || '').includes('pb-plan-editor__orphans-title')).map((node) => (node.children || []).join(''));
  assert.deepEqual(orphanTitles, ['这些任务会被标 orphaned，不会删除']);
  const orphanItems = orphanTree.filter((node) => node.type === 'li').map((node) => (node.children || []).join(''));
  assert.deepEqual(orphanItems, ['被移除的任务']);
  const draftPaneNodes = flattenTree(ui.PlanEditPane({
    summary: { id: 'pln_3', title: '草稿计划', status: 'draft', rev: 1, currentVersion: 0 },
    isDraft: true,
    form: editForm,
    parsed: editParsed,
    diff: t.planEditDiff(editParsed.steps, editParsed.steps),
    conflict: false,
    confirming: false,
    publishConfirm: false,
    busy: false,
    error: null,
    onForm() {}, onCancel() {}, onSave() {}, onPublish() {}, onConfirm() {}, onCloseConfirm() {}, onReload() {}, onKeepEditing() {},
  }), []);
  const draftButtonLabels = draftPaneNodes
    .filter((node) => typeof node.type === 'function' && node.type.name === 'Button')
    .map((node) => (node.children || []).join(''));
  assert.ok(draftButtonLabels.includes('发布计划'), 'drafts offer the publish action');
});

// 责任：多计划列表排序不得受 focus 改序，须传递所有计划和焦点并让搜索命中计划 id。（原 L1079-1108）
test("multi-plan page and focus", () => {
  const { exportsValue } = loadClientBundle();
  const ui = exportsValue.__ui;
  const multiSummaries = multiSummariesFixture();
  const plansPane = ui.PlanPane({
    projectId: 'prj_x',
    initial: {
      plans: multiSummaries,
      focusPlanId: 'p_act_new',
      selected: multiSummaries[3],
      detail: {
        plan: { id: 'p_act_new', version: 1, status: 'published', title: '演示计划', steps: [] },
        head: { id: 'p_act_new', title: '演示计划', status: 'active', rev: 2, currentVersion: 1, taskCount: 0, progress: { done: 0, total: 0, percent: 0 } },
        steps: [], progress: { done: 0, total: 0, percent: 0 }, rev: 3,
      },
    },
    onOpenTask() {},
  });
  assert.equal(plansPane.type.name, 'PlansView', 'the plans page renders its view');
  // 分段职责：显式执行子组件验证最终卡片数量、顺序、焦点标题和新建计划入口。
  // PlansView is a child component of PlanPane; invoke it once with the props
  // PlanPane computed to reach the card list (the React stub never calls
  // components itself).
  const plansPaneNodes = flattenTree(plansPane.type(plansPane.props), []);
  assert.equal(plansPane.props.plans.length, 4, 'every plan reaches the list');
  assert.equal(plansPane.props.plans[0].id, 'p_act_new', 'the sorted list starts with the newest active plan');
  assert.equal(plansPane.props.focusPlan.id, 'p_act_new', 'the focused plan is passed for the header');
  assert.equal(plansPane.props.showEmpty, false, 'a non-empty list never shows the empty state');
  const paneCards = plansPaneNodes.filter((node) => typeof node.type === 'function' && node.type.name === 'PlanCard');
  assert.equal(paneCards.length, 4, 'one card per plan summary');
  assert.deepEqual(paneCards.map((node) => node.props.summary.id), ['p_act_new', 'p_act_old', 'p_draft', 'p_arch_new']);
  const plansMeta = plansPaneNodes.filter((node) => node.type === 'p' && String(node.props && node.props.className || '').includes('pb-plans__meta'));
  assert.equal(plansMeta[0].children.join(''), '4 个计划 · 聚焦「演示计划」', 'the header names the focused plan');
  assert.ok(plansPaneNodes.some((node) => typeof node.type === 'function' && node.type.name === 'Button' && (node.children || []).join('') === '新建计划'), 'the create action is present');
});
