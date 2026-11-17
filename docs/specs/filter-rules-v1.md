# 方案：过滤规则与持久化 v1

> 状态：已替代（现行语义见[实现契约](<../CONTRACT.md>)；正文保留方案或决策时的语境）。

> 状态：待评审（未实现、未建看板任务、未发布计划）
> 日期：2026-10-29 · 范围：`src/client/**` + 测试/预览/文档
> 硬边界：**不改** `lib/core`、`lib/host`、`lib/shared`、CONTRACT、看板读模型、HTTP 端点；不引第三方运行时依赖；不做浏览器自动化探针。

## 0. 一句话

把 P7 的“临时过滤对象”升级为**固定 6 维、跨维 AND / 维内 OR 的规则集**；规则按项目持久化、看板与列表同源；用“草稿 + 方案（preset）快照”管理，支持另存/更新/重命名/删除/应用，并带 v0 迁移与回退。

---

## 1. 目标 / 非目标

### 目标

1. 可持久化：刷新、重启页面后规则仍在；按项目隔离。
2. 同源：同一规则同时作用于看板列、注意力托盘、列表；命中集合与计数一致。
3. 可管理：规则可逐项调整、清除；可保存为命名方案并再次应用；草稿与方案的关系明确。
4. 可迁移：P7 已写入的 `localStorage['projectBoard.filters']` 不丢，非法/损坏数据安全回退。
5. 可验证：规则模型、匹配、迁移、方案全部是纯函数，node 直测；UI 由 preview 出图 + 人工点检。

### 非目标（v1 明确不做）

- 服务端过滤/保存、跨设备同步、方案导入导出。
- 任意规则构造器（field/op/value）、正则、表达式、规则嵌套 OR 组。
- 拖拽规则排序（AND 可交换，顺序无语义）。
- 按“负责人是我”过滤（Web 端没有稳定人类身份）；按验收进度/证据/时间过滤。
- 按优先级档位/tier 着色或过滤（决策文档已否决阈值配色；只保留 P 上限这一显式数值过滤）。
- 看板与列表各自维护不同规则（沿用 P7 同源原则；分组/密度仍属视图偏好）。

---

## 2. 现状（P7 之后）

- `filters = { query, state(单选), gateOnly(bool), plan('in'|'out'|null), group }`
- 单键全局保存：`projectBoard.filters`；`group` 混在 filters 里。
- 看板列、注意力托盘、列表共用同一对象（P7 已收口）。
- 不足之处：
  1. `state` 只能单选；`plan` 只能 in/out，不能指定计划/步骤。
  2. 没有标签、优先级过滤。
  3. 规则不可命名、不可管理，只能手工调。
  4. `gateOnly` 与 `gate:human` 标签存在潜在双入口（标签过滤尚无，但扩展时必须先定正交）。
  5. 全局存储对多项目会串计划 id；`group` 不是过滤，却占着过滤键。

---

## 3. 规则词汇（已定：6 维）

| # | 维度 | 存储字段 | 取值 | 默认（关闭） |
|---|---|---|---|---|
| 1 | 文本 | `query` | 字符串，空白分词；词间 AND | `""` |
| 2 | 状态 | `states` | 8 个状态的多选（OR） | `[]` |
| 3 | 人审 | `gate` | `any` / `required` / `not-required` | `any` |
| 4 | 计划 | `plan` | 模式 + 计划 + 步骤，见下 | `mode:"any"` |
| 5 | 标签 | `labels` | `any` / `none` / `some(values[])`（OR） | `mode:"any"` |
| 6 | 优先级 | `priority.max` | 整数或 `null`；`P ≤ max` | `null` |

### 3.1 文本（query）

- 大小写不敏感；按空白切词，**每个词都必须出现**（词间 AND，词内子串）。
- haystack：title、id、labels、owner.sessionId、planRef.planId、blocked.code/note，以及**解析后的计划名与步骤名**（来自规则上下文里的计划目录）。
- 不搜描述/验收文本（卡片 payload 不含；避免额外请求与不一致）。
- 上限 200 字符；纯空白视为关闭。

### 3.2 状态（states）

