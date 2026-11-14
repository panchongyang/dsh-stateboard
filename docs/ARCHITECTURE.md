# 架构与模块地图

本文是 L2：说明分层、依赖、运行时入口和产物；产品行为以 [L1 实现契约](<CONTRACT.md>) 为准。各模块的代码入口和结构事实见下列模块页；术语、权限与降级分别见[术语表](<GLOSSARY.md>)、[信任边界](<TRUST-BOUNDARIES.md>)、[兼容与降级](<COMPATIBILITY.md>)。

## 0. 系统上下文

![图 1：系统上下文与信任边界](<diagrams/context.svg>)

- UI、DSH 工具与本机 MCP 汇入同一 core；宿主身份与领域状态分开。
- 工作区和 Git 是读取来源，不是命令执行入口。
- 图中部署边界与 import 分层不同；模块入口见 [host](<modules/host.md>)、[project](<modules/project.md>)、[client](<modules/client.md>)。

## 1. 分层与依赖方向

![图 2：分层依赖与三个入口](<diagrams/layers.svg>)

- 实线指向被依赖层；shared 是依赖终点，core 不认识 DSH 或浏览器。
- client 与 host 通过 HTTP 通信，不存在 client import host。
- 三个入口把身份和参数送到 core；适配器不承接领域状态机。

| 代码层 | 允许依赖 | 禁止依赖 | 模块入口 |
|---|---|---|---|
| shared | 无 | 任何运行时包或上层 | [shared](<modules/shared.md>) |
| core | shared、core 内部、node | host、client、DSH 包 | [project](<modules/project.md>)、[command](<modules/command.md>) |
| host | core、shared、DSH 包、node | client | [host](<modules/host.md>) |
| client | React、client 内部；分层规则允许 shared | node、core、host | [client](<modules/client.md>) |

分层与无环规则由[可维护性审计](<../scripts/maintainability-audit.mjs>)检查；客户端六层方向和唯一 fetch 入口由[客户端分层检查](<../scripts/check-client-layers.mjs>)检查。客户端内部结构归 [client 模块](<modules/client.md>)，不在此复制页面和函数清单。

## 2. 模块清单

![图 3：十二模块职责与主要数据流](<diagrams/module-map.svg>)

- 十二模块是职责分组，不等同于十二个物理目录。
- 写入主链为 host → service → handle → commands → store；查询从已发布状态投影。
- knowledge 的索引是独立派生物；documents 和 evidence 的读取旁路不改变主提交边界。

### 2.1 机器可校验的清单（arch-map）

下块每行是一个仓库相对路径，可含段内通配符；保持标记和逐行格式。[检查器](<../scripts/check-architecture.mjs>)验证已列项存在，通配符不代表磁盘文件全覆盖。新增、搬移或更名模块时同步清单，并运行 `npm run check:architecture`；[测试](<../test/ops/architecture-map.test.mjs>)复用此检查。

