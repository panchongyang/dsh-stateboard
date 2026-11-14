# 宿主模块内部契约

> 文档定位：L4 模块内部契约；L1 权威：[入口](<../../CONTRACT.md#261-入口>)、[生命周期](<../../CONTRACT.md#262-生命周期>)、[工具](<../../CONTRACT.md#263-工具>)、[HTTP](<../../CONTRACT.md#265-http>)、[MCP](<../../CONTRACT.md#267-可选本机-mcp>)。

本文约束 host 装配与翻译；端点/工具完整表只在 L1，设计见[模块设计](<design.md>)。

## 1. 导出与实际注册

| 入口 | 调用语义 |
|---|---|
| [lib/index.js](<../../../lib/index.js>) 的 name/inject/apply | DSH 命名插件导出；不通过 default 丢失 inject |
| [registerTools](<../../../lib/host/tools/index.js>) | 顺序执行域 registrar，实际注册原生工具 |
| [registerRoutes](<../../../lib/host/routes.js>) | 可选 prefix 与 token 注入；无 Web 返回 null，有则返回 disposer |
| [attachAgent/detachAgent](<../../../lib/host/lifecycle.js>) | 会话与 handle 映射，best-effort 生命周期 |
| [installPrompt/disposePrompt](<../../../lib/host/prompt.js>) | 对称管理动态 section，重复安装短路 |
| [mountProjectMcp](<../../../lib/host/mcp.js>) | 可选 listener；返回异步幂等 stop 或 null |
| [createMcpHandler](<../../../lib/host/mcp-http.js>) | 凭据分离的 tools/list/tools/call 与协议封装 |
| [projectReadTools](<../../../lib/host/mcp-tools.js>) | 概览读工具 schema/映射 |
| [createMcpWrite](<../../../lib/host/mcp-write.js>) | 工作会话、项目授权业务目录与 close |
| [knowledgeTools](<../../../lib/host/mcp-knowledge.js>) | 给共用知识 schema 追加项目与会话身份 |

兼容 tools.js 不是运行时注册权威；验证必须从 apply 到 registrar 实际执行。
新增面向 Agent 业务须两端交付，聚合/独立工具映射可以不同，不能只补常量。

## 2. 输入校验与身份域

原生管理工具身份来自 exec.agent，cwd 来自受信会话 header。
没有 owning agent 或合法 cwd 时拒绝，不接收调用方自报 project/actor 扩权。
知识原生工具拒绝 projectId 参数，只按 cwd 确认项目，不调用 writer/touch。
core 仍验证业务白名单、CAS、租约与角色，host schema 不是唯一守卫。

HTTP 的 token 是当前实例随机能力，经同源 index-inject 交给页面。
先校验来源头，再校验非空 token 的长度与内容；不设 CORS 头。
Sec-Fetch-Site 出现时仅接受 same-origin/none。
非空且非字面 null 的 Origin 必须可解析，host 与请求 Host 一致。
通过 authorizeWebRequest 得到的 Symbol 才可传 requireWebActor 生成 human/web。
请求 body/query/header 自报角色不参与授权；业务输入中的不可信 actor 不能直送 core。
body 大小、JSON 对象和外置写字段校验在 open 前执行，具体域见[L1 HTTP](<../../CONTRACT.md#265-http>)。

MCP 只接受显式配置布尔 true；读写 token 均按已定义格式核验且必须不同。
local/remote socket、Host、Origin、Sec-Fetch-Site 和 Bearer 每次校验，不继承网页 capability。
概览凭据与写凭据各自仅发现本类工具；完整正文不向概览凭据开放。
写授权 projectIds、输入白名单与 work session 项目域在 writer 打开前验证。

## 3. 工作会话、命令与提交

open_work_session 仅签发该项目的 24 小时会话凭据，不打开项目日志。
工作会话凭据由服务端签名，actor.kind=agent、via=mcp，session/agent ID 由服务端产生。
不得接受请求的 actor、session ID、role 或任意归因替换。
工作会话与无会话 MCP HTTP 传输分开，重连不等于重新领取任务。
首次成功领取或 resume 对账才在同一业务 commit 绑定会话。

MCP requestId 和经过校验的 actor/op/参数生成 cmdId；原样重试走 core 去重。
改变参数形成新命令，不能将 requestId 单独当作“强制重放原结果”的键。
续租去重有独立的进程/租约/进度周期范围，不能外推为永久日志幂等。
领取重试不保证原租约仍有效，lease:null 时重新读，不使用陈旧 fencingToken。
日志 committed、warning 与结果不明统一沿用[L1](<../../CONTRACT.md#21-命令信封错误码与-http-映射>)。

## 4. 不变量与读写边界

| 路径 | 权威写入/读取约束 |
|---|---|
| 原生管理工具 | resolveHandle 可 open/recover/heal，且 touch；仅指定创建动作可 create |
| 原生知识工具 | resolveWorkspace 后专用 worker，无项目/绑定创建、无 touch |
| 普通 HTTP 资源 GET | 多数先 open，不能宣传整链零写 |
| HTTP 文档图片 | 专用锁外 peek，不获取 writer，不恢复任务 |
| 显式完整 health | HTTP/原生用 healthAsync，不能放 prompt 热路径 |
| MCP 概览 | 专用 reader，从发布态或锁外前缀读取 |
| MCP 完整视图/知识 | 写凭据类授权，但业务只读；worker 不 open writer |
| MCP 变更 | 白名单/范围/会话验证后 open，业务守卫在 core |

同一业务两端共享语义不表示同一身份；human-only 操作不能因 MCP parity 开放。
DSH 知识 schema 的范围转说明是展示适配，core 必须继续强制相同约束。
输出来源、coverage、游标与不可用标记不能在 host 再摘要丢弃。
MCP 脱敏不公开 token、根目录、内部异常路径；领域错误分类与安全提示分开。

## 5. prompt 的字面语义与去重

section 名为 project:brief、order=9000，text 每次装配查当前 sessionProjects。
interpolate=false 必须保留，不能让看板里的模板括号被宿主解释为变量或表达式。
标题、note、文档名和事件正文都是数据，不是高优先级指令。
字段净化不是授权机制；不能从正文提取动作、执行 shell 或注册工具。

RULES 全文只由 core digest 定义；host 不维护另一份规则 section。
promptFibers 已安装时，原生 brief 传 includeRules=false；未安装则保留规则兜底。
非 brief 原生视图在同会话、同参数、渲染文本逐字节相同时才短路。
fresh=true 强制全文；不能只凭 projectRev 未变就抑制租约/时间变化。
去重状态仅在 host，不写项目状态、不修改 core 渲染器。

## 6. 生命周期、并发与销毁

apply 注册事件并尝试附着已有 agent，不要求新会话才能得到摘要。
attach 错误记录后隔离，不让项目失败破坏会话创建；有效 cwd 无项目仍安装 section。
detach 先删项目映射、触发 prompt dispose，再 best-effort 领域 detach。
disposePrompt 不等待 fiber.dispose 完成，不承诺跨资源原子销毁。

总清理等待 stopMcp，再在 finally 关闭 service。
MCP stop 先停止监听与断连接，并行等待 reader 终止、写入口 close 收口。
写 close 先拒绝新入场，再等待已接纳写请求 allSettled，不回滚已提交日志。
service.close 等待列表读取器并释放共享句柄；原生知识 reader 由独立 effect 关闭。
Web 路由和 token 注入在自己的 disposer 中注销，不由 core 反向引用 host。
关闭/重载使工作会话不可继续用；在途或已提交结果须按日志核对。

## 7. 错误分类与兼容

领域 code/status 唯一表见[L1](<../../CONTRACT.md#错误码>)；不在本页复制总表。
原生 BoardError 包装带 code/message/details/next；HTTP 用统一 JSON envelope。
MCP 协议错误与业务 isError 分开，业务响应仅安全 code/message，不泄露参数/路径。
未知内部错误不得携带原始异常文本返回本机 MCP 客户端。
鉴权失败不打开 writer；不能把权限拒绝降级为只读正文访问。

缺 webServer、MCP 配置/凭据/端口失败各自降级，原生工具不依赖 MCP 开关。
协议版本、业务 schema、事件 schema 和工作 token 生命周期属于不同兼容域。
工具注册顺序、schema 对模型的可见形状、prompt 字面插值均是隐含集成契约。
改业务参数须验证两侧实际注册、SDK 渲染与读写链路，不以 tools/list 成功替代调用验证。
验证入口：[parity](<../../../test/host/mcp-parity.test.mjs>)、[MCP 写入](<../../../test/host/mcp-write.test.mjs>)、[MCP 生命周期](<../../../test/host/mcp-lifecycle.test.mjs>)、[知识双端](<../../../test/host/mcp-knowledge.test.mjs>)。
