# 可维护性评估与代码拆分方案

> 评估对象：ProjectBoard 的内部开发基线
> 评估日期：2026-10-22 · 方法：源码实测 + 可重复审计脚本 + 三路只读子评审交叉核对
>
> **基线说明**：计划 v2 · U1（计划管理页）已合入，`lib/client.js` 为 3,953 行。
> 本文数字由 `node scripts/maintainability-audit.mjs` 在 `d08104f` 上重跑得到；
> 拆分边界按职责定义，不依赖行号；后续功能改动后重跑脚本即可刷新。
>
> **M1–M4 已完成**（2026-10-23）：client 拆成 `src/client/*`（20 文件 + `index.js` 150 行），
> core 拆成 `service.js` 198 / `handle.js` 284 / `commands/*` / `store/*`，host 拆成 `tools/*` + `routes/*`；
> 构建 `src/client → esbuild → lib/client.js`（原子替换，产物提交）。
> `npm test`：core 111 + client 20 + host 2 全绿；`mutation-check` 7/7；`audit --check` 零违规。
>
> **M4 复评：8.7 / 10（达标）**。下面 §2/§8 的 3.9 是 2026-10-22 的历史基线，保留用于对照；
> 当前评分与证据见 §1.1。

---

## 0. 结论先行

1. **不达标的不是技术选型。** 运行时只有 React 一个第三方依赖，测试用 `node:test`，
   存储是可读的 JSONL，DSH 的 `__ModuleLoader__` 是平台接口、有文档。
   「技术栈不冷门」这一项现在就有 8/10。
2. **真正的问题是编辑心智。** `lib/client.js` 3,953 行、18 个段落；
   其中第 182 行是**约 6.9 万字符的单行 CSS**（占文件字节 27%），无法 review、无法 blame。
   `lib/core/service.js` 2,002 行、67 个方法，`ProjectHandle` 同时是命令总线、领域逻辑、
   视图组装和文件 I/O。改一个任务字段要在 3,600 行里跳 6 个位置。
3. **硬约束冲突必须显式解决。** `CONTRACT.md:632` 写着「无构建步骤」，
   但 3,600 行手写 bundle 已经证明这条约束在规模上不可持续。
   本方案**保留运行时约束**（单文件、只 `require('react')`、无第三方运行时依赖），
   只增加**开发期构建**（esbuild，产物提交）。这是一次需要留痕的契约修订，不是偷偷加工具。
4. **先建护栏再动刀。** 现有 84–86 项测试是真正的资产，但 `client-smoke` / `host-preflight`
   不在 `node --test test/*.test.mjs` 的发现范围里，也没有 `npm test`。
   M1 先让「一条命令 + CI + 公开 API 快照 + 审计脚本」就位，再开始搬代码。

**不做的事**（避免把重构做成重写）：

- 不换框架、不上 TypeScript 全量迁移、不引入 UI 组件库；
- 不拆 npm 多包（会让一个插件变成 3–4 个包的装配问题）；
- 不改状态机语义、不顺手改公开命令/错误码/事件名；
- 不在重构 PR 里夹带功能改动（独立 PR、独立回滚）。

---

## 1. 「人类可维护」的可执行定义

没有度量就没有达标。下面 8 个维度全部可测，权重按「改坏的概率 × 修复成本」定。

| # | 维度 | 权重 | 基线 | 目标 | M4 后 | 度量方式 |
|---|---|---:|---:|---:|---:|---|
| M1 | 技术栈普及度 | 15% | 8 | 9 | 9 | 运行时依赖数、是否标准工具、是否需要私有工具链 |
| M2 | 文件/函数规模 | 15% | 2 | 9 | 9 | 单文件 LOC、最大函数 LOC（审计脚本） |
| M3 | 分层与依赖方向 | 15% | 6 | 8 | 9 | 逆向 import、环、core 是否碰 DSH/HTTP |
| M4 | 抽象与单一职责 | 15% | 3 | 8 | 8 | 单类方法数、单函数职责、重复块数量 |
| M5 | 编辑心智/可发现性 | 15% | 2 | 8 | 9 | 定位一个改动要跨几个文件/几行；有无模块地图 |
| M6 | 测试与反馈速度 | 10% | 5 | 8 | 8 | 一条命令？纯逻辑可否直测？套件耗时 |
| M7 | 工具链与自动化 | 10% | 1 | 9 | 8 | scripts、lint、CI、构建可复现 |
| M8 | 文档与上手 | 5% | 4 | 8 | 9 | ARCHITECTURE / CONTRIBUTING / 决策记录 |
| | **加权** | 100% | **3.9** | **8.4** | **8.7** | |

**达标线（三条同时满足）**：

1. 加权 ≥ 8.0，且**每个维度 ≥ 7**（不允许用长板补短板）；
2. 硬规则零违规：源码单文件 ≤ 450 行、普通函数 ≤ 80 行、React 组件 ≤ 200 行、
   分层依赖零逆向零环、公开 API 快照不变；
3. `npm test` 一条命令在 60 秒内跑完（含 client bundle 冒烟与 host 预检），
   `npm run audit --check` 零违规，CI 在干净 clone 上复现。

现状 3.9 的构成：M1 8、M2 2、M3 6、M4 3、M5 2、M6 5、M7 1、M8 4。
**M2/M4/M5 三项合计占 45%，是这次重构的主战场。**

### 1.1 M4 复评（2026-10-23）

**8.7 / 10，达标**（每维 ≥7；硬规则零违规）。证据全部可复跑：

