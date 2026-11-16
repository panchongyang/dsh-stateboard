# DSH 与 MCP 全工具等价复查

日期：2026-11-16。源码基线：`8658680`。记录范围：**变更前的隔离审计与本次统一处置**。对应[统一接口与上下文方案](../design/agent-query-context.md)。

基线只有一部分领域守卫和知识工具契约复用，不能宣称“接口和行为完全相同”。基线实际注册结果为 DSH 7 个工具、MCP 28 个工具（概览连接 4 个、授权连接 24 个）；只有 `search_project_knowledge` 和 `read_project_knowledge` 同名。名称差异之外，本次在隔离合成数据中确认了 16 个行为/返回差异。

## 1. 范围与证据强度

检查了双方全部注册工具、所有枚举操作和视图、参数声明、分发代码、输出/错误包装、调用副作用与相关现有测试。注册清单取自真实 `registerTools`、`projectReadTools` 和 `createMcpWrite` 的执行结果，未靠文档猜测。

从指定提交导出源码，在独立 HOME/USERPROFILE、DSH、XDG、npm、临时目录及合成项目上运行。DSH 调用真实注册 handler 和 renderer，MCP 经过实际回环 HTTP；**没有启动完整 DSH Web 宿主或让模型执行任务**。因此属于适配层行为核对，不能代替部署后的宿主/模型验收。

现有 7 个相关测试入口合计 **38/38 通过，0 skip**；另有 16 项差异观测。测试全绿与双端不等价同时成立。未把未实测的操作标成通过：下表“共用 core”仅说明代码路径，所有操作仍须进入后续共享行为矩阵。

## 2. 完整工具清单

### DSH 注册面

| 工具 | 全部操作或视图 |
|---|---|
| `project_board` | brief、board、task、plan、plans、docs、doc、events、health |
| `project_task` | create、update、gate、ready、claim、begin、renew、submit、verify、reject、block、interrupt、unblock、release、reconcile、cancel、reopen |
| `project_plan` | publish、revise、create、rename、archive、unarchive、focus、adopt、release |
| `project_doc` | get、put、list、link、register、inspect、update_meta、relocate、confirm、unregister、list_external、get_fixed |
| `project_session` | init、checkpoint、handoff |
| `search_project_knowledge` | 关键词检索、来源类型、分页、版本历史及关系线索 |
| `read_project_knowledge` | 来源原文/上下文、字节预算、分页及关联预算 |

`reopen` 和 `focus` 是人类操作，DSH Agent schema 仍列出它们，执行由 core 拒绝；MCP 没列出。它们不应被描述为“给 MCP 补上 Agent 权限”，应在统一 Agent 目录中一致处理，保留原有人类入口。

### MCP 注册面及逐项对应

下表覆盖全部 28 个工具。“共用”不代表接口已相同；任务/计划/文档写入普遍受第 3 节的参数、幂等、回执和副作用差异影响。

