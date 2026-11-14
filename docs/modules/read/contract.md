# 读模型模块内部契约

> 文档定位：L4 模块内部契约；L1 权威：[查询](<../../CONTRACT.md#查询>)、[Health/fsck](<../../CONTRACT.md#health--fsck-只读诊断>)、[Digest](<../../CONTRACT.md#digest>)。

本文约束内部调用，不扩展 npm 导出面；取舍见[设计](<design.md>)。

## 1. 入口与语义

| 入口 | 内部调用含义 |
|---|---|
| handle.query(view, params) | 同步分发，检查句柄未关闭；不是输入 schema 总校验器 |
| [views 导出](<../../../lib/core/views.js>) | briefView/boardView/taskView/planView/plansView/docsView/docView/eventsView/healthView；docsForTask 为关系投影 |
| handle.healthSummary() | 只采样内存租约，输出 unchecked 摘要 |
| handle.health(options) | 同步完整诊断；includeEvidenceWarnings 默认 false |
| handle.healthAsync(options) | 经 isolatedHealth 运行完整隔离审计 |
| [checkState](<../../../lib/core/fsck.js>) | 状态不变量诊断；不读证据内容、不修输入 |
| [buildDigest](<../../../lib/core/digest.js>) | brief、sessionId、options → 文本；sanitizeField 净化自由字段 |
| [createProjectReader](<../../../lib/core/project-reader.js>) | 概览、完整视图与知识读端口；关闭时收回 worker |

## 2. view/路径与纯度矩阵

“无权威写入”不等于纯函数；下表先限定 view 自身，再列入口附加行为。

| view/路径 | 读取域 | view 自身写盘/改状态 |
|---|---|---|
| brief | 已发布状态、commits、会话租约、注入时钟 | 无；仅内存健康摘要，不调度内容审计 |
| board | 状态、运行时租约与时钟 | 无；到期标记可能在 rev 不变时变化 |
| task | 状态、timeline、租约、时钟、资格预览 | 无；不实际回收，不授租约 |
| plan/plans | head、版本、任务进度 | 无；返回值按只读消费 |
| docs | 文档元数据克隆 | 无；不读外置文件 |
| doc | 内嵌元数据及 blob | 有同步读 I/O，无写；external 拒绝 |
| events | 内存 timeline | 无；不执行事件中的材料 |
| query health / health() | state、租约、时钟及证据内容 | 同步读 I/O，无修复/事件 |
| healthAsync | 捕获快照、worker 外部观测 | 无权威写入；有调度状态和 worker 生命周期 |
| buildDigest | 已传入 brief/session/options | 纯渲染，无时钟与 I/O |
| open 后 query / 普通 HTTP GET | 先 service.open 再 query | 冷开可 recover/heal，不能声称整链零写 |
| 原生管理工具读 | resolveHandle/open/touch 后 query | 可有恢复写和内存续租，不自动创建项目 |
| 专用 project-reader | writer 发布态或 lock=false 前缀 | 不 open writer、不修尾/恢复/续租 |
| knowledge 读端口 | 已保留来源及发布锚点 | 无权威写入；可写可重建派生缓存 |

管理入口的 open/touch 边界见[project](<../project/contract.md>)与[host](<../host/contract.md>)。

## 3. 输入校验域

内部 view 接收可信 handle 形状，不能拿任意 JSON 冒充已验证状态。
taskId/docId 必须由调用方提供；缺失或未知按实体查找失败处理。
planView 的未知 planId 返回 plan:null；完整 MCP 适配可将显式未知 ID 转 not-found。
plansView 的 includeArchived 仅严格 false 排除归档。
docsView 本身不执行 query 文本过滤；完整 reader 适配单独过滤标题。
eventsView 仅对整数 after/limit 应用默认与限幅，不是通用分页 schema。
docView 的 maxBytes 名称不能替代单位核对：同步实现按字符串 length/slice 截断。
MCP 完整视图另以 UTF-8 字节安全截断，不能从同步实现推导其预算。

isolatedHealth 的 maxAgeMs 必须有限、正且不超过实现上限；默认 30 秒。
错误参数和超时没有“上次健康”回退；输入域见[调度器](<../../../lib/core/health-audit.js>)。
专用 reader 的 ID、state、分页与 MCP 视图参数由共享 schema、reader 和适配共同校验。

## 4. 不变量与副作用边界

1. checkState/health 不修改输入状态、不追加事件、不执行证据命令。
2. 兼容 plan head 只在 checkState 的私有投影派生。
3. brief 的 evidenceAudit.status 为 unchecked；ok=false 不能解释成完整内容审计失败或通过。
4. fullHealth 返回 checks、warnings、counts、leases、intents 等本次诊断；不是存储修复结果。
5. health 的 hashChain 标签依赖已验证投影，不代表重新逐字节审计日志。
6. 审计 worker 只接收捕获数据和读取位置，不调用 service.init/open。
7. docView 的 null blob 是缺失错误，不是空正文；外置文档不按 inline 读取。
8. taskView 等可能返回状态别名，调用方不可修改它们或把 DTO 作为命令工作副本。
9. allowedOps 是当时的预览；expectedRev/fencingToken 和领域守卫仍在提交时验证。

完整证据观测严重度由[L1](<../../CONTRACT.md#错误码>)定义，不在本页复制错误全集。

## 5. 并发、幂等与关闭

普通同步投影不提供事务隔离，不得在跨 await 后沿用旧资格。
专用概览读取 writer.store.state，而不是可能处于 staging 的 handle.state。
冷读前后比对文件指纹，最多有限重试；无法稳定则拒绝发布。
外进程合法前缀只供展示，不证明同步完成，也不包含可靠运行时租约。

完整审计同 handle/rev 只合并在途 flight，不缓存完成结果。
rev 变更、关闭、年龄超限使本次结果失效，不能包装为 complete。
并发上限与排队上限属于进程内资源控制；worker 终止后才释放名额。
cancelHealth/reader.close 取消各自拥有的读取，不发业务补偿事件。
重复查询可能得到更新后的外部观测，不能按 cmdId 幂等理解读取。

## 6. digest 输入输出与隐含契约

buildDigest 不读调用历史、上一条工具响应或会话外状态。
includeRules=false 只省略 RULES，不裁剪其他正文；host 不得事后字符串删规则。
自由字段经 sanitizeField 单行化与截断，正文中的模板或命令不获得执行权。
handle.digest 先 briefView，故完整输入还包含运行时 lease/binding 与摘要时钟观测。
L1 的 state 三元组确定性不能被收窄理解为“只看持久项目 JSON”；边界调整先裁定 L1。
prompt 不得为了更新健康标记隐式调用 healthAsync。
单次 DTO/诊断不是证据正确性担保，warning 与不可观测不能隐藏。

## 7. 错误分类、兼容与验证

稳定 code/status 以[L1 错误码](<../../CONTRACT.md#错误码>)为准。
实体/入口错误要求修正参数；源损坏/版本拒读要求保留数据并维护处理。
忙、超时、源变化、快照过期要求重试新读取，不通过抢锁或修尾恢复。
正文超限应缩小范围或分页，不能静默截掉来源标记。

DTO 增加字段属于读面兼容评估；排序、空值和单位变化可能影响消费者。
事件可读性由[存储兼容](<../../CONTRACT.md#事件兼容契约fail-closed>)决定，快照不能绕过拒读。
知识缓存失效不改变项目 schema，不提供任务写权限。
验证入口：[digest 测试](<../../../test/core/digest.test.mjs>)、[隔离审计测试](<../../../test/ops/prompt-health-isolation.test.mjs>)、[reader 测试](<../../../test/core/project-reader.test.mjs>)。
