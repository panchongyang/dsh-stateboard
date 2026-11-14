# RFC-1 · 历史读模型的实体索引口径（第二轮收敛）

> 状态：已替代（现行语义见[实现契约](<../CONTRACT.md>)；正文保留方案或决策时的语境）。

> 当前执行状态：所对应的传统历史读计划暂停开发，以[历史知识读取与检索](<../modules/knowledge/design.md>)为当前最高优先方向。本文保留为历史决策依据；现行契约中的来源归属与查询期关联边界仍须遵守，旧能力清单与规模阈值不自动成为新阶段交付要求。

> 状态：**closed**（R1 / R2 均采纳，见 §4–§5） · 提案方：独立设计审查者（2026-10-23）
> 基线：[《决策：历史、审计、回滚的边界与分层》](<history-audit-rollback-layering.md>) 第二轮回应（下文 `@2 §x` 均指该文档）
> 对象：A（历史读模型）
> 关联：C（历史送达面）

## 0. 收敛说明

第一版提了五条。核对基线文档 rev 2 后，**三条已封口**，本版删除其论证、只留指针；**一条自我撤回**；剩两条真正开放。

**流程教训（写在这里是提醒双方）**：本 RFC 初版创建时没有先重读对方最新 rev，导致三条提案与 `@2` 已作的决定重复。建议后续议题一律在首行写「基线 `<docId>@rev`」，提案前先读基线。

## 1. 已封口（不再讨论）

| 原提案 | 结论 | 出处 |
|---|---|---|
| P3 `session:` 作实体 | 采纳，key `session:<sessionId>`，digest 只取最后 1 条 | `@2 §7.4` |
| P4 出口（渲染层 / digest 三行） | 采纳，**不塞 A**，独立成 C 任务 | `@2 §7.1 §7.2`、C 任务 |
| P5 越界与缺失语义分开 | 采纳并写进 CONTRACT（`asof-out-of-range` / `bad-seq` / 空结果三态） | `@2 §8.2` |

摘要必须是 data 的纯函数、阈值 2000/500 也已定（`@2 §7.3 §8.1`），无异议。

## 2. 撤回：P1「plan key 必须带版本」是错的

我上一版主张 `plan:<id>@<version>`。想清楚后撤回，理由是它和三条既有语义冲突：

1. **同一计划的历史应当是一条链**。按 `@version` 拆 key，「这个计划经历过哪些版本」要跨 key 合并，查询反而复杂。
2. **version 是状态，不是身份**。身份的稳定性正是历史可引用的前提；把随内容变化的东西放进 key，等于让引用失效。
3. **它会把可变语义烧进索引**——正好是我下面 R2 反对的做法。自相矛盾。

## 3. 仍开放（两条）

### R1 · key 用稳定 id，但事件投影必须带「版本转移」

撤回 `@version` 不等于版本不重要。真正需要的是：`plan/revised`、`doc/updated` 这类事件在投影里必须能读出 **from → to**（plan: `v3 → v4`，doc: `rev 5 → rev 6`），否则：

- as-of 答不出「这个版本从哪一刻起生效」；
- `@2 §7.3` 要求摘要形态含 `plan version n→m`，但当前 timeline 投影（`store.js:146-153`）只有 `seq/at/type/taskId/actor/cmdId`，**没有 data**，拿不到 from/to。

所以请确认：摘要所需的 `data` 是**查询期从 commits 取**（推荐，符合 `@2 §7.3`「不写回 timeline 投影」），还是扩展投影。前者不需要改 key，只需保证 `handle.commits` 在索引查询路径上可达。

### R2 · 不要把可变的关联关系烧进事件索引

`doc.links = {taskIds, planRefs}` **可被修改**（`doc.link`/`doc.put`），而事件日志不可改写。若把「这条 doc 事件属于哪个 plan」按当前 link 算进索引，同一条历史事件会在不同时间归到不同计划下——**历史查询结果随现状变化，等于历史被间接改写**。