| MCP 工具 | DSH 对应 | 本次结论 |
|---|---|---|
| `list_projects` | 无同形入口 | DSH 主要按 cwd 定位，缺少等价的项目目录分页接口 |
| `list_tasks` | `project_board board` 只覆盖部分用途 | state/after/limit 卡片分页形状不同 |
| `get_task` | `project_board task` 只覆盖部分用途 | 轻量投影与完整任务视图不同 |
| `get_work_context` | brief/提示注入只有相关信息 | 没有同名同形的候选、阶段、nextAction 查询 |
| `open_work_session` | 宿主会话身份 | 生命周期/凭据入口不同，不能作为业务 schema 永久分叉理由 |
| `create_task` | `project_task create` | 共用创建守卫；自动建项目、入参、回执与重试差异 |
| `update_task` | `project_task update` | 共用更新守卫；参数/版本声明、输出与错误不同 |
| `ready_task` | `project_task ready` | 共用就绪守卫；接口及调用前副作用不同 |
| `claim_task` | `project_task claim` | 共用领取守卫；逐操作字段校验、会话绑定与领取回执不同 |
| `begin_task` | `project_task begin` | 共用意图命令；required/type 范围和错误包装不同 |
| `submit_task` | `project_task submit` | 共用证据/提交守卫；完整任务与收据、警告信息不同 |
| `verify_task` | `project_task verify` | 共用验收守卫；DSH 声明人类专属字段，MCP schema 不接受 |
| `reject_task` | `project_task reject` | **实测不同状态与租约结果**，见 D14 |
| `release_task` | `project_task release` | 共用释放守卫；intent.outcome 声明、必填项与幂等不同 |
| `interrupt_task` | `project_task interrupt` | 共用中断守卫；note 必填/非空声明不同 |
| `gate_task` | `project_task gate` | 共用审计门守卫；schema 必填/角色拒绝路径不同 |
| `renew_task` | `project_task renew` | **实测重复请求消耗额度不同**，见 D15 |
| `block_task` | `project_task block` | 共用阻塞守卫；fencing/intent 参数约束与返回不同 |
| `unblock_task` | `project_task unblock` | **实测不同状态与租约结果**，见 D13 |
| `reconcile_task` | `project_task reconcile` | 共用对账守卫；MCP 新工作会话绑定、后续自动恢复策略不同 |
| `cancel_task` | `project_task cancel` | 共用取消守卫；逐操作字段接受集和回执不同 |
| `manage_plan` | `project_plan` | 8 个共同操作；DSH 另列 human-only focus；required/projectRev/回执/重试不同 |
| `manage_document` | `project_doc` 的 7 个写操作 | 共同为 register/update_meta/relocate/confirm/unregister/put/link；读取另拆工具，schema/回执不同 |
| `checkpoint_work_session` | `project_session checkpoint` | 共用记录命令；projectRev/requestId 与结果形状不同 |
| `handoff_work_session` | `project_session handoff` | 同上 |
| `get_project_view` | `project_board` + `project_doc` 读取 | 12 个视图的完整对应及差异见下表 |
| `search_project_knowledge` | 同名工具 | 业务 schema/描述/reader 已共用，已有跨端测试；公开 schema 的范围表达、身份参数和错误/取消路径仍不完全同形 |
| `read_project_knowledge` | 同名工具 | 原文、来源引用、分页可跨端；同样存在公共输入包装与取消/错误投递差异 |

DSH 的 `project_session init` 没有 MCP 对等能力。MCP `open_work_session` 只签发已授权项目的工作会话，**不会创建项目**，不能把两者填成同一能力。初始化必须基于服务端已验证的工作区上下文；统一接口不能接受任意客户端路径来扩大授权。

### 全部读取视图

| MCP view | DSH 对应 | 关键差异 |
|---|---|---|
| brief | board brief | DSH 增加 digest/提示规则去重；MCP 返回脱敏投影 |
| board | board board | 同源卡片视图，DSH 文本摘要与 MCP JSON、整段重复读取策略不同 |
| task | board task | 返回结构、审查/证据展开、allowedOps/lease 字段和读取副作用不同 |
| plans | board plans | 同源列表，响应包装和渲染不同 |
| plan | board plan | 指定不存在的计划时，DSH 成功且 plan=null，MCP not-found |
| docs | board docs / doc list | DSH board.query 未实际过滤；MCP 有过滤 |
| doc | board doc / doc get | 默认预算与 maxBytes 的字符/字节语义不同 |
| list_external | doc list_external | 共用记录列表；包装、渲染/脱敏不同 |
| inspect | doc inspect | fresh 只在 DSH，观察根目录/诊断和预览预算不同 |
| get_fixed | doc get_fixed | **仓库读取域不同**；MCP 额外 withinBinding，正文预算也不同 |
| events | board events | DSH 无 after 参数且固定从 0 取，limit 上限不同 |
| health | board health | DSH healthAsync 的完整健康结果，与 MCP 只读捕获视图的脱敏摘要不同 |