| 维度 | 分 | 关键证据 |
|---|---:|---|
| M1 技术栈 | 9 | 运行时依赖 0；仅 dev 用 esbuild（`tools/build` 隔离） |
| M2 规模 | 9 | audit：maxFile 445、maxFunction 198（组件；普通函数 ≤80） |
| M3 分层 | 9 | layer violations 0、cycles 0 |
| M4 抽象 | 8 | service 198 / handle 284 / store 407 / commands 域模块 / host tools+routes |
| M5 编辑心智 | 9 | `src/client/index.js` 150；CSS 真文件；arch-map 86 路径可校验 |
| M6 测试 | 8 | core 111 + client 20 + host 2；mutation 7/7；client 快照 54/27/4 slot |
| M7 工具链 | 8 | npm test/fast/ci/audit/check/build/preview/check:architecture；CI 离线子集 |
| M8 文档 | 9 | ARCHITECTURE/CONTRACT/DESIGN/CONTRIBUTING/README 与磁盘一致，链接可解析 |

```bash
npm run audit:check     # violations none / layer none / cycles none
npm test                # core 111 + client 20 + host 2，约 16s
npm run check:architecture  # 61 entries / 86 paths resolved, 0 missing
npm run build:client    # 两次 sha256 800f3c41b4ca，261,941 B
```

> M7 未给 9：还没接 typecheck/lint，CI 也尚未跑 `check:architecture`；这些留给 M5（TS）与发布闸门。
> `plan-life.js`（445/450）余量很小，后续加功能先拆文件。

---

## 2. 现状实测

### 2.1 规模

| 文件 | 行数 | 最大函数 | 主要问题 |
|---|---:|---:|---|
| `lib/client.js` | **3,953** | `TaskDrawer` 474 | 18 段混装；CSS 单行约 69 KB；`DocsPane` 361、`BoardPage` 228、`PlanPane` 226 |
| `lib/core/service.js` | **2,002** | `_planRevise` 145 | `ProjectHandle` 67 个方法；`_planPublish` 120 |
| `lib/host/tools.js` | 634 | — | 5 个工具 + schema 混在一个文件 |
| `lib/core/store.js` | 447 | — | 锁、JSONL 重放、blob 三种关注点 |
| `lib/core/model.js` | 351 | — | 状态机 + 投影 + 守卫，尚可 |
| `lib/host/routes.js` | 154 | `handleApi` 104 | 路由分发与错误映射混写 |
| 其余 core/host | 9–217 | — | 健康 |

审计脚本实测（`node scripts/maintainability-audit.mjs`）：
**17 个文件、8,459 行源码、291 个函数；3 个文件超 450 行、9 个函数超限。**
文件级依赖**零逆向、零环**——这是现有架构最值得保留的部分。

### 2.2 浏览器半：18 个段落，五个「巨石段」

| 段落 | 行范围 | LOC | 判断 |
|---|---|---:|---|
| labels | 34–179 | 146 | 纯字典，可整段搬 |
| css | 180–194 | 15 | **第 182 行是约 6.9 万字符的单行字符串** |
| **helpers** | 195–887 | **693** | 8 类互不关联的纯函数（剪贴板/格式化/Markdown/图表/存储/路径/会话跳转） |
| transport | 888–964 | 77 | 可整段搬 |
| hooks | 965–1055 | 91 | 4 个 hook，可整段搬 |
| icons | 1056–1088 | 33 | 可整段搬 |
| **primitives** | 1089–1664 | **576** | 控件 + Drawer + 图表 + Markdown + 文本工具五种关注点 |
| board views | 1665–1901 | 237 | 可整段搬 |
| page chrome | 1902–2041 | 140 | 可整段搬 |
| **task drawer** | 2042–2549 | **508** | `TaskDrawer` 一个函数 474 行，内含 4 个 composer |
| **plan pane** | 2550–2981 | **432** | U1 后含列表/新建/归档/聚焦 + `PlanPane` 226、`PlanDetailPane` 103 |
| **docs pane** | 2982–3345 | **364** | `DocsPane` 一个函数 361 行 |
| health pane | 3346–3469 | 124 | 可整段搬 |
| new project | 3470–3533 | 64 | 可整段搬 |
| page shell | 3534–3764 | 231 | `BoardPage` 编排 31 个 props |
| tool card / shortcut | 3765–3827 | 63 | 可整段搬 |
| bootstrap | 3828–3953 | 126 | 入口 + 4 个 slot 注册 + 测试出口 |

**好消息**：模块级可变状态只有 2 个（`pendingJumpCwd` 第 30 行、`pluginCtx` 第 31 行），
没有模块级缓存。纯搬移的作用域风险远低于「3,950 行」给人的直觉。

**坏消息**：

- 约 69 KB CSS 是一行，任何改动都无法 diff。
- 重复模式密集：提交三件套（`setBusy/ setError/ catch`）4 份、三态守卫 6 处、
  `pb-hint` 空态文案 16 处、手写 className 拼接 4 处、`DocsPane` 内联 style 6 处。
- props 传递最深 4 层：`BoardPage`（31 键）→ `AppLayout`（`Object.assign` 全透传）→
  `TaskDrawer`（17 个 `useState`）→ `Drawer`。`BoardPage` 的 31 个键里真正属于页面的状态
  不到一半，其余是给子组件传的回调与派生值。

### 2.3 核心：67 个方法的上帝对象

| 域 | 方法数 | 方法 LOC | 备注 |
|---|---:|---:|---|
| task | 16 | 528 | 含 `_override` |
| plan | 14 | 476 | `_planRevise` 145、`_planPublish` 120 |
| lease/校验 | 10 | 152 | 租约授予/过期/归属 |
| session/lifecycle | 5 | 123 | `attach`/`detach` 绕过命令协议 |
| doc | 3 | 46 | |
| project 命令 | 2 | 39 | |
| query/read + infra | 9 | 170 | `command` 50、`_appendEvents` |
| **合计** | **67** | **1,696** | 类体 364–1927，自由函数另 250 行 |

量化证据：