- 取值：`backlog / ready / in_progress / review / blocked / interrupted / done / canceled`。
- 多选，**维内 OR**；空数组=关闭。
- 选中全部 8 个时规范化为空数组（等价关闭），避免“全选”这种伪状态。
- 不另设“注意力”维度：blocked/interrupted 就是状态；看板托盘与列共用同一状态轴。

### 3.3 人审（gate）

- `any` 关闭；`required` = `isGate(card)`；`not-required` = 取反。
- `isGate` 同时认 `requiresHumanReview===true` 与 `labels` 含 `gate:human`。
- 标签维度**排除 `gate:human`**，避免同一事实两套规则、两套口径。

### 3.4 计划（plan）

单一维度、互斥模式：

| mode | 匹配 |
|---|---|
| `any` | 关闭 |
| `unplanned` | `card.planRef == null` |
| `planned` | `card.planRef != null` |
| `plan` | `planRef.planId === planId`（不管步骤） |
| `steps` | `planRef.planId === planId` 且 `stepIds` 含 `planRef.stepId` |

- 只支持**一个计划 + 该计划下多个步骤**；不支持多计划 OR（v1 克制，后续可扩展成多选）。
- `steps` 模式但 `stepIds` 为空 → 规范化为 `plan` 模式；`plan/steps` 模式但 `planId` 为空 → `any`。
- 计划目录来源与 P6/P7 一致：`board.plans` + `/plans`（含归档）+ `board.plan`；不新增计划编辑/归档/创建逻辑。
- 计划被归档/不在目录：规则保留（按 planId 仍能匹配卡片），UI 摘要显示“计划不可用”，不静默清除。

### 3.5 标签（labels）

- `any` 关闭；`none` = 无标签；`some(values)` = 维内 OR（有任一标签即命中）。
- 取值来源：当前 board payload 全部卡片（含 done/attention）的标签并集；剔除 `gate:human`；加“无标签”入口。
- `none` 与 `some` 互斥（结构上就是两个 mode，不会同时生效）。
- 方案里引用了当前项目已不存在的标签：保留并显示“已失效”，允许一键移除；不自动删。

### 3.6 优先级（priority）

- 仅 `max`（`P ≤ N`）：数字越小越优先，默认值 100 表示“未显式设定”；不提供 min，避免把“P 值”当连续量纲。
- 整数，范围 0–10000；空/非法=关闭。
- 决策文档“rank 而非阈值配色”约束的是**自动配色**；这里是用户显式输入的数值过滤，不引入 tier 阈值。

---

## 4. 正交性（已定）

1. **跨维度 AND**：所有开启维度同时命中；维度之间无优先级、无短路语义差异（实现可按代价短路，结果必须相同）。
2. **维内多值 OR**：`states`、`labels`、`stepIds` 均为“任一命中”。
3. **否定只由模式表达**：`gate=not-required`、`plan=unplanned`、`labels=none`；不提供任意 NOT。
4. **一个事实只有一个入口**：
   - `gate:human` 归人审维度，标签维度剔除；
   - blocked/interrupted 归状态维度，不另设“注意力”过滤器；
   - 计划内/外是计划维度的两个 mode，不是两个布尔。
5. **空=关闭**，没有隐式“全部”；“全选状态”规范化为关闭。
6. **文本只收窄**：query 与结构维度可以重叠（haystack 含标签/计划名），但 AND 语义下不会放宽结果；其 haystack 是文档化契约。
7. **分组/排序/密度/视图不是过滤**：不参与匹配、不影响命中集合；`group` 从 filters 拆到独立视图偏好。
8. **顺序无语义**：规则展示顺序固定（文本→状态→人审→计划→标签→优先级）；保存时不记录顺序，拖拽排序不做。

---

## 5. 持久化（已定）

### 5.1 键与结构

- 新键：`localStorage['projectBoard.filters.v2']`

