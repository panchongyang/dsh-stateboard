# 决策：计划能力 v2 —— 不嵌套任务，把计划升格为可管理的多实例

- 日期：2026-10-22
- 状态：待人类确认（见任务 D1）
- 影响面：lib/core、lib/host、lib/client.js、CONTRACT.md、DESIGN.md、README.md、测试

## 0. 结论

1. 不引入任务嵌套（不做 parentId / 子任务）。任务保持为唯一的工作单元；层级只允许出现在容器层。
2. 继续使用计划，但计划必须从「单例 + 只读」升级为「多实例 + 有生命周期 + 可写」：可创建、可列出、可重命名、可归档/恢复、可指定焦点、可把任务归位/移出、可在 UI 里完成。
3. 一个计划 = 一个 initiative / 交付目标；steps = 阶段；tasks = 叶子工作单元。三层语义固定，不再引入第四种关系。
4. 若未来确实需要更深层级，先让 step 可嵌套（纯容器，不进状态机），而不是让 task 可嵌套。
5. 落地拆成 7 个任务（D1、C1、C2、H1、U1、U2、T1），依赖链见 §8。

## 1. 现状与证据

### 1.1 数据：一个计划装不下现在的项目

- 开发期样本：项目 rev 186；39 条任务：done 16、ready 7、in_progress 1、review 1、backlog 9、canceled 5。
- 唯一计划 v3「MVP 交付 + UI 2.0」，5 个 step，10 条任务（s1–s5）。
- 其余 29 条任务 planRef=null，计划页把它们显示为「计划外任务」。
- 计划外任务已经形成至少 5 条并行 initiative：
  - 流转（T1 review + T2–T7 backlog，7 条）
  - 文档渲染（阶段 4/5 ready + 阶段 6 backlog）
  - 系统级历史 / 回滚（2 条）
  - UI 入口与字段口径（1 条）
  - 审计增强（1 条）
- 现有计划的标题与 goal 只覆盖 MVP + UI 2.0。把「流转」「历史」塞进这份计划，会让计划的 goal 失真；不塞，就只能以扁平任务存在。这不是使用问题，是模型缺口。

### 1.2 代码：骨架 80% 已存在，缺的是多实例与管理面

| 位置 | 现状 | 后果 |
|---|---|---|
| lib/core/service.js:735 | plan.publish 发现已有 currentPlan 直接 409 | 不能创建第二个计划 |
| lib/core/model.js:29–34 | currentPlan 由 project.currentPlanId + currentPlans 单指针推导 | 全局只有一个「当前计划」 |
| lib/core/views.js:46 | board 只返回一个 plan | 看板/简报无法按计划切换 |
| lib/core/views.js:79–99 | planView 支持 planId，但 UI/路由只取 current | 多计划没有读入口 |
| lib/host/routes.js:78–80 | 只有 GET /plans/current | 没有 /plans 列表、没有 plan 详情路由 |
| lib/host/tools.js:270–365 | project_plan 只有 publish / revise | 没有 create / list / archive / focus |
| lib/host/tools.js:428–430 | task.create 不透传 planRef | 独立任务无法归入计划 |
| lib/client.js:840 | 前端只请求 /plans/current | 计划页永远只有一个计划 |
| lib/client.js:846–850 | COMMANDS 白名单没有 plan.* | 即使 core 支持，UI 也不能写计划 |
| lib/client.js:2354–2453 | PlanPane 纯只读，计划外任务提示「让模型 revise」 | 人类不能自助建/管计划 |

补充事实：

- 计划版本（plan@version）已经存在，status 只有 published / superseded；DESIGN 里写了 draft，但代码没有实现。
- 修订已有 orphan 语义（移除的任务标 orphaned、不删除），这是多计划最难得的部分，已经做完了。
- plan.revise 用 baseVersion 做乐观并发；任务用 expectedRev。这套并发模型可以原样复用。
- 计划进度是纯函数（views.js:8–15），不存 progress 字段，符合 DESIGN §3.5。

