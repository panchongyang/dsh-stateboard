# 项目文档地图

按读者与稳定性分层；行为权威只在[实现契约](<CONTRACT.md>)，冻结内容按[冻结索引](<CONTRACT.md#3-冻结子契约索引1c>)读取。本文是唯一路由，不复制规则；写作与归档见[文档治理](<DOC-GOVERNANCE.md>)。

## 项目级契约、架构与横向入口

- [ProjectBoard 实现契约](<CONTRACT.md>)
- [工作区文档外置 · D1 冻结契约](<WORKSPACE-DOCUMENTS-CONTRACT.md>)
- [架构与模块地图](<ARCHITECTURE.md>)
- [ProjectBoard（项目板）— DSH 跨会话项目状态机插件设计方案](<DESIGN.md>)
- [术语表](<GLOSSARY.md>)
- [信任边界](<TRUST-BOUNDARIES.md>)
- [兼容与降级](<COMPATIBILITY.md>)
- [文档治理：分层、归属与维护规则](<DOC-GOVERNANCE.md>)

图集：[上下文](<diagrams/context.svg>) · [分层](<diagrams/layers.svg>) · [模块](<diagrams/module-map.svg>) · [写入](<diagrams/command-write.svg>) · [读隔离](<diagrams/read-isolation.svg>) · [存储恢复](<diagrams/store-recovery.svg>) · [文档证据](<diagrams/doc-evidence.svg>) · [任务计划](<diagrams/task-plan-state.svg>)。

## 治理（L0）

源码协作入口：[AGENTS](<../AGENTS.md>)；随包入口：[README](<../README.md>)。

- [人类审查上移与 AI 自主交付模型](<governance/AUTONOMOUS-DELIVERY.md>)
- [后端可读性基线与渐进迁移](<governance/BACKEND-READABILITY.md>)
- [项目框架约束](<governance/CONSTRAINTS.md>)
- [贡献指南](<governance/CONTRIBUTING.md>)
- [产品方针（ProjectBoard）](<governance/PRODUCT-PRINCIPLES.md>)
- [ProjectBoard 独立测试环境](<governance/TEST-ENV.md>)
- [分级测试与基线保护规范](<governance/TESTING-POLICY.md>)
- [TypeScript 开发工具链](<governance/TYPESCRIPT.md>)
- [任务确认后的完整工作流](<governance/task-delivery-workflow.md>)

## 模块目录（L2 → L3 / L4）

| 模块入口 | 设计（L3） | 内部契约（L4） |
|---|---|---|
| [shared](<modules/shared.md>) | 与内部契约合篇 | [内部契约](<modules/shared/contract.md>) |
| [project](<modules/project.md>) | [设计](<modules/project/design.md>) | [内部契约](<modules/project/contract.md>) |
| [command](<modules/command.md>) | [设计](<modules/command/design.md>) | [内部契约](<modules/command/contract.md>) |
| [task](<modules/task.md>) | [设计](<modules/task/design.md>) | [内部契约](<modules/task/contract.md>) |
| [plan](<modules/plan.md>) | [设计](<modules/plan/design.md>) | [内部契约](<modules/plan/contract.md>) |
| [documents](<modules/documents.md>) | [设计](<modules/documents/design.md>) | [内部契约](<modules/documents/contract.md>) |
| [evidence](<modules/evidence.md>) | [设计](<modules/evidence/design.md>) | [内部契约](<modules/evidence/contract.md>) |
| [store](<modules/store.md>) | [设计](<modules/store/design.md>) | [内部契约](<modules/store/contract.md>) |
| [read](<modules/read.md>) | [设计](<modules/read/design.md>) | [内部契约](<modules/read/contract.md>) |
| [knowledge](<modules/knowledge.md>) | [设计](<modules/knowledge/design.md>) | [内部契约](<modules/knowledge/contract.md>) |
| [host](<modules/host.md>) | [设计](<modules/host/design.md>) | [内部契约](<modules/host/contract.md>) |
| [client](<modules/client.md>) | [设计](<modules/client/design.md>) | [内部契约](<modules/client/contract.md>) |

## 操作与运维（L5）

- [Changelog](<operations/CHANGELOG.md>)
- [开发 CLI 与维护命令](<operations/CLI.md>)
- [约三分钟脱敏文字演示](<operations/DEMO.md>)
- [内嵌文档迁移与恢复 runbook](<operations/DOC-MIGRATION.md>)
- [文档页（外置文档）人工验收清单](<operations/DOCS-UI-CHECKLIST.md>)
- [安装、首次运行与卸载](<operations/INSTALL.md>)
- [ProjectBoard 迁移入口](<operations/MIGRATION-ENTRY.md>)
- [工作区搬迁、换机与 schema v3 升级](<operations/MIGRATION.md>)
- [ProjectBoard 恢复与继续交付 Runbook](<operations/RECOVERY.md>)
- [维护者发布准备、人工公开发布与部署](<operations/RELEASE.md>)
- [ProjectBoard 使用说明](<operations/runbooks/projectboard-usage.md>)
- [恢复与继续交付](<operations/runbooks/recovery-backup-then-repair.md>)
- [文档渲染回归样例](<operations/runbooks/render-regression-samples.md>)

## 保留方案（按文首状态读取）

- [方案：看板 → 会话（反向跳转）](<design/board-to-session-jump.md>)
- [实施方案：文档 ↔ 任务关联（反查 + 写校验 + 任务页资产区）](<design/doc-task-linking-implementation.md>)
- [推进视图（Flow）](<design/flow-view.md>)
- [I7：状态交接显式化](<design/invariant-i7-state-handoff.md>)
- [多会话并发推进与计划—任务一致性](<design/multi-session-concurrency.md>)
- [最小身份闭环与兼容验收方案](<design/oss-minimal-identity-loop.md>)
- [实施方案：项目读取、业务准入与 writer 生命周期分离](<design/project-access-lifecycle-boundaries.md>)
- [实施方案：项目摘要按字面文本进入宿主 Prompt（F01）](<design/prompt-literal-section.md>)
- [方案：驳回/重做保委派人 · 接手交接审计 · 前置依赖可见](<design/reject-redo-preserve-assignee.md>)
- [设计草案：AI 驳回与第三方审计门（审查治理 v6）](<design/review-governance-v6.md>)
- [任务 worktree、Git 隔离与串行集成](<design/worktree-isolation-serial-integration.md>)

## 保留规格（按文首状态读取）

- [并发推进分期、依赖及 R3 门禁](<specs/concurrency-phases-acceptance.md>)
- [增补：过滤规则 v1.1（done 时间窗 + 多计划作用域）](<specs/filter-rules-v1-1-addendum.md>)
- [方案：过滤规则与持久化 v1](<specs/filter-rules-v1.md>)
- [规格：查询模块 v2（独立模块 · WHERE 表达式 · 与历史读模型分层）](<specs/query-module-v2.md>)

## 决策与处置记录（不替代现行规则）

- [决定](<decisions/auto-follow-fixed-evidence.md>)
- [容量决策收口](<decisions/capacity-100k-boundary.md>)
- [决策：ProjectBoard 自身的上下文成本](<decisions/context-cost.md>)
- [L1 契约重排核对记录](<decisions/contract-l1-reorganization.md>)
- [契约重排前的实现与维护口径档案](<decisions/contract-legacy-surfaces.md>)
- [决策：会话快捷入口如何把 cwd 映射到项目](<decisions/cwd-project-mapping.md>)
- [旧文档逐篇处置记录（2026-11-14）](<decisions/doc-disposition-2026-11-14.md>)
- [决策：历史、审计、回滚的边界与分层](<decisions/history-audit-rollback-layering.md>)
- [历史知识读取与检索验证记录](<decisions/history-knowledge-validation-2026-11-14.md>)
- [决策：人审门用 requiresHumanReview 开关，agent 只能开不能关](<decisions/human-review-gate.md>)
- [图片与数学公式：做不做（文档渲染 · 阶段6）](<decisions/image-math-tradeoffs.md>)
- [MVP 范围与验收档案](<decisions/mvp-scope.md>)
- [决策：计划能力 v2 —— 不嵌套任务，把计划升格为可管理的多实例](<decisions/plan-capability-v2.md>)
- [决策：优先级语义与可视化口径](<decisions/priority-semantics.md>)
- [产品方针复查：审查治理 v6（硬切迁移偏离 + AI 审计信任标签）](<decisions/product-policy-review-v6.md>)
- [查询 v2 首任务：最小契约](<decisions/query-v2-first-task-contract.md>)
- [RFC-1 · 历史读模型的实体索引口径（第二轮收敛）](<decisions/rfc-1-history-read-model.md>)
- [RFC-3 状态收口与归档写闸](<decisions/rfc-3-state-closure.md>)
- [RFC-4 增补：执行前校验、持久 execution 凭证与证据 supersede](<decisions/rfc-4-addendum-preflight.md>)
- [RFC-4 证据强度与宿主执行](<decisions/rfc-4-evidence-strength.md>)
- [RFC-5：证据漂移分级、固定版本与刷新](<decisions/rfc-5-evidence-drift.md>)
- [Project Board 未来方向与下阶段唯一目标](<decisions/structured-continuous-knowledge-base.md>)

## 维护与检查

新增/移动现行文档须更新本地图；执行 `npm run check:docs` 校验路径、Markdown 标题锚点、全图可达性和公共文档隐私。档案不参与路由，旧路径只在逐篇处置记录中以代码映射保留。