- `this.state` 出现 **92 次**，8 个域全部直读；8 个方法直接写字段。
- `this.leases` 出现 **29 次**，被 **12 个方法**变更。
- `status:` 字面量 **159 处**——HTTP 状态码知识渗进了领域层。
- 「撤销租约 → interrupted/ready」的 15 行块重复 **4 份**（584–598、608–624、648–663、676–691），
  字段顺序已经出现细微漂移。
- `_execute` 是 **30 分支**的 `switch`（462–495），命令表在 host、core、client 各写一遍。
- 死代码：`_revokeLease`、`notReview` 无调用者；`service.js` 有 8 个未使用 import；
  `createIfMissing` 由 `tools.js` 传入但 service 从不读取。

最危险的一处不是行数，而是**隐式状态别名**：

```
store.open() → data.state
new ProjectHandle(..., data) → this.state = data.state      // service.js:369
store.append(commit) → applyEvent(this.store.state, event)  // store.js:362
```

`command()` 先把 `this.state` 换成 clone、执行、再换回 `realState`（426–446），
然后 `store.append` 把事件应用到 `store.state`。**两者必须是同一个对象**，
但这个不变量既没有断言也没有文档。拆分 `handle` 时只要有人把 `state` 改成深拷贝，
所有写入会静默丢失——这是本方案把 M3 的最后一步留给它的原因。

其他职责级缠绕：

| 违反 | 证据 |
|---|---|
| 应用层 import 展示层 | `service.js:27-29` import views；`digest()` 711、`query()` 739 负责视图分发 |
| 应用层做文件 I/O | `service.js:781` `statSync`、`1457-1462` 读证据算 hash、`798` 写 `meta.json` |
| 持久层懂领域事件 | `store.js:16` import `applyEvent`；重放逻辑在 64–84 与 228–249 各写一遍 |
| handle 反向摸 service 注册表 | `_projectRelocate` 读 `this.service.pathIndex`（787），`_applyRelocate` 写回（808–810） |
| host 重复领域决策 | `tools.js:6-9` 的枚举与 `service.js:462-495` 的 switch 是两份真相；publish title 双检 |
| 传输层决定身份/授权 | `routes.js:116-121` 注入 `actor:{kind:'human'}`、兜底 cmdId |
| attach/detach 绕过命令总线 | 628–700 各自 `_appendEvents`，不吃 `cmdId` 去重、不吃 `expected.projectRev` |

### 2.4 契约存在三处真相

| 契约 | core | host | client |
|---|---|---|---|
| 命令 op 列表 | `_execute` switch 462–495 | `TASK_OPS` 等 6–9 | `COMMANDS` 878 |
| HTTP 端点 | — | `routes.js:68-108` | `API_PATHS` 868 |
| 状态/证据/文档枚举 | `model.js:3-5` 等 | `tools.js:6-9` | `STATE_LABELS` 等 36–126 |

目前靠 `client-smoke` 冻结 client 一侧、靠人肉同步 host/core。没有测试断言
「host 暴露的命令集合 == core 接受的集合 == client 发送的集合」。

### 2.5 测试与工具链

- 全量：**84 项通过，约 13.4 秒**（`node --test test/*.test.mjs`，10 个文件）；
  `core.test.mjs` 单文件 52 项、约 0.95 秒。无参 `node --test` 是 86 项（多出 client-smoke 与
  host-preflight），但发现规则与 README 不一致。
- `wt.test.mjs` 一项占 **13.6 秒（99.6%）**，反馈回路被 git 子进程绑架。
- `test/client/client-smoke.mjs`（722 行、约 300 条断言）用「读源码文本 + 正则 + 假 React」跑 bundle：
  一半以上是纯逻辑，渲染只覆盖 10 个组件的首屏。能挡外壳/导出/接口冻结/CSS 关键值，
  但 `__test` 的 54 个键把测试专用出口泄漏进了生产产物。
- **发现缺口**：上面两个文件不匹配 `*.test.mjs`，所以 `node --test test/*.test.mjs` 不会跑它们；
  而 `node --test test/` 在 Node 22.20 上直接 `MODULE_NOT_FOUND`。README 只能让你记住
  三条命令——这就是「反馈回路」缺失的直接体现。
- 覆盖率基线（`--experimental-test-coverage`）：行 91.0% / 分支 71.7% / 函数 83.6%，
  但统计**包含测试文件**，且 **client.js 完全没被加载**——它占 `lib/` 代码 47%，
  等于对最大的一块没有任何覆盖率信号。
- 没有 `package.json` scripts、没有 lint/format/typecheck、没有 CI、没有 ARCHITECTURE/CONTRIBUTING。
- README 已漂移：`README.md:19` 写「核心测试 19/19」（实际 52），开发章节只列 3 条命令、漏 7 个测试文件。
- 契约漂移：client 的 `COMMANDS` 是 13 条，缺 `doc.link`；core/host 支持它。这正是「三处真相」
  已经产生实际偏差的证据。
- 覆盖缺口（子评审逐条核对）：`_expireLeases`、`detach` 的租约回收、
  `plan.revise` 的 backlog→ready 提升、`plan.adopt` 幂等空返回、`_override`、`doc.link`、
  `project.update`、`session.checkpoint/handoff`、query 的 `brief/docs/doc/events` 视图。
- 组件渲染只覆盖 10 个；`PlanPane`、`HealthPane`、`CreateProject`、`BoardPage`、`ToolCard`、
  `QuickEntry` 完全没渲染过，任何事件处理器、`fetch`、`useEffect`、CSS 顺序都测不到。

### 2.6 评分明细

