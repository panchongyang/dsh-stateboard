# ProjectBoard UI 重做 · 设计系统与页面方案

> 状态：v1 设计记录 · 2026-10-21
> 范围：\`lib/client.js\`（浏览器半）与配套文档/测试。**不改** core 状态机、HTTP 路由、命令信封、数据格式、槽位注册方式、工具清单。
> 旧实现的问题：单一 inline style 常量表 + 手写 5 个视图；没有 hover/focus/media 能力（inline style 表达不了）、没有暗色适配验证、没有搜索/筛选、抽屉信息平铺、文档页无预览与冲突恢复、健康页无层级。

> UI 2.0 的宽屏、抽屉与后续设计见 [UI 2.0 规格](<specs/ui-2-spec.md>)。

---

## 1. 设计原则

| 原则 | 落到实现 |
|---|---|
| **状态先于装饰** | 颜色只用来编码语义（状态、阻塞、人审、危险操作），不做纯装饰渐变；每个色块都能回答"它代表什么状态"。 |
| **一屏一焦点** | 看板页回答"哪些任务在哪一列、哪些在等我"；抽屉回答"这个任务现在能做什么、为什么不能"；计划回答"整体到哪一步"；文档回答"我在改哪一篇"；健康回答"系统是否可信"。 |
| **人类动作要有护栏** | 按钮可用性来自 \`allowedOps\`，禁用时**必须**说明原因（title + 行内 hint），危险操作（取消/驳回）永远不与主操作同排。 |
| **可键盘、可读屏** | 全部交互元素原生可聚焦；抽屉是 \`role=dialog aria-modal\` + Esc + 焦点归还；卡片 Enter/Space 打开；表格化数据用列表语义。 |
| **窄屏不是缩小的桌面** | 容器查询改写布局：看板列变横向滑动；抽屉全宽；文档列表与编辑器互斥。 |
| **主题跟随宿主** | 亮/暗色不自己发明，映射宿主 \`--dsw-*\` 语义 token；暗色下重新校准阴影与描边。 |

**非目标**：拖拽排序、SSE 推送、计划编辑（仍只读）、多用户/权限、移动端独立路由。这些维持 README §7 的已知限制。

---

## 2. 视觉基础（Design Tokens）

### 2.1 Token 分层

三层，全部以 CSS 自定义属性表达（不再用 JS 内联样式，因为需要 \`:hover\` / \`:focus-visible\` / \`@container\` / \`@media\`）：

1. **宿主层**：\`--dsw-static-*\` / \`--dsw-alias-*\`（DSH 主题插件提供，暗色由 \`body[data-ds-dark-theme]\` 切换）。
2. **语义层**：\`--pb-*\`，只在这一层做"亮/暗"的选择。
3. **组件层**：\`.pb-btn\` 等类名消费语义层，不直接写颜色值。

### 2.2 颜色

| Token | 亮色 | 暗色 | 用途 |
|---|---|---|---|
| \`--pb-canvas\` | \`neutral-bluish-50\` #f9fafb | \`neutral-bluish-1000\` #0f1115 | 页面底色 |
| \`--pb-surface\` | #ffffff | \`neutral-bluish-875\` #232324 | 卡片 / 抽屉 / 列 |
| \`--pb-surface-2\` | \`neutral-bluish-60\` #f9fafb | \`neutral-bluish-900\` #1b1b1c | 凹槽：标签条、代码、时间线底 |
| \`--pb-surface-3\` | \`neutral-bluish-75\` #f1f3f5 | \`neutral-bluish-850\` #2c2c2e | 悬浮/选中态 |
| \`--pb-border\` | \`neutral-bluish-150\` #e9ecf2 | \`neutral-bluish-800\` #353638 | 常规描边 |
| \`--pb-border-strong\` | \`neutral-bluish-300\` #cfd3d6 | \`neutral-bluish-750\` #43454a | hover / 分组边界 |
| \`--pb-text\` | #0f1115 | #f9fafb | 主文本 |
| \`--pb-text-2\` | #61666b | #cfd3d6 | 次要文本 |
| \`--pb-text-3\` | #979da6 | #979da6 | 元信息 / 占位 |
| \`--pb-accent\` | \`state-business-primary\` #4176e6 | \`deepseek-400\` #7aaaff | 主操作、选中、进度 |
| \`--pb-violet\` | #7c5cff | #b3a1ff | "评审中"专用（与蓝色主色区分） |
| \`--pb-danger\` | \`state-error-primary\` | \`red-400\` | 阻塞、破坏性操作 |
| \`--pb-warn\` | \`state-warn-primary\` #f59e0b | 同左 | 待对账、孤儿任务 |
| \`--pb-success\` | \`state-success-primary\` #22c55e | #4ed17e | 已完成、校验通过 |
| \`--pb-focus\` | \`color-mix(accent 55%, transparent)\` | 同规则 | 焦点环 |

"柔和填充"统一由 \`color-mix(in srgb, <色> 12%, transparent)\` 生成，避免为每个色调再定义一套 12 个色值。

### 2.3 排版

| 层级 | 字号 / 行高 / 字重 | 场景 |
|---|---|---|
| Display | 20 / 1.25 / 650 | 项目名（看板页 header） |
| Title | 15 / 1.4 / 650 | 抽屉标题、页面区块标题 |
| Body | 13 / 1.55 / 400 | 描述、任务标题、正文 |
| Small | 12 / 1.5 / 400–600 | 按钮、表单、列表 |
| Caption | 11 / 1.45 / 500 | 元信息、badge、分区标签（\`letter-spacing: .04em; text-transform: uppercase\` 仅用于分区标签） |
| Mono | 11 / 1.5 | id、hash、token、路径（\`ui-monospace, SFMono-Regular, Consolas\`） |

字族继承宿主，不引入 webfont。数字（计数、rev）使用 \`font-variant-numeric: tabular-nums\`，避免轮询刷新时抖动。

### 2.4 间距 / 圆角 / 阴影 / 动效

- 间距：4 的倍数 \`--pb-s1..s5 = 4/8/12/16/24\`；页面内边距 16，卡片内边距 12–14。
- 圆角：\`6\`（badge/小控件）· \`10\`（按钮/输入）· \`14\`（卡片/列）· \`20\`（抽屉外沿）· \`999\`（chip）。
- 阴影：
  - \`--pb-shadow-1\`（卡片 hover）：亮 \`0 1px 2px rgba(15,17,21,.05), 0 6px 16px rgba(15,17,21,.06)\`；暗 \`0 1px 2px rgba(0,0,0,.5), 0 8px 20px rgba(0,0,0,.45)\`
  - \`--pb-shadow-2\`（抽屉）：\`-24px 0 60px rgba(0,0,0,.18)\`（暗色 .5）
- 动效：\`--pb-fast 120ms\` / \`--pb-base 200ms\`，缓动 \`cubic-bezier(.2,.7,.25,1)\`。只对 \`opacity\`、\`transform\`、\`box-shadow\`、\`border-color\` 做过渡。
- \`@media (prefers-reduced-motion: reduce)\`：全部过渡/动画时长归零，骨架屏不再闪烁（保留静态灰块）。

### 2.5 状态色板

| 状态 | 点/条 | 文本 | 说明 |
|---|---|---|---|
| backlog 待办 | \`--pb-text-3\` | 次要 | 未进队列 |
| ready 就绪 | \`--pb-accent\` | 主色 | 可领取 |
| in_progress 进行中 | \`--pb-warn\` | 主文本 | 有租约/意图 |
| review 评审中 | \`--pb-violet\` | 主文本 | 等人审或自动验证 |
| done 已完成 | \`--pb-success\` | 主文本 | 终态 |
| blocked 阻塞 | \`--pb-danger\` | 主文本 | Attention 托盘 |
| interrupted 待对账 | \`--pb-warn\`（虚线边） | 主文本 | Attention 托盘 |
| canceled 已取消 | \`--pb-text-3\` | 次要 + 删除线 | 默认隐藏 |
| 需人审（gate） | \`--pb-violet\` 描边 | violet | badge "需人审" |

### 2.6 焦点与可访问性基线

- 焦点环：\`outline: 2px solid var(--pb-focus); outline-offset: 2px\`，只对 \`:focus-visible\` 生效，鼠标点击不出现环。
- 触达尺寸：按钮最小高 28px（紧凑）、主导航 32px；卡片整面可点，命中区 ≥ 40px。
- 对比度：主文本 ≥ 12:1，次要 ≥ 7:1，\`text-3\` 仅用于非关键元信息（≥ 4.5:1）。
- 图标一律 \`aria-hidden="true"\` + 伴随文本；纯图标按钮必须有 \`aria-label\`。
- 动态区域：toast 容器 \`role="status" aria-live="polite"\`；看板刷新不打断读屏（不整块替换 aria-live）。

---

## 3. 组件规范

所有组件都在 \`lib/client.js\` 内实现（只 \`require('react')\`，不引第三方）。CSS 类名统一 \`pb-\` 前缀，样式表一次性注入 \`<style data-plugin-css="dsh-project-board/ui.css">\`（与宿主主题插件同一种注入方式，幂等）。

| 组件 | 结构 | 变体 / 状态 | 键盘 / ARIA |
|---|---|---|---|
| \`Button\` | \`<button.pb-btn>\` | primary / secondary / ghost / danger / danger-ghost；size sm；busy（\`aria-busy\`，禁用并显示省略号）；disabled | 原生 button；禁用用 \`disabled\` 而非 pointer-events |
| \`IconButton\` | 方按钮 + svg | ghost / subtle | \`aria-label\` 必填 |
| \`Input\` / \`Textarea\` / \`Select\` | 带 \`label\` 可选、\`hint\` 可选、\`error\` 可选 | 默认 / 错误（红边）/ 禁用 | \`id\`+\`htmlFor\` 关联；错误用 \`aria-invalid\`+\`aria-describedby\` |
| \`Switch\` | \`role="switch"\` 按钮 | on / off / disabled | Space 切换；\`aria-checked\` |
| \`Tabs\` | \`role="tablist"\` | 4 页签 | ←/→ 移动，Home/End 跳转，\`aria-selected\` |
| \`Badge\` | \`<span.pb-badge>\` | neutral / accent / violet / success / warn / danger / outline；可选圆点 | 纯展示 |
| \`Chip\` | 可选中的过滤片 | 未选 / 选中（\`aria-pressed\`） | 原生 button |
| \`Card\`（任务卡） | 状态条 + 标题 + 元信息 + 进度 | default / hover / focus / 阻塞 | \`role="button" tabindex=0\`，Enter/Space 打开 |
| \`Drawer\` | scrim + panel + header + body + sticky footer | 打开/关闭（进入动画 160ms） | \`role=dialog aria-modal\` + Esc + 初始焦点 + 关闭后焦点归还 |
| \`Toast\` | 右下堆叠，3.2s 自动消失 | success / error / info | \`role=status aria-live=polite\` |
| \`Empty\` | 圆形图标 + 标题 + 说明 + 可选动作 | — | 标题用 \`<p>\` 不进标题层级 |
| \`Loading\` | 骨架条 3 行 + \`aria-busy\` | — | \`aria-busy=true\`，不阻塞操作 |
| \`ErrorState\` | 红色左边条 + 消息 + code + 重试按钮 | 行内 / 区块 | \`role=alert\` |
| \`ProgressBar\` | 细轨 + 填充 | accent / success / warn / danger | \`role=progressbar\` + \`aria-valuenow\` |
| \`StatTile\` | 数值 + 标签 + 可选进度/说明 | 5 个语义色 | 纯展示 |
| \`Section\` | 标题行 + 内容 | 可带右侧动作 | 用 \`<section aria-labelledby>\` |
| \`Timeline\` | 左侧竖线 + 点 + 事件行 | 最新在上 | 列表语义 |
| \`Markdown\` | 块级渲染器（标题/列表/代码块/引用/粗体/行内代码/链接文本） | 预览 / 编辑 | **不使用** \`dangerouslySetInnerHTML\` |

---

## 4. 页面方案

### 4.1 看板（默认页）

~~~text
┌──────────────────────────────────────────────────────────────────────────┐
│ [icon] 项目板   示例项目 · WORKSPACE_ROOT   [项目 ▾] [＋新建] [⟳]      │  header-top
│ 完成度 ▓▓▓▓▓▓▓░░ 80%    修订 32 · 2s 自动刷新                            │  header-meta
├──────────────────────────────────────────────────────────────────────────┤
│ ( 看板 | 文档 | 计划 | 健康 )        [🔍 搜索任务…]  [需人审] [阻塞]      │  tabs + filters
├──────────────────────────────────────────────────────────────────────────┤
│ 就绪 1 │ 进行中 0 │ 评审 0 │ 完成 4 │ 阻塞+对账 0                        │  stat tiles
│ ⚠ 阻塞 (0)            │ ⟳ 待对账 (0)                                     │  attention
│ 待办   │ 就绪      │ 进行中  │ 评审中  │ 已完成                          │  5 columns
│ ┌────┐ │ ┌──────┐  │         │         │ ┌──────┐                        │
│ │card│ │ │ card │  │         │         │ │ card │                        │
│ └────┘ │ └──────┘  │         │         │ └──────┘                        │
└──────────────────────────────────────────────────────────────────────────┘
~~~

- **Stat tiles**：就绪 / 进行中 / 评审 / 完成 / 阻塞+对账。完成度用加权 \`counts.percent\`（core 推导，前端不算）。
- **Attention 托盘**：只有存在 blocked/interrupted 时才出现，红/黄边；直接列出卡片，避免为了看阻塞项切页。
- **列**：Backlog / Ready / In Progress / Review / Done，列头 = 状态点 + 名称 + 计数（\`tabular-nums\`）；空列显示占位而不是空白。
- **卡片信息层级**（从强到弱）：标题 → 状态 + 需人审 → 验收进度条 \`2/3\` + 证据数 → P/权重/负责人/计划引用 → 阻塞原因（红）。
- **筛选**：搜索命中 title / id / label / owner；状态 chip 单选（全部 = 不过滤）；"需人审"开关。过滤后每列显示 \`命中 n\`，全空时给 Empty（"没有匹配的任务，清除筛选"）。
- **轮询**：2s，页面隐藏时暂停；右上角显示"更新于 HH:MM:SS"和上一次成功时间，不闪整页。
- **窄屏（<980px 容器）**：列变横向滚动（scroll-snap），列宽 78%，stat tiles 换行 2 列。

### 4.2 任务抽屉

~~~text
┌──────────────────────────────────────────────┐
│ ● 评审中   任务标题                     [×]  │  title + state + rev
│ tsk_… · 修订 3 · P200 · 权重 1               │  meta line
├──────────────────────────────────────────────┤
│ [通过] [驳回] [阻塞]        （主操作条）      │  action bar ← 由 allowedOps 决定
│ ┌ 描述 ────────────────────────────────────┐ │
│ ┌ 验收项 2/3  ▓▓▓░░  失败项展开原因 ───────┐ │
│ ┌ 证据 2 ── kind badge · ref · hash ───────┐ │
│ ┌ 执行（claim/begin/release）──────────────┐ │
│ ┌ 提交证据（kind/ref/验收项/摘要/备注）────┐ │
│ ┌ 治理（人审开关 / 阻塞 / 对账）───────────┐ │
│ ┌ 时间线（最新在上）───────────────────────┐ │
├──────────────────────────────────────────────┤
│ [领取] [释放] [取消]        （sticky footer）│
└──────────────────────────────────────────────┘
~~~

- **动作分组**：主操作条只放"当前状态最该做的一件事"+ 一个次操作；完整操作列表在"更多操作"里，禁用项显示 \`reasonText\`。
- **证据表单**：证据类型 → 引用（占位随类型变化）→ 归属验收项（已满足项标注 ✓）→ 摘要 → 备注；\`Ctrl/⌘+Enter\` 提交。
- **冲突（409 / stale-revision）**：抽屉顶部 ErrorState，显示"你基于 rev N，服务端已到 rev M"，提供"刷新"（重新拉取）与"关闭"。
- **人审开关**：仅 \`gate\` op 可用时可切换；agent 只开不能关，禁用时说明"仅人类可关闭"。
- **Esc / 点击遮罩**：关闭；关闭后焦点回到打开它的卡片。
- **窄屏**：抽屉全宽、圆角为 0、footer 与主操作条合并。

### 4.3 计划

- 头部：计划标题 + v 版本 + 状态 badge + 加权进度条（done/total）+ assumptions/risks（有才显示，折叠列表）。
- **步骤时间线**：序号圆点（完成=绿勾，进行中=主色，未开始=灰）+ 步骤名 + 该步完成数；步骤内任务为可点击行（打开抽屉）。
- **计划外任务**：单独区块 + 说明（"这些任务没有 planRef；可在计划编辑器里纳入，或由模型用 project_plan op=adopt 归位"）。
- 无计划：Empty + 提示模型可用 \`project_plan op=publish\`。

### 4.4 文档

文档页由左侧列表和右侧详情组成。列表同时放内嵌文档和外置文档（即登记在工作区文件上的记录），详情随选中项切换。面板容器宽度小于 900px 时，列表和详情只显示其一。

设计目标：打开一篇文档，三秒内能看出**能不能读、要不要我确认、正文是什么**。默认视图只放这三件事。机器和审计字段不删除，全部收进默认折叠的「技术详情与登记管理」。四个状态维度（管理、可用性、确认、Git）在数据里和折叠区里仍然分开，不合并成一个“正常/坏了”。

~~~text
┌ 列表 400px（≥1100）/ 320px ──┬ 详情 ───────────────────────────────────────────┐
│ [＋登记外置][新建内嵌]  ⟳    │ 外置文档登记（核心层与对外表面）   [⟳ 重新读取文件] │
│ 🔍 搜索文档                  │ docs/specs/EXTERNAL-DOCS.md · 规格 · 草稿 · 更新于 … │
│ (全部)(需处理)(未确认)(已解除)│ ─────────────────────────────────────────────── │
│ › docs/specs            12   │ ● 可读  ● 确认后有改动 上次确认 …  [确认当前内容][编辑信息] │
│   外置文档登记…        11-03 │ ─────────────────────────────────────────────── │
│   EXTERNAL-DOCS.md   ● 已改动 │ （仅在需要时）横幅：说明 + 补救动作              │
│ › private/docs/notes     9   │ 关联任务 …  计划 …                               │
│   D9 人工闸门…         11-04 │ 正文（Markdown 渲染 / 查看原文）                  │
│   d9-human-gate-brief.md  ✓  │ ▸ 技术详情与登记管理（默认收起）                   │
│ › 看板内嵌              25   │                                                  │
└──────────────────────────────┴──────────────────────────────────────────────────┘
~~~

展示选择全部写成纯函数，集中在 `src/client/doc-view.js`：`rowSignal`、`filterCounts`、`groupDocRows`、`headerMeta`、`statusLine`、`attentionNotice`、`confirmOffer`、`technicalSections`。单元测试见 `test/client/unit/doc-view.test.mjs`。

**列表**

- 宽度：容器宽度 ≥ 1100px 时为 400px，900–1100px 时为 320px。宽屏下列表固定在视口内（sticky）并单独滚动，读长正文时列表不会跟着滚走。
- 分组：外置文档按所在目录（`relPath` 的目录部分）分组，内嵌文档归入「看板内嵌」组。组头显示目录名和条数，可以折叠；组的顺序按组内最近更新的文档排列。项目只有一个绑定时，组头不写绑定 id；同一目录出现在多个绑定下时，组头附上短绑定名，以免两个工作树混进同一组。组头只反映目录，不表示“已公开发布”，因为数据层没有这个事实。
- 每行内容：标题（最多两行）+ 短日期；下一行是文件名（内嵌文档显示类型和修订号）；管理状态只在不是“草稿”时显示；最多再加一个状态信号。行里不再显示「外置」徽标、类型、metaRev、关联数和 Git。
- 状态信号规则见 `rowSignal`：
  - 不可读：黄点或红点加可用性短词。
  - 确认后有改动：主色“已改动”。
  - 重定位后未确认（`not_comparable`）：“需重新确认”。
  - 已确认且一致：绿色 ✓，不带文字。
  - 未确认、尚未观测：不显示，这是大多数文档的常态，靠筛选片查找。
  - 已解除登记：标题划线，并排到本组末尾。
  - 读屏用户始终能听到完整状态（`pb-sr-label`）。
- 筛选片：全部 / 需处理（不可读 + 已改动 + 需重新确认）/ 未确认 / 已解除。计数与行信号使用同一套判定，计数为 0 时变暗但不隐藏。筛选可以和搜索叠加。
- 数据来源：列表来自 `GET /docs`（内嵌，其中 `source:'external'` 的行丢弃）和 `GET /docs/external?includeUnregistered=1`（外置，包括墓碑），每条记录只出现一次。
- 后台观测：列表每次载入或刷新后，外置行逐条串行做一次带缓存、不带预览的 inspect，只读；失败的行保持“尚未观测”。状态以最新的列表行为准：行比观测新（别处改过登记或解除了登记）时，旧观测不再采信，墓碑首次加载就显示“已解除登记”。
- 搜索：外置正文不参与搜索，只匹配标题、id、类型、绑定和路径；内嵌文档还会搜正文。

**内嵌文档**（不变）：`Ctrl/⌘+S` 保存，`baseRev` 随请求发送，冲突时给“重新载入”。读视图渲染安全的块级 Markdown，不解析原始 HTML。

**外置文档详情**（默认视图，从上到下）

1. 页头：标题（Title 档）；meta 行依次是完整相对路径（mono）、类型、管理状态、更新时间。右侧是「重新读取文件」，带 `fresh=1`，绕过 30 秒缓存，不会确认。
2. 状态行：可用性和确认情况分成两段，各自有色点和文案；Git 只在“有未提交修改 / 未跟踪”时以次要色跟在后面。右侧放操作：
   - 「确认当前内容」只在**能确认而且有必要确认**时出现（未确认、确认后有改动、需重新确认）。
   - 已一致时不显示这个按钮，避免把“已确认”说两遍。
   - 没有完整 hash 时也不显示，原因由横幅说明。
   - 只读（schemaVersion ≠ 1）时按钮保留但禁用，原因写在行内。
   - 「编辑信息」改登记信息：标题、类型、管理状态、关联。
3. 横幅（只在需要时出现，见 `attentionNotice`）：
   - 不可读：黄底（越根 / 安全拒绝为红底），写出可用性标题和下一步文案，横幅里直接放「重新读取文件」「重定位…」「解除登记…」。
   - 确认后有改动 / 需重新确认：主色淡底，说明一句，不影响阅读。
   - 已解除登记：灰底，写明只改了记录、没有删除文件、不能再修改。
   - 横幅只陈述看板观察到的事实，不推断“被删除”或“换了分支”。
4. 关联：关联任务（点击打开任务抽屉）和计划；两者都没有时整行不显示。
5. 正文：预览使用 `preview=1` 返回的 `{text, truncated, totalBytes}`。
   - `.md` 按 Markdown 渲染，可以切换到原文。
   - `truncated` 时在正文上方显著提示“只显示前 N 字节、全文 M 字节，不能据此认为已读完”，并强制按原文显示。
   - `previewable:false`、不可用、已解除登记时，显示说明框而不是空白正文。
6. 技术详情与登记管理（原生 `<details>`，默认收起，本页会话内记住开合）：
   - 读取来源：`locator.bindingId`、根目录与角色、相对路径、观测时间与是否缓存。文档只从登记的绑定读取，不随会话目录或所在工作树变化。
   - 确认基线：内容 hash（短形，悬停显示全长）、确认时间和确认人、确认时的位置；登记位置改过时注明“只作审计保留”。
   - Git：状态和 detail；`ignored` 附解释“命中 .gitignore，与看板是否读取它无关”。
   - 标识：docId、metaRev、读取结果码、登记者。
   - 底部是「重定位…」「解除登记…」。从这里打开的表单显示在折叠区内；危险操作不与确认同排。

**写入与守卫**（行为不变）

- 动作与端点：
  - 登记：`POST /docs/external`。
  - 编辑信息：`PATCH /docs/external/:id`。
  - 重定位、确认、解除登记：`POST /docs/external/:id/{relocate,confirm,unregister}`。
  - 写入体都带 `expectedMetaRev`（登记除外）和 `cmdId`，确认还带 `expectedContentHash`（取自最近一次观测）。只发送白名单字段，只发送有变化的字段。
- 确认：截断预览下须先勾选“我知道只看到了部分正文，确认针对的是完整文件的 hash”。观察、预览、刷新、重试都不确认，确认只能由“确认当前内容”完成。
- 解除登记和归档只改记录，不删除、移动或改写工作区文件。墓碑保留记录、关联和历史，之后所有写入禁用。
- 错误：
  - `stale-revision`：提示重新读取后再重试，并给“重新读取”按钮，输入不会自动重放。
  - `external-doc-operation-required`：打开文档时自动改走外置面板。
  - 登记 / 重定位的目标被拒绝：按可用性码给出原因。
- 表单绑定到打开时的 metaRev：重新读取发现 metaRev 变了，表单自动关闭，并提示草稿没有提交。确认表单还绑定到打开时的文件 hash，截断知情勾选只对当时那个 hash 有效。
- 写权限的判断是“最近一次成功的列表响应明确返回 1”：
  - 首次载入完成前、列表刷新失败时，都保持上次已知值；只读状态不会被失败的刷新解除。
  - 外置列表的 `schemaVersion` 不是 1 时，整个外置面板只读：登记、编辑、重定位、确认、解除登记全部禁用并说明原因。
- `rebind`（批量换绑定）不在界面里，只能由人类经命令接口执行。

**窄屏**：列表与详情只显示其一（选中后进入详情，带“返回列表”）；列表不再 sticky，随页面滚动；状态行和操作自动换行。

人工验收步骤见 [DOCS-UI-CHECKLIST.md](./DOCS-UI-CHECKLIST.md)。

### 4.5 健康

- 顶部 6 个 stat：日志序号 / 哈希链 / 只读 / 告警 / 租约 / 未关闭意图。
- **不变量检查**（\`health.checks\`）：逐条 ✓/×，失败项展示 \`detail\`（如 \`doc-hash: …\`）并高亮。
- **租约**：taskId · session · token · 到期时间；已过期标红。
- **未关闭意图**：taskId · summary · 开始时间（提示"崩溃后需对账"）。
- **告警**：按 warningText 中文化，红/黄分色。
- 5s 自动刷新 + 手动刷新；显示最后更新时间。

### 4.6 项目切换 / 新建

- 顶栏项目选择器（原生 select，样式化），显示"名称 · id 前 10 位"；无项目时显示"暂无项目"。
- 新建项目卡片：工作区绝对路径（必填）+ 名称（可选）+ 创建；\`Enter\` 提交，错误行内展示。
- 记住上次项目：\`localStorage['projectBoard.lastProject']\`（保持现有 key，不迁移）。

---

## 5. 与状态机的契约（不改）

- 读：\`GET /projects\`、\`/projects/:id/board|tasks/:taskId|plans/current|docs|docs/:docId|health\`。
- 写：\`POST /projects/:id/commands\`，信封 \`{op, cmdId, taskId, expected:{entityRev}, fencingToken, ...}\`；actor 由宿主覆盖为 \`{kind:'human',via:'web'}\`。
- 前端命令白名单（冻结，测试断言）：\`task.claim|begin|submit|verify|reject|block|unblock|release|reconcile|cancel|reopen|gate\`、\`doc.put\`。
- 按钮可用性 = \`allowedOps\`，前端不推断状态转移。
- 轮询 2s、隐藏暂停、本地存储 key 全部保持原样。

---

## 6. 响应式与容器查询

\`.pb-root { container-type: inline-size }\`，断点按**面板宽度**而不是视口（看板挂在 main 槽位，宽度由布局决定）：

| 容器宽度 | 变化 |
|---|---|
| ≥ 1100px | 5 列等宽；文档双栏；stat 5 列 |
| 780–1100px | 5 列最小 200px 可挤压；stat 换行 3 列；文档列表 240px |
| < 780px | 列横向滑动；抽屉全宽；文档单栏；stat 2 列；header 分两行 |
| < 520px | 搜索占满一行；tab 均分；按钮文字可隐藏为图标（保留 aria-label） |

---

## 7. 验收清单（人类可逐条点）

1. 亮色 ↔ 暗色切换（设置 → 外观）后，看板/抽屉/计划/文档/健康都没有白底黑字或不可读的低对比文本。
2. 桌面宽度下列不换行；拖窄窗口到 700px 时列变横向滑动、抽屉全宽、文档列表与编辑器互斥。
3. 只用键盘：Tab 能到项目选择、页签、搜索、每张卡片、抽屉按钮；卡片 Enter 打开；Esc 关闭且焦点回到原卡片；页签 ←/→ 切换。
4. 提交证据：无引用时"提交"禁用；\`Ctrl+Enter\` 提交成功出 toast，列表与证据数更新。
5. 冲突：在两个页面同时改同一任务 → 旧页面操作报 stale-revision，抽屉顶部出现"刷新"，刷新后 rev 更新。
6. 减少动效（系统设置）后无过渡动画、骨架屏不闪。
7. 文档：粘贴 markdown → 预览渲染标题/列表/代码块；保存后修订 +1；冲突不覆盖。 外置文档的验收见 [DOCS-UI-CHECKLIST.md](./DOCS-UI-CHECKLIST.md)。
8. 健康页：告警项与 \`checks\` 失败项红显；租约过期标红；刷新时间更新。

---

## 8. 测试与验证计划

| 层级 | 做法 |
|---|---|
| 纯逻辑（必做） | \`test/client/client-smoke.mjs\` 扩展：\`filterCards\`（搜索/状态/人审）、\`markdownBlocks\`（标题/列表/代码/粗体）、\`progressPercent\`、\`stateTone\`、\`buildEvidence\`（payload 形状）、**命令与端点白名单冻结断言**、无 \`dangerouslySetInnerHTML\`、只 require \`react\`。 |
| 装配冒烟 | 同文件保留原有断言：bundle id、\`inject\`、三个槽位注册（main / sidebar.panellist / tool.call.toolview）、\`PANEL_ID\`。 |
| 视觉 | 在隔离宿主用合成项目检查亮色、暗色与窄屏。 |
| 回归 | 执行 `npm run test:ci` 与 `npm run test:host`。 |
| 人工 | 按 §7 逐项点检，记录环境与结果。 |

---

## 9. 风险与取舍

| 风险 | 处理 |
|---|---|
| 宿主 \`--dsw-*\` token 改名 | 语义层全部带回退值（\`var(--x, #hex)\`），缺 token 时仍是可读的亮色/暗色。 |
| 样式表注入与 HMR 重复 | 以 \`data-plugin-css\` 幂等去重；同一 id 只注入一次。 |
| \`main\` 槽位宽度未知 | 用容器查询而非视口查询；最窄 360px 仍可用。 |
| 抽屉在受限容器内 \`position: fixed\` | 保持 \`fixed\`（面板无 transform 祖先），窄屏直接 100% 宽。 |
| 轮询刷新导致输入被覆盖 | 表单状态都在本地 state，只有 \`allowedOps/rev\` 来自轮询；不重置用户输入。 |
| 只读项目 | 错误码 \`read-only\` 映射到顶部横幅，写按钮保留禁用与原因，不隐藏（隐藏会让人以为坏了）。 |

---

### 附录：与旧实现的差异摘要

| 维度 | 旧 | 新 |
|---|---|---|
| 样式 | JS inline 常量 \`S.*\` | 注入式 \`.pb-*\` 样式表 + 语义 token |
| 主题 | 依赖 \`currentColor\` 与 rgba | 亮/暗两套语义 token，阴影/描边分别校准 |
| 组件 | Button / Badge / Card | 16 个组件（含 Tabs/Switch/Drawer/Toast/Empty/Loading/Error/Progress/StatTile/Timeline/Markdown） |
| 看板 | 5 列 + 原生滚动，无搜索筛选 | stat tiles + attention + 搜索/状态/人审筛选 + 响应式列 |
| 抽屉 | 全部操作平铺在底部 | 主操作条 + 分组（执行/提交/治理/时间线）+ 冲突刷新 |
| 计划 | 卡片列表 | 步骤时间线 + 进度条 + assumptions/risks + 计划外分组 |
| 文档 | 列表 + textarea | 搜索/类型/未保存指示 + 预览 + 冲突恢复 + 快捷键 |
| 健康 | 4 个灰卡片 | 6 stat + checks + 过期租约高亮 + 告警分色 + 自动刷新 |
| 可访问性 | 无焦点管理 | dialog/Esc/焦点归还、tablist 键盘、aria-live toast、reduced-motion |
