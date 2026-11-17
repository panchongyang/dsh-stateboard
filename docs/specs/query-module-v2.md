# 规格：查询模块 v2（独立模块 · WHERE 表达式 · 与历史读模型分层）

> 状态：待实施（本篇为方案/规格，不构成能力已交付声明）。

> 状态：**权威规格**；计划已发布，实现未开始。
> 取代：[过滤规则 v1](<filter-rules-v1.md>)（6 维结构化）与 [过滤规则 v1.1 增补](<filter-rules-v1-1-addendum.md>)（done 时间窗 + 多计划）。两篇保留为历史决策与 legacy 编译器依据，不再作为实现口径。
> 先读：本规格文末「文档关系」；任务在内部计划（本机看板记录，未随仓库分发）。
> 硬边界：模块在浏览器半 `src/client/query/**`；**不改** `lib/core`、`lib/host`、`lib/shared`、CONTRACT、HTTP 端点、board 读模型；不新增运行时依赖；不做浏览器自动化探针。

## 0. 一句话

查询 = **对行集的 WHERE 谓词**。它独立成模块、schema-driven、表达式驱动；board/list 只是宿主与结果视图；历史读模型（as-of / 事件检索）是**另一个数据源**，query 不重放、不读取、不复制它。

## 1. 目标 / 非目标

### 目标

1. 独立查询模块：`src/client/query/**`，纯逻辑、无 React/DOM，显式 public API，可被 board/list 之外的宿主复用。
2. WHERE 表达式：SQL 风格的安全子集，能表达任意布尔组合；不再为每种筛选加 schema 字段。
3. 查询入口重构：现有搜索框 + 状态/人审/计划 chips 收敛为一个 QueryBar/QueryDrawer + 方案库。
4. 看板/列表同源：同一 `applied` 查询同时过滤列、注意力托盘、列表；计数一致。
5. 持久化：按项目保存草稿、最后有效查询、命名方案；刷新/重启恢复。
6. 分层：`QuerySource` 接口隔离“当前 board”与未来“历史 as-of”；query 不碰 commits/timeline/`/history`。
7. 可验证：parser/typecheck/eval/printer/store 纯函数单测；对旧结构化 matcher 做属性等价；边界/API 冻结；在隔离宿主人工验收。

### 非目标

- SELECT / JOIN / 聚合 / ORDER BY / GROUP BY / LIMIT；这些分别属于视图、分组或未来的查询结果页。
- 服务端查询、把表达式发给 host、跨设备同步、方案导入导出。
- 在表达式里做 as-of / 时间旅行；as-of 是数据源参数。
- 历史事件检索并入同一个 schema；事件查询是第二个 schema，不混合实体。
- 可视化规则构建器（v1 先表达式 + 示例片段；构建器后续编译到同一 AST）。
- 任意字段/正则/函数；固定字段表 + 白名单函数。
- 修改历史读模型 A / 补偿回滚 B；query 只读。

## 2. 设计原则（换会话先读这 8 条）

1. **Predicate, not source**：query 只接收 `rows + ctx`，编译 `predicate(row, ctx)`；不取数、不缓存行。
2. **Schema-driven**：engine 由字段/函数表驱动；task 是第一个 schema，未来可接文档/事件 schema，但一次只查一种实体。
3. **WHERE-only**：只回答“这行是否命中”；视图/排序/分组是宿主职责。
4. **No history replay**：不读 commits、不 replay、不读 timeline、不调 `/history`；as-of 是 QuerySource，不是语法。
5. **Pure & safe**：无 `eval`/`Function`/任意属性访问；字段/函数白名单；长度/深度/节点数硬上限。
6. **One entry, one applied query**：看板与列表共用同一 `applied`；非法草稿不清空结果。
7. **View settings separate**：分组/密度/视图切换是 `viewPrefs`，不参与匹配、不影响命中集合。
8. **Legacy is compiler/oracle**：v0/v2 结构化规则通过 `queryFromLegacyRules` 迁移，并作为属性等价测试的 oracle；不进入 UI。

## 3. 模块边界

### 3.1 目录

