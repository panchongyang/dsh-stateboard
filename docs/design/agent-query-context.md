# Agent 工具统一与查询上下文

七个 DSH 工具是唯一的 Agent 接口。原生与 MCP 共享名称、描述、参数、校验、执行、原始结果边界和文本 renderer；MCP 只处理凭据、来源校验与 HTTP 信封。权威契约见 [CONTRACT §2.6.7](../CONTRACT.md#267-可选本机-mcp)。

## 1. 实现基线

统一以 DSH 行为为准：管理读取 open/touch；每次变更生成新命令；重复创建不是重试去重；驳回和解阻满足条件时自动恢复原受派者的执行租约；错误保留 code/status/details/next；同参同文读取折叠为 unchanged。知识查询保留其无 writer、无 touch 的路径。

固定 Git 读取共同限制在绑定内，避免为了对齐而放宽安全边界。新 context 不允许 actor、sessionId、cwd 或旧凭据字段混入业务参数；角色始终由可信入口决定。其他历史差异与取舍见 [基线审计](../decisions/agent-tool-parity-audit-2026-11-16.md)。

## 2. 单一注册与执行路径

`lib/host/tools/index.js` 的 agentTools 生成唯一目录，原生 registerTools 和 MCP projectTools 使用同一组定义。

| 工具 | 责任 |
|---|---|
| project_board | 管理视图、元数据投影、有界任务摘要与精读 |
| project_task | 完整任务状态机，包括原有 human-only 拒绝 |
| project_plan | 计划、版本与归属 |
| project_doc | 内嵌档案读取、外置文档与固定 Git 读取 |
| project_session | 项目发现、context 建立、初始化及检查点/交接 |
| search_project_knowledge | 有界历史检索 |
| read_project_knowledge | 引用对应的原文、游标与覆盖信息 |

参数定义无 DSH peer 运行依赖。共享校验器验证 lossless JSON、类型与枚举；core 保留业务守卫。真实 DSH SDK 生成的固定 corpus 约束校验接受集合，真实 SDK 门禁还验证公开 schema、TypeScript/Python SDK 和原始输出。结果须通过共同 JSON/schema 边界，不能出现 MCP 渲染成功而 DSH executor 拒绝的 undefined 字段。

旧 MCP 原子工具已退出注册。迁移使用共同工具及 op/view；不保留第二套隐形写入、去重或回执路径。旧工具调用失败后应刷新目录并读卡对账。完整映射见 CONTRACT。

## 3. 身份与授权

所有工具有同一个可选 context 字段。原生省略它使用 owning agent/cwd；MCP 使用 project_session projects/open 获取项目绑定句柄。显式空或无效 context 必须拒绝，不能落回默认项目。

MCP 连接可被多个 Agent 共用，因此连接 ID 不代表 worker。context 绑定逻辑 actor、项目、访问级别、凭据实例和有效期；切换项目保留 actor，并保留原句柄的项目归属。新凭据实例拒绝旧句柄。原生 context 不得替换 owning agent 身份。

概览凭据只允许项目发现和 tasks/task_overview/work_context 元数据视图；完整凭据仍受当前 allowlist 约束。权限在 writer/touch 前检查。原生新项目初始化依赖受信 cwd；MCP 只能选已授权且已登记的项目，不接收任意客户端路径。

首次管理调用对逻辑 actor/project attach 一次，并发共用 Promise。原生 Agent 退出时释放所有已接触项目的绑定和租约。project_board 会恢复/绑定/续租，因此 readOnlyHint=false；知识工具才声明 true。原生项目提示仍来自当前工作区，跨项目 context 的结果明确携带来源，不能把提示归属当作切换项目。

MCP 完整凭据实例关闭时先停止准入并等待在途调用，再释放本实例所有工作者的绑定和租约，清理其 context 与跟踪；不能把返工自动恢复给已关闭身份，也不能清掉其他原生或 MCP 实例的工作。

## 4. 精读与累计成本

默认 task 和任务回执使用 DSH 文本摘要，并给出 task/project 修订、摘要覆盖说明和精读入口。摘要正文有 8 KiB 上限；详细证据和完整报告不通过摘要假装已读取。

project_board view=task_detail 接受：

- taskId，以及 section 或最多三个唯一 sections。
- evidenceId、acceptanceId、kind、includeSuperseded，约束证据选择；默认包含历史证据。
- offset/maxBytes，按 UTF-8 字节分页，不拆字符；默认 8192、上限 24576。
- atRev，用于连续读取同一任务版本；版本变化返回 stale-revision。

结果包含 source、scope、coverage；明确 offset、nextOffset、总字节、实际字节与 truncated。timeline 范围是最近 30 条任务事件；完整历史走知识引用。多个 section 共享一个响应预算，不各自扩张预算。已知目标可以直接精读，不强制概要调用。

两次读取需要把第一次结果在第二轮重放的成本算进去。以 P 为公共输入前缀、F 为全量、S 为摘要、R 为选中详情，主项分别是 P+F 和 2P+2S+R；调用参数与消息信封另计。长 P、摘要后又全读、频繁继续分页，都可能让多次读取更贵。实测见 [成本记录](../decisions/agent-query-context-cost-2026-11-16.md)。

## 5. 强制门禁

`npm run test:parity` 执行实际原生注册 + 回环 MCP HTTP；同一批测试也在默认 test:core/test:ci 中。覆盖目录/schema/描述、所有任务 op、全部计划/文档/会话 op、全部 board view、错误详情、状态/租约、副作用、并发绑定、摘要与精读。新 op/view 没有场景会在枚举覆盖断言中失败。目录门禁自身注入漏工具、漏操作、改参数类型的变异并断言失败。

`test/contract/tool-schema-snapshot.test.mjs` 无 peer 依赖、无 skip。七工具快照必须一起更新。SDK 特殊值 corpus 由真实 SDK 生成，离线检查不能重录自己的期望。host 的 agent-sdk 测试重新核算 corpus、生成两种 SDK 并检查 raw output，缺 SDK 直接失败。

CI 配置两个独立任务：DSH and MCP interface and behavior parity，以及 Real DSH SDK compatibility。后者安装 tools/dsh-sdk 中固定的开发期 SDK 子集，不把依赖装进产品包。完整本机宿主门禁仍覆盖插件 apply、生命周期、路由和知识取消。分支保护的 required checks 属于远端配置，需在交付记录中核对实际状态；不能仅凭工作流存在声称保护已开启。

门禁按同一候选运行，R3 保留独立审查。存储 schema 与事件格式不变；部署后客户端需刷新工具目录并重开 context。
