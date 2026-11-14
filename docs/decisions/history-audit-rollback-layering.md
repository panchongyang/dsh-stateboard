# 决策：历史、审计、回滚的边界与分层

> 状态：已替代（现行语义见[实现契约](<../CONTRACT.md>)；正文保留方案或决策时的语境）。

> 当前执行状态：本文的传统历史读计划暂停开发。项目所有者确定[历史知识读取与检索](<../modules/knowledge/design.md>)为当前最高优先方向，可以取代传统历史读；未覆盖的旧能力仍暂停。以下保留原决策背景，不作为新阶段的前置或强制范围。

> 起因：阶段3「文档历史 / diff / 回滚」被指出不是文档单一问题。核对后成立——所有实体的变更都落在同一份事件日志里，只给文档做 revisions 会复制一套查询与恢复逻辑，也让审计无法复用。

## 1. 现状（读代码 + 磁盘实测）

- 每次写操作 = 一个 commit（commits.jsonl，本项目当前 102 条）：v/seq/prev/hash/at/actor{kind,sessionId,agentId,callId,via}/cmdId/baseRev/events[]；hash 链由 store.validateCommits 校验，断链直接 503。
- 状态 = 对 commits 的 replay 结果；snapshot.json 只是启动加速，不是第二事实源。
- 时间线投影只有 seq/at/type/taskId/actor/cmdId（lib/core/store.js:48-55）：doc/plan 事件没有实体 id，时间线上无法按文档或计划定位。
- eventsView 只支持 after+limit（lib/core/views.js:142-147）：只能从旧到新取尾部，没有实体过滤、时间窗、as-of。
- 文档正文按 sha256 存 blob，旧版本没删也没有 GC；doc/updated 事件里带 doc 对象（含 hash），所以旧正文随时可读。
- 计划只保留当前版本 + supersedes 链，旧版本只存在于事件里。
- 没有 restore / rollback 命令；任务状态只有 human override 一条路。

## 2. 结论：拆三层，不再给单个实体做特例

审计（独立议题）：命令执行留痕、verify 复核、证据反向对照。回答「这条证据真的执行过吗、谁验的」。
历史（A）：实体级事件检索 + as-of 只读投影。回答「上周三这个任务/文档/计划是什么样」。
回滚（B）：补偿写入。回答「怎么退回去」，永远追加事件、不改历史。

文档历史只是「历史 + 回滚」的第一个 UI 消费方，不再单独立项。

## 3. 方案要点

A 读模型：
- entity key：task: / doc: / plan: / evidence: / intent:；新事件直接带，旧事件从 data.id 反推（不能只认新字段）。
- GET /projects/:id/history?entity=&fromSeq=&limit=；返回 seq/at/type/actor/cmdId/一行摘要。
- GET 同路径 ?asOf=seq：replay commits[0..seq] 的只读快照（本项目 102 条，O(n) 可接受；后续再加 snapshot 缓存）。

B 补偿回滚：
- doc.restore：用旧 rev 的正文走 doc.put，事件带 restoredFrom={rev,hash,seq}。
- 计划恢复：以旧版本 steps 走 plan.revise（版本 +1，保留 supersedes 链）。
- 任务状态恢复：只允许 human + reason（沿用 override 边界）；agent 只能读历史，不能回写状态。
- UI：文档页历史列表 / diff / 恢复，消费 A 的接口，不自建第二套后端。

## 4. 风险与取舍

- commits 无归档、blob 无 GC：as-of 是 O(n)，长期项目要在阈值后加 snapshot / 分段；blob 不 GC 是时间旅行的前提，但必须写明保留策略。
- as-of 只读，不能「切回去继续写」；写必须走补偿事件，保持 hash 链是唯一事实源。
- 恢复文档会产生新 rev → 已有的 doc@rev 证据变成历史证据；health 的 drift 检查要把它当预期，而不是损坏。
- 事件里的历史数据可能引用已不存在的实体（例如被 orphan 的计划），查询要容忍缺失，不能 500。

## 5. 落板

