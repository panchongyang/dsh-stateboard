# 宿主模块设计

> 文档定位：L3 模块设计；L1 权威：[Host 表面](<../../CONTRACT.md#26-host-表面>)。调用限制见[内部契约](<contract.md>)，模块位置见[L2](<../host.md>)。

## 1. 职责与非职责

host 装配 DSH、网页与 MCP 的可信身份、工具和资源生命周期，领域状态机与安全守卫留在 core。任务/文档正文不是指令；不执行正文命令，不接收自报角色，不把可选监听失败扩大为原生不可用。共同目录不代表不同凭据权限相同。

## 2. 唯一 Agent 执行链

apply → tools/index 的 agentTools → 各业务 registrar → core。原生 registerTools 直接注册同一组对象；MCP mcp-http → mcp-tools 仅适配凭据与响应信封。definition 与 json-value 校验输入/原始输出，task-detail 负责显式部分读取和覆盖信息。核心范围守卫不在 adapter 复制。

维护者只改一套名称、描述、参数和 renderer。无 peer 的默认门禁对比真实两端目录与行为；开发期固定 SDK 子集验证实际 executor/类型生成兼容。范围关键词统一转换为说明，core 强制范围，不再为 MCP 保留另一份 schema。完整方案见[Agent 统一与上下文](<../../design/agent-query-context.md>)。

## 3. context 与生命周期

agent-context 以逻辑 actor/project 管理显式 context，凭据实例与访问级别不能互换。新 MCP open 建独立 actor，携带 context 切项目保留 actor；原生省略 context 仍按受信 cwd，显式 context 不改变默认提示和默认调用目标。普通写所需的首次绑定与该命令同批发布；可信生命周期另行装配，普通查询不执行它。

所有接触过的项目值引用单独追踪，以便原生退出或 MCP authority 关闭时逐个 detach。MCP 先封闭准入并等待在途命令，再释放自己的 workers，防止自动恢复到已经无法调用的身份。其他入口资源保留；目录与读取器按所有权关闭，失败不伪装成功。

## 4. 读取与上下文成本

共同管理视图保持文本去重并走 application 只读端口；概览、图片和知识读取不获取 writer。MCP 概览权限只开放元数据视图；完整权限使用共同管理工具。知识 reader 独立并发预算不与完整 health 混用，取消释放读取名额，不撤销已提交事务。

任务摘要有界且声明覆盖；已知目标可直接按最多三个部分精读，多个部分共享一次预算。累计上下文必须计算前文重放与调用参数，不能只比较返回 JSON 大小；长公共前缀下两次读取可能更贵，见[实测](<../../decisions/agent-query-context-cost-2026-11-16.md>)。

## 5. HTTP token 与来源

网页 token 每次插件实例创建时随机生成，经 index-inject 交给同源页面。
请求先检查 Sec-Fetch-Site 与 Origin/Host，再检查 x-project-board-token。
来源失败和 token 失败都拒绝，但提示不同；刷新 token 不能修复来源拒绝。

鉴权成功得到进程内 Symbol capability，写适配据此生成 human/web actor。
请求 body/query/header 的角色字段没有授权作用，不设置 CORS 放宽来源。
body 上限与 JSON 错误封装在 host util 统一处理。

普通资源与图片走统一只读端口，使用已发布状态或锁外验证，不触发 writer 恢复。外置写参数先校验再进入应用命令。
命令入口先检查 body 对象/op 并构造受信 actor，再进入 service；完整领域校验不都发生在 open 前。

## 6. 提示与失败隔离

installPrompt 对 owning agent 安装唯一 project:brief，缺项目时返回空；interpolate=false，字段单行化由 digest 完成。RULES 只保留一份权威定义，brief 根据已安装 section 去重；其他共同视图按同参同文短路，fresh 可重印。

没有 Web 服务仍保留原生工具；MCP 配置、凭据或端口失败仅禁该入口。领域错误共同保留完整分类与下一步，未知异常不泄露原文。显式生命周期与命令有各自的写权限，不转授给普通读取。

## 7. 阅读与验证

阅读顺序：[插件入口](<../../../lib/index.js>) → [共同目录](<../../../lib/host/tools/index.js>) → [上下文](<../../../lib/host/agent-context.js>) → [传输](<../../../lib/host/mcp-http.js>) → [生命周期](<../../../lib/host/lifecycle.js>)。回归覆盖和关闭边界见[内部契约](<contract.md#7-验证入口>)。