## 3. 已复现的 16 项差异

| 编号 | 同目的调用 | DSH 结果 | MCP 结果 |
|---|---|---|---|
| D01 | 文档目录 query=alpha | 同时返回 alpha、beta | 只返回 alpha |
| D02 | 中文正文 maxBytes=4 | 返回 4 个汉字，12 字节 | 返回 1 个汉字，3 字节 |
| D03 | 30,000 字节中文正文，不传预算 | 全部返回，不截断 | 返回 24,576 字节并标截断 |
| D04 | 显式读取不存在的 planId | 成功，plan=null | not-found |
| D05 | inspect 携带 fresh=true | 成功，cached=false | schema 拒绝 invalid-command |
| D06 | 同参数创建重试；DSH 连 callId 也相同 | 新建 2 个任务 | 新建 1 个，第二次 deduped=true |
| D07 | 任务创建成功响应 | ok/projectId/task/result | projectId/projectRev/taskId/taskRev/state/deduped |
| D08 | claim 携带 create 的 title 字段 | 接受，领取成功并忽略 title | invalid-command，未领取 |
| D09 | update 使用过期 expectedRev | 含 status、currentRev、taskId 和 next 的领域错误 | 只保留 code 与安全 message |
| D10 | 时间推进 30 秒后读取本人任务 | 续延租约 30 秒 | 租约未变 |
| D11 | 子工作区读取父仓库另一个文件的固定 Git 内容 | 读取成功 | outside-root |
| D12 | events limit=101 | 成功 | schema 拒绝 invalid-command |
| D13 | 解阻，原受派会话仍活跃 | in_progress，自动有租约 | ready，无租约 |
| D14 | 提交后驳回，原受派会话仍活跃 | in_progress，自动有租约 | ready，无租约 |
| D15 | 原样重复续租 | renewCount=2 | renewCount=1，重复回执去重 |
| D16 | 同参再次读取未变的任务 | 渲染为 unchanged 提示 | 重返完整 JSON |

这些是差异证据，不是 16 个独立缺陷的严重度排序。D11 不把原生宿主与 MCP 的既有信任设计一概判为漏洞，但它不满足本次“同授权上下文下行为相同”的要求；对齐时必须收敛到安全的共享读取边界，不能放宽 MCP 去追平。

知识工具的正向引用互读与完整原文已有证据；本次没有穷尽所有域错误、每个计划操作及并发调度。相应场景是门禁必须补齐的内容，不能因共用 core 就跳过。

## 4. 基线根因与当时的测试缺口

1. **目录和 schema 仍是两套。** DSH 的五个管理工具在 `lib/host/tools/` 各自定义；MCP 在 `mcp-tools.js` 与 `mcp-write.js` 另定义。共享操作名和 core 命令不足以阻止 required/default/字段允许集漂移。
2. **读写副作用在适配器中。** DSH `resolveHandle` 调用 openByWorkspace/touch；MCP 读服务使用捕获或冷读数据。DSH 命令每次 randomUUID；MCP 按工作会话和精确请求生成去重 ID。
3. **core 内也存在来源相关策略。** MCP 首次领取绑定 `autoResume:false`，而 native attach 的绑定支持自动恢复；续租去重仅在 `actor.via==='mcp'` 分支，不能以“同一个 core”证明相同行为。
4. **返回与错误分别维护。** native 管理输出是摘要、完整原始值和详细错误；MCP 使用收据/JSON/安全错误白名单。需要共享安全投影和 renderer，而不是关闭 MCP 脱敏。
5. **测试名不能代替测试范围。** `mcp-parity.test.mjs` 主要验证 MCP 到 core 的规则、冷读和边界，未把所有 native handler 与 MCP 成对比较；真正跨端的 `knowledge-parity` 只覆盖两个知识工具。
6. **CI 没有宿主门禁。** 当前 `.github/workflows/ci.yml` 明确只跑 offline 子集，宿主 peers 不完整公开安装；`test:host` 的要求停留在本机执行和附证据。当前不存在全工具等价的必过 CI 状态。远端分支保护设置本次未检查，不能声称已经开启 required check。

