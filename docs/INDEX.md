# 项目文档地图

从问题选择层级，再进入模块；行为权威只在 [CONTRACT](<CONTRACT.md>)，冻结内容按其[子契约索引](<CONTRACT.md#3-冻结子契约索引1c>)读取。本文只做路由，不复制字段、错误码或规则全文。文档分层与单一事实源规则见[文档治理](<DOC-GOVERNANCE.md>)。

## 项目级契约（L1）

| 入口 | 何时读 |
|---|---|
| [领域模型（L1a）](<CONTRACT.md#1-领域模型1a>) | 项目/任务/计划、状态机、进度与不变量 |
| [对外契约（L1b）](<CONTRACT.md#2-对外契约1b>) | 命令、查询、文档、存储、HTTP、DSH/MCP 与知识读取 |
| [冻结子契约索引（L1c）](<CONTRACT.md#3-冻结子契约索引1c>) | 判断子契约权威来源与适用口径 |
| [D1 外置文档冻结契约](<WORKSPACE-DOCUMENTS-CONTRACT.md>) | 身份、四维状态、安全读取与固定内容边界 |

## 架构地图（L2）

| 入口 | 何时读 |
|---|---|
| [架构与模块地图](<ARCHITECTURE.md>) | 分层依赖、机器清单、进程入口、不变量与构建产物 |
| [机器模块清单 §2.1](<ARCHITECTURE.md#21-机器可校验的清单arch-map>) | 新增/移动/更名模块，核对 check:architecture |
| [写入与读隔离](<ARCHITECTURE.md#3-进程与宿主入口>) | 沿宿主、命令、存储、冷读与 worker 排查链路 |
| [图集：上下文](<diagrams/context.svg>) · [分层](<diagrams/layers.svg>) · [模块](<diagrams/module-map.svg>) | 理解边界和依赖方向 |
| [图集：写入](<diagrams/command-write.svg>) · [读取](<diagrams/read-isolation.svg>) · [存储](<diagrams/store-recovery.svg>) | 理解运行时和失败边界 |
| [图集：文档证据](<diagrams/doc-evidence.svg>) · [任务计划](<diagrams/task-plan-state.svg>) | 跟读模块状态与内容身份 |

## 模块设计（L3）

模块入口页列当前结构事实、真实代码入口与 L1 指针；实现取舍和专题阅读路径由下表继续定位。

| 模块入口 | 专题设计/阅读材料 |
|---|---|
| [shared](<modules/shared.md>) | [L1 领域词汇](<CONTRACT.md#11-词汇表>)与[共享契约入口](<modules/shared.md#代码入口>) |
| [project](<modules/project.md>) | [项目身份](<IDENTITY.md>)、[身份最小闭环](<design/oss-minimal-identity-loop.md>)、[项目访问生命周期](<design/project-access-lifecycle-boundaries.md>) |
| [command](<modules/command.md>) | [设计背景](<DESIGN.md>)、[状态交接不变量](<design/invariant-i7-state-handoff.md>) |
| [task](<modules/task.md>) | [多会话并发](<design/multi-session-concurrency.md>)、[驳回与返工](<design/reject-redo-preserve-assignee.md>)、[审查治理](<design/review-governance-v6.md>) |
| [plan](<modules/plan.md>) | [计划 v2](<PLAN-V2.md>) |
| [documents](<modules/documents.md>) | [外置文档](<EXTERNAL-DOCS.md>)、[文档关联任务](<design/doc-task-linking-implementation.md>) |
| [evidence](<modules/evidence.md>) | [固定内容证据](<DOC-EXTERNAL-EVIDENCE.md>)、[Git 执行边界](<GIT-EXECUTION.md>) |
| [store](<modules/store.md>) | [设计背景](<DESIGN.md>)、[存储兼容](<COMPATIBILITY.md#3-快照覆盖与构建回退>) |
| [read](<modules/read.md>) | [Prompt 字面段](<design/prompt-literal-section.md>)、[历史读取决策](<decisions/rfc-1-history-read-model.md>) |
| [knowledge](<modules/knowledge.md>) | [历史知识读模型](<design/history-knowledge-read-model.md>) |
| [host](<modules/host.md>) | [信任边界](<TRUST-BOUNDARIES.md>)、[会话跳转](<design/board-to-session-jump.md>) |
| [client](<modules/client.md>) | [UI 设计](<UI-REDESIGN.md>)、[前端分层](<design/frontend-layering.md>)、[流程视图](<design/flow-view.md>) |

## 模块内部契约（L4）

以下是调用与修改模块时的规则落点；专题文档不能覆盖 L1 的现行行为。

| 模块 | 当前细则入口 |
|---|---|
| shared | [事件分类定义](<../lib/shared/events.js>)、[固定结构定义](<../lib/shared/fixed-schema.js>)、[知识 schema](<../lib/shared/knowledge.js>) |
| project / host | [身份与绑定](<IDENTITY.md>)、[项目/宿主入口](<modules/project.md#对外面>)、[鉴权边界](<TRUST-BOUNDARIES.md#1-dsh网页与-mcp-双端>) |
| command / task | [命令入口](<modules/command.md#代码入口>)、[任务守卫入口](<modules/task.md#代码入口>)、[状态闭包依据](<decisions/rfc-3-state-closure.md>) |
| plan | [计划 head、版本与成员](<PLAN-V2.md>)、[计划入口](<modules/plan.md#代码入口>) |
| documents | [外置登记与观测](<EXTERNAL-DOCS.md>)、[只读正文/图片](<modules/documents.md#代码入口>) |
| evidence | [固定内容域与降级](<DOC-EXTERNAL-EVIDENCE.md>)、[Git 白名单与执行解析](<GIT-EXECUTION.md>) |
| store / read | [存储格式与兼容权威](<CONTRACT.md#25-存储格式与事件兼容>)、[存储入口](<modules/store.md#代码入口>)、[读隔离入口](<modules/read.md#代码入口>) |
| knowledge | [来源与预算](<CONTRACT.md#历史知识读取与检索>)、[实现读模型](<design/history-knowledge-read-model.md>) |
| client | [客户端入口与依赖](<modules/client.md>)、[前端六层规则](<design/frontend-layering.md>) |

## 横向（术语、信任边界、兼容）

| 文档 | 用途 |
|---|---|
| [术语表](<GLOSSARY.md>) | 一个词的一句话含义与 L1 锚点 |
| [信任边界](<TRUST-BOUNDARIES.md>) | 宿主双端、token、冷读、文件根、Git 和人类验收权 |
| [兼容与降级](<COMPATIBILITY.md>) | schema、事件分类、快照覆盖、构建回退和文档固定降级 |

## 运维与决策

### 治理与开发入口

| 文档 | 用途 |
|---|---|
| [README](<../README.md>) · [AGENTS](<../AGENTS.md>) | 产品入口与仓库会话规则 |
| [产品方针](<PRODUCT-PRINCIPLES.md>) · [框架约束](<CONSTRAINTS.md>) | 产品/工程底线与评审边界 |
| [文档治理](<DOC-GOVERNANCE.md>) · [协作治理](<AUTONOMOUS-DELIVERY.md>) | 单一事实源、授权与职责 |
| [任务交付流程](<design/task-delivery-workflow.md>) · [贡献指南](<CONTRIBUTING.md>) | 实施、验证、独立审查与合入 |
| [TypeScript 工具链](<TYPESCRIPT.md>) · [后端阅读基线](<BACKEND-READABILITY.md>) | 类型检查范围、代码阅读与注释入口 |
| [测试分级](<TESTING-POLICY.md>) · [隔离环境](<TEST-ENV.md>) · [测试依赖清单](<design/test-implicit-contracts.md>) | 验证范围与基线保护 |

### 安装、发布与数据操作

| 文档 | 用途 |
|---|---|
| [运维 CLI](<operations/CLI.md>) | 仓库维护命令与授权边界 |
| [安装](<INSTALL.md>) · [演示](<DEMO.md>) · [使用说明](<runbooks/projectboard-usage.md>) | 安装、讲解与日常操作 |
| [发布](<RELEASE.md>) · [变更记录](<CHANGELOG.md>) | 候选/发布/部署授权和版本记录 |
| [恢复](<RECOVERY.md>) · [迁移入口](<MIGRATION-ENTRY.md>) · [schema 迁移](<MIGRATION.md>) | 一致性备份、回退与搬迁 |
| [内嵌文档迁移](<DOC-MIGRATION.md>) · [恢复演练](<runbooks/recovery-backup-then-repair.md>) | 外置迁移与备份后修复 |
| [文档页验收](<DOCS-UI-CHECKLIST.md>) · [渲染样例](<runbooks/render-regression-samples.md>) | 人工点检文档与图表 |

### 决策与专题材料

以下材料用于理解取舍或核对来源；方案/规格是否实施按文首状态与代码核对，不因目录或标题成为产品承诺。

- 方向与范围：[结构化连续知识库](<decisions/structured-continuous-knowledge-base.md>)、[MVP 范围](<decisions/mvp-scope.md>)、[上下文成本](<decisions/context-cost.md>)、[优先级](<decisions/priority-semantics.md>)。
- 身份与计划：[cwd 映射](<decisions/cwd-project-mapping.md>)、[计划能力](<decisions/plan-capability-v2.md>)、[worktree 隔离与串行集成](<design/worktree-isolation-serial-integration.md>)。
- 验收与证据：[人类审查门](<decisions/human-review-gate.md>)、[产品方针复查](<decisions/product-policy-review-v6.md>)、[证据前置检查](<decisions/rfc-4-addendum-preflight.md>)、[证据强度](<decisions/rfc-4-evidence-strength.md>)、[证据漂移](<decisions/rfc-5-evidence-drift.md>)、[固定证据自动跟随](<decisions/auto-follow-fixed-evidence.md>)。
- 历史读取与兼容：[历史审计回退分层](<decisions/history-audit-rollback-layering.md>)、[知识读取验证记录](<decisions/history-knowledge-validation-2026-11-14.md>)、[约束恢复调研](<research/history-constraint-recovery.md>)。
- 文档与架构治理：[L1 重排依据](<decisions/contract-l1-reorganization.md>)、[契约表面核对](<decisions/contract-legacy-surfaces.md>)、[图片与数学取舍](<decisions/image-math-tradeoffs.md>)、[外置文档实施计划](<WORKSPACE-DOCUMENTS-PLAN.md>)。
- 查询与筛选规格：[查询模块 v2](<specs/query-module-v2.md>)、[首任务契约](<decisions/query-v2-first-task-contract.md>)、[过滤规则](<specs/filter-rules-v1.md>)、[过滤补充](<specs/filter-rules-v1-1-addendum.md>)。
- UI 与并发规格：[UI 2](<specs/ui-2-spec.md>)、[并发阶段验收](<specs/concurrency-phases-acceptance.md>)、[D5 规格](<specs/d5-autoshell-spec.md>)。
- 评估与容量：[可维护性评估](<MAINTAINABILITY.md>)、[容量基准](<CAPACITY.md>)、[容量边界决策](<decisions/capacity-100k-boundary.md>)。