```text
src/client/query/
  index.js          # 唯一 public API
  lexer.js
  parser.js         # tokens → AST
  ast.js            # 节点/遍历/深度与节点数
  printer.js        # AST → 规范化文本
  typecheck.js
  evaluate.js       # AST → (row, ctx) => boolean
  errors.js         # code / position / hint
  limits.js
  task-schema.js    # task 字段/虚拟字段/search haystack
  task-legacy.js    # rulesToQuery + 旧 matcher（迁移/等价 oracle）
  store.js          # projectBoard.query.v1 适配层（唯一碰 localStorage）
  examples.js
```

### 3.2 Public API

```js
createEngine(schema) -> {
  parse(text)     -> { ok, ast, errors }
  validate(text)  -> { ok, ast, canonical, errors }
  compile(ast)    -> (row, ctx) => boolean
  format(ast)     -> string
}

export const taskQuery = createEngine(taskSchema);
export function queryFromLegacyRules(rules) -> string;
export { TASK_SCHEMA, LIMITS, ERROR_CODES };
```

- `validate` 是 UI/存储的唯一校验入口；`canonical` 用于方案相等（dirty）与持久化。
- `compile` 不接收 context；predicate 的第二参数是 `ctx`。
- `errors` 是普通对象 `{ code, message, position: {line, column, offset}, hint }`。
- API 冻结测试：导出名/函数形状不得漂移。

### 3.3 依赖边界（硬）

- `query/**` **禁止** import `views/**`、`hooks.js`、`transport.js`、`state.js`、`index.js`、`lib/core/**`、`lib/host/**`。
- 允许 import：自身文件；无依赖的 `src/client/task-model.js`（从 selectors 抽出的 `isGate/planMeta/默认优先级`）。
- 边界测试：扫描 import 路径；架构文档登记模块与方向。
- `query/store.js` 是唯一碰 `localStorage` 的文件；engine 文件不得引用浏览器全局。

## 4. 查询语言

### 4.1 示例

```sql
(state != 'done' OR (state = 'done' AND updatedAt >= hoursAgo(24)))
AND planId IN ('pln_n1', 'pln_n2', 'pln_n3')
```

- `updatedAt` 是**当前读模型字段**（最近更新时间）；done 是终态，通常等于完成时刻，但不是历史审计事实。
- 若要精确 verified 时间，见 §5.4；v1 不为此读历史。

### 4.2 语法（EBNF）

```ebnf
query      := or_expr EOF
or_expr    := and_expr (OR and_expr)*
and_expr   := not_expr (AND not_expr)*
not_expr   := NOT not_expr | primary
primary    := '(' or_expr ')'
            | comparison
            | boolean_expr          // 裸布尔字段/函数
comparison := operand comp_op operand
            | operand [NOT] IN '(' literal (',' literal)* ')'
            | operand [NOT] CONTAINS operand
            | operand [NOT] STARTS WITH operand
            | operand IS [NOT] NULL
operand    := field | literal | function
function   := IDENT '(' [arg (',' arg)*] ')'
literal    := string | number | TRUE | FALSE | NULL
string     := "'" (any-char | "''")* "'"
```

- 关键字大小写不敏感；字段/函数名小写；字符串单引号，`''` 转义。
- 无注释、无分号、无 `LIKE`、无算术、无 `BETWEEN`。

### 4.3 字段（只来自 `cardOf` + ctx）

| 类型 | 字段 |
|---|---|
| string | `id` `title` `state` `planId` `stepId` `planTitle` `stepTitle` `owner` `assignee` `createdBy` `blockedCode` `blockedNote` |
| number | `priority` `acceptanceMet` `acceptanceTotal` `evidenceCount` |
| boolean | `gate`（虚拟，等价 isGate）`planned`（虚拟） |
| array | `labels`（string[]） |
| timestamp | `updatedAt` |

- `planId/stepId/planTitle/stepTitle/owner/assignee/createdBy/blockedCode/blockedNote` 可空；空值用 `IS NULL`。
- `gate` 同时认 `requiresHumanReview===true` 与 `labels` 含 `gate:human`；表达式不得自写这两个判断。
- `planTitle/stepTitle` 来自 `ctx.plans`（当前计划目录）；as-of source 必须提供 as-of 目录。
- **禁止**历史派生字段：`everBlocked` `blockedAt` `reviewedAt` `stateHistory` `lastTransitionAt` 等；要加字段必须先成为 `cardOf` 字段或 source 显式提供，并更新本表/契约测试。