## 5. 本次统一处置

用户指定以 DSH 接口和行为为准，按 R3 在独立候选实现。七工具共用定义、校验、执行和文本渲染；旧 28 工具退出注册。以下处置与基线差异逐项对应：

| 差异 | 共同结果与门禁 |
|---|---|
| D01 文档过滤 | 沿用 DSH board docs 的既有 query 行为（不筛选）；不声称已修复过滤功能。双端同参比较。 |
| D02/D03 文档预算 | 沿用 DSH 既有字符计数和默认正文预算；既有 maxBytes 名称不代表 UTF-8 字节。新 task_detail 单独明确 UTF-8 字节。 |
| D04 缺失计划 | 两端返回 plan=null。 |
| D05 inspect fresh | 共用 schema 与执行，支持 fresh。 |
| D06 重复创建 | 每次新命令，创建两张卡；不延续 MCP 请求去重。 |
| D07 回执 | 同一个原始结果校验及摘要 renderer；MCP 不重复发送 structuredContent。 |
| D08 操作外已声明字段 | 沿用 DSH 共用工具 schema，操作不使用的已声明字段行为一致。 |
| D09 领域错误 | 同一品牌错误，保留 code/status/details/next；未知异常不透传。 |
| D10 管理读副作用 | 两端管理读取 touch；元数据和知识读保持无 writer/touch。 |
| D11 固定 Git 范围 | 两端共同限制绑定内读取，不放宽安全边界。 |
| D12 事件 limit | 共同使用 DSH 上限 500，101 允许。 |
| D13/D14 解阻和驳回 | 共用原生 attach/autoResume；符合条件时自动恢复原受派者租约。 |
| D15 renew | 两次调用计两次续租；移除 core 内 MCP 专属去重和回收判断。 |
| D16 重复读取 | 同参同文共享 unchanged，fresh 可强制重印。 |

全部 task/plan/doc/session op 与 board view 有实际双端执行覆盖；枚举增加而未补场景会失败。目录/schema/描述逐字段一致，定向变异证明漏工具、漏操作、改类型会阻断。固定 SDK corpus、真实 SDK 的 schema/生成器/原始输出另设 CI 门禁；完整 host 测试仍在隔离本机执行。release handoff 依赖两项新门禁，远端 required checks 的实际配置另记交付证据。当前设计见[统一方案](../design/agent-query-context.md)。

## 6. 复算材料与验证边界

本机忽略目录 `.evidence/agent-tool-parity-20261116/` 保存：源码导出、`catalog.json`、`probe-results.json`、测试/反例日志、隔离 runner。公共文档不含真实业务样本、配置、密钥或实体 ID。

现有测试入口：`test/host/host-tools.test.mjs`、`mcp-http.test.mjs`、`mcp-write.test.mjs`、`mcp-parity.test.mjs`、`mcp-lifecycle.test.mjs`、`mcp-knowledge.test.mjs`、`knowledge-parity.test.mjs`。首次运行被沙箱拒绝回环连接；获准使用隔离临时端口后 38/38 通过。补充反例的初稿触发正常 WIP=1 限制，改为同任务顺序执行后全部 16 项完成；没有改产品代码以得到结果。

源码入口：[native 注册](../../lib/host/tools/index.js)、[MCP 只读](../../lib/host/mcp-tools.js)、[MCP 授权工具](../../lib/host/mcp-write.js)、[native 公共处理](../../lib/host/tools/shared.js)、[只读视图](../../lib/core/project-reader-views.js)、[租约策略](../../lib/core/lease.js)、[会话绑定](../../lib/core/commands/session.js)、[CI](../../.github/workflows/ci.yml)。
