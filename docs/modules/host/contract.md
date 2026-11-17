# 宿主模块内部契约

> 文档定位：L4 模块内部契约；L1 权威：[工具](<../../CONTRACT.md#263-工具>)、[HTTP](<../../CONTRACT.md#265-http>)、[MCP](<../../CONTRACT.md#267-可选本机-mcp>)。设计见[模块设计](<design.md>)。

## 1. 共同目录与校验

[agentTools](<../../../lib/host/tools/index.js>) 是唯一 Agent 目录。原生 registerTools 与 MCP projectTools 使用同一对象的名称、描述、schema、execute、output.schema 和 renderer；不得另建业务分发、回执或隐形旧写入口。兼容 tools.js 与 mcp-knowledge.js 只转发共同定义。

[definition](<../../../lib/host/tools/definition.js>) 编译无 peer 依赖的定义，并校验 lossless JSON、类型与枚举；core 继续检查业务字段、CAS、租约和角色。原始输出先通过共同边界，再渲染；MCP 仅发送相同文本，不重复附送 structuredContent。真实固定 SDK 门禁验证 schema、TS/Python 生成器、特殊值 corpus 和七工具原始输出，缺依赖必须失败。

## 2. 身份与权限

[agent-context](<../../../lib/host/agent-context.js>) 管理共同 context。原生省略时使用 owning agent/cwd，显式选择项目不能替换 owning agent。MCP context 绑定逻辑 actor、项目、访问级别与凭据实例；连接不代表 worker。projects/open 不打开 writer，完整权限仍受当前 allowlist 约束。

概览与完整凭据发布相同目录，但概览仅允许发现项目及 tasks/task_overview/work_context。准入先于 writer/touch；完整正文、文件路径和租约令牌不会因为 tools/list 相同而向概览凭据开放。请求不能注入 actor/sessionId/cwd 或旧 sessionToken/requestId。human-only 守卫保持共同拒绝。

## 3. HTTP 与 MCP 传输

HTTP 的 token 是当前实例随机能力，经同源 index-inject 交给页面。
先校验来源头，再校验非空 token 的长度与内容；不设 CORS 头。
Sec-Fetch-Site 出现时仅接受 same-origin/none。
非空且非字面 null 的 Origin 必须可解析，host 与请求 Host 一致。
通过 authorizeWebRequest 得到的 Symbol 才可传 requireWebActor 生成 human/web。
请求 body/query/header 自报角色不参与授权；业务输入中的不可信 actor 不能直送 core。
body 大小、JSON 对象和外置写字段校验在 open 前执行，具体域见[L1 HTTP](<../../CONTRACT.md#265-http>)。

MCP 显式 enabled=true、合法端口和独立 Bearer 才启用；逐请求校验 loopback、Host 与来源。配置失败只禁 MCP，原生与网页继续可用。协议错误与业务 isError 分开；领域错误共同保留 ok/code/message/status/details/next，未知异常不透传原文。

## 4. 业务与读写边界

管理调用共用 DSH resolveHandle/open/touch；首次显式 context 管理调用按 actor/project attach 一次，并发复用同一 Promise。每次变更生成新命令；调用 ID 不是幂等键。自动恢复、续租计数与错误不能按入口来源分支。

元数据和知识读取不打开 writer、不 touch；普通 HTTP GET 仍可能 open/recover，图片走锁外 peek。固定 Git 读取两端限制在绑定内仓库。task 摘要有界，task_detail 的 section/sections 共享一个 UTF-8 预算并返回 source/scope/coverage；来源与截断不能省略。

## 5. 提示与去重

project:brief 动态 section 的 order=9000、interpolate=false；看板文字是数据。sessionProjects 只追踪 owning cwd 的默认提示目标，显式跨项目 context 不覆盖它。所有使用过的 handle 另存 sessionHandles，用于退出释放。

RULES 的唯一权威副本在 core digest；promptFibers 已安装时 brief 不重复投递规则，其他视图按同会话、同参数、逐字节相同才返回 unchanged。fresh 强制重印；不能只比较 projectRev，也不能在输出生成后裁剪缓存前缀。

## 6. 生命周期与恢复

attachAgent 的错误隔离不破坏宿主会话创建；无项目仍安装动态提示。detachAgent 清理默认映射、全部项目跟踪和 context，释放所有已接触项目的绑定及租约；prompt disposer 触发但不承诺跨资源原子完成。

MCP close 先拒绝新调用、等待本实例在途请求，再 closeAuthority，仅 detach 该凭据实例的 actors/handles 并废止 context。返工不能交回已关闭身份；不影响其他原生或 MCP 实例。插件等待 MCP stop 后关闭 service，共同目录持有读取器生命周期；关闭不回滚已提交日志。结果不确定时读卡和日志对账。

## 7. 验证入口

默认 core 与 test:parity 执行实际原生注册和回环 HTTP，覆盖全部 op/view、权限、状态、租约、输出、并发与退出。枚举覆盖和目录变异阻断漏端；CI 另有真实 SDK 检查，release handoff 必须等待两项完成。具体回归见[契约测试](<../../../test/contract/agent-parity.test.mjs>)、[状态流程](<../../../test/contract/agent-workflow-parity.test.mjs>)、[生命周期](<../../../test/host/mcp-write.test.mjs>)、[真实 SDK](<../../../test/host/agent-sdk.test.mjs>)。