```json
{
  "version": 2,
  "projects": {
    "prj_xxx": {
      "draft": { "query": "", "states": [], "gate": "any",
        "plan": { "mode": "any", "planId": null, "stepIds": [] },
        "labels": { "mode": "any", "values": [] },
        "priority": { "max": null } },
      "presets": [
        { "id": "fpr_...", "name": "我的待办", "projectId": "prj_xxx",
          "rules": { }, "createdAt": "ISO", "updatedAt": "ISO" }
      ],
      "activePresetId": null,
      "updatedAt": "ISO"
    }
  },
  "migratedAt": "ISO"
}
```

- **按项目隔离**：草稿、方案、activePresetId 都挂在 projectId 下；标签/计划 id 是项目内概念，不能跨项目复用。
- 视图偏好拆到新键 `projectBoard.viewPrefs.v1`：`{ "group": "none" }`（`group` 不再属于过滤规则）。
- 旧键 `projectBoard.filters` **只读、不删除**：保留给回滚与旧客户端。

### 5.2 v0 → v2 迁移

映射：

| v0 | v2 |
|---|---|
| `query` | `draft.query` |
| `state`（单值） | `draft.states:[state]` |
| `gateOnly:true` | `draft.gate:"required"` |
| `plan:"in"/"out"` | `draft.plan.mode:"planned"/"unplanned"` |
| `group` | `viewPrefs.group`（仅当 viewPrefs 不存在） |

- 只在目标项目**没有 v2 条目**时迁移一次，并写 `migratedAt`；迁移目标 = `projectBoard.lastProject`（空则当前打开的项目）。
- 迁移失败/校验不通过：该字段回退默认，其余字段照常迁移；不因一个坏字段整体丢弃。
- v2 损坏/版本高于 2：返回默认规则，**不覆盖**原值，直到用户第一次修改才重写；不静默删除。
- 方案/草稿校验失败（未知枚举、重复、超限）逐项修正并保留可识别部分。

### 5.3 容量与上限

- 每项目方案 ≤ 30；名称 1–40 字符；方案名项目内不重复（精确匹配）。
- query ≤ 200；`states ≤ 8`；`labels.values ≤ 50`；`stepIds ≤ 50`；整份 v2 JSON 建议 < 256 KB（超出拒绝写入并保留旧值）。
- localStorage 不可用/配额满：写失败不抛到 UI；当前会话内存态继续生效，toast 提示“筛选规则未能保存”。

---

## 6. 方案（preset）管理语义

- **草稿（draft）**：当前生效规则，自动保存；刷新恢复。
- **方案（preset）**：命名快照，含 projectId + rules；**不自动跟随草稿变化**。
- 应用方案：把 `preset.rules` 深拷贝到 draft，`activePresetId=preset.id`；方案本身不变。
- 编辑草稿：只改 draft；`activePresetId` 保留，`dirty = !rulesEqual(draft, preset.rules)` 派生“未保存 ●”。
- 保存修改：仅当 activePreset 存在且 dirty；覆盖该方案 rules + updatedAt。
- 另存为：新建方案（名称必填、去重、限 30 个）；成功后 activePresetId 指向新方案。
- 重命名：只改 name/updatedAt，不改 rules。
- 删除：删除方案；若 active，则 activePresetId=null，draft 保留。
- 切换项目：加载该项目 draft；不跨项目复用 activePresetId；不存在则默认规则。
- **不做默认方案**：启动永远恢复 draft，避免“刷新后规则被默认方案覆盖”的歧义。
- 多标签页：最后写入者胜；v1 不监听 storage 事件同步。

---

## 7. 管理 UI

### 7.1 头部（看板/列表共用）

- 保留搜索框（`/`、Ctrl/⌘+K）。
- 新增「筛选」按钮：显示生效维度数（如 `筛选 3`）；点击打开筛选抽屉。
- 新增方案下拉：`临时筛选` / 方案名（dirty 时带 `●`）/ `管理方案…`；选中即应用。
- 生效时显示「清除」；下方一行**活动规则 chips**（只读摘要 + 每项 × 移除；点击 × 只移除该维度）。
- 移除 P7 的内联状态/人审/计划 chips，避免与面板形成两套编辑入口；快捷操作由“活动 chips 的 ×”承担。

### 7.2 筛选抽屉（role=dialog，复用 Drawer）

分节：