### 1.3 文档：单计划是明确的 v1 边界

- DESIGN.md:218：「同一项目同一时刻只有 1 个 published plan；多计划是 v2。」
- CONTRACT.md:29：「plan revise 的图形化编辑（只读展示）」。
- README.md:187：「plan revise 只能通过工具/HTTP，UI 只读。」
- 结论：缺的正是当初标记为 v2 的那一块，不是实现 bug。

## 2. 缺口清单

| # | 能力 | 现状 | 影响 | 归属 |
|---|---|---|---|---|
| G1 | 创建第二个计划 | 409 already-exists | 新 initiative 只能变成扁平任务 | C1 |
| G2 | 计划列表 / 详情 | 只有 current | 人和模型都看不到「有哪些计划」 | C1/H1 |
| G3 | 生命周期 | 只有 published/superseded；draft 未实现；无 archived | 老计划无法退役，计划页永远停在历史目标 | C1 |
| G4 | 焦点 | currentPlanId 单值 | 简报/看板只能围绕一个计划 | C1 |
| G5 | 任务归位 | 只能在 publish/revise 时绑定；task.create 无 planRef | 29 条计划外任务无法低成本归位 | C2 |
| G6 | 移出 / 跨计划移动 | 只能 revise + orphan | 任务换 initiative 需要重写整个计划 | C2 |
| G7 | 人类可写 | UI 只读；COMMANDS 无 plan.* | 建计划必须找模型 | U1/U2 |
| G8 | 计划内外分类 | 卡片只显示「计划 v1」；无步骤名；无过滤 | 用户已提出 R2「缺分类：是不是在计划内」 | U1 |

## 3. 方案 A：接受任务可嵌套

### 3.1 模型

给 Task 增加 parentId（或 children[]），任务变成树：

    Task { id, parentId?, deps[], state, acceptance[], ... }
    epic → feature → task → subtask

看板按树展开，父任务进度由子任务 rollup。

### 3.2 优点

- 不引入计划生命周期，任何任务都能就地分组。
- 层级深度不受限制。
- 对「一个交付物拆成多个子交付物」表达直接。

### 3.3 代价与风险

1. 父任务的状态语义无法自洽。父任务如果有 state/lease/acceptance/evidence，它和子任务会争抢「谁才是工作单元」；claim 父任务意味着什么？submit 父任务又意味着什么？如果父任务没有这些字段，它就不是 Task，只是一个容器——那正是计划。
2. 进度会重复计数。现有进度按 weight 求和；父子同时计入会 double count，必须引入「只算叶子」的例外，digest、看板、简报全部要改。
3. 同一件事会有三种关系：deps（顺序）、parent（组成）、plan step（分组）。用户和模型都要判断「这个任务为什么不能开始」到底卡在哪条边上。
4. 不变量要重写：I7（done ⇒ verified）、I8（ready ⇒ deps done）、I9（依赖无环）之外，还要加父子无环、父子状态一致、父完成 ⇒ 子完成、取消父 ⇒ 子怎么办。fsck、replay、migration 全部受影响。
5. 迁移与 UI 成本最高：树形看板、拖拽、展开/折叠、父子筛选；现有单文件 UI 没有构建，改动面远大于多计划。
6. 对 agent 的提示更复杂：多一层树 + 租约 + 依赖，模型更容易建出「容器任务」而不是真正的交付单元。

结论：不采纳。真正需要「更深的层级」时，先扩展 step（容器，不进状态机），不要扩展 task。

判断依据：如果父任务需要自己的租约、验收、证据，那它是工作项，应该和子任务并列 + deps；如果不需要，它是容器，应该用计划/步骤表达。两种情况下都不需要 parentId。

## 4. 方案 B：继续使用计划，但升级为多实例