### 4.4 函数

| 函数 | 语义 |
|---|---|
| `now()` | 当前匹配时刻（来自 `ctx.now`，引擎不读系统时钟） |
| `hoursAgo(n)` / `daysAgo(n)` | `ctx.now - n*3600_000` / `n*86400_000`；n 整数 0–8760 |
| `date('ISO-8601')` | 解析为 timestamp；非法 → 运行时错误/类型错误 |
| `search('q')` | 大小写不敏感、空白分词、词间 AND；haystack = title/id/labels/owner/planId/blocked/planTitle/stepTitle |
| `lower(s)` / `upper(s)` | 字符串大小写转换 |

- `search` 不搜描述/验收/事件文本；事件搜索属于历史 schema。
- 时间函数只返回 timestamp；比较必须 timestamp vs timestamp。

### 4.5 语义

- **优先级**：comparison > NOT > AND > OR；括号显式优先。建议示例总带外层括号。
- **空值**：两值逻辑（JQL 风格，不是 SQL 三值）。任何与 `null` 的比较为 false；`IS NULL`/`IS NOT NULL` 显式；`NOT` 正常取反。与 `null` 做 `IN` 为 false。
- **大小写**：`=`/`!=`/`IN` 精确大小写（state/label/id）；`CONTAINS`/`STARTS WITH`/`search` 大小写不敏感。
- **数组**：`labels CONTAINS 'ui'`；`labels IS EMPTY` 不提供，用 `labels IS NULL` 不成立（labels 恒为数组）→ 用 `labels CONTAINS` 或 `NOT (labels CONTAINS 'x')`；v1 不提供长度/空数组算子。
- **布尔**：裸 `gate` / `planned` 等价 `gate = true`；支持 `NOT gate`。
- **时间戳**：`updatedAt >= date('2026-10-01')`；`updatedAt >= hoursAgo(24)`。
- **错误**：语法/类型错误不得让板子 500；UI 保留上一有效查询。

### 4.6 上限与错误码

- 表达式 ≤ 2000 字符；tokens ≤ 500；AST 节点 ≤ 500；嵌套深度 ≤ 20；`IN` 项 ≤ 100；字符串字面量 ≤ 200。
- 错误码：`syntax` `unexpected-token` `expected-eof` `unknown-field` `unknown-function` `type-mismatch` `limit-exceeded` `invalid-literal`。
- 错误对象带位置；未知字段给最近候选（编辑距离）。

## 5. QuerySource 与历史读模型

### 5.1 分层

```text
当前 board 读模型（cardOf + plan catalog） ─┐
历史读模型 A（as-of 快照 + /history）      ─┴─> QuerySource { id, label, rows, ctx } ─> predicate
```

- `ctx = { now, plans }` 由 source 提供。
- 当前 source：`now = Date.now()`（每轮刷新取一次），`plans = 当前计划目录`。
- 历史 source（未来）：`rows = as-of 卡片`，`now = asOf 时刻`，`plans = as-of 计划目录`；同一表达式下 `hoursAgo(24)` 表示 as-of 前 24h。
- query 对 `id/label` 无感；UI 负责显示“当前 / as-of”，避免误读。

### 5.2 硬规则

1. query 不读 commits、不 replay、不读 `taskView.timeline`、不调 `/history`。
2. 表达式里没有 as-of / 时间旅行语法；as-of 只能是 source 参数。
3. query store 只存表达式/方案，不存行、seq、快照；不做查询结果缓存（predicate 缓存可以）。
4. `search` haystack 不含事件/时间线文本。
5. 不在一个表达式里 join 卡片与事件；事件查询是第二个 schema，不混合。
6. A 的 as-of 要复用 query，必须输出 **card 形状 + as-of 计划目录**（或由 host 侧 adapter 转换）；query 不接受原始 commits。
7. query 只读：不 restore/rollback；补偿回滚是 B 任务。

### 5.3 历史读模型现状

