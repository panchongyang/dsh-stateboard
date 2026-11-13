# 后端可读性基线与渐进迁移

## 1. 用途与边界

本文是后端阅读路径、后端注释细则与后续小批改进的单一入口，不另定义产品契约；全仓通用的注释写法见[项目框架约束 · 注释准则](<CONSTRAINTS.md#33-注释准则>)。[架构模块地图](<ARCHITECTURE.md#21-机器可校验的清单arch-map>)说明依赖方向，其清单检查验证已列项存在，不能据此证明磁盘文件全覆盖；[实现契约](<CONTRACT.md>)维护行为。本文按实际后端文件分组、选择承重阅读链，不复制契约全表。

范围是 `lib/shared`、`lib/core`、`lib/host` 与[后端插件入口](<../lib/index.js>)。客户端源码、生成 bundle、浏览器查询模块不在本计划内，前端可读性/类型迁移另立范围。维护脚本和测试用于核对实现，不因此成为批量注释对象。

**当前交付是文档基线，不是批量实现、重构或更换生产加载路径的授权。** 后端补齐目标是每个函数都有中文用途与参数作用说明，包括小工具函数；复杂逻辑再补不变量、副作用和失败路径。参数、返回值与数据形状的 TS 类型表达作为这份说明的一部分，随中文注释在同一小批中渐进补齐，不另设完整类型化工程。按批完成，不要求一次补齐，不设全仓注释率。阅读基线以“能沿链解释职责、不变量、额外 I/O 和失败结果”为验收对象，不以注释行数衡量。

[TypeScript 工具链](<TYPESCRIPT.md>)提供开发期可检查的说明：`strict:false`、`checkJs:false`，允许显式 any、局部类型缺口，不要求清零或逐个论证，也不设单批或全局完整类型门槛。类型表达不替代每函数中文用途、why 与边界，不引入装饰器或 TS 运行时构造/框架。现有 JS 未做全量语义类型检查；后端新增 TS 自动纳管，平台中立 base 可由未来浏览器配置独立继承。Node >=22 的生产入口继续运行 JS，`noEmit` 检查不提供生产 TS 加载/编译路径；不能只改扩展名就声称运行可用。保持 JS 并用 JSDoc/逐文件 `@ts-check` 表达局部说明也是可选的低成本方式，不强制某一种实现形式。

## 2. 六条关键阅读链

按“调用者 → 入口 → 规则/数据 → 返回与失败”阅读。下面的源码符号是定位点，不代表整个文件已经满足注释目标。

### A. 领域写入：命令、守卫、intent、租约到提交

1. [共享契约](<../lib/shared/contract.js>)的 `COMMAND_OPS` → [命令注册表](<../lib/core/commands/index.js>)的 `COMMAND_HANDLERS`。参数/返回/事件语义查[实现契约](<CONTRACT.md#22-命令信封>)，不要从工具参数表推导领域授权。
2. [handle](<../lib/core/handle.js>)的 `ProjectHandle.command`：先检查命令形状、只读、cmdId 去重、项目 rev 与归档状态，再进入 `_executeOnWorkingCopy`。后者克隆 state/lease，在工作投影上 `normalizeExpiredLeases` 后分发；处理器拒绝时还原原 state/lease。实体 rev 校验还要读[lease](<../lib/core/lease.js>)的 `assertRev` 对 `_lapsed.baseRevs` 的处理。
3. [任务工作命令](<../lib/core/commands/task-work.js>)的 `taskClaim` / `taskBegin` / `taskSubmit` → [租约守卫](<../lib/core/lease.js>)的 `assertLease` / `grantLease` / `isLeaseReclaimable` → [intent 结算](<../lib/core/intent.js>)的 `settleOpenIntent`。到期、可续与可回收不是同义词；open intent 的副作用清单是声明，不是宿主核验，`unknown` 不能当作 `stopped` 关闭。
4. 回到 `_appendEvents` → [store](<../lib/core/store.js>)的 `JsonlStore.append` → [写适配](<../lib/core/store/writes.js>)的 `appendCommitLine`。handle 显式接收 append 返回的 state，`assertStateAttached` 防止写入落在脱钩对象上。到期事件与业务事件的顺序、token 和 state 的提交边界要一起核对，不能在注释中承诺多次提交等价。

**失败边界**：工作副本回滚不等于全部磁盘 I/O 回滚。[内嵌写入](<../lib/core/commands/doc.js>)的 `docPut` 在允许写入时可能先写 blob 再检查 baseRev；[证据归一化](<../lib/core/evidence.js>)会读取文件/Git。日志 I/O 结果不明走 `log-write-uncertain` 并降只读，不能说“任何失败都零字节写入”；后置 relocate 元数据失败由 `_applyRelocateSafe` 返回 warning。持久化定义与恢复条件以[命令提交契约](<CONTRACT.md#22-命令信封>)为准。

### B. 项目身份、读取与 host 准入

[service](<../lib/core/service.js>)的 `resolveWorkspace` → [身份发现](<../lib/core/identity/discover.js>)的 `resolveWorkspace` / `walkUp`，结合[绑定索引](<../lib/core/identity/bindings.js>)与[注册表](<../lib/core/identity/registry.js>)判断目录归属；身份冲突、未绑定 marker 与本机数据缺失不能自动合并或新建替代。细节查[项目身份](<IDENTITY.md>)。

区分三种入口：

- `peekProjectState` → [store](<../lib/core/store.js>)的 `readStateWithoutLock`：无项目锁回放，不做 recovery；不可读返回 null，不是“项目不存在”的证明。
- `open` / `openByWorkspace` → `_openSync`：可能获取写锁、执行 `_healMeta` 和 `recover`；看似读取的冷打开可能写派生元数据及恢复事件。`refreshFromDisk` 还会确保目录存在，不能把整个 service 标成纯读。
- [工具共享入口](<../lib/host/tools/shared.js>)的 `resolveHandle`：校验 owning agent/cwd，等待 ready，打开项目；仅在调用方请求 create 时尝试创建，随后 `touch` 并更新会话映射。[HTTP 分发](<../lib/host/routes.js>)的 `handleApi` 先调用 `authFailure`，拒绝请求在等待 ready、解析资源和 open 前返回 403；放行后才继续解析和部分写入准入，再 open。`prepareCommandWrite`、`prepareExternalWrite` 及内嵌策略的共享 core 校验只能说明各自覆盖的拒绝窗口，不能推广成所有 HTTP 错误无写入。

[项目列表读取器](<../lib/core/project-list-reader.js>)的 `ProjectListReader` 与[其 worker](<../lib/core/project-list-worker.js>)服务展示摘要，不是写准入权威。注释需要区分内存投影、文件指纹缓存、冷回放与写入判断，避免把显示用缓存引入授权路径。

### C. 查询投影、digest 与完整 health 的成本

[handle](<../lib/core/handle.js>)的 `query` → [views](<../lib/core/views.js>)的 `boardView` / `taskView` / `briefView`：投影 DTO、关联文档与 allowedOps；allowedOps 来源仍是[model](<../lib/core/model.js>)，不能在 host/views 复制守卫。

`digest` → `briefView` → [health](<../lib/core/health.js>)的 `healthSummary` → [digest](<../lib/core/digest.js>)的 `buildDigest` / `sanitizeField`。简报不重新审文件/blob/绑定/Git，并如实标 `evidence unchecked`；`buildDigest` 对传入 brief 生成有界文本，不代表包括上游时钟/租约取样在内的所有查询都没有时间依赖。

**额外 I/O 例外**：[views](<../lib/core/views.js>)的 `docView` 读 blob；`healthView` 调同步 `handle.health`，完整审计可能读取证据、文件、绑定与 Git。host 显式完整审计走 `healthAsync` → [隔离审计](<../lib/core/health-audit.js>)的 `isolatedHealth` → [审计 worker](<../lib/core/health-audit-worker.js>)；不要把该工作放回 prompt 热路径。队列/时效拒绝是拒绝，不是健康通过，worker 边界也不意味着已经完成宿主或 UI 验收。

### D. 外置文档、固定内容与 Git 降级

[外置命令](<../lib/core/commands/doc-external.js>)登记 locator/元数据，不代替编辑器写正文。观察走[external-observe](<../lib/core/documents/external-observe.js>)的 `inspectExternalDoc` → `readLocator` → [reader](<../lib/core/documents/read.js>)的 `readDocument` → [locator](<../lib/core/documents/locate.js>)的 `validateRelPath` / `locateDocument`。inspect 的 availability 与命令抛错口径不同；观察缓存不用于 confirm 或正式证据，绑定根不能取会话 cwd 代替。

`taskSubmit` → [evidence](<../lib/core/evidence.js>)的 `normalizeEvidence` → [fixed-auto](<../lib/core/documents/fixed-auto.js>)的 `autoExternalEvidence` / `fixedEvents` → [fixed-content](<../lib/core/documents/fixed-content.js>)、[fixed-worktree](<../lib/core/documents/fixed-worktree.js>)、[fixed-git](<../lib/core/documents/fixed-git.js>)。工作区字节哈希和 Git blob 字节哈希是不同校验域。可安全固定时，来源记录/`doc/content-fixed` 与任务证据同 commit；自动固定失败可降 `current-only` + `fixedReason`，不伪称 pinned。

**不是所有失败都降级**：`autoExternalEvidence` 先读当前文件；不可读且没有可用哈希时会抛错，非 UTF-8 有原始哈希则有专门降级分支。固定对象读取/审计还必须区别不可观测 warning 与结构/来源/hash 不符 error，不可用当前正文冒充固定版本。[Git 执行边界](<GIT-EXECUTION.md>)及[git-exec](<../lib/core/git-exec.js>)的 `resolveGitExecutable` / `assertReadOnlyGitArgs`约束只读子进程，不安装 Git、不运行内容转换器、不管理分支或 worktree；完整定义见[固定内容证据](<DOC-EXTERNAL-EVIDENCE.md>)与[D1 契约](<WORKSPACE-DOCUMENTS-CONTRACT.md>)。

### E. tools / HTTP 的翻译与错误

[工具注册](<../lib/host/tools/index.js>) → [task 工具](<../lib/host/tools/task.js>)的 `execute` → [tools/shared](<../lib/host/tools/shared.js>)的 `actorOf` / `resolveHandle` / `run` / `fail` → `handle.command`。工具用领域错误生成 next 提示，不执行 command/test 证据里的 ref，不把自述审计变成实际执行证明。

[HTTP 注册与分发](<../lib/host/routes.js>)的 `registerRoutes` / `handleApi` → [commands route](<../lib/host/routes/commands.js>)的 `prepareCommandWrite` / `commandsRoute` → `handle.command`。[auth](<../lib/host/auth.js>)的 `authFailure` 先判断请求来源，再比较 token，返回 `fetch-site-rejected` / `origin-rejected` / `token-mismatch` 或 null；`checkAuth` 保留布尔接口。`handleApi` 将鉴权拒绝直接映射为带具体 code 的 403，来源拒绝不能靠刷新 capability 修复。[host util](<../lib/host/util.js>)的 `readJson` 控制 body 上限，`sendError` 映射后续 BoardError；未知异常只回通用 internal，细节留本机日志。工具错误封装与 HTTP error envelope 不相同，不能为了注释“统一”而改返回形状。

### F. 宿主生命周期与 prompt

[插件入口](<../lib/index.js>)的 `apply` 创建 runtime/ready，注册工具、可选 web 路由、agent 事件和 service 清理。[lifecycle](<../lib/host/lifecycle.js>)的 `attachAgent` / `detachAgent` 对接 handle 的 attach/detach，可能产生会话/恢复/租约事件，不是单纯 Map 操作；项目失败记录 warning，不使会话创建失败。

[prompt](<../lib/host/prompt.js>)的 `installPrompt` / `disposePrompt` 管理每 agent 的动态 section。每次组装查当前 handle，缺项目/closed 返回空文本；digest 失败记录 warning 并返回空文本。`interpolate:false` 保证看板自由文本按字面数据进入宿主，不能以字符替换替代这条契约。重复挂载防护、dispose 的异步失败和工具 brief 的规则去重一起查[Prompt 契约](<CONTRACT.md#34-prompt>)，不把 best-effort 写成“所有能力正常”。

## 3. 中文注释口径

每个函数都补中文用途与参数作用说明，包括普通/私有函数、小工具函数、类方法、箭头函数和回调；按[注释准则](<CONSTRAINTS.md#33-注释准则>)优先写成紧贴声明的 JSDoc，让调用处的悬浮提示能读到。简单函数一句话说明用途即可；注册操作里的匿名回调可在注册处说明，不为每个回调套重复模板。复杂逻辑在用途说明之外解释 **why、前提和边界**，跟随所描述的最小模块/函数/分支维护：

- 模块头：负责什么、不负责什么、上游/下游是谁；有关键共享状态或 I/O 时说明所有者和生命周期。
- 函数用途：说明它在调用链中解决什么问题，不止复述名称。复杂/承重函数还解释调用前提、输入来源/校验域、输出含义、可观察副作用，不重复类型字段。额外磁盘/Git/worker I/O 与内存更新分别说明。
- 关键分支：保护哪个不变量、为什么必须先后这样做、去掉会发生什么；失败是否抛错、返回分类结果、warning 或降级，以及保留什么状态。不能把“无领域提交”扩成“无任何副作用”。
- 符号/错误码/字段保留原名，解释用中文；沿用有价值的英文说明或引用，不为了中文化删掉约束。只翻译“执行 X”、逐行复述语法、重复类型/契约整表都不是目标。
- 类型说明：用 TS 表达触达处的参数、返回值和数据形状，随中文说明同批补充；已有类型可复用，any 与局部缺口可保留，不为追求精确类型反向重写运行逻辑。中文用途与复杂边界仍需单独写清，不把类型签名当作每函数中文说明。
- 注释与类型说明描述实际实现；若代码与契约不一致，记录需独立核对的问题，不通过说明发明修复、隐藏缺口或扩大产品职责。涉及职责、口径或范围取舍且授权不足时，先提具体问题。

以下均是**拟补示例，未写入源码**；不是已完成注释覆盖的声明。

### 示例一：模块职责与冷打开副作用

拟用于 [service](<../lib/core/service.js>) 模块头，结合 `_openSync` / `peekProjectState`：

```js
// 管理项目注册表、本机绑定和进程共享 handle；领域状态迁移由 handle/commands 负责。
// open 不是纯读：冷打开可能取得写锁、修复派生 meta，并回收上次进程的在途工作。
// 只需在打开前判断持久策略时看 peekProjectState；它不恢复项目，null 仅表示不可读，
// 不能据此推断身份空闲或直接创建新项目。
```

### 示例二：工作投影与提交不变量

拟用于 [handle](<../lib/core/handle.js>) 的 `_executeOnWorkingCopy` 附近：

```js
// 在工作投影上先归一化可回收租约，再计算业务事件，避免旧任务快照覆盖回收结果。
// 处理器抛错时恢复原 state/leases；成功事件由 command 合并成同一 commit 后交 store。
// 这里保护的是内存投影，不是通用 I/O 事务：处理器已写的 blob 不能靠换回引用撤销。
// append 后必须接回 store 的 state 并检查绑定关系，否则后续读取可能静默丢失已写事件。
```

### 示例三：输入/输出、副作用与降级窗口

拟用于 [fixed-auto](<../lib/core/documents/fixed-auto.js>) 的 `autoExternalEvidence`：

```js
// 输入是已登记文档的 locator，读取它所属绑定根下的当前字节，而非会话 cwd。
// 先取得当前哈希，再尝试只读 Git 固定；可固定时返回 Git blob 哈希与固定身份，
// 不能固定时保留当前字节哈希并标 current-only/fixedReason，不阻塞这次证据提交。
// 当前文件无法读取且没有可用哈希仍会抛错；非 UTF-8 但有原始哈希走专门降级分支。
// 此函数读取文件/Git，但不写来源事件；返回的 approval 由后续 fixedEvents 暂存到
// 命令工作投影并产出事件，最终是否持久化仍取决于整个 submit 的审计与 append。
```

### 示例四：生命周期失败不伪装成功

拟用于 [prompt](<../lib/host/prompt.js>) 的 section 配置：

```js
// 每次组装读取会话当前 handle；没有项目或摘要失败时不注入内容，失败另记 warning。
// 看板标题/备注来自其他会话，只能按数据投递：关闭宿主插值，不能让 {{...}} 被解释。
// 这是动态 section 的契约，不是清洗个别字符的补丁；工具 brief 去重也依赖挂载状态。
```

## 4. 中文与类型说明批次：按阅读风险切片，不是开工指令

下面各批在同一文件/符号集合内补中文说明与适量 TS 类型说明，保持实际运行语句、导入导出、事件顺序、错误/降级和测试断言不变；不混入抽函数、移动职责、性能修复或历史修复。类型说明是本批注释工作的一部分，不要求该集合一次完整类型化，也不因尚有 any/缺口阻塞整批。文件集合是拟实施上限，可进一步按所列符号拆小，不顺手扩展。模块/依赖规则仍归[架构文档](<ARCHITECTURE.md#21-机器可校验的清单arch-map>)维护，文件集合还需对照磁盘复核，未列文件不代表“无需说明”或已验收。

可证明只增加中文与可擦除类型说明、运行行为不变的候选按 R1 局部整理评估；这不证明任意 TS 语法都无行为。实际改动运行语句、模块加载、emit/构建、契约或其他行为时，按[风险规范](<TESTING-POLICY.md>)单独判级并验证，不能用“类型也是注释”豁免。每批交非实现者独立复查：对照源符号/调用者与契约，检查新增承诺和负面路径，不以自测代替独审。下表“专项复查”是该独审的重点，不要求新增固定人员角色。

| 批次 | 明确文件集合与主要阅读目标 | 主要风险 / 专项复查 | 定向验证组 |
|---|---|---|---|
| C1 契约入口 | [shared/contract](<../lib/shared/contract.js>)、[shared/events](<../lib/shared/events.js>)、[commands/index](<../lib/core/commands/index.js>)：枚举与分发/兼容分类 | 误把枚举当守卫；核对冻结表面和事件分类，不增删 op | V1 |
| C2 命令事务 | [handle](<../lib/core/handle.js>)：只覆盖 `command`、`_executeOnWorkingCopy`、`_appendEvents`、`_applyRelocateSafe`、`assertStateAttached` | 把投影回滚说成全 I/O 原子；核对 staging/commit/后置 warning | V2 |
| C3 租约与意图 | [lease](<../lib/core/lease.js>)、[intent](<../lib/core/intent.js>)：到期/可续/回收、rev/token、stopped/unknown | 恢复条件和无进展期限误述；复查时钟、epoch 与失败保留状态 | V3 |
| C4 工作与审查 | [task-work](<../lib/core/commands/task-work.js>)、[task-gov](<../lib/core/commands/task-gov.js>)、[audit](<../lib/core/audit.js>)：claim/begin/submit/verify/reconcile | 自述变核验、human 兜底缺失；核对事件顺序和独立性边界 | V3 |
| C5 项目打开 | [service](<../lib/core/service.js>)：只覆盖 `resolveWorkspace` / `open` / `openByWorkspace` / `_openSync` / `peekProjectState` / `peekProject` / `_healMeta` 与共享 handle 辅助；[project-list-reader](<../lib/core/project-list-reader.js>)、[project-list-worker](<../lib/core/project-list-worker.js>) | open 隐含恢复、列表缓存误用作准入；复查锁/共享引用和 worker 收尾 | V4 |
| C6 身份 | [identity/discover](<../lib/core/identity/discover.js>)、[bindings](<../lib/core/identity/bindings.js>)、[registry](<../lib/core/identity/registry.js>)、[ops](<../lib/core/identity/ops.js>) | 自动绑定/错误合并的错误承诺；核对 registry 写入、冲突与降级 | V4 |
| C7 读模型 | [views](<../lib/core/views.js>)、[digest](<../lib/core/digest.js>)、[health](<../lib/core/health.js>) | 一概称纯读或健康通过；复查 blob/完整审计例外、unchecked 与有界文本 | V5 |
| C8 隔离审计 | [health-audit](<../lib/core/health-audit.js>)、[health-audit-worker](<../lib/core/health-audit-worker.js>) | worker 生命周期、stale/超时误称缓存命中；核对取消、并发与结果有效期 | V5 |
| C9 持久化 | [store](<../lib/core/store.js>)、[store/writes](<../lib/core/store/writes.js>)、[lock](<../lib/core/store/lock.js>)、[format](<../lib/core/store/format.js>)、[files](<../lib/core/store/files.js>) | 过度承诺原子性/锁能力；复查半尾恢复、uncertain、快照/侧文件 | V2 |
| C10 文档观察 | [doc-external](<../lib/core/commands/doc-external.js>)、[external-model](<../lib/core/documents/external-model.js>)、[external-observe](<../lib/core/documents/external-observe.js>)、[locate](<../lib/core/documents/locate.js>)、[read](<../lib/core/documents/read.js>) | locator/哈希域/缓存混淆；复查路径拒绝、availability 与命令错误 | V6 |
| C11 固定证据壳 | [evidence](<../lib/core/evidence.js>)、[fixed-auto](<../lib/core/documents/fixed-auto.js>)、[fixed-reference](<../lib/core/documents/fixed-reference.js>)、[shared/fixed-schema](<../lib/shared/fixed-schema.js>) | 降级吞掉真实错误；核对 current-only/pinned、同 commit 屏障和硬审计 | V6 |
| C12 Git 字节 | [fixed-content](<../lib/core/documents/fixed-content.js>)、[fixed-git](<../lib/core/documents/fixed-git.js>)、[fixed-worktree](<../lib/core/documents/fixed-worktree.js>)、[external-git](<../lib/core/documents/external-git.js>)、[git-exec](<../lib/core/git-exec.js>) | 混淆 Git/工作区字节或安全可执行文件来源；复查只读/无转换器与不可观测 | V6 |
| C13 tools 翻译 | [tools/shared](<../lib/host/tools/shared.js>)、[tools/task](<../lib/host/tools/task.js>)、[tools/doc](<../lib/host/tools/doc.js>)、[tools/board](<../lib/host/tools/board.js>) | create/touch/读写准入与错误 next 误述；不改 schema/参数/领域规则 | V7 |
| C14 HTTP 翻译 | [routes](<../lib/host/routes.js>)、[routes/commands](<../lib/host/routes/commands.js>)、[routes/docs](<../lib/host/routes/docs.js>)、[auth](<../lib/host/auth.js>)、[host/util](<../lib/host/util.js>) | 把局部 pre-open 校验推广到全部错误；复查鉴权、未知异常不泄露路径 | V7 |
| C15 宿主装配 | [入口](<../lib/index.js>)、[lifecycle](<../lib/host/lifecycle.js>)、[prompt](<../lib/host/prompt.js>) | best-effort 误述、重复挂载/未释放；复查字面文本、ready 与会话事件 | V5、V7 |

后续补齐批次继续覆盖全部函数，而非只挑复杂函数；下列集合补充首轮未覆盖的文件/符号，仍不代表本卡授权实施：

| 批次 | 明确文件集合与主要阅读目标 | 主要风险 / 专项复查 | 定向验证组 |
|---|---|---|---|
| C16 任务输入 | [command-shape](<../lib/core/command-shape.js>)、[task-intake](<../lib/core/commands/task-intake.js>)、[task 注册](<../lib/core/commands/task.js>)：字段白名单、依赖与注册 | 把输入形状检查当成所有领域守卫；复查拒绝窗口与派生 ready | V1、V3 |
| C17 计划 | [plan 注册](<../lib/core/commands/plan.js>)、[plan-life](<../lib/core/commands/plan-life.js>)、[plan-members](<../lib/core/commands/plan-members.js>)：版本/生命周期/成员关系 | 将成员更新说成原地改版本；复查 orphan、归档/focus 边界 | V8 |
| C18 会话与项目生命周期 | [project 命令](<../lib/core/commands/project.js>)、[session 命令](<../lib/core/commands/session.js>)；[handle](<../lib/core/handle.js>)除 C2 的其余函数；[service](<../lib/core/service.js>)除 C5 的其余函数，两个大文件各自拆独立候选 | 共享引用、创建失败/恢复/绑定 I/O 被遗漏；复查失败结果不明及派生写入 | V3、V4、V7 |
| C19 状态与归一化 | [model](<../lib/core/model.js>)、[normalize](<../lib/core/normalize.js>)、[contracts](<../lib/core/contracts.js>)，每文件独立候选：投影/allowedOps、输入/策略、事件构造 | 领域守卫和显示提示混同；复查事件数据、默认值及回放兼容 | V1、V3、V8 |
| C20 基础辅助 | [errors](<../lib/core/errors.js>)、[util](<../lib/core/util.js>)、[schema](<../lib/core/schema.js>)：错误对象、I/O 辅助与版本拒绝 | 小工具函数被漏注释，原子替换被过度承诺；复查每个函数用途与 I/O | V1、V2 |
| C21 内嵌档案 | [doc](<../lib/core/commands/doc.js>)：默认写入禁用与特权 fixture 路径 | 把正文 blob 写与事件提交混为一谈；复查 policy、历史档案和失败物理残留 | V9 |
| C22 检查与修复 | [fsck](<../lib/core/fsck.js>)、[repair](<../lib/core/repair.js>)，每文件独立候选：状态检查与日志修复入口 | 将检查说成自动修复、将代码回退说成数据回退；不执行真实修复 | V9 |
| C23a 迁移材料 | [migration-inventory](<../lib/core/documents/migration-inventory.js>)、[migration-fixture](<../lib/core/documents/migration-fixture.js>)、[migration-blob](<../lib/core/documents/migration-blob.js>)、[migration-backup](<../lib/core/documents/migration-backup.js>)：盘点/合成夹具/原正文/备份 | 只读盘点与备份 I/O 混淆；独审分清材料与真正应用的边界 | V9 |
| C23b 迁移应用 | [migration](<../lib/core/documents/migration.js>)、[migration-record](<../lib/core/documents/migration-record.js>)、[migration-archive](<../lib/core/documents/migration-archive.js>)、[doc-migration](<../lib/core/commands/doc-migration.js>)：离线迁移记录与归档 | 误述成可从 host 随意调用；复查事件、原正文保留与失败恢复，不执行真实迁移 | V9 |
| C24a 读端资源 | [routes/board](<../lib/host/routes/board.js>)、[events](<../lib/host/routes/events.js>)、[health](<../lib/host/routes/health.js>)、[shared](<../lib/host/routes/shared.js>)：查询参数/DTO/完整审计入口 | 把上游 open 成本遗漏，health 异步边界失真；不改 envelope | V5、V7 |
| C24b 其他资源 | [routes/plans](<../lib/host/routes/plans.js>)、[projects](<../lib/host/routes/projects.js>)、[tasks](<../lib/host/routes/tasks.js>)：资源翻译/项目列表 | 读写/创建混淆；核对 listProjectsAsync 与 actor 来源，不复制规则 | V4、V7、V8 |
| C25 工具装配余项 | [tools/index](<../lib/host/tools/index.js>)、[tools/plan](<../lib/host/tools/plan.js>)、[tools/session](<../lib/host/tools/session.js>)、[兼容壳](<../lib/host/tools.js>)：注册、计划/会话工具与兼容导出 | 误将兼容壳当实际注册入口；复查回调/箭头用途及 schema 不变 | V1、V7、V8 |

以上批次共用行为保持、范围与按实际影响判级的边界。执行每批时逐个核对该集合中的函数声明/表达式、方法和回调：已有准确中文用途可保留；没有则补用途与参数作用说明，复杂处再补边界，并在触达处渐进补参数/返回/数据形状的类型说明。不要因其私有、短小或匿名而跳过中文用途；批次拆分时记录剩余符号，类型缺口可保留，不以文件已出现一次当作全文件完成。

每批除定向组外，还核对 `git diff --check`、`npm run check:architecture`；有类型说明时运行 `npm run typecheck`、`npm run test:types` 并准确记录实际检查范围，不要求完整类型覆盖。独审需核对运行语句、值导入导出与加载入口是否保持；只改中文时可比较去除注释后的执行 token，有类型变化时还需区分可擦除说明和有运行行为的语法，不能用编译检查通过证明行为未变。具体核对方式由实施者按实际路径选择，不为此新增产品工具或依赖。

### 定向验证组（后续批次使用，本基线不宣称已执行）

命令在各自候选中执行，使用[独立测试环境](<TEST-ENV.md>)要求的白名单 HOME/USERPROFILE/DSH/XDG/npm/TEMP 与合成 fixture，不指向真实 store/profile。host 组需已有兼容宿主开发依赖，缺依赖/skip 如实报告，不在根目录安装依赖补环境。定向测试不能替代风险规范要求的完整门禁、独审或经授权的宿主验证。

```text
# V1 契约/分发
node --test test/contract-parity.test.mjs test/api-surface.test.mjs
# V2 提交/日志/失败恢复
node --test test/alias-guard.test.mjs test/commit-boundary.test.mjs test/store-faults.test.mjs test/replay-snapshot.test.mjs test/lock.test.mjs
# V3 租约/intent/工作审查
node --test test/lease-renew.test.mjs test/lease-reclaim.test.mjs test/intent-settlement.test.mjs test/review-governance.test.mjs test/fsck-intents.test.mjs
# V4 身份/打开/列表
node --test test/identity.test.mjs test/identity-conflicts.test.mjs test/handle-lifecycle.test.mjs test/project-list-performance.test.mjs
# V5 简报/隔离审计/prompt
node --test test/digest.test.mjs test/prompt-health-isolation.test.mjs
# V6 文档/固定内容/Git
node --test test/doc-read.test.mjs test/doc-external.test.mjs test/doc-fixed-auto.test.mjs test/doc-fixed-head-race.test.mjs test/doc-fixed-evidence.test.mjs test/git-exec.test.mjs
# V7 host 翻译/装配（含前置依赖检查）
npm run test:host
# V8 计划/投影
node --test test/plan-acceptance.test.mjs test/plan-concurrency.test.mjs test/core.test.mjs
# V9 档案/完整性/离线迁移（仅合成 fixture）
node --test test/doc-inline-write-policy.test.mjs test/doc-inline-write-boundaries.test.mjs test/fsck-intents.test.mjs test/repair-log.test.mjs test/doc-migration.test.mjs test/doc-migration-write.test.mjs
```

首轮承重链与后续补齐可以按授权拆分、调整顺序；全后端每函数用途是逐批目标，不是本卡或首轮完工条件。新增/改名文件时相应更新批次定位与架构文档，不用静态清单替代实施时的磁盘/符号复核。

## 5. 随 C 批次补充的类型说明参考

类型检查规则/工具链不在此重做或严格化。下表 T1–T4 仅定位 C 批次触达时可写的类型说明，不是独立阶段、额外 ready 队列或整轮迁移任务；同一文件/符号由一个实际批次承接，不能再另开重复类型工作。TS 表达参数、返回值和数据形状等可检查说明，与中文用途/why/边界同批渐进补；允许 any 和部分类型缺失，不要求跨层精确传递或一次完整类型化。

| 参考位置 | 随哪个 C 集合触达 / 说明对象 | 行为保持与独审重点 | 适用验证 |
|---|---|---|---|
| T1 基础说明 | C20 的 [errors](<../lib/core/errors.js>) 与 C7 的 [digest](<../lib/core/digest.js>)：错误字段、brief 输入和文本返回 | 类型不替代构造器/辅助函数中文用途；不改错误 instanceof、导出或文案，保留宽松边界 | 类型检查与 V1/V5；涉及 host 错误再加 V7 |
| T2 共享形状 | C1 的 [contract](<../lib/shared/contract.js>)、[events](<../lib/shared/events.js>) 与 C11 的 [fixed-schema](<../lib/shared/fixed-schema.js>)：既有契约值/事件/固定身份的形状 | 不改枚举值/事件分类、不扩大运行表面；独审核对值导出和消费方，不要求所有字段精确类型化 | 类型检查与 V1/V6/V7，按实际风险补门禁 |
| T3 读模型形状 | C7 的 [views](<../lib/core/views.js>)、[health](<../lib/core/health.js>)：DTO、handle/lease 与审计边界 | 不拆 query 模块、不把全部视图假设成纯函数；保留 blob/审计 I/O，中文写清成本而非只给签名 | 类型检查与 V5/V6，按实际风险补门禁 |
| T4 host 边界说明 | C14 的 [routes/commands](<../lib/host/routes/commands.js>)：`assertCommandBody` / `prepareCommandWrite` / `commandsRoute`；C13 的 [tools/shared](<../lib/host/tools/shared.js>)：`actorOf` / `fail` / `run` 等函数输入输出 | 随该文件的每函数中文用途一起补，不另建 host 类型迁移义务；可用 any，不要求 core/shared 先完整类型化。不改 pre-open 校验、actor、错误封装或领域守卫 | 类型检查与 V7，按实际风险补门禁/隔离加载验证 |

这里的类型检查指现有 `npm run typecheck`、`npm run test:types`；沿用上节白名单环境、合成 fixture 与 host 依赖隔离要求，不代替运行验证。生产模块若涉及 `.ts` 改名、JS 产物/加载/打包、import 后缀或 emit，需单独按实际行为判级、说明可执行路径并验证；`noEmit` 不提供这些能力，也不证明任意 TS 语法可安全擦除。保持 JS 并用 JSDoc/逐文件 `@ts-check` 也是可选表达，不强制作为所有批次的实现形式；不引入装饰器或 TS 运行时构造/框架。

## 6. 去重、独立事项与交付核对

- **读取/准入/生命周期治理**：现有独立架构治理事项承接职责拆分。本基线只揭示 `open`、recover、touch 与 host pre-open 校验，不实施新 ProjectReader、改准入顺序或移动恢复职责；C5/C13/C14 实施前先核对该事项的最新决定，避免注释马上失真。
- **查询模块 v2**：[权威规格](<specs/query-module-v2.md>)是浏览器 WHERE 模块，与本文后端 views/digest 阅读路径不同；不复建 query 骨架、不把后端抽象设计捆绑到前端计划。
- **TS 工具链与同批说明**：[工具链现状](<TYPESCRIPT.md>)是既有能力，不另设第二套配置/依赖或独立类型迁移阶段；后续文件按中文与类型说明同批承接，host 不等待 core/shared 完整类型化。批次登记由负责人对照既有任务/计划去重，明确不重叠的文件/符号，本公共入口不存真实看板 ID，也不自行创建实施卡。
- **文字与实现差异**：发现差异时，在本机证据/既有事项记录“位置、事实、影响、所属事项”，按实际源码说明当前链，待独立核对，不在注释批次修历史问题或修改命令语义。

文档基线按 R0 验证：新增链接/文件/源码符号存在，人工抽查注释样例与真实分支、TS 口径及契约一致，`git diff --check`，确认仅文档差异；可运行只读 `npm run check:architecture`。不为本文运行 strict/stores gate、真实宿主、UI 或重启。已有门禁红项独立留证，不修、不隐藏、不宣称全绿，也不把它们当作文档或 TS 工作的隐含前置条件。

后续每批最小交接包括：实际文件/符号范围、非目标、候选与目标基线、行为保持/运行产物说明、风险与独审结论、真实验证命令及 pass/fail/skip、未覆盖和独立事项。证据/实测日志放本机 `.evidence`，现行文档只保留当前事实；交付流程仍按[完整工作流](<design/task-delivery-workflow.md>)执行。