<!-- arch-map:start -->
lib/index.js
lib/client.js
lib/shared/contract.js
lib/shared/events.js
lib/shared/knowledge.js
lib/shared/fixed-schema.js
lib/shared/verification.js
lib/shared/verification.d.ts
lib/core/service.js
lib/core/project-reader.js
lib/core/project-reader-worker.js
lib/core/project-reader-views.js
lib/core/project-reader-projection.js
lib/core/project-read-handle.js
lib/core/knowledge/*.js
lib/core/handle.js
lib/core/lease.js
lib/core/normalize.js
lib/core/plan-stages.js
lib/core/contracts.js
lib/core/evidence.js
lib/core/audit.js
lib/core/schema.js
lib/core/command-shape.js
lib/core/inline-doc-access.js
lib/core/intent.js
lib/core/model.js
lib/core/store.js
lib/core/store/lock.js
lib/core/store/format.js
lib/core/store/files.js
lib/core/store/writes.js
lib/core/commands/index.js
lib/core/commands/task.js
lib/core/commands/task-intake.js
lib/core/commands/task-work.js
lib/core/commands/task-gov.js
lib/core/commands/plan.js
lib/core/commands/plan-life.js
lib/core/commands/plan-members.js
lib/core/commands/project.js
lib/core/commands/doc.js
lib/core/commands/doc-external.js
lib/core/commands/session.js
lib/core/views.js
lib/core/digest.js
lib/core/fsck.js
lib/core/repair.js
lib/core/errors.js
lib/core/util.js
lib/core/git-exec.js
lib/core/documents/locate.js
lib/core/documents/read.js
lib/core/documents/assets.js
lib/core/documents/external-model.js
lib/core/documents/external-observe.js
lib/core/documents/external-git.js
lib/core/documents/fixed-git.js
lib/core/documents/fixed-worktree.js
lib/core/documents/fixed-reference.js
lib/core/documents/fixed-content.js
lib/core/documents/fixed-auto.js
lib/core/identity/registry.js
lib/core/identity/bindings.js
lib/core/identity/discover.js
lib/core/identity/ops.js
lib/host/routes.js
lib/host/routes/*.js
lib/host/tools.js
lib/host/tools/*.js
lib/host/lifecycle.js
lib/host/prompt.js
lib/host/auth.js
lib/host/mcp.js
lib/host/mcp-http.js
lib/host/mcp-tools.js
lib/host/mcp-write.js
lib/host/mcp-knowledge.js
lib/host/util.js
src/client/index.ts
src/client/styles.css
src/client/styles.ts
src/client/react.d.ts
src/client/css.d.ts
src/client/pages/*.tsx
src/client/components/*.tsx
src/client/hooks/*.ts
src/client/model/*.ts
src/client/utils/*.ts
src/client/api/*.ts
src/client/api/request-gate.ts
src/client/api/read-lifecycle.ts
<!-- arch-map:end -->

### 2.2 模块路由

| 模块 | 结构入口 | 模块 | 结构入口 |
|---|---|---|---|
| shared | [共享契约](<modules/shared.md>) | project | [项目与身份](<modules/project.md>) |
| command | [命令总线](<modules/command.md>) | task | [任务、租约与意图](<modules/task.md>) |
| plan | [计划与阶段](<modules/plan.md>) | documents | [文档登记与读取](<modules/documents.md>) |
| evidence | [证据与固定内容](<modules/evidence.md>) | store | [存储与诊断](<modules/store.md>) |
| read | [读模型与简报](<modules/read.md>) | knowledge | [知识读取与检索](<modules/knowledge.md>) |
| host | [宿主与协议适配](<modules/host.md>) | client | [浏览器客户端](<modules/client.md>) |

## 3. 进程与宿主入口

| 运行位置 | 装配入口 | 结构说明 |
|---|---|---|
| DSH 宿主主线程 | [lib/index.js](<../lib/index.js>) → [host](<modules/host.md>) | 创建 ProjectService，注册原生工具、可选 Web/MCP 与生命周期清理 |
| 浏览器 | [index.ts](<../src/client/index.ts>) → [client](<modules/client.md>) | 注册 slot，页面经 HTTP transport 与宿主通信 |
| 项目列表/项目冷读 worker | [project](<modules/project.md>) → [read](<modules/read.md>) | 与已有 writer 的发布态读取共存，不为查询创建 writer |
| 完整 health worker | [read](<modules/read.md>) | 重文件/Git 审计独立于 prompt 热路径 |
| 知识 worker | [knowledge](<modules/knowledge.md>) | 与普通视图 worker 分离，持有可重建缓存，不参加命令事务 |

![图 4：写命令时序与失败边界](<diagrams/command-write.svg>)

- 入口先建立身份，service 选取项目句柄，handle 串行调度领域处理器。
- 事件批次只在 store 追加成功后发布；handle 显式采用返回 state。
- 元数据与快照的后置工作不作为新的命令提交点；具体语义链接 [L1 命令信封](<CONTRACT.md#21-命令信封错误码与-http-映射>)，实现阅读顺序见 [command](<modules/command.md>)、[store](<modules/store.md>)。

### 3.1 读路径与审计隔离

![图 5：内存读模型、隔离审计与锁外冷读](<diagrams/read-isolation.svg>)

- brief 取内存健康摘要，显式完整 health 才调度内容审计。
- 项目读取器使用同进程已发布状态或 worker 的验证前缀，运行时 lease 与日志状态分开。
- 专用只读入口与管理工具的 open/touch 链不是同一路径；阅读 [read](<modules/read.md>)、[project](<modules/project.md>)、[knowledge](<modules/knowledge.md>)，授权边界见[信任边界](<TRUST-BOUNDARIES.md#2-只读与冷读>)。

### 3.2 存储与恢复边界

![图 6：存储文件、验证顺序与显式修复](<diagrams/store-recovery.svg>)

- 日志是事实源；快照与 blob 各有独立身份校验，缓存不是权威状态。
- writer 冷开持锁验证完整日志与快照，再回放、检查 schema，最后规范化尾部。
- 锁外读取不修尾，诊断与修复分开；实现入口见 [store](<modules/store.md>)，维护操作见[恢复 Runbook](<operations/RECOVERY.md>)。

## 4. 关键不变量

这里仅列结构落点；领域不变量的定义和编号见 [CONTRACT §1.4](<CONTRACT.md#14-不变量>)。

| 结构约束 | 代码落点 | 模块 |
|---|---|---|
| 一个日志由共享句柄与合作式锁约束 writer | [service.js](<../lib/core/service.js>)、[lock.js](<../lib/core/store/lock.js>) | [project](<modules/project.md>)、[store](<modules/store.md>) |
| 工作副本与发布状态有明确交接断言 | [handle.js](<../lib/core/handle.js>) 的 assertStateAttached | [command](<modules/command.md>) |
| 领取资格由命令与视图共用，不在 UI 重新定义 | [lease.js](<../lib/core/lease.js>) | [task](<modules/task.md>)、[read](<modules/read.md>) |
| 命令名、事件类别、端点和工具 schema 由共享定义约束 | [contract.js](<../lib/shared/contract.js>)、[events.js](<../lib/shared/events.js>) | [shared](<modules/shared.md>)、[host](<modules/host.md>) |
| 文档与 Git 字节读取不扩大到任意文件/程序执行 | [locate.js](<../lib/core/documents/locate.js>)、[git-exec.js](<../lib/core/git-exec.js>) | [documents](<modules/documents.md>)、[evidence](<modules/evidence.md>) |
| 客户端 fetch 集中，页面选择与请求票据分工 | [transport.ts](<../src/client/api/transport.ts>)、[request-gate.ts](<../src/client/api/request-gate.ts>) | [client](<modules/client.md>) |

## 5. 构建与产物

| 输入/工具 | 产物/运行方式 | 说明 |
|---|---|---|
| [客户端入口](<../src/client/index.ts>)、[构建脚本](<../scripts/build-client.mjs>) | [lib/client.js](<../lib/client.js>) + [map](<../lib/client.js.map>) | 开发期 esbuild，浏览器 CJS 外壳由 ModuleLoader 加载，React external，CSS 内联 |
| [tools/build/package.json](<../tools/build/package.json>) | 隔离构建工具链 | 运行/安装不现场构建；产物以 tmp + rename 写入 |
| [后端入口](<../lib/index.js>)、core/host/shared | Node ESM 直接加载 | Node ≥22；类型检查 noEmit，不增加运行时编译链 |
| [tools/typescript/package.json](<../tools/typescript/package.json>) | 开发期类型检查 | 检查范围和配置见 [TypeScript 工具链](<governance/TYPESCRIPT.md>) |
| [package.json](<../package.json>) 的 files/exports | npm 交付面 | scripts/test 是仓库维护面，不作为用户 CLI 发布 |

源码与产物的归属见 [client](<modules/client.md>)、[host](<modules/host.md>)；开发操作见[贡献指南](<governance/CONTRIBUTING.md>)，构建检查不构成[发布授权](<operations/RELEASE.md>)。