| 维度 | 分数 | 依据（一句话） |
|---|---:|---|
| M1 技术栈 | 8 | React + 标准库；唯一「非主流」是平台模块加载器，且有文档 |
| M2 规模 | 2 | 3,953 / 2,002 行；3 个文件、9 个函数超限 |
| M3 分层 | 6 | 文件级干净；职责级 7 类缠绕；159 个 status 泄漏 |
| M4 抽象 | 3 | 67 方法上帝对象；4 份重复块；30 分支 switch |
| M5 编辑心智 | 2 | 单行 69 KB CSS；改任务字段跨 6 处；无模块地图 |
| M6 测试 | 5 | 84–86 项且快；但发现不全、无纯逻辑直测、无组件覆盖 |
| M7 工具链 | 1 | 无 scripts / CI / lint / 构建 |
| M8 文档 | 4 | DESIGN/CONTRACT 很扎实；缺 ARCHITECTURE/CONTRIBUTING；README 含本机路径 |

---

## 3. 根因（四条，不是十二个症状）

1. **把交付格式当成了源码组织方式。** 平台要求一个 `client.js`，于是作者也只维护一个文件；
   CSS 因为「不想多一次请求」被塞进字符串，最后变成一行 69 KB。
2. **应用层没有物理边界。** `ProjectHandle` 同时拥有状态、租约、命令分发、领域决策、
   blob 读取和视图组装。它不是一个类，是一个「什么都能放」的命名空间。
3. **契约没有单一来源。** 命令、端点、枚举各写三份，用测试冻结代替结构约束；
   于是每次加命令都要改 3–4 处，漏一处只有运行时才炸。
4. **反馈回路缺失。** 没有一条命令能跑全部检查，没有 CI 阻止回退，没有审计脚本让规模问题可见。
   人只能靠「打开文件数行数」感知腐化。

外加一个**隐性风险**：`handle.state` 与 `store.state` 的隐式别名（见 2.3）。
它现在是对的，但没有护栏；重构时最容易在这里静默破坏正确性。

---

## 4. 目标架构

### 4.1 分层与依赖方向

```
┌──────────────────────────────┐
│ src/client  (React UI)       │  ← 只 import lib/shared 与 react
└──────────────┬───────────────┘
               │ HTTP（token + JSON）
┌──────────────▼───────────────┐
│ lib/host    (DSH 适配层)      │  tools / routes / lifecycle / prompt
└──────────────┬───────────────┘
               │ 命令 / 查询
┌──────────────▼───────────────┐
│ lib/core    (应用 + 领域)     │  handle / commands / lease / views / store
└──────────────┬───────────────┘
               │ 纯数据
┌──────────────▼───────────────┐
│ lib/shared  (契约，零依赖)    │  状态枚举 / 命令 / 错误码 / 端点模板
└──────────────────────────────┘
```

硬规则（由审计脚本与测试双重执行）：

- `lib/shared` 不 import 任何东西；`lib/core` 不 import `host`/`client`/DSH 包；
- `lib/host` 只做翻译（参数 → 命令、错误 → HTTP），不做领域判断；
- `src/client` 不 import `node:*`、`lib/core`、`lib/host`，只 import `lib/shared` 与 `react`；
- 依赖图零环；同层内允许按 `model → commands` 单向。

### 4.2 浏览器半：27 个文件

| 文件 | 来源行号 | 职责 | 预估 LOC |
|---|---|---|---:|
| `src/client/index.js` | 3828–3953 | `apply` + 4 个 slot + `__test`/`__ui` 出口 | ~126 |
| `react.js` | 19–25 | `h` 与 5 个 hook 的唯一来源 | 12 |
| `state.js` | 27–32, 873–886 | 两个可变单例 + 跳转 API | 20 |
| `labels.js` | 34–179 | 12 个字典 + 11 个标签函数 | 146 |
| `styles.css` / `styles.js` | 182 / 184–193 | 真 CSS 文件 + 幂等注入 | ~69 KB / 15 |
| `util.js` | 198–266, 660–673 | 剪贴板/class/数字/时间/motion | 83 |
| `filters.js` | 268–306 | 搜索/筛选/人审门 | 40 |
| `markdown.js` | 309–384, 521–632, 1505–1540 | 行内语法 / 表格 / 块解析 / TOC | 224 |
| `chart.js` | 386–515 | 受控 DSL → SVG 几何 | 130 |
| `payloads.js` | 634–658, 676–685 | 证据/命令/文档跳转载荷 | 39 |
| `storage.js` | 687–748 | 上次项目 / 密度 / 视图偏好 | 62 |
| `selectors.js` | 751–871 | 优先级/计划/会话/路径选择器 | 121 |
| `transport.js` | 888–964 | token fetch + 命令信封 | 77 |
| `hooks.js` | 965–1055 | 4 个数据 hook | 91 |
| `icons.js` | 1056–1088 | 19 个图标 | 33 |
| `primitives.js` | 1091–1357 | 控件（Button…ToastHost） | 267 |
| `drawer.js` | 1359–1430 | 遮罩抽屉 + 焦点陷阱 | 72 |
| `content.js` | 1432–1540, 1542–1663 | 图表渲染 + Markdown 渲染 + 复制 | 194 |
| `views/board.js` | 1665–1901 | 五列 / 卡片 / 列表 / 警示区 | 237 |
| `views/chrome.js` | 1902–2041 | AppHeader / AppLayout | 140 |
| `views/task-drawer.js` | 2042–2549 | 抽屉框架 + 详情/验收/时间线 | 508 → 拆 3 个 ≤200 |
| `views/plan.js` | 2550–2981 | 计划详情/步骤 + 计划管理（列表/新建/归档/聚焦） | 432 → 拆 2 个 ≤220 |
| `views/docs.js` | 2982–3345 | 列表/编辑器/预览 | 364 → 拆 2 个 ≤200 |
| `views/health.js` | 3346–3469 | 健康页 | 124 |
| `views/create-project.js` | 3470–3533 | 建项目表单 | 64 |
| `views/board-page.js` | 3534–3764 | 全局编排（31 props → 收敛到 3 组） | 231 |
| `slots.js` | 3765–3827 | ToolCard / PanelIcon / QuickEntry | 63 |

关键手法：

