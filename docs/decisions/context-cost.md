# 决策：ProjectBoard 自身的上下文成本

> 状态：已替代（现行语义见[实现契约](<../CONTRACT.md>)；正文保留方案或决策时的语境）。

> 来源：跨项目会话输出的内部核查报告（本机留证，不随仓库分发；不含原始对话与凭据）。
> 本文只抽取**与 `dsh-project-board` 有关**的条款，并给出处置（采纳 / 部分采纳 / 不采纳 / 转交）。
> 引用的是报告的单次输出测量；跨会话总量不采用。裁决日期：2026-10-26。

## 0. 结论先说

- **单位调用最脏的一档里有我们两个**：`project_board` 重复率 **50%**，`project_task` **39%**；`project_board` 一次 `view=brief` 里 **439/630 字符（70%）是规则块**。
- 根因不是"看板状态大"，是**同一段固定文本被重复投递两次**：`RULES` 既在系统提示的 `project:brief` section 里，又随 `view=brief` 的工具结果再发一遍；`view=board` 则是每次整板重印。
- 处置：三条改动（brief 不再重复 RULES / 同参同文短路 / 作用域内的恒定字段折叠），**全部落在 host 层**，core 的"逐字节确定"不变量不动。工时小、收益可测、风险低。

## 1. 范围与口径

**在范围内**：`lib/core/digest.js`、`lib/host/prompt.js`、`lib/host/tools/board.js`、`lib/host/tools/task.js`、`lib/host/tools/shared.js`（`boardSummary` / `taskSummary`），以及 `CONTRACT.md §2.10 / §3.4`。

**明确不在范围内**（报告里占大头，但不属于本项目，写在这里防止后续被误派）：

| 工具 | 归属 | 报告结论 |
|---|---|---|
| `edit` / `write` / `read` | `dsh-tool-fs` | `edit` 整条结果就是一句确认句（重复率高） |
| `ops_*` | `dsh-ops` | 每条结果尾巴固定 119 字符 `sandbox` 对象 |
| `ops_bash` / `pwsh` / `run_code` | `dsh-ops` / `dsh-tool-pwsh` / `dsh-ptc-runtime-node` | 内容级重复（同栈、同报错重跑） |
| `send_message` / `skill` / `web_fetch` | 各自插件 | 固定信封 / 同 skill 重载 / "不可信内容"提示 75 字符 |

**口径提醒**：跨会话模板重复不等于单会话上下文预算的实际占比；本文只采用单次输出的字符测量，不引用跨会话总量。

## 2. 与本项目相关的发现

### F1 `RULES` 被投递两次（系统提示 + `view=brief`）【报告实测】

- 证据：报告 §6 第 2 条 —— 只读调用 `project_board view=brief` 返回 630 字符，其中 `RULES` 段 439 字符，与同会话开头那次（同 rev）逐字一致。
- 代码对位：规则文本只在 `lib/core/digest.js:87-92` 生成一次（4 行，共 439 字符），由两条路径送出 —— `lib/host/prompt.js:17`（systemPrompt section `project:brief`）与 `lib/host/tools/board.js:44-45`（`view=brief` 复用同一份 digest）。
- 而 `project_board` 的工具描述（`lib/host/tools/board.js:11`）明确要求 **"use view=brief at session start and after compaction"** —— 即我们自己把 agent 引向了那次重复调用。压缩后系统提示的 section 仍在（`text` 是动态函数，每请求重建），所以"压缩后再读一次 brief"拿到的就是系统提示里已有的那段文本。
- 量化：单次调用省掉规则块后 630 → 191 字符（-70%）。

### F2 `view=board` 整板重印，无短路【报告实测】

- 报告 §4 B：`project_board {"view":"board"}` 单次 4,584 字符，每次整板重写。
- 代码对位：`boardSummary()`（`lib/host/tools/shared.js:121-142`）每次全量拼装，无"上次已发过、内容没变"的判断；core 也没有增量视图。
- 注意：报告建议的"看板 `rev` 没变只回一行 `rev N unchanged since <seq>` / `view=board` 支持 `sinceRev`"我们**只能部分采纳**，理由见 §5.2。