- A 任务状态 **ready，未实现**；query v2 不依赖它、不假装支持 as-of。
- A 的 `/history` 是“事件检索/as-of”，与 query 的“卡片谓词”是两种能力；未来 UI 可以并列，但不能把事件字段塞进 task schema。
- 集成切口：定义 `QuerySource` + 用 fake `historySource` 测试同一表达式/ctx，不改引擎。

### 5.4 `updatedAt` 与 `verifiedAt`

- v1 表达式用 `updatedAt`；语义是“最近更新时间”，不是审计级完成时间。
- 若要精确“verified 24h 内”，两条路：
  1. 给 `cardOf` 增加只读 `verifiedAt`（当前读模型字段增补；R2 小改动；不是历史查询），`doneAt` 才能 = `verifiedAt || updatedAt`；
  2. 交给 A/审计的历史查询（不进入当前卡片 predicate）。
- **禁止** query 为这个字段 replay commits 或读 timeline。
- 该决策未定前，字段名不得写 `doneAt`；示例统一用 `updatedAt`。

## 6. 持久化与迁移

### 6.1 新键

`localStorage['projectBoard.query.v1']`

```json
{
  "version": 1,
  "projects": {
    "prj_x": {
      "draft": "编辑器原文（可为非法）",
      "applied": "最后一次 validate 通过的 canonical 表达式",
      "presets": [
        { "id": "qpr_...", "name": "我的待办", "projectId": "prj_x",
          "expr": "canonical", "createdAt": "ISO", "updatedAt": "ISO" }
      ],
      "activePresetId": null,
      "updatedAt": "ISO"
    }
  },
  "migratedAt": "ISO"
}
```

- `draft` 可为非法；`applied` 永远合法（或空串=不过滤）。
- 加载：draft 合法 → 应用；非法 → 应用已存 `applied`，显示错误，不改板子。
- 方案只存合法 canonical 表达式；应用=复制到 draft/applied；dirty 用 canonical 比较。
- 上限：每项目方案 ≤30；名称 1–40 字、项目内不重名；expr ≤2000；项目隔离。
- localStorage 写失败：内存态继续，toast 提示“未能保存”。
- 多标签页最后写入者胜；v1 不监听 storage 事件。

### 6.2 迁移

| 来源 | 处理 |
|---|---|
| v0 `projectBoard.filters` | 先按 v1/v1.1 结构化规则解析，再 `queryFromLegacyRules` → query 文本 |
| v2 `projectBoard.filters.v2` | 同上；v1.x 结构化规则 → 表达式 |
| 两个旧键 | **只读保留**，不删除；回退到旧代码仍可读 |
| 无旧键 | 空查询（不过滤） |

- 迁移按项目首次访问执行；写 `migratedAt`。
- 损坏/未来版本：回退默认/空查询，不覆盖旧值，直到首次用户修改。
- 回退：新代码坏 → 回旧代码读 v2/v0；新方案不可见（文档写明）。

## 7. 查询入口重构（替换现有筛选）

### 7.1 现状 → 目标

| 现在 | 之后 |
|---|---|
| `views/chrome.js` 搜索框 + 状态/人审/计划 chips | `views/query/query-bar.js` |
| P7 内联过滤编辑 | `views/query/query-drawer.js` |
| `views/board-page.js` 四组 filter state | `hooks/use-task-query.js` 的 `{draft, applied, error, presets}` |
| `filters.js` `filterCards/hasActiveFilters/isGate` | query engine + `task-model.js` |
| `storage.js` filters | `query/store.js` |
| `views/board.js` 各处 `filterCards` | `query.matches(card)` |
| `index.js` `__test.filterCards` | `__test.taskQuery` + API 冻结 |

保留：`planMeta`、分组、密度、视图切换、计数/空态、`/` 与 Ctrl/⌘+K。
删除：`filters.js`、`storage.js` 的 filters、chrome 的旧 chips、board 的 filterCards 调用（S5 一次替换）。

### 7.2 行为