1. **状态**：8 个 chip 多选；`全部` 清空该维度。
2. **计划**：模式选择（全部/计划内/计划外/指定计划/指定步骤）+ 计划 select + 步骤 chips（steps 模式）。
3. **标签**：标签 chips + 无标签；与具体标签互斥。
4. **需人审**：分段控件（不限/需人审/不需人审）。
5. **优先级上限**：数字输入（可选，`P ≤ N`；空=关闭）。
6. **方案**：当前方案名 / 未保存提示 / 保存修改 / 另存为 / 方案列表（应用、重命名、删除）。
7. 底部：`重置全部`、`完成`；修改**实时生效**（与 P7 一致），不设“应用”二次确认。

错误行内展示（重名、名称超长、方案数满、优先级非法）。Esc/遮罩关闭；焦点归还触发按钮；全键盘可达。

### 7.3 窄屏

- 头部：筛选按钮显示计数；方案下拉可缩为图标+当前方案名截断；活动 chips 换行。
- 抽屉全宽、圆角 0（沿用现有容器查询规则）。

---

## 8. 看板/列表/统计边界

- **看板**：列内卡片按规则过滤；注意力托盘同规则；列计数/托盘计数=命中数；底部 `筛选命中 n/N` 的 N 含注意力卡片。
- **列表**：行过滤；done 折叠计数=命中数；分组在过滤后的集合上做（分组不参与匹配）。
- **统计块**：`需要你`、`完成度` 保持**全项目口径**，不随规则变化；底部标注“筛选中”避免误读。理由：统计回答“项目健康”，过滤回答“当前看什么”。
- 空态：无命中时给“清除全部规则”动作；项目本身无任务时仍给建任务提示。

---

## 9. 不做的规则与理由

| 规则 | 不做理由 |
|---|---|
| 负责人/assignee | Web 端无稳定“我”的身份；owner 与状态高度相关，收益低 |
| 验收进度/证据数/证据类型 | 卡片只带计数；语义更适合抽屉，做成过滤会诱导“卡验收” |
| 时间/陈旧（N 天未更新） | 依赖时钟与轮询，测试不稳定；v1 不做 |
| 优先级档位/tier | 决策文档明确否决阈值配色；只保留显式 P 上限 |
| 阻塞原因 code | blocked 状态 + 抽屉已足够；避免状态维度的子级重复 |
| 任意字段/正则/表达式 | 组合爆炸、性能与 UI 成本；固定词汇足够 |
| 规则排序/嵌套 OR 组 | AND 可交换；嵌套组会让“正交”与摘要复杂化 |
| 服务端保存/共享 | 需要 host/契约改动，超出本计划边界 |

---

## 10. 验收标准

1. 规则模型：6 维、跨维 AND、维内 OR、全状态归零、互斥模式、上限校验；纯函数单测覆盖。
2. 匹配一致性：同一 fixture 下，看板列 + 托盘 + 列表的命中 id 集合完全相等；计数一致。
3. 持久化：刷新/重启页面后 draft 保持；项目 A/B 的 draft 与方案互不串写。
4. 迁移：v0 各字段正确映射；旧键保留；v2 损坏/未来版本回退且首次修改前不覆盖。
5. 方案：另存/更新/重命名/删除/应用/未保存标记/30 个上限/重名校验全部可用；应用方案不改方案本身。
6. 回退：删除 v2 键或回退代码后，旧客户端仍能读 v0；文档给出可复现步骤。
7. UI：头部在 900/1440 不溢出；抽屉 Esc/焦点/aria 符合规范；窄屏可用。
8. 门禁：`test:ci`、`test:host`、`audit:check`、`check:architecture`、`contrast`、`git diff --check` 全绿；preview 截图入库；人工按清单点检。

---

## 11. 分阶段计划

### S1 · 规则内核与存储（纯逻辑，先不换 UI）

- t1 `filter-rules.js`：schema、`normalizeRules`、`matchesRules`、`describeRules`、`rulesEqual`、`migrateV0`；单测。
- t2 `filter-store.js`：v2 per-project 读写、v0 迁移、viewPrefs 拆分、容量/损坏/配额处理；单测。
- 出口：旧 P7 UI 通过适配器映射到新规则，行为不变；所有旧测试仍绿。