### F3 `project_task` 每行都带恒定字段【报告实测】

- 报告 §3：`project_task` 的重复主要来自恒定字段 `humanReview:` / `allowed:`，而不是重复调用（同参重写极少）。
- 代码对位：`lib/host/tools/shared.js:164`（`humanReview: required before done` / `humanReview: off`）、`:167`（`allowed: a, b, c`）。
- 收益：`humanReview: off` 每次 16 字符。**小**，但改动是一行判断，零风险。

### F4 报告给的通用短路我们借不到

- 报告 §7 第 7 条建议在通用层做"同会话 / 同工具 / 同参数 / 结果哈希未变 → 回摘要"，并指出 `dsh-repeat-tool-reminder` 已经算出参数同一性。
- 那是**别的插件**的活。对我们的含义只有一条：**别指望通用层兜底**，本项目自己的高频只读视图要自己短。

### F5 禁止用"事后裁剪"补偿【报告结论，采纳为约束】

- 报告 §7 末尾：任何事后裁剪都会让裁剪点之后的 KV cache 失效；要省就在**写入时**省。
- 对我们是硬约束：`dsh-compaction-tool-result-pruner` 只对 >8192 字符的单条结果做头尾保留，对 `edit`（90 字符）、`project_task`（~700 字符）这类高频小结果**完全无效** —— 我们的两条路径正好都在它的盲区里。

## 3. 归因：为什么现有两道防线没挡住

1. **不是工具做错了事，是同一份正确文本被送了两遍**。`digest` 同时承担"系统提示"和"工具结果"两种用途，用途不同、要求不同，却共用一个字符串。
2. **确定性口径把"少印一次"挡在了 core 之外**：`CONTRACT.md:500` 要求"同一状态必须逐字节确定"，`digest.js` 头注释也写死"same project state and session must produce byte-identical text"。任何"规则只发一次""rev 没变就回一行"都引入**调用序列状态**，写进 core 就会破坏这个不变量与 `test/digest.test.mjs` 的确定性断言。
3. **工具描述还在主动鼓励重复调用**（F1 最后一条）。

## 4. 处置

| # | 条目 | 处置 | 做法 | 预期 |
|---|---|---|---|---|
| D1 | `view=brief` 里的 `RULES`（F1） | **采纳** | core 增加 `digest(sessionId, { includeRules })`（默认 `true`，系统提示路径不变）；host 在**该会话已挂 `project:brief` section** 时，`view=brief` 传 `includeRules:false`，未挂（非 agent 会话 / 注入失败）时仍回完整 digest —— 规则不能丢 | 单次 630→191 字符 |
| D2 | `view=board` 整板重印（F2） | **部分采纳** | 只做"**同参数 + 新生成的文本与上次逐字节相同** → 回一行 `board rev <N> unchanged since <seq>`"。**不**做 `rev` 相等即短路、**不**做 `sinceRev` 增量（见 §5.2） | `project_board` 重复率 50%→约 15% |
| D3 | `project_task` 恒定字段（F3） | **部分采纳** | `humanReview` 仅在 gate 为真时打印（`humanReview: off` 省略）；`allowed:` / `lease: none` / `evidence: 0` **保留**（它们是"下一步能做什么"的判据，不是装饰） | 收益小，风险为零 |
| D4 | 工具描述（F1 末条） | **采纳** | `project_board` 描述改为：brief 用于核对状态；**规则已在系统提示里，无需为看规则而再调一次**；压缩后也无需重读（section 会重建） | 减少无效调用本身 |
| D5 | 通用"同参短路"（F4） | **不采纳** | 属 `dsh-repeat-tool-reminder` 等其它插件，本项目不越界改；仅在文档里记一条转交建议 | — |
| D6 | 事后裁剪（F5） | **不采纳** | 不新增任何"事后压缩我们的输出"的机制；只在生成时短 | — |
| D7 | 度量（可复现验收） | **采纳** | 新增 `scripts/measure-context-cost.mjs`：内存里构造 digest / brief / board / task 输出，打印字节数与规则块占比，改造前后各跑一次作为证据 | 让 D1–D3 的收益可复核，不靠感觉 |

