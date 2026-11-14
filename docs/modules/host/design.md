# 宿主模块设计

> 文档定位：L3 模块设计；L1 权威：[Host 表面](<../../CONTRACT.md#26-host-表面>)、[工具](<../../CONTRACT.md#263-工具>)、[HTTP](<../../CONTRACT.md#265-http>)、[MCP](<../../CONTRACT.md#267-可选本机-mcp>)。

本文说明装配与信任翻译；调用限制见[内部契约](<contract.md>)，模块位置见[L2](<../host.md>)。

## 1. 职责与非职责

host 把 DSH、网页与 MCP 的受信身份翻译为 core actor 和业务参数。
它管理入口注册、错误封装、prompt section 与读取资源的生命周期。
业务是否合法仍由 core 判定，传输成功不等于提交或验收成功。

**非职责**：

- 不复制任务状态机、租约资格、文档安全读取或证据审计规则。
- 不接受请求体自报 human/system/session 身份来扩权。
- 不执行任务正文、证据命令或模板文本。
- 不把可选 MCP 监听失败扩散成网页或原生工具不可用。
- 不把“双端同步能力”误解为所有凭据拥有相同权限。

## 2. 装配结构

| 实现 | 职责 |
|---|---|
| [lib/index.js](<../../../lib/index.js>) | 命名导出、runtime、service ready 与装配 |
| [tools/index.js](<../../../lib/host/tools/index.js>) | 六个 registrar，实际注册七个原生工具 |
| [tools/shared.js](<../../../lib/host/tools/shared.js>) | actor、resolveHandle、错误提示与公共渲染 |
| [routes.js](<../../../lib/host/routes.js>) | prefix、鉴权、资源分发和清理 |
| [auth.js](<../../../lib/host/auth.js>) | 网页来源/token 与进程内 capability |
| [lifecycle.js](<../../../lib/host/lifecycle.js>) | agent attach/detach 与项目映射 |
| [prompt.js](<../../../lib/host/prompt.js>) | 动态 section 与字面插值边界 |
| [mcp.js](<../../../lib/host/mcp.js>) | 可选本机 listener 及读写资源所有权 |
| [mcp-http.js](<../../../lib/host/mcp-http.js>) | 来源、Bearer、JSON-RPC 与安全错误 |
| [mcp-write.js](<../../../lib/host/mcp-write.js>) | 写范围、工作会话、白名单与命令归因 |

旧 [tools.js](<../../../lib/host/tools.js>) 是兼容壳，不能只检查它就声称能力已注册。
原生业务 registrar 与 MCP 工具表分别实际装配，非自动从同一个工具列表生成。

## 3. 启动与原生调用链

apply 创建 service、ready Promise、网页 token、会话项目表与 prompt fiber 表。
工具立即注册，执行时等待 ready；初始化失败只记录，不伪装数据可用。
Web 服务通过可选注入挂载，避免冷启动时提前 get 导致漏路由/token。
没有 Web 的组合仍保留原生工具和 prompt。

原生管理工具从 exec.agent.session.header.cwd 解析项目。
resolveHandle 会 openByWorkspace、touch 当前 session，并更新 sessionProjects。
仅显式允许的创建动作传 create 选项；普通 read miss 不自动建项目。
actor 从 exec.agent.id/callId 建立，不从业务参数取角色。

原生知识工具另走 resolveWorkspace → knowledge reader，不借 resolveHandle。
两种原生工具都读取项目，但只有后者不打开 writer、不 touch。
取消信号传给知识读取器，不进入可序列化业务参数或来源身份。

## 4. 双端交付如何核对

原生工具按 board/plan/task/doc/session/knowledge registrar 交付。
MCP 分为概览读工具、项目授权完整视图/写工具、知识工具映射。
聚合原生操作可映射为独立 MCP 工具，但业务守卫、参数意图和来源范围不应丢失。

维护一项能力须同时核对：

1. 原生 register 实际执行，名称与参数对模型可见。
2. MCP 对应凭据的 tools/list 确实发现该业务能力。
3. 两侧执行到相同 core 语义，不以 schema 描述替代运行时验证。
4. 业务错误分类、分页、来源/覆盖保持一致，安全传输封装允许不同。
5. human-only 能力仍留在受信人工入口，不能为凑齐数量而扩权。

知识 schema 与描述共用 shared 定义，原生 PTC 仅机械转换范围关键词为说明。
core 仍强制范围；MCP 保留完整 JSON Schema。
验证需覆盖真实 SDK 渲染与两端注册，不仅检查工具常量存在。

## 5. HTTP token 与来源

网页 token 每次插件实例创建时随机生成，经 index-inject 交给同源页面。
请求先检查 Sec-Fetch-Site 与 Origin/Host，再检查 x-project-board-token。
来源失败和 token 失败都拒绝，但提示不同；刷新 token 不能修复来源拒绝。

鉴权成功得到进程内 Symbol capability，写适配据此生成 human/web actor。
请求 body/query/header 的角色字段没有授权作用，不设置 CORS 放宽来源。
body 上限与 JSON 错误封装在 host util 统一处理。

普通资源读取先 service.open，不能将所有 GET 声称为锁外零写。
文档图片走专用 lock-free peek，不为读图片触发 writer 恢复。
外置写参数先校验再 open，避免非法 body 在冷开 recover 后才被拒绝。
命令入口先检查 body 对象/op 并构造受信 actor，再进入 service；完整领域校验不都发生在 open 前。

## 6. MCP 读写隔离

MCP 只在显式布尔 enabled=true、合法端口和读凭据具备时挂载。
listener 绑定本机 IPv4，逐请求核对 socket、Host、来源和独立 Bearer。
概览 read token 只发现概览工具，不得到正文/项目写范围。
写 token 必须另配、不同于读 token，并绑定非空项目 ID 授权集合。
写配置失败只关闭写通道，不关闭概览读取。

工作会话和 MCP 传输会话是不同对象。
open_work_session 为指定授权项目签发有时效 token，不打开 writer、不写日志。
服务端从 token 生成独有 agent/session 归因，请求不能自报 actor。
首次成功 claim/reconcile resume 的 session/bound 与任务事件在同一 commit。
重连复用工作 token，插件重载/重启后失效；不得把它记成持久项目身份。

完整视图与知识工具虽然放在写凭据类，也只是只读业务。
它们经授权后走 reader worker，不因持有写 token 就为读取打开 writer。
显式写操作才在白名单/项目/会话验证后进入 service.open。

## 7. prompt 与重复投递

installPrompt 对每个 agent 安装唯一 project:brief section，动态查当前项目 handle。
没有项目或句柄关闭返回空；稍后显式创建项目后可开始贡献摘要。
section 设置 interpolate=false，模板括号按字面文本处理，不让宿主求值。
字段单行化在 digest 层完成；任务、文档和事件内容仍是数据，不成为指令。

RULES 权威副本只由 digest 生成并从该 section 投递。
原生 brief 根据 promptFibers 是否已安装决定 includeRules，不能事后剪字符串。
其他原生只读视图以同参同文比较减少重复，fresh=true 可强制重印。
这类去重只在 host，不能污染 core 的输入输出决定性。

## 8. 失败、销毁与恢复

agent attach 等待 ready，发现/打开/绑定失败记录告警，不让会话创建失败。
有效 cwd 的 agent 即使尚无项目仍安装动态 prompt。
detach 先删除 sessionProjects 并卸 prompt，再 best-effort 调 handle.detach。
prompt disposer 被触发但非同步等待完成，不能承诺它与领域 detach 原子完成。

插件总清理先等待 MCP stop，再在 finally 中关闭 service。
MCP stop 幂等地停止监听、关闭连接，并并行等待 reader.close 与写在途请求收口。
写层先 closed 拒绝新入场，再 allSettled 已接纳命令，不把提交当作可取消事务。
service.close 关闭列表读取器并释放 writer 引用；原生知识 reader 有独立 effect 清理。
Web prefix 与 index-inject 有自己的 disposer，不在 service 中反向清理 host。

## 9. I/O 成本与阅读顺序

注册工具/schema/section 是启动装配成本，不该在每次 prompt 重建时重复注册。
冷开管理工具/普通 HTTP 仍可同步验证日志，重 health 则显式隔离到 worker。
MCP 概览冷读和完整视图有 worker/序列化成本，知识 worker 另受全局名额限制。
输出裁剪和去重只省上下文，不减少所有投影或外部读取成本。

阅读顺序：[插件入口](<../../../lib/index.js>) → [生命周期](<../../../lib/host/lifecycle.js>) → [原生 registrar](<../../../lib/host/tools/index.js>) → [HTTP](<../../../lib/host/routes.js>) → [MCP 装配](<../../../lib/host/mcp.js>) → [写入门](<../../../lib/host/mcp-write.js>) → [prompt](<../../../lib/host/prompt.js>)。
验证入口：[MCP parity](<../../../test/host/mcp-parity.test.mjs>)、[HTTP](<../../../test/host/mcp-http.test.mjs>)、[生命周期](<../../../test/host/mcp-lifecycle.test.mjs>)和[知识双端](<../../../test/host/mcp-knowledge.test.mjs>)。
