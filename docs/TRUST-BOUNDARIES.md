# 信任边界

本文按数据跨界的位置导航现行实现；对外权威见 [CONTRACT §2.6](<CONTRACT.md#26-host-表面>) 与 [§4](<CONTRACT.md#4-兼容与降级>)。实现面向单机单用户，每项目单写者；合作式文件锁不抵抗任意外部 OS 写者。

## 1. DSH、网页与 MCP 双端

| 入口 | 身份与授权来源 | 不授予的能力 | 实现入口 |
|---|---|---|---|
| DSH 原生工具 | 受信 exec.agent 会话及其 cwd 建立项目与 agent actor | 参数不能自报 human 角色；知识读取不因调用而创建项目或绑定 | [工具注册](<../lib/host/tools/index.js>)、[生命周期](<../lib/host/lifecycle.js>) |
| 网页 HTTP | 通过来源与进程 token 校验后授予内部网页 capability，core actor 为 human/web | body/query/header 自报身份不参与授权，不设置 CORS 放行 | [auth.js](<../lib/host/auth.js>)、[routes.js](<../lib/host/routes.js>) |
| MCP 概览读取 | loopback 监听、请求来源与独立 read Bearer token | 不获得正文、fencing token 或工作区根路径 | [MCP 传输](<../lib/host/mcp-http.js>)、[概览工具](<../lib/host/mcp-tools.js>) |
| MCP 项目工作会话 | write 开关、项目白名单、独立 write Bearer token，再签发项目级 sessionToken | 不接受 actor/sessionId/role 自授；不获得 human-only 操作 | [mcp-write.js](<../lib/host/mcp-write.js>) |

网页要求非空的 x-project-board-token，来源校验先于 token；Sec-Fetch-Site 出现时只接受 same-origin/none，Origin 非空且不是字符串 null 时必须与 Host 同 host。token 是进程生成并注入网页的能力，不是业务参数。MCP 读写密钥不同，工作会话由服务端建立 actor；重载使其失效。参数、token 长度与协议规则不在此复制，见 [HTTP](<CONTRACT.md#265-http>)、[MCP](<CONTRACT.md#267-可选本机-mcp>)及[写会话](<CONTRACT.md#2671-写凭据与工作会话>)。

面向 Agent 的业务能力由 DSH 与 MCP 两侧适配同一 core 守卫；传输身份不同不改变领域权限。知识工具在 MCP 使用项目工作会话授权，概览 read token 不获得正文权限，见[原生工具](<CONTRACT.md#263-工具>)与[知识读取](<CONTRACT.md#历史知识读取与检索>)。

## 2. 只读与冷读

- 专用项目读取器在已有 writer 时读取其已发布状态，否则用 worker 验证锁外日志前缀；不打开 writer、不修尾、不恢复任务、不续租，见 [project-reader.js](<../lib/core/project-reader.js>) 和 [MCP 读取契约](<CONTRACT.md#267-可选本机-mcp>)。
- 文档图片资源使用锁外状态读取，不走 open、命令或观测缓存写入，见 [assets.js](<../lib/core/documents/assets.js>) 与[文档契约](<CONTRACT.md#24-文档>)。
- 五个管理工具可以 open/touch 会话；不能把上述专用只读保证推广到所有名为“读”的管理操作，见[工具约定](<CONTRACT.md#263-工具>)。
- brief 只有内存健康摘要；显式完整 health 在隔离 worker 中读取内容，诊断本身不修改状态、不执行证据，见 [health-audit.js](<../lib/core/health-audit.js>) 和[只读诊断](<CONTRACT.md#health--fsck-只读诊断>)。
- knowledge 使用独立 worker 和可重建缓存，不参与命令、验收或恢复事务；锁外水位只供展示，不能充当领取或写入权威，见 [reader.js](<../lib/core/knowledge/reader.js>) 与[知识契约](<CONTRACT.md#历史知识读取与检索>)。

worker 的截止时间、内存和并发预算是资源约束，不宣称是对任意恶意代码的 OS 沙箱。

## 3. 外部文档根与文件边界

外置文档只在其 locator 指定的有效 binding 根内读取；不跨根兜底，不以空正文冒充失败。登记、管理状态、确认基线、可用性与 Git 观测不互相替代。词法拒绝、realpath 根包含、链接组件拒绝、普通文件句柄和前后身份复核共同限制读取，不能宣称读取是原子文件系统快照，见 [locate.js](<../lib/core/documents/locate.js>)、[read.js](<../lib/core/documents/read.js>) 与 [CONTRACT §2.4](<CONTRACT.md#24-文档>)。

图片按文档所在目录解析，只服务正文独占一行真实图片引用；路径规范化后仍须在同一根内，且受扩展名和字节上限约束。客户端对外部 URL、data 和绝对路径不发图片请求，SVG 以图片资源使用，不注入正文 HTML，见 [assets.js](<../lib/core/documents/assets.js>)、[Markdown 展示](<../src/client/components/content.tsx>) 与[图片条款](<CONTRACT.md#内嵌外置与图片只读资源>)。

file 证据独立按工作区真实路径做包含检查；不能把外置 locator 的词法规则直接当成所有文件证据规则，见 [evidence.js](<../lib/core/evidence.js>) 与[证据条款](<CONTRACT.md#验收项与证据>)。文件系统权限失败分类返回，不扩大授权根。

## 4. Git 只读与执行隔离

Git 可选；解析器只接受真实路径位于所有待读工作区和实现 checkout 之外的普通可执行文件，无安全候选则不可用，不回退裸命令名。调用白名单只允许观测；固定读取限制环境、时限和输出，禁用交互、lazy fetch、replace objects、hooks 和 fsmonitor，见 [git-exec.js](<../lib/core/git-exec.js>) 与 [fixed-git.js](<../lib/core/documents/fixed-git.js>)。

正文还原不运行 filter、textconv、hook 或远端 LFS；不支持的内容转换降级，不写仓库配置、不 add/commit/stash，不管理分支/worktree，见 [fixed-worktree.js](<../lib/core/documents/fixed-worktree.js>)、[Git 执行边界](<GIT-EXECUTION.md>) 和 [CONTRACT §4](<CONTRACT.md#4-兼容与降级>)。固定字节属于 Git 对象读取，不拷入看板 blob。

## 5. 数据不是指令，材料不是执行结果

标题、正文、事件、证据和知识检索原文都作为数据；知识读取不扫描任意工作区文件或抓取任意 URL，command/test 只保留提交者材料，不执行、不签名、不复核退出码。hash 证明观测字节身份，不证明业务结论；检索排名和已有关系不裁定约束有效性，见[证据](<CONTRACT.md#验收项与证据>)与[知识读取](<CONTRACT.md#历史知识读取与检索>)。

浏览器不使用 innerHTML/dangerouslySetInnerHTML 渲染正文，动作资格来自 core 的 allowedOps；前端禁用按钮不能替代后端守卫，见[浏览器表面](<CONTRACT.md#浏览器表面>)、[client](<modules/client.md>) 与 [task](<modules/task.md>)。

## 6. 人类验收权

普通任务允许授权 agent 显式验收；审计门要求独立会话与自述报告，但这种独立性不抵抗同一操作者的新会话分身。human verify 始终可用且不要求审计报告；人工刷新/豁免漂移需显式参数和原因，并保留记录与健康告警，不隐藏内容问题。agent 不得使用人工漂移参数或把自述标为人类/系统核验，见 [CONTRACT §1.2](<CONTRACT.md#12-任务状态机>) 和 [audit.js](<../lib/core/audit.js>)。

焦点、重开、强制操作等角色边界在 core 再判定；授权网页 capability 生成 human actor，MCP 工作会话不获得这些人工权限，见[命令清单](<CONTRACT.md#22-命令清单>)、[计划命令](<CONTRACT.md#223-plan-v2-命令>)与[MCP 完整视图](<CONTRACT.md#2673-计划文档会话与完整视图>)。