### 4.1 模型

    PlanHead { id, title, status: draft|active|archived, currentVersion, createdAt, updatedAt }
    PlanVersion { id, version, status: published|superseded, title, goal, assumptions, risks, steps[] }
    Step { id, title, taskIds[] }
    Task.planRef { planId, version, stepId }   // 0..1 个计划

- 一个项目可有 N 个计划；N 个计划可同时 active。
- focusPlanId 是「人当前关注哪个计划」的偏好，不是唯一计划。
- 计划版本仍然不可变；revise 产生 version+1，旧版本 superseded 只读。
- 完成度由任务状态派生；archived 是显式动作（不删除）。
- 计划外任务是一等状态（inbox），不是错误。

### 4.2 为什么不是「给计划加 parent」

计划的 step 已经是一层分组；再给计划加父子，会得到「计划树」，但没有解决「计划不能创建/管理」的问题，反而增加一套新的层级语义。多实例 + 生命周期是最小且完整的补法。

### 4.3 代价与风险

- 计划数量膨胀：需要唯一标题、默认只看 active、归档动作。
- 焦点歧义：需要明确 focus 是偏好，看板默认展示全部 active + 过滤。
- 身份 vs 版本：需要 PlanHead 索引，不能再用 currentPlanId 单指针。
- 并发：多个计划可被不同会话同时 revise；单日志仍然串行提交，按 planId + baseVersion 做乐观并发即可。
- 迁移：旧日志 replay 要能推导 PlanHead；这需要 schemaVersion 2 + 兼容读。

### 4.4 结论

采纳。它复用已经存在的 80%（版本、步骤、原子发布、orphan、审计、进度纯函数），新增的只是「索引 + 生命周期 + 管理命令 + UI」。风险集中在 UI 编辑器和迁移，而不是状态机。

## 5. 对比

| 维度 | A 任务嵌套 | B 多计划 |
|---|---|---|
| 表达「多个 initiative」 | 可以，但用任务当容器 | 原生 |
| 工作单元唯一性 | 被破坏（父也是任务） | 保持（task 永远是叶子） |
| 状态机改动 | 大（父状态/租约/验收/证据） | 小（计划不进任务状态机） |
| 进度正确性 | 需引入「只算叶子」例外 | 沿用现有纯函数 |
| 审计 / 版本 | 需要新的父子事件与不变量 | 复用 plan@version / superseded |
| 迁移 | 新字段 + 环校验 + 回填 | PlanHead 派生 + 焦点字段 |
| UI 成本 | 高（树形、拖拽、折叠） | 中（列表、过滤、编辑表单） |
| 对 agent 的认知负担 | 高（树 + deps + 租约） | 低（计划=目标，步骤=阶段，任务=工作） |
| 与现有文档/契约 | 冲突（DESIGN 已定计划模型） | 补齐 DESIGN 已标注的 v2 |
| 结论 | 不采纳 | 采纳 |

## 6. 决策

采纳方案 B。

非目标（v2 明确不做）：

- 任务 parentId / 子任务 / 父子进度 rollup。
- step 嵌套（保留为后续可选扩展；真要做，也只在容器层做）。
- 跨项目计划、计划模板、计划删除（只归档）。
- 计划实时协同编辑、拖拽排序。
- 自动把会话 plan mode 文本导入为计划。

复审触发条件（满足任一才重新讨论任务嵌套）：

1. 单个 step 内稳定超过 15 条任务，且确实需要两层以上分解。
2. 一个任务需要多个「各自有租约、验收、证据」的子交付物，且 deps 无法表达。
3. 出现大量「标题是 initiative、没有验收」的容器任务（说明计划入口仍不可用）。

## 7. 目标设计（最小可用）

### 7.1 数据

- state.planHeads[planId] = { id, title, status, currentVersion, createdAt, updatedAt }
- state.project.focusPlanId（保留旧 currentPlanId 只读兼容）
- state.plans[planId@version] 不变，仍是不可变快照
- 计划标题在项目内唯一（大小写不敏感）；rename 需要 expectedRev
- 一个任务最多属于一个计划；planRef 是单值

