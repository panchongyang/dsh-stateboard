# 读模型模块设计

> 文档定位：L3 模块设计；L1 权威：[Query 与视图](<../../CONTRACT.md#23-query-与视图>)、[只读诊断](<../../CONTRACT.md#health--fsck-只读诊断>)、[Digest](<../../CONTRACT.md#digest>)。

本文解释投影与审计如何分工；调用限制见[内部契约](<contract.md>)，结构入口见[L2](<../read.md>)。

## 1. 职责与非职责

read 将已发布项目状态、运行时租约和历史记录组织为查询 DTO。
brief 为 prompt 提供小摘要，完整 health 为显式诊断提供状态与内容观测。
两者不共享“完整审计已通过”的含义，也不共享重 I/O 热路径。

**非职责**：

- 不推进任务状态、不回收租约、不修日志或迁移数据。
- 不执行 command/test 证据、不探测任意 URL、不判定交付正确。
- 不从项目标题推断身份，不给冷读结果授予 writer 资格。
- 不保存调用历史来改变 core digest，也不定义新的产品视图权限。
- 知识检索属于[knowledge](<../knowledge.md>)，不是普通 query 的别名。

## 2. 内部结构

| 实现 | 分工 |
|---|---|
| [views.js](<../../../lib/core/views.js>) | board/task/plan/plans/docs/doc/events/brief 投影 |
| [model.js](<../../../lib/core/model.js>) | 共用派生、进度和 allowedOps |
| [digest.js](<../../../lib/core/digest.js>) | brief 的确定性文本渲染与自由文本净化 |
| [health.js](<../../../lib/core/health.js>) | 内存摘要、同步兼容完整检查 |
| [fsck.js](<../../../lib/core/fsck.js>) | 私有投影上的不变量诊断 |
| [health-audit.js](<../../../lib/core/health-audit.js>) | 显式审计的限流、去重、时效与取消 |
| [health-audit-worker.js](<../../../lib/core/health-audit-worker.js>) | 捕获状态的文件/blob/Git 内容审计 |

入口挂在 [ProjectHandle](<../../../lib/core/handle.js>)，独立读取适配挂在[project-reader-views](<../../../lib/core/project-reader-views.js>)。
前者可被管理链持有；后者只使用捕获或验证的私有快照。
不要因函数同名而合并两者的打开、授权与生命周期行为。

## 3. 普通视图数据流

1. handle.query 先检查句柄未关闭，再分发同步视图函数。
2. board 汇总卡片、关注事项、活动计划与派发顺序。
3. task 组合任务、证据、关联文档、timeline 与操作资格预览。
4. plan 读取 head 和不可变版本；草案保留尚未发布的任务定义。
5. docs 只返回元数据，doc 才通过 store 读取内嵌 blob。
6. events 从既有 timeline 按 seq 过滤并取有界尾段。

卡片进度与计划进度复用领域计算，不写回百分比。
任务关联文档按 doc.links 反向查询，不创建第二份持久关系。
这些查询不会提交回收事件；allowedOps 只是预览，命令仍需重新校验。
部分返回值包含原状态对象引用，内部消费者必须按只读使用。

## 4. brief 与 digest 的热路径

brief 扫描任务和计划，选当前会话焦点、少量 attention 与 next ready。
历史送达信息从 store.commits 反向寻找最近 checkpoint 和验收记录。
healthSummary 只查看运行时租约与注入时钟，不读证据文件、blob、绑定或 Git。
它明确标记 evidence unchecked，而不是复用上次完整审计的绿色结果。

buildDigest 只渲染传入 brief，不取系统时钟、不读文件、不调用工具。
记录时间来自事件，标题、note 等自由文本经 sanitizeField 单行化和截断。
规则文字由该渲染器的 RULES 段集中产生，不从任务正文提取规则。
includeRules=false 只改变尾部规则段，供 host 的已注入会话去重。

必须区分两种确定性：

- 固定 brief、sessionId、options 时，buildDigest 是确定性渲染。
- handle.digest 先产生 brief；其租约和健康摘要采样运行时状态与时钟。
- 不能仅固定持久 state，就断言整条 handle.digest 链永远不变。

外部确定性口径以[L1](<../../CONTRACT.md#digest>)为准；修改该边界须先裁定契约。

## 5. 完整 health 的隔离路径

HTTP 和原生 board 的显式 health 调用 healthAsync，而不是同步 health。
调度器捕获 state/rev/meta、租约、取样时钟及 blob 读取位置。
worker 构造无 store.open 的审计句柄，再执行同步 fullHealth。
它重读外部内容，但不获取 writer、不 recover、不更新绑定注册表。

fullHealth 先调用 checkState，再检查租约与各任务证据。
checkState 在私有浅投影上派生兼容 plan head，不能借诊断修复输入。
隔离 worker 还保留不可观测证据 warning，不能把“读不到”解释为匹配。
健康结果描述本次捕获状态及随后外部观测，不是跨文件原子快照。

调度生命周期：

1. 同一 handle/rev 的在途请求合并。
2. 排队时若项目已关闭或 rev 改变，拒绝旧快照。
3. 返回时再次检查关闭、rev 与最大年龄。
4. 成功标 complete、snapshotAt/completedAt，cached=false。
5. worker 真正停止后才释放并发名额。

不缓存已完成结果，因为工作区文件/Git 可在项目 rev 不变时改变。

## 6. 锁外冷读与专用投影

[项目读取器](<../../../lib/core/project-reader.js>)先查同进程已发布 writer。
概览可直接从 writer.store.state 构造有界副本，避免读到命令工作态。
完整视图即使有 writer，也把捕获数据送 worker 进行投影和脱敏。
没有 writer 时，worker 用 lock=false store 验证并回放可观测前缀。
读取前后文件指纹变化时有限重试，不修尾、不恢复任务。

冷读没有运行时租约表，不能把持久 owner 当有效执行权。
完整视图将冷读 allowedOps 标不可用，隐藏 token、根目录和绝对引用。
完整 health 在该 worker 内同步执行，不再嵌套一个审计 worker。
只读水位是展示依据，不证明另一个进程已完成 fsync。
知识读取另有发布锚点、coverage 与派生缓存，不能混用其游标或额度。

## 7. 失败、降级与恢复

- 实体不存在按各视图语义返回空或 not-found，不能一律伪装空看板。
- 内嵌 blob 缺失是错误，不返回空正文；外置记录要求走外置读取端口。
- audit-busy/expired/stale 表示本次未完成，不能保留为健康通过。
- handle.close 取消其在途完整 health；reader.close 等待自有 worker 终止。
- 冷读源变化返回 read-unstable，调用者重新读，不抢锁或自动修复。
- 固定历史不可观测与内容不匹配保持不同严重度，详见[L1 错误分类](<../../CONTRACT.md#错误码>)。

恢复权仍在显式命令或运维路径；读层只报告事实与边界。

## 8. I/O 成本与阅读顺序

普通视图在主线程同步扫描、排序和 join；内存路径不等于零 CPU 成本。
board 全量卡片、task 的文档/timeline 扫描、brief 的历史反查随输入增长。
doc 有同步 blob I/O；同步 health 还会读取证据与 Git，不能放 prompt 回调。
隔离审计有状态 structured clone、worker 启动及外部内容重读成本。
其当前并发/队列界限在调度器定义，不是吞吐或容量保证。
冷读还要验证完整日志，快照不免除兼容检查；worker 只隔离阻塞位置。
完整 MCP 视图有正文和总输出预算，超限须缩窄读取。

阅读顺序：

1. [handle.query/digest/healthAsync](<../../../lib/core/handle.js>)：区分三个入口。
2. [views.js](<../../../lib/core/views.js>)与[digest.js](<../../../lib/core/digest.js>)：跟踪 brief 输入域。
3. [health.js](<../../../lib/core/health.js>)与[fsck.js](<../../../lib/core/fsck.js>)：区分摘要和完整检查。
4. [审计调度器](<../../../lib/core/health-audit.js>)与[worker](<../../../lib/core/health-audit-worker.js>)：检查过期与关闭窗口。
5. [项目 worker](<../../../lib/core/project-reader-worker.js>)与[视图适配](<../../../lib/core/project-reader-views.js>)：检查冷读和脱敏。

验证可从[prompt/health 隔离](<../../../test/ops/prompt-health-isolation.test.mjs>)、[digest](<../../../test/core/digest.test.mjs>)和[专用 reader](<../../../test/core/project-reader.test.mjs>)测试进入。