- `h` 从 `react.js` 单点导出，避免 580+ 处 `React.createElement` 各自 require；
- `TaskDrawer` 按「详情 / 表单 composer / 时间线」拆三个组件，`DocsPane` 按「列表与编辑 / 阅读」拆两个，
  `PlanPane` 按「计划详情 / 计划管理」拆两个；
  `BoardPage` 的 31 个 props 收敛成 `{data, actions, ui}` 三组（一次改动，不改变子组件行为）。

### 4.3 核心：命令路由器 + 每域函数

```
lib/core/
  service.js              # ProjectService：根目录 / meta / pathIndex / handle 复用（≈330）
  handle.js               # ProjectHandle 门面：command/query/attach/detach/close + 提交（≈300）
  ctx.js                  # makeCtx(handle, cmd) + 提交后的状态同步（≈60）
  commands/index.js       # op → handler 注册表（替代 30 分支 switch）
  commands/task-intake.js # create/update/gate/ready（≈150）
  commands/task-work.js   # claim/begin/submit/verify/reject（≈280）
  commands/task-gov.js    # block/unblock/release/reconcile/cancel/reopen/override（≈300）
  commands/plan-life.js   # create/publish/revise/rename/archive/unarchive/focus（≈300）
  commands/plan-members.js# adopt/release/membership（≈150）
  commands/project.js     # update/relocate（≈90）
  commands/doc.js         # put/link（≈50）
  commands/session.js     # checkpoint/handoff/attach/detach 事件（≈110）
  lease.js                # requireTask/assertRev/assertLease/grant/expire（≈170）
  normalize.js            # labels/acceptance/steps/evidence/docLinks（≈150）
  contracts.js            # 事件构造器（撤销租约、interrupted/readied、assignment）
  model.js store.js views.js digest.js fsck.js util.js   # 保留
```

命令 handler 签名统一为：

```
(ctx, cmd) => ({ events, entityRev, relocate? })
```

`ctx` 显式携带 `{ state, leases, rev, clock, store, nextId, policy, meta, registry }`。
handler 里禁止 `this`、禁止 import `views`/`digest`。`handle.command()` 的返回形状
`{ok, committed, deduped, projectRev, entityRev, events}` **逐字不变**（tools 依赖它反查新 id）。

迁移用「门面 + 委派」过渡：先把方法体搬到 `commands/*`，handle 里留
`_taskSubmit(cmd) { return taskWork.submit(this, cmd); }`，测试通过后逐个删壳。
这样任何一步都可单独提交、单独回滚。

同时拆掉三类隐性耦合：

- `handle.state` / `store.state` 别名 → `store.append()` 返回新状态，handle 显式接收；
- `_projectRelocate` 反向摸 `service.pathIndex` → 窄接口 `writeMeta()/relocateIndex()`；
- `attach/detach` 绕过命令协议 → 生成带 `cmdId` 的事件（行为不变，只补可去重性）。

### 4.4 共享契约

新增 `lib/shared/contract.js`（零依赖、纯 ESM）：

- `TASK_STATES` / `ACTIVE_STATES` / `TERMINAL_STATES`
- `COMMAND_OPS`（含 `task.*` / `plan.*` / `doc.*` / `session.*` / `override`）
- `EVIDENCE_KINDS` / `DOC_KINDS` / `ERROR_CODES` → `status` 的一张表
- `API_PATHS`（客户端用模板；host 用同一模板拼路由）

core 的 `model`/`service`、host 的 `tools`/`routes`、client 的 `transport` 全部从
`lib/shared` 取值；新增一条 `contract-parity.test.mjs` 断言「三者集合相等」。
端点仍保留「host 注册 / client 调用」两种形态，但取值来自同一张模板表。

### 4.5 构建与产物

```
src/client/**  ──esbuild(--format=cjs, --external:react, --charset=utf8, keepNames)──▶  lib/client.js (+ .map)
```

- **运行时契约不变**：产物仍是单个 `lib/client.js`，仍只 `require('react')`，
  `package.json` 的 `exports["./client"]` 与 `dsh.client` 不用改。
- **产物提交**：`lib/client.js` 是生成物，首行 banner 写「generated from src/client」，
  审计脚本在 `src/client` 存在时自动跳过它。
- **CSS 变成真文件**：`src/client/styles.css`，构建时 `--loader:.css=text` 内联成字符串。
  编辑时是 CSS（语法高亮、diff、lint），运行时仍是 `var CSS = "..."`，测试可继续抽取。
- **构建工具隔离**：`tools/build/package.json` 只放 esbuild（固定版本 + lockfile），
  避免在仓库根 `npm install` 冲掉 `node_modules/@deepseek-ai` 这个指向本机 DSH 的 junction。
  根 `package.json` 仍然零 devDependency。
- **不做 minify**：测试用 `node.type.name` 认组件身份，且人类要能读产物。
- **sourcemap**：发布构建写 `lib/client.js.map`（DSH 的 combo loader 支持按插件提供 map），
  开发时可用 `--sourcemap=inline`。

**可行性已实测**：用 esbuild 0.28.2 把两个 ESM 模块 + 一个 `.css`（text loader）
打成 CJS，套进现有 `window.__ModuleLoader__.load({factory})` 外壳，
在 Node 里用假 `require` 执行成功（bundle 2.2 KB，`inject`/`apply`/`COMMANDS` 均正确导出）。
不是纸面方案。

### 4.6 硬阈值

| 规则 | 阈值 | 执行点 |
|---|---|---|
| 源码文件 | ≤ 450 行 | `npm run audit --check` |
| 普通函数 | ≤ 80 行 | 同上 |
| React 组件 | ≤ 200 行 | 同上 |
| 分层 | 零逆向、零环 | 同上 |
| 公开 API | 集合与返回键快照不变 | `test/contract/api-surface.test.mjs` |
| 契约 | 三端集合相等 | `test/contract/contract-parity.test.mjs` |
| 测试 | 一条命令、< 60s | `npm test` + CI |