## 5. 设计约束（这决定了上面为什么"部分采纳"）

### 5.1 分层：确定性留在 core，记忆留在 host

`handle.digest()` 必须继续满足"同状态 + 同会话 → 逐字节相同"。因此：

- **core** 只多一个纯参数 `includeRules`（不引入调用历史）。
- **host** 才允许持有 per-session 的"上次输出文本 / hash"。`lib/host/tools/shared.js` 已有 `runtime.sessionProjects` 这个 per-session 容器，短路表挂在同一层。

### 5.2 为什么不用 `rev` 判"没变"

`rev` 是 `lastSeq`，只覆盖**事件**变化。看板文本还受**当前时间**影响：`brief` 的 health 用 `_nowMs()` 判租约过期，`boardSummary` 的卡片带 `owner token`，租约过期/清扫会改变可见状态而**不产生事件**。用 `rev` 相等短路，会把"租约已死"的陈旧视图当成真话发给 agent —— 这类错误比多花几 KB 贵得多。

所以判据必须是**新生成文本与上次逐字节相同**：CPU 白算一遍，省的是上下文预算；正确性不打折。

### 5.3 单一规则来源

`CONTRACT.md:561` 已经定了"规则文本含在 digest 的 RULES 块，不单独再注册 section"。D1 之后这条要改成：**规则由 `project:brief` section 承载；`view=brief` 是它的兜底副本，仅在该会话没有 section 时出现。** 避免以后有人"顺手"再加一个规则 section 变三份。

### 5.4 边界仍然成立

`digest` 里所有自由文本（任务标题、备注、文档名）继续单行化 + 截断（`digest.js:12-19`）。D1 不碰这条 —— 报告里"board text 是数据不是指令"的边界不因省字节而放松。

## 6. 验收口径

| 指标 | 现状（报告实测） | 目标 |
|---|---|---|
| 单次 `view=brief` 字符数 | 630（RULES 439） | ≤ 200（规则块为 0，除非无 section） |
| `project_board` 重复率 | 50% | ≤ 15%（同参同文短路生效后） |
| `view=board` 同参二次输出 | 4,584 字符 | ≤ 64 字符（一行 unchanged） |
| `project_task` 单次输出 | ~635 字符 | 视任务而定，`humanReview: off` 不再出现 |
| 确定性 | `test/digest.test.mjs` 全绿 | 保持全绿；新增 `includeRules` 两态各一条用例 |

验收方式：`npm test`（core + client + host 全绿）+ `node scripts/measure-context-cost.mjs` 前后对比数字进 CHANGELOG。

## 7. 转交外部（不在本项目动手）

- `dsh-tool-fs`：`edit`/`write` 结果只回机器信号（`ok` / `rev` / `changed`），确认句交 UI 渲染；`read` 加内容哈希短路。
- `dsh-ops`：`sandbox` 对象移出文本、进结构化 meta（成本极低）。
- `dsh-repeat-tool-reminder`：已算出参数同一性，只差把这条信息用于去重。
- 通用层若采纳"同参短路"，本项目的 D2 可以退化成它的特例，但**别等**（F4）。

## 8. 相关

- 计划：内部交付计划「上下文成本 · ProjectBoard 输出去冗」——本文是该计划的决策依据。
- 任务：三条实现任务（契约与描述 / 实现 + 用例 / 度量与收口），均为 P150（中等），依赖链 1→2→3。
- 相邻不变量：「digest 边界：单行化 + 截断 + 数据边界声明」已确立的边界，本文 §5.4 与其一致，不推翻。