- 输入实时 validate（debounce 150ms）；合法→应用+持久化；非法→保留上一次 applied，显示错误/“查询未生效”，不清空板子。
- `命中 n/N` 常驻；空态给“清空查询”；错误行内显示位置。
- 方案下拉：临时查询 / 方案名（dirty ●） / 管理…；抽屉内保存修改/另存为/重命名/删除/应用。
- 示例/片段：活跃 + 24h、指定计划、需人审、无标签、P≤100、search。
- `/`、Ctrl/⌘+K 聚焦查询；Esc 失焦/清空按现有约定。
- v1 固定 `current` source；UI 标注“当前数据”，不做 as-of 切换。

## 8. 测试

- **parser**：优先级、括号、NOT、IN、字符串转义、尾随 token、错误位置。
- **typecheck**：未知字段/函数、类型不匹配、可空、根 bool、数组/文本/时间算子。
- **eval**：真值表、空值两值、大小写、数组、时间函数（注入 now）、search、短路。
- **等价性属性测试**：随机旧结构化规则 × 随机卡片，legacy matcher === compiled predicate。
- **边界**：`query/**` import 扫描；public API 冻结；schema 字段必须可指到 `cardOf` 或 ctx。
- **历史切口**：fake `historySource`（固定 rows/now/plans）跑同一表达式；断言 query 不发起 `/history`、不读 timeline。
- **store/migration**：项目隔离、损坏、未来版本、配额、v0/v2→query、回退。
- **上限/fuzz**：超长、深嵌套、100 项 IN，不卡死/不爆栈。
- **性能**：10k 卡片 × 代表查询；编译缓存命中。
- **UI**：preview 出图 + 人工；不做 AI 浏览器探针。

## 9. 推进顺序

1. S1 模块契约/骨架/QuerySource/边界测试/task-model。
2. S2 lexer/parser/printer/typecheck。
3. S3 evaluate/task schema/search/time + 属性等价。
4. S4 store/迁移/回退。
5. S5 入口重构（QueryBar/Drawer + board/list/attention 切换）。
6. S6 文档/门禁/迁移演练/人工验收。

任务在计划中；**S5 之前不改用户可见入口**；每个任务独立可回滚；一次一个任务。

门禁命令：`npm run test:ci`、`npm run test:host`、`npm run audit:check`、`npm run check:architecture`、`node scripts/contrast-check.mjs`、`git diff --check`。

## 10. 风险 / 开放决策

- 风险：R2（交互 + 本地偏好迁移；无 board/state/HTTP/权限）。parser/类型/空值语义复杂；入口替换可见；历史字段 creep；迁移/回退。
- 缓解：WHERE-only、静态类型、上限、属性等价、边界测试、S5 前不可见、旧键保留。
- 开放决策：
  1. `verifiedAt` 是否进 `cardOf`（R2 小改动）以支持精确“verified 24h”；v1 默认 `updatedAt` 近似。
  2. 可视化构建器（后续，编译到同一 AST）。
  3. as-of source 的 UI（等 A 落地；同一表达式复用）。
  4. 内部模块 vs 独立 npm 包（当前选内部模块；零依赖单插件）。
  5. 历史事件查询是否复用 engine 的第二个 schema（建议复用，不混实体）。

## 11. 代码地图（新会话）

新建：`src/client/query/**`、`src/client/views/query/query-bar.js`、`query-drawer.js`、`src/client/hooks/use-task-query.js`、`src/client/task-model.js`、`test/unit/client/query/**`。
改动：`board-page.js`、`board.js`、`chrome.js`、`storage.js`、`index.js`、`selectors.js`、`styles.css`、`test/client/unit/`、`docs/specs/query-module-v2.md`、`docs/ARCHITECTURE.md`、`CHANGELOG.md`。
删除：`src/client/filters.js`（S5，迁移/等价测试完成后）。

## 12. 文档关系

- 本规格：**唯一实现口径**。
- [过滤规则 v1](<filter-rules-v1.md>)：历史决策；说明固定 6 维为什么被 v2 取代；legacy 编译器参考。
- [过滤规则 v1.1 增补](<filter-rules-v1-1-addendum.md>)：done 时间窗/多计划的分析；其语义已被表达式覆盖，保留为迁移参考。
- 一页交接：内部记录（未随仓库分发；包含原则/边界/第一任务/命令）。
- 计划：内部计划（任务、依赖、验收）。
- 历史 A/B 任务：内部编号；本规格只定义接口要求，不改它们。