---

## 5. 关键决策（ADR 摘要）

**D1 · 允许开发期构建（推荐 esbuild）** — 这是本方案唯一需要修订契约的决策。

| 选项 | 运行时依赖 | 编辑体验 | 装配复杂度 | 结论 |
|---|---|---|---|---|
| A. 保持单文件，只重排段落 | 0 | 差（3.6k 行不变） | 低 | 不解决 M2/M5 |
| B. 拆成多个 DSH 插件包，各自 `client.js` | 0 | 好 | 高（3–4 个包 + 链接 + 版本） | 不推荐 |
| C. 自写 150–250 行拼接器 | 0 | 好 | 中（自造模块系统） | 不推荐 |
| **D. ESM 源码 + esbuild 产物** | **0（仅开发期）** | **好** | **低** | **采用** |

代价：`CONTRACT.md:632`「无构建步骤」需修订为「运行时无构建、开发期可构建」；
构建相关约束与 README 构建说明同步更新。
收益：文件可 review、CSS 可 diff、纯逻辑可单测、IDE 可跳转。

**D2 · CSS 变真文件。** 单行 69 KB 是纯粹的编辑障碍；`--loader:.css=text` 不改变运行时。

**D3 · 核心用 `(ctx, cmd)` 函数，而非 mixin。** mixin 搬得快，但 `this` 上的隐式共享原样保留；
函数签名让「读什么、写什么」可见，也让 handler 可以脱离真实 store 单测。
过渡期保留门面委派，降低单步风险。

**D4 · 公开 API 冻结。** 工具名/参数、HTTP 路径/错误码、`command` 返回形状、
`__test`/`__ui` 导出全部不变；内部随便改。新增 `api-surface` 快照测试守住。

**D5 · v0.1 不引入 TypeScript；v0.2 由 M5 全面 TS/TSX。**
v0.1 的优先级是把单文件拆开、把边界立起来；此时全量类型化会和搬移混在一起，review 无法区分。
M1–M4 完成后模块边界与测试安全网已就位，再按 M5 迁移：classic JSX（不引入 `react/jsx-runtime`）、
core/host 用 `tsc` emit 到 `lib/`、测试继续跑构建产物、逐文件 strict。**M5 不阻塞 v0.1 发布。**
可选后手（M5 之前的过渡）：只给 `lib/shared/contract.js` 与 `model.js` 的公开类型加 JSDoc +
`checkJs`，在 `tools/` 里跑，不进入运行时。

---

## 6. 迁移路线（4 阶段 / 14 个任务）

每个任务都能独立合并；阶段之间用「全量测试 + 审计 + 预览截图」三道闸。

### M1 · 护栏与契约（约 1.5 人日）

| 任务 | 内容 | 验收 |
|---|---|---|
| M1-1 工程化入口 | `package.json` scripts：`test`（core + client-smoke + host-preflight）、`audit`、`build:client`、`check`；修测试发现；GitHub Actions（Node 22） | `npm test` 一条命令全绿；`npm run audit --check` 可重复；CI 在干净 clone 通过 |
| M1-2 契约单一来源 | `lib/shared/contract.js` + 三端改 import + `contract-parity.test.mjs` | 命令/枚举只在 shared 定义；client-smoke 冻结断言仍过 |
| M1-3 安全网 | `api-surface.test.mjs`（公开成员/返回键/事件序列）、`alias-guard.test.mjs`（store.state 同步）、client 纯逻辑直测（markdown/chart/filters）；把 client-smoke 的 161 条纯逻辑断言按 1:1 迁出 | 新测试在拆分前全绿；覆盖 12 个命令域；client-smoke 缩到 ≤150 行、只留产物启动/槽位/关键组件首渲染 |

### M2 · 浏览器半（约 3.5 人日）

| 任务 | 内容 | 验收 |
|---|---|---|
| M2-1 构建链 | `tools/build` + `scripts/build-client.mjs` + 先把现有文件整体 `git mv` 到 `src/client/index.js`，产物写回 `lib/client.js` | `npm test` 全绿；产物可被 `new Function` 执行；体积 ±5%；构建幂等 |
| M2-2 基础层 | 拆 `react/state/labels/util/filters/markdown/chart/payloads/storage/selectors/transport/hooks/icons/primitives/drawer/content`；CSS → `styles.css` | 每文件 ≤450；纯逻辑直测替代 bundle 文本断言；CSS 内容哈希不变 |
| M2-3 视图层 | 拆 9 个 view + `slots` + `board-page`；`TaskDrawer` 拆 3 个、`DocsPane` 拆 2 个、`PlanPane` 拆 2 个；`BoardPage` props 收敛 | 组件 ≤200（含 U1 后 226 行的 PlanPane）；人工比对基线布局；`__ui`/`__test` 不变 |
| M2-4 入口收敛 | `index.js` 只留 apply/注册/出口；banner 标注生成物 | 入口 ≤150；公开导出快照相等；sourcemap 可用 |

### M3 · 核心（约 2.5 人日）

| 任务 | 内容 | 验收 |
|---|---|---|
| M3-1 守卫/归一化/事件 | `lease.js`、`normalize.js`、`contracts.js`、`policy` 抽取；删死代码与未用 import；4 份租约回收合并 | `service.js` 减少 ≥300 行；core 测试全过；事件序列不变 |
| M3-2 task 命令三分 | `task-intake/task-work/task-gov` + 注册表；handle 留委派 | task 相关 30+ 用例全过；`command` 返回形状快照不变 |
| M3-3 plan/doc/session/project | 按域拆分；`_execute` 改表；handle ≤300 | 全量测试；重放/并发/锁用例全过；`handle` 不含 `_task/_plan/_doc` |
| M3-4 状态别名显式化 | `store.append()` 返回状态；handle 显式接收；加断言与用例 | 去掉隐式别名；重放一致；`alias-guard` 覆盖 |