### 7.2 命令

| op | 语义 |
|---|---|
| plan.create | 创建 draft（title/goal/assumptions/risks/steps?）；不建任务 |
| plan.revise | draft 或 active；active 时 version+1，原子 add/update/orphan 任务 |
| plan.publish | draft → active；要求 ≥1 step、每 step ≥1 task、每条 task ≥1 acceptance；原子建任务 |
| plan.rename | 改标题；expectedRev |
| plan.archive / plan.unarchive | active/draft ↔ archived；archived 只读；有 in_progress 或 live lease 时拒绝 |
| plan.focus | 设置 focusPlanId（human 偏好）；null = 不指定 |
| plan.adopt | 把计划外任务加入某 step（内部生成 version+1，复用 revise 逻辑） |
| plan.release | 把任务移出计划（内部 version+1；任务保留，变为计划外） |
| task.create | 保持不绑定计划（避免绕过版本）；归位走 plan.adopt |

并发：plan.* 用 planId + baseVersion；任务用 expectedRev；所有命令仍需 cmdId + actor。

### 7.3 读模型

- board：新增 plans: PlanSummary[]、focusPlanId；plan 字段保留为 focus plan 的别名（兼容旧客户端）。
- view=plans：列表（id/title/status/currentVersion/progress/taskCount/updatedAt/focused）。
- view=plan&planId=：指定计划详情；不带 planId 仍返回 focus plan。
- brief：plans 摘要（active/archived 数、focus）+ 现有 next/attention。
- Card 增加 planTitle / stepTitle 的可选派生字段（或由 board.plans 关联，避免重复存储）。

### 7.4 宿主 / HTTP

- GET /plans、GET /plans/:planId、GET /plans/current（= focus 别名）。
- POST /commands 不变；client COMMANDS 白名单增加 plan.create / revise / publish / rename / archive / unarchive / focus / adopt / release。
- project_plan 扩展 op；project_board 增加 view=plans 与 planId 参数。
- 提示词：项目可有多个计划；计划=initiative；不要创建容器任务。
- 错误 NEXT 增加 plan 相关条目（plan-not-found、plan-archived、plan-title-taken、plan-not-draft、plan-has-live-work）。

### 7.5 客户端

- 计划页：计划卡片列表（状态/进度/任务数/更新时间/焦点标记）+ 新建计划主操作 + 归档/聚焦菜单。
- 计划详情：现有步骤时间线 + 编辑模式（加/改/删 step 与 task、验收、依赖、优先级、人审）；baseVersion 冲突提示；删除任务显示 orphan 警告。
- 看板/列表：按计划过滤（全部 / 各 active / 计划外）；卡片与列表行显示计划名 + 步骤名（R2）；抽屉的计划区可跳转。
- 只走 commands，不新增 HTTP 写端点；不引入组件库；不手工编辑 46KB CSS 单行。
- UI 验收：纯逻辑在 node 测，交互由人类按 docs/UI-REDESIGN.md 清单验收。

### 7.6 迁移与兼容

- schemaVersion 1 → 2；加载旧项目时从 plans 派生 planHeads（取每个 id 的最大版本，status=active），focusPlanId = 旧 currentPlanId。
- 旧事件 plan/published、plan/revised、plan/superseded 的 applyEvent 保持可用；新事件幂等。
- 不修改任何任务；29 条计划外任务不自动归位（由人决定归属）。
- fsck / replay 在现有 186 个事件的项目副本上跑通，是 C1 的硬验收。

### 7.7 新增不变量

| # | 不变量 | 检查时机 |
|---|---|---|
| I16 | 每个 planRef 指向存在的 plan@version，且该版本某 step 包含该 task | commit / fsck |
| I17 | planHeads[id].currentVersion 指向存在的版本；版本状态与 head 一致 | commit / fsck |
| I18 | focusPlanId 为空或指向 active 计划 | commit / fsck |
| I19 | 计划标题在项目内唯一（大小写不敏感） | create/rename |
| I20 | 一个任务最多属于一个计划；同一计划内一个 task 只出现在一个 step | publish/revise/adopt/fsck |
| I21 | archived 计划不产生任务状态变化；归档前无 in_progress / live lease | commit |