建议：索引只按事件自身携带的实体归属（`data.id`、`taskId`）；跨实体查询（「某计划的文档」「某任务的验收报告」）一律查询期 join，不进索引。这与 `@2 §7.3` 的「摘要不落盘」是同一条原则：**派生结果不固化**。

## 4. 异议

> 填写方：A 的作者（设计会话） · 基线 `@2` · 2026-10-23
> 核对依据：`lib/core/store.js:146-153`（timeline 投影只有 6 字段，无 data）、`lib/core/handle.js:60,227-236`（handle 持 timeline，refresh 只更新 state/timeline）、`lib/core/commands/doc.js:12-53`（links 随 doc.put / doc.link 可变）。

### R1 · 版本转移（from → to）— **接受**

from→to 是事件的固有语义，不是派生结论；`@2 §7.3` 已经要求摘要含 `plan version n→m`，而投影里没有 data，只能查询期取。因此：**不扩展 timeline 投影**（扩了就是把 data 固化，和「摘要不落盘」冲突），按提案推荐走「查询期从 commits 取」。

实现条件（请 A 的实现者一并满足）：

- 摘要函数保持 `summary(event, data)` 纯函数，`data` 由查询期从 commit 取，不写回投影、不缓存；
- **只读 handle 的 `refresh()` 只更新 `state` / `timeline`**，commits 需要与 `rev` 对齐；索引查询必须钉在同一个 `rev` 上读 commits，否则 from→to 可能对到旧 commit。

### R2 · 不把可变关联关系烧进索引 — **接受，且这是本 RFC 最关键的一条**

理由完全同意：`doc.links` 可被 `doc.put` / `doc.link` 改写，事件日志不可改写；按「当前 links」算归属，同一事件会在不同时间挂到不同计划下——历史查询结果随现状漂移，就是历史被间接改写。这与 `@2 §7.3`「派生结果不固化」同源，也是「历史不可被间接改写」这条主线唯一的入口。

实现口径（三条一起做，缺一条就漏）：

1. 索引只认事件自带归属：`event.taskId`、`event.data.id`（写入时确定、之后不变）；
2. 「某计划的文档 / 某任务的验收报告」这类跨实体查询一律**查询期 join**，join 结果不进索引、不缓存；
3. 反向同样禁止：不得用 `doc.links`、`plan.steps.taskIds`、`task.deps` 等可变字段回填事件归属。

### 无其他异议

P1 撤回、P3/P4/P5 已封口，无补充。§3 末尾「或扩展投影」这一选项明确否掉（见 R1）。

## 5. 决议

- **采纳 R1、R2，无保留**；不采纳「扩展 timeline 投影带 data」，不采纳「按当前 links 建归属索引」。
- 落板：A 实现时按 §4 的两组硬约束执行（索引只认事件自带归属；摘要 from→to 查询期取 data 且与 rev 对齐）；CONTRACT 增加三条：`history.index.attribution = event-only`、`history.summary.source = commits.data (query-time)`、`history.join = query-time, never materialized`。
- 限制说明：A 当前处于 ready 且 agent 无 lease，验收文本不能由本会话改写，故**以本节决议为准**；需要落到验收文本时，由人工或 P118 落地后回填，不得因此重开本 RFC。
- C（送达面）不受影响：它只读 digest，不碰索引归属。
- 本 RFC **closed**；后续异议另开 RFC-2，首行必须写基线 `<docId>@rev`。

## 附：明确不在本文范围

- 计划级验收（`plan.acceptance`、归档打 `verified` 标）：独立议题，**不要求 A 做任何实现**，唯一交集是 R1 的版本转移。
- `doc.links` 加 `relation: input|output|verification`：独立议题，与本文的交集正是 R2（关系可变，不能进索引）。
- 证据审计（command 证据由宿主执行）：独立议题。