### M4 · 宿主与收口（约 1.5 人日）

| 任务 | 内容 | 验收 |
|---|---|---|
| M4-1 host 拆分 | `tools.js` → `tools/{board,plan,task,doc,session}.js` + 注册器；`routes.handleApi` 按资源拆 | 每文件 ≤450；host-preflight 全过；工具 schema 快照不变 |
| M4-2 文档与契约 | `docs/ARCHITECTURE.md`（模块地图 + 改动指南）、`CONTRIBUTING.md`、README 开发章节、CONTRACT/DESIGN 的构建条款修订（两份文档已按目标态成稿，本步按落地结果校准） | 链接有效；新人按 CONTRIBUTING 能在 10 分钟内跑起测试 |
| M4-3 达标复核 | 审计零违规、`npm test`、构建可复现、API 快照、预览截图、评分卡 ≥8.0 | 全部门禁绿；结果写回本文档；对接发布闸门任务 |

依赖关系：M1-1 → M1-3；M1-2 可与 M1-1 并行；M2 全部依赖 M1；M3 依赖 M1-3；
M4-1 依赖 M3；M4-2/M4-3 最后。**M2 与 M3 可以两人并行**（文件不重叠）。

> 门禁分两步开：M1 的 CI 先跑 `npm run audit`（只报告），
> `--check` 硬门禁到 M4 才打开——否则基线的 12 处超限会让 CI 从第一天起就是红的。

### 6.5 与「健壮性修复」及其它计划的先后

结论：**不是二选一**。健壮性 P1 必须早于 M3（否则同一批方法要改两次、搬两次），
M1 护栏应立刻做（它同时是健壮性计划的前置）。推荐顺序：

| 顺序 | 工作 | 时长 | 理由 |
|---|---|---:|---|
| 1 | **M1 三项护栏**（含健壮性里的「工程化：npm test + CI」，合并成一个任务） | 2–2.5 天 | 不改行为；一条命令/CI/契约单一来源，两个计划都受益；避免重复实现 |
| 2 | **健壮性 P1 六项**（状态机封闭、时钟/TTL、完整性、HTTP 边界、evidence 边界、读模型） | 3–4 天 | 都是 `service.js` / `routes.js` 的行为修正；M3 要搬同一批方法，先改后搬只动一次 |
| 3 | **M2 客户端拆分**（可与第 2 步并行，文件不重叠） | 3.5 天 | 只动 `lib/client.js`；U1 已合入，正是拆的窗口 |
| 4 | **M3 核心拆分**（P1 合入后） | 2.5 天 | 纯搬移；P1 已把行为固定，重放/事件序列快照才有意义 |
| 5 | **M4 宿主与收口** | 1.5 天 | 最后拍评分与发布闸门 |

**功能冻结按面，不全停**：

| 阶段 | 冻结 | 仍可做 |
|---|---|---|
| M1 | 无 | 一切（护栏是加法） |
| P1 + M2 | `lib/client.js` 与新 UI 功能 | core 健壮性、测试、文档、脚本 |
| M3 | `lib/core/service.js` 的命令语义与新命令 | 已拆分后的 UI 功能、测试、文档 |
| M4 | 公开契约（工具/命令/事件） | 文档、打包、发布准备 |

为什么值得冻：现在每加一个 UI 功能，`client.js` 再长几十到几百行，M2 的搬移 diff 和冲突面同步变大；
每加一个 core 命令，`service.js` 再多一个方法，M3 的命令表就多搬一处。**先拆再堆功能，总成本更低。**

若必须二选一：**健壮性 P1 优先**。M2 可以等一个窗口，数据正确性不能。
如果只有一位开发者，按上表串行；如果有两位，第 2 步与第 3 步并行（core/client 文件不重叠）。

> 注意：健壮性 p2 的「工程化：npm test + CI + LICENSE + 变异基线」与本计划 M1-1/M4 重叠。
> 建议合并：npm test 与 CI 归 M1-1，LICENSE 与变异基线归 M4 或「开源四道门」，不要再开第三个任务。

---

### 6.6 M5 · TypeScript + JSX（v0.2，发布后）

M1–M4 之后另立计划 **「M5 · TypeScript + JSX 现代化」**（看板独立 plan），
把 core/host/client 全部迁到 TypeScript，组件从 `h(...)` 改为 JSX/TSX。
它不是 v0.1 的发布门槛，**不阻塞 M4**。

| 步骤 | 内容 | 任务数 |
|---|---|---:|
| M5a 决策与工具链 | 钉 TS/@types 版本；tsconfig；esbuild `.ts/.tsx` + classic JSX；spike；ADR 修订 D5 | 2 |
| M5b 核心与宿主 | `src/{core,host,shared}` 双构建（tsc → lib）；领域类型；service/handle/commands/host `.ts` | 2 |
| M5c 客户端 | 纯逻辑 `.ts`；组件 `.tsx`，props 接口，JSX 替换 `h()` | 2 |
| M5d 收口 | strict、CI typecheck、文档、bundle/audit 重新基线 | 1 |

**已定的技术选择**（详见计划 assumptions）：

- **classic JSX transform**（`jsxFactory: React.createElement`），不引入 `react/jsx-runtime`——
  宿主模块表只保证 `react`，运行时契约仍是单 bundle + 仅 `react`。
- **core/host 用 `tsc` 逐文件 emit 到 `lib/`**，测试继续 `import lib/*.js`，不给 `node --test` 加 TS loader。
- `@types/react` 固定到宿主实际版本；缺失的 DSH 类型用最小本地声明。
- 先 `allowJs` + 逐文件 strict，最后再移除 `allowJs`；行为冻结，只做类型与语法迁移。