- A 历史读模型 P265（ready）
- B 补偿回滚 P285（依赖 A）
- 原阶段3 已改写成本评估任务，不再单独存在
- 审计保持独立，不并入

## 6. 为什么不直接给文档加一张 revisions 表

- 会变成两套历史（事件日志 + revisions 表），漂移时以谁为准？
- 任务/计划/证据同样需要历史，各自加表会让审计无从复用。
- 回滚语义会分叉：文档能回滚、任务不能，权限边界不一致。


## 7. 第二轮评审回应（2026-10-23）：四条全采纳

### 7.1 送达面不是加分项，是 A 的结果

核对：`host/prompt.js` 的 digest 是**每次 system prompt 组装都重取**（不是会话启动一次），所以“主动送达”成本极低；而 `lib/core/digest.js` 里既没有 checkpoint 也没有 verified 记录。

digest 新增三行，位置固定在 `NEXT READY` 与 `RULES` 之间：

- `LAST CHECKPOINT <seq> <at> <note 截 160>`
- `LAST VERIFIED <seq> <taskId> "<title>" ×3`（取最近 `task/verified`）
- `FOCUS PLAN <planId> "<title>" v<n> <pct>%`

约束不变：全部 `sanitizeField` 单行化 + 截断；`at` 取事件里记录的 at（replay 值），不读系统时钟；同状态同 session 必须字节相同（`test/digest.test.mjs` 已断言）。

### 7.2 渲染层丢字段：事实成立

复核 `lib/core/store.js:146-153`：timeline 投影确有 `actor` 与 `cmdId`；`lib/host/tools.js:209-211` 的 `eventsSummary` 只打 `seq/at/type/taskId`；`taskSummary`（145-170）完全不打印 `timeline`；`lib/core/views.js:102` 已把 timeline 放回 taskView。结论：数据层完整，读渲染层丢弃。

决策：这部分**不塞进 A**（A 已 ready，且它只解决检索），单开 C 先上——`eventsSummary` 补 `actor.kind` + session 短码 + `cmdId` 尾 6，`taskSummary` 补 timeline 末 5 行。若 host 拆分（P111）先落，按拆分后的文件落。

### 7.3 摘要必须是 data 的纯函数

采纳，并写成硬约束：摘要只允许可机械核对的形态——`state from→to`、`acceptance m/n`、`owner/lease` 变化、`doc rev n→m`、`plan version n→m`、`evidence count`。没有可比对字段时只输出 `type` + 1–2 个键名，**禁止自然语言概括**。

实现约束：`summary(event, data)` 纯函数，`data` 从 commit 取，不写回 timeline 投影、不落盘；这样摘要永远可由日志重算，不会变成第三份事实。

### 7.4 `session:` 是实体

采纳。key = `session:<sessionId>`；checkpoint 事件本身已带 `note/nextActions`（`lib/core/commands/session.js:67`）。digest 只取最后 1 条，note 截 160；`nextActions` 不进 digest（避免膨胀），但保留在事件里可按 session 查。

## 8. 拍板（写进 CONTRACT）

### 8.1 规模阈值

- `commits > 2000` 或索引常驻 `> 32MB`（先到者）时，改走分段：每 500 commits 一个只读段文件，as-of 从最近段的起点 replay ≤500 条。
- 阈值与段大小写进 CONTRACT（`history: maxInMemoryCommits=2000, segmentSize=500`），不留“后续再加”。

### 8.2 越界与缺失语义（不得混用）

| 情形 | 结果 |
| --- | --- |
| 实体不存在 / 该时刻实体尚未存在 | `200` + 空结果 |
| `asOf` 非整数、`<1`、`>head` | `4xx`，code `asof-out-of-range` |
| `fromSeq` 非法或越界 | `4xx`，code `bad-seq` |
| 事件引用已 orphan 的实体 | `200`，事件照常返回，不 500 |

## 9. 落板更新

- A 保持原范围（索引 / 查询 / as-of / tool 通道）。
- 新增 C（送达面三行 + 渲染层），P240、无依赖、先于 A。
- B 仍依赖 A。