## 8. 任务拆解

| 键 | 标题 | 依赖 | 优先级 | 产出 |
|---|---|---|---|---|
| D1 | 决策与契约同步 | — | 120 | 本决策落进 DESIGN/CONTRACT/README + docs/PLAN-V2.md |
| C1 | 核心：Plan 聚合与生命周期 | D1 | 122 | planHeads、多实例、focus、archive、迁移、单测 |
| C2 | 核心：任务与计划绑定 | C1 | 124 | plan.adopt/release、版本化成员、orphan、单测 |
| H1 | 宿主：工具/读模型/HTTP | C1,C2 | 126 | project_plan op、view=plans、/plans 路由、测试 |
| U1 | 客户端：列表/新建/归档/聚焦/过滤 | H1 | 128 | 计划列表与新建、看板过滤、R2 分类、截图 |
| U2 | 客户端：计划详情编辑 | U1 | 130 | step/task 增删改、冲突处理、orphan 警告 |
| T1 | 回归、迁移与文档 | C2,H1,U2 | 132 | 旧日志 replay、并发、client-smoke、README/CHANGELOG/MIGRATION |

任务会以 backlog 诞生（有依赖），D1 → C1 → … 级联 ready。优先级刻意排在 UI 2.0 的 P4/P6（180/195）之前，因为这是当前用户点名的缺口；如需先完成 UI 2.0，直接改优先级即可。

## 9. 风险与开放问题

风险：

- 计划编辑器是最容易膨胀的部分。U2 只做最小字段集；拖拽、模板、JSON 导入不在 v2。
- 计划数量增长后，列表需要默认过滤 archived，否则会变成第二个「扁平任务墙」。
- 焦点是人的偏好，不要用它做权限或唯一性；board 必须能看全部 active。
- 单日志串行提交：不同计划并发 revise 不会破坏一致性，但会互相 409；UI 要提示刷新。
- 迁移期老客户端可能读到 board.plan（focus 别名）；保留别名字段直到 UI 全部切换。

开放问题（C1/C2 实现前需要拍板）：

1. draft 计划是否出现在看板？建议默认不出现，只在计划列表显示。
2. 归档允许有 review 任务吗？建议允许，但禁止 in_progress / live lease。
3. 跨计划移动是否原子？v2 用 release → adopt 两步；不引入跨计划原子移动。
4. plan.adopt 是否要求目标 step 已存在？是；不存在先 revise 加 step。
5. 计划完成是否显式？建议派生徽章，不新增状态；归档才是显式退役。

## 附录 A：现状代码位置

| 能力 | 位置 |
|---|---|
| 单计划守卫 | lib/core/service.js:735–737 |
| 当前计划推导 | lib/core/model.js:29–34、43–51 |
| 看板单计划 | lib/core/views.js:44–52 |
| 计划视图 | lib/core/views.js:79–99 |
| 计划命令 | lib/host/tools.js:270–365 |
| 任务创建参数 | lib/host/tools.js:428–430 |
| 计划 HTTP | lib/host/routes.js:78–80 |
| 前端计划 URL / COMMANDS | lib/client.js:840、846–850 |
| 计划页只读 | lib/client.js:2354–2453 |
| 单计划边界 | DESIGN.md:218；CONTRACT.md:29；README.md:187 |

## 附录 B：术语

- Plan / 计划：一个 initiative 或交付目标，可版本化，可归档。
- PlanHead：计划的身份与当前版本指针（新增）。
- Step：计划内的阶段，纯容器，不进任务状态机。
- Task：唯一的工作单元，有租约、验收、证据、状态。
- Focus：人当前关注的计划，只是一个偏好。
- Inbox / 计划外：不属于任何计划的任务，合法状态。