代价 **8–12 人日**（不含回归手测），主要风险是测试/构建链与全量迁移的 churn；
收益是 props/命令/事件都有编译期约束，组件写法回到主流 JSX。

## 7. 风险与对策

| # | 风险 | 触发点 | 对策 / 验证 |
|---|---|---|---|
| R1 | 状态别名被拆坏，写入静默丢失 | `service.js:369/426-446`、`store.js:362` | M3-4 先加 `alias-guard`；`append` 返回状态；重放对比测试 |
| R2 | 事件顺序在搬移中改变 | publish 894–930、revise 1012–1076、submit 1536–1556 | 事件类型序列 golden test；`replay-snapshot` |
| R3 | 漏 import 的全局符号只在点击时炸 | client 30+ 跨段符号 | 逐组件渲染脚本（`__ui.*` 全量渲染一次）+ 事件处理器手测 |
| R4 | CSS 顺序/哈希变化导致暗色主题失效 | `ensureStyles` 去重键、token 顺序 | 构建前后 CSS 字节哈希相等；`indexOf('--pb-canvas') < indexOf('.pb-btn')` |
| R5 | 组件名被压缩，测试身份断言失效 | `node.type.name` 588–663 | 不 minify / `--keepNames`；产物断言 `TaskDrawer.name` |
| R6 | `npm install` 冲掉 `node_modules/@deepseek-ai` junction | 根目录装依赖 | 构建工具隔离在 `tools/build`；`npm run link:host` 幂等修复；CI 用真实 peer 包 |
| R7 | 2s/5s 轮询因回调身份变化重建，请求翻倍 | `useBoard` 961–981、HealthPane 3029 | 手动挂 2 分钟看 Network；Effect 依赖快照测试（可选） |
| R8 | 重构 PR 夹带行为改动，回滚困难 | 四个阶段 | 每阶段独立分支/PR；公开 API 快照；不改命令语义与事件名 |

---

## 8. 成本、收益与量化目标

| 阶段 | 人日 | 主要产出 | 风险 |
|---|---:|---|---|
| M1 护栏 | 1.5 | 一条命令、CI、契约单一来源、安全网 | 低 |
| M2 浏览器半 | 3.5 | 27 个模块、CSS 真文件、可直测纯逻辑 | 中（组件搬移） |
| M3 核心 | 2.5 | 命令表 + 9 个域模块、别名显式化 | 中高（状态机） |
| M4 宿主与收口 | 1.5 | host 拆分、ARCHITECTURE/CONTRIBUTING、门禁 | 低 |
| M5 TS + JSX（v0.2） | 8–12 | 全量 TypeScript、组件 TSX、类型门禁 | 中高（迁移面大） |
| **合计** | **9（含缓冲 8–11）** | | |

| 指标 | 现在 | 目标 |
|---|---:|---:|
| 最大源码文件 | 3,953 | ≤ 450（UI/命令 ≤ 300） |
| 最大函数 | 474 | ≤ 200（普通 ≤ 80） |
| 单行 CSS | 约 6.9 万字符 | 真 `.css` 文件，无单行超 200 字符 |
| 命令/端点/枚举定义处 | 3 / 2 / 3 | 1（`lib/shared`） |
| 跑全部检查 | 3 条命令 + 人工记忆 | `npm test` + `npm run check` |
| 新增一个任务字段的触点 | 6–8 处 | 3–4 处（contract → handler → view） |
| 测试数 | 133（core 111 + client 20 + host 2） | ≥ 120（已达标） |
| 覆盖率 | core/host 行 90.9% / 分支 71.5%（client 未计入） | core/host 行 ≥90%、分支 ≥75%；client 纯逻辑行 ≥85% |
| 可维护性评分 | 3.9 → **8.7**（M4 复核） | ≥ 8.0（已达标） |

收益不只在「好看」：现在每次加命令要同时改 core switch、host 枚举、client 列表和测试，
漏一处就是线上 400；拆完后契约编译期/测试期就能发现。CSS 可 diff 后，UI 评审不再靠截图猜。

---

## 9. 验收门禁（可执行）

```bash
npm test                    # core + client-smoke + host-preflight，< 60s
npm run audit --check       # 文件/函数/分层/环，零违规
npm run test:coverage       # 全部 wired tracked；V8 行/分支/函数 ≥90/80/90%；SKIP 不计覆盖
npm run build:client        # 干净 clone 可复现；产物 hash 稳定
```

发布前额外（与「开源四道门」的 other 两项联动）：

- `test/contract/api-surface.test.mjs` 与 `test/contract/contract-parity.test.mjs` 全绿；
- `docs/ARCHITECTURE.md` 的模块表与磁盘一致（审计脚本可校验文件存在）；
- CHANGELOG 记录契约修订（构建、CSS、模块路径）；
- 人类点检：打开看板 → 抽屉 → 计划 → 文档 → 健康 → 新建项目，各一次。

---

## 10. 证据与复现

以下是当时的测量方法。当前候选的执行入口见[贡献指南](<CONTRIBUTING.md>)。

```bash
node scripts/maintainability-audit.mjs        # 规模/函数/分层/环
node --test "test/**/*.test.mjs"              # 递归入口
node test/client/client-smoke.mjs                    # bundle 冒烟
node test/host/host-preflight.mjs                  # 工具注册
git ls-files | xargs wc -l                    # 文件规模
```

构建可行性原型：esbuild 0.28.2 + `--format=cjs --external:react --loader:.css=text`，
产物套 `__ModuleLoader__` 外壳后在 Node 假 React 下执行通过；CSS 文本与 sourcemap 均可保留。

只读子评审（2026-10-22）分别核对：客户端 18 段/2 个可变单例/4 类测试约束；
核心 67 方法/92 处 `this.state`/159 处 `status`/4 份重复块；测试与工具链的发现缺口。
三份结论与本文交叉一致，未发现互相矛盾的数字。