### S2 · 同源生效

- t3 BoardPage/board/list 使用 Rules；适配器只保留一个版本；看板列/托盘/列表命中一致。
- t4 计数/空态/统计口径/注意力托盘收口；board/list 同规则截图。
- 出口：新维度（标签/优先级/指定计划）即使 UI 未暴露，也能通过 fixture 验证匹配。

### S3 · 管理 UI

- t5 筛选抽屉（5 节规则 + 实时生效 + 每节清除）。
- t6 方案管理（另存/更新/重命名/删除/应用/未保存态/项目隔离）。
- t7 头部布局收敛（搜索/筛选按钮/方案下拉/活动 chips/清除）+ 窄屏 + preview。
- 出口：交互由人工点检；纯逻辑（摘要、移除补丁、dirty、名称校验）单测覆盖。

### S4 · 收口

- t8 文档：`docs/FILTERS.md`（或 UI-REDESIGN 新章节）+ ARCHITECTURE 模块表 + CHANGELOG + 迁移/回退说明。
- t9 全量门禁、迁移演练（v0 注入 → 刷新 → 清除 v2 → 回退）、人工验收清单、截图基线。

依赖：t1→t2→t3→t4；t3→t5→t6→t7；t8/t9 最后。无 core/host 依赖，可与其它 UI 任务并行（但同文件需串行）。

---

## 12. 测试计划

- **纯函数（必做）**：normalize（非法/重复/上限/全状态/模式互斥）、match（每维正反例、AND/OR、默认 P100、归档计划、未知计划）、describe（顺序/文案/移除补丁）、migrate（v0 各字段/坏字段/坏 JSON/未来版本）、preset（重名/上限/dirty/apply/delete）、store（项目隔离/配额失败/损坏不覆盖）。
- **回归**：P7 的 `filterCards` 行为经适配器保持；client-smoke 既有断言不退；API/COMMANDS 冻结不变。
- **视觉**：preview 新增 `board-filtered-rules`、`list-filtered-rules`、`filters-panel`、`filters-preset`（亮/暗、1440/900）；人工对照。
- **人工**：新建/应用/更新/删除方案；刷新；项目切换；v0 迁移；损坏 localStorage；窄屏；键盘。
- 不做 AI 浏览器探针（遵循 `ui-testing-policy`）。

---

## 13. 风险与回退

| 风险 | 处理 |
|---|---|
| 多选 OR/AND 语义回归 | 纯函数矩阵测试 + 适配器回归 + 同 fixture 三视图集合比对 |
| 迁移丢旧过滤 | v0 只读保留；迁移逐字段降级；迁移前后对比测试 |
| 方案与草稿混淆 | 显式 dirty 标记、应用=复制、保存=显式覆盖；文案区分“方案/临时筛选” |
| 头部控件拥挤 | 内联 chips 收敛为活动摘要；面板化；900/1440/窄屏预览 |
| localStorage 配额/禁用 | 写失败不阻断；内存态继续；toast 说明 |
| 回退 | 代码回退到 P7 仍读 v0（未被修改）；v2 键可保留或手工删除；方案数据不迁移回 v0（文档说明） |

风险级别：**R2**（用户交互流程 + 本地偏好数据迁移；不触达 board/state/HTTP/权限）。验证按 R2：完整门禁 + preview + 隔离实例人工点检（人工，不由 worker 自验）。

---

## 14. 请重点复核的 3 个决策

1. **规则集就这 6 维**：文本、状态、人审、计划、标签、P 上限。特别是：标签只要 OR，不做“同时含多个”（AND）；优先级只做上限，不做区间/档位。
2. **方案是显式快照**：草稿自动保存；编辑不会自动改方案，必须“保存修改”。不做默认方案。若你更想要“改了就自动落方案”，这里要改。
3. **按项目隔离 + 看板/列表同源**：不做“看板一套、列表一套”，也不做跨项目方案共享。若你要“每个视图各自一套规则”，这里要改。

以上三点变了，存储 schema 与 UI 都会随之调整；其余细节可在实现中微调。
