# 旧文档逐篇处置记录（2026-11-14）

> 状态：已实施（文档处置记录；不授予提交、合入、发布、部署或真实数据操作权限）。

## 1. 全集、统计与规则

旧文全集固定为 `git ls-tree -r --name-only deb8637 -- docs` 的 74 篇；逐篇恰好一行，无目录通配符代替单篇结论。s7 输入为 `docs/doc-layers` 的 `76c5fd4`；本文也列出相对于旧文全集新增的文档与图资产，不把移动后的新路径重复算新增。

- 旧文：原位保留 38，移动 21，归档 15（其中拆入模块后归档 11，直接归档 4），合计 74。
- 新增、非旧文：44 篇 Markdown（含本记录和 knowledge 新增两篇）及 8 份 SVG 图资产。
- 归档以 move 保留完整本机原件；原路径仅暂存删除，目标在忽略目录，不入库。无硬删除、旧路径占位、历史改写或提交。
- 根目录没有 CONSTRAINTS；原件是 `docs/CONSTRAINTS.md`，移入治理目录。§13 提到的 UI-AUDIT、ROBUSTNESS-2026-10-22、RELIABILITY-REVIEW-2026-10-29、RESEARCH-dsh-tasks-manager 四篇均不在基线全集和 s7 输入树中，因此没有补造或遗漏。

## 2. 旧文逐篇结论

| 旧路径 | 结论 | 新路径或去向 | 依据 |
|---|---|---|---|
| `docs/ARCHITECTURE.md` | 原位保留 | `docs/ARCHITECTURE.md` | 保留项目级路由、架构或设计入口；本轮只收口引用。 |
| `docs/AUTONOMOUS-DELIVERY.md` | 移动 | `docs/governance/AUTONOMOUS-DELIVERY.md` | 治理 §13：方针/流程/测试/工具链属于 L0 治理。 |
| `docs/BACKEND-READABILITY.md` | 移动 | `docs/governance/BACKEND-READABILITY.md` | 治理 §13：方针/流程/测试/工具链属于 L0 治理。 |
| `docs/CAPACITY.md` | 归档 | `docs/archive/CAPACITY.md（本机）；现行 docs/decisions/capacity-100k-boundary.md` | 历史基准测量；容量边界决策保留，现行成本见 store/read 模块，不把历史测量当当前门禁。 |
| `docs/CHANGELOG.md` | 移动 | `docs/operations/CHANGELOG.md` | 治理 §13：安装/发布/恢复/迁移/操作清单属于 L5 运维。 |
| `docs/CONSTRAINTS.md` | 移动 | `docs/governance/CONSTRAINTS.md` | 治理 §13：方针/流程/测试/工具链属于 L0 治理。 |
| `docs/CONTRACT.md` | 原位保留 | `docs/CONTRACT.md` | L1 权威路径不变；只重指失效链接/路径，不改行为语义，见 §4。 |
| `docs/CONTRIBUTING.md` | 移动 | `docs/governance/CONTRIBUTING.md` | 治理 §13：方针/流程/测试/工具链属于 L0 治理。 |
| `docs/DEMO.md` | 移动 | `docs/operations/DEMO.md` | 治理 §13：安装/发布/恢复/迁移/操作清单属于 L5 运维。 |
| `docs/DESIGN.md` | 原位保留 | `docs/DESIGN.md` | 保留项目级路由、架构或设计入口；本轮只收口引用。 |
| `docs/DOC-EXTERNAL-EVIDENCE.md` | 拆入模块后归档 | `docs/archive/DOC-EXTERNAL-EVIDENCE.md（本机）；现行 docs/modules/evidence/contract.md` | evidence 模块覆盖 raw/blob 身份、自动 pin/降级、同 commit 屏障、get_fixed 与备份恢复；原因闭集回指 pinReason。 |
| `docs/DOC-MIGRATION.md` | 移动 | `docs/operations/DOC-MIGRATION.md` | 治理 §13：安装/发布/恢复/迁移/操作清单属于 L5 运维。 |
| `docs/DOCS-UI-CHECKLIST.md` | 移动 | `docs/operations/DOCS-UI-CHECKLIST.md` | 治理 §13：安装/发布/恢复/迁移/操作清单属于 L5 运维。 |
| `docs/EXTERNAL-DOCS.md` | 拆入模块后归档 | `docs/archive/EXTERNAL-DOCS.md（本机）；现行 docs/modules/documents/contract.md` | documents 模块覆盖登记/元数据、四维状态、缓存/绑定及回放校验；L1/D1 为行为权威。 |
| `docs/GIT-EXECUTION.md` | 拆入模块后归档 | `docs/archive/GIT-EXECUTION.md（本机）；现行 docs/modules/evidence/contract.md` | evidence 内部契约保留绝对程序解析、禁止根、缓存复核与 linked/separate 根边界；实现和恶意程序测试为核对源。 |
| `docs/IDENTITY.md` | 拆入模块后归档 | `docs/archive/IDENTITY.md（本机）；现行 docs/modules/project/contract.md` | 项目模块 design/contract 覆盖稳定身份、绑定、发现、创建/relocate 边界；冻结身份以 D1 为准。 |
| `docs/INDEX.md` | 原位保留 | `docs/INDEX.md` | 保留项目级路由、架构或设计入口；本轮只收口引用。 |
| `docs/INSTALL.md` | 移动 | `docs/operations/INSTALL.md` | 治理 §13：安装/发布/恢复/迁移/操作清单属于 L5 运维。 |
| `docs/MAINTAINABILITY.md` | 归档 | `docs/archive/MAINTAINABILITY.md（本机）；现行 docs/governance/CONSTRAINTS.md` | 历史拆分评估，现行规模/分层口径见框架约束与架构门禁。 |
| `docs/MIGRATION-ENTRY.md` | 移动 | `docs/operations/MIGRATION-ENTRY.md` | 治理 §13：安装/发布/恢复/迁移/操作清单属于 L5 运维。 |
| `docs/MIGRATION.md` | 移动 | `docs/operations/MIGRATION.md` | 治理 §13：安装/发布/恢复/迁移/操作清单属于 L5 运维。 |
| `docs/PLAN-V2.md` | 拆入模块后归档 | `docs/archive/PLAN-V2.md（本机）；现行 docs/modules/plan/contract.md` | 计划模块 design/contract 覆盖 head/不可变版本、成员、阶段、CAS 与兼容派生；操作面回指 L1。 |
| `docs/PRODUCT-PRINCIPLES.md` | 移动 | `docs/governance/PRODUCT-PRINCIPLES.md` | 治理 §13：方针/流程/测试/工具链属于 L0 治理。 |
| `docs/RECOVERY.md` | 移动 | `docs/operations/RECOVERY.md` | 治理 §13：安装/发布/恢复/迁移/操作清单属于 L5 运维。 |
| `docs/RELEASE.md` | 移动 | `docs/operations/RELEASE.md` | 治理 §13：安装/发布/恢复/迁移/操作清单属于 L5 运维。 |
| `docs/TEST-ENV.md` | 移动 | `docs/governance/TEST-ENV.md` | 治理 §13：方针/流程/测试/工具链属于 L0 治理。 |
| `docs/TESTING-POLICY.md` | 移动 | `docs/governance/TESTING-POLICY.md` | 治理 §13：方针/流程/测试/工具链属于 L0 治理。 |
| `docs/TYPESCRIPT.md` | 移动 | `docs/governance/TYPESCRIPT.md` | 治理 §13：方针/流程/测试/工具链属于 L0 治理。 |
| `docs/UI-REDESIGN.md` | 拆入模块后归档 | `docs/archive/UI-REDESIGN.md（本机）；现行 docs/modules/client/design.md` | client 设计保留设计系统/组件/可访问性入口；数值源回指 styles.css，人工点检见 operations 清单。 |
| `docs/WORKSPACE-DOCUMENTS-CONTRACT.md` | 原位保留 | `docs/WORKSPACE-DOCUMENTS-CONTRACT.md` | D1 冻结原文，零改动。 |
| `docs/WORKSPACE-DOCUMENTS-PLAN.md` | 归档 | `docs/archive/WORKSPACE-DOCUMENTS-PLAN.md（本机）；现行 docs/modules/documents/design.md` | 历史实施计划，不再作为当前能力或授权来源；交付边界见 documents 模块。 |
| `docs/decisions/auto-follow-fixed-evidence.md` | 原位保留 | `docs/decisions/auto-follow-fixed-evidence.md` | 方案/规格或决策背景保留；仅状态行与交叉链接收口，不把文首历史语境当现行实现。 |
| `docs/decisions/capacity-100k-boundary.md` | 原位保留 | `docs/decisions/capacity-100k-boundary.md` | 方案/规格或决策背景保留；仅状态行与交叉链接收口，不把文首历史语境当现行实现。 |
| `docs/decisions/context-cost.md` | 原位保留 | `docs/decisions/context-cost.md` | 方案/规格或决策背景保留；仅状态行与交叉链接收口，不把文首历史语境当现行实现。 |
| `docs/decisions/cwd-project-mapping.md` | 原位保留 | `docs/decisions/cwd-project-mapping.md` | 方案/规格或决策背景保留；仅状态行与交叉链接收口，不把文首历史语境当现行实现。 |
| `docs/decisions/history-audit-rollback-layering.md` | 原位保留 | `docs/decisions/history-audit-rollback-layering.md` | 方案/规格或决策背景保留；仅状态行与交叉链接收口，不把文首历史语境当现行实现。 |
| `docs/decisions/history-knowledge-validation-2026-11-14.md` | 原位保留 | `docs/decisions/history-knowledge-validation-2026-11-14.md` | 方案/规格或决策背景保留；仅状态行与交叉链接收口，不把文首历史语境当现行实现。 |
| `docs/decisions/human-review-gate.md` | 原位保留 | `docs/decisions/human-review-gate.md` | 方案/规格或决策背景保留；仅状态行与交叉链接收口，不把文首历史语境当现行实现。 |
| `docs/decisions/image-math-tradeoffs.md` | 原位保留 | `docs/decisions/image-math-tradeoffs.md` | 方案/规格或决策背景保留；仅状态行与交叉链接收口，不把文首历史语境当现行实现。 |
| `docs/decisions/plan-capability-v2.md` | 原位保留 | `docs/decisions/plan-capability-v2.md` | 方案/规格或决策背景保留；仅状态行与交叉链接收口，不把文首历史语境当现行实现。 |
| `docs/decisions/priority-semantics.md` | 原位保留 | `docs/decisions/priority-semantics.md` | 方案/规格或决策背景保留；仅状态行与交叉链接收口，不把文首历史语境当现行实现。 |
| `docs/decisions/product-policy-review-v6.md` | 原位保留 | `docs/decisions/product-policy-review-v6.md` | 方案/规格或决策背景保留；仅状态行与交叉链接收口，不把文首历史语境当现行实现。 |
| `docs/decisions/query-v2-first-task-contract.md` | 原位保留 | `docs/decisions/query-v2-first-task-contract.md` | 方案/规格或决策背景保留；仅状态行与交叉链接收口，不把文首历史语境当现行实现。 |
| `docs/decisions/rfc-1-history-read-model.md` | 原位保留 | `docs/decisions/rfc-1-history-read-model.md` | 方案/规格或决策背景保留；仅状态行与交叉链接收口，不把文首历史语境当现行实现。 |
| `docs/decisions/rfc-3-state-closure.md` | 原位保留 | `docs/decisions/rfc-3-state-closure.md` | 方案/规格或决策背景保留；仅状态行与交叉链接收口，不把文首历史语境当现行实现。 |
| `docs/decisions/rfc-4-addendum-preflight.md` | 原位保留 | `docs/decisions/rfc-4-addendum-preflight.md` | 方案/规格或决策背景保留；仅状态行与交叉链接收口，不把文首历史语境当现行实现。 |
| `docs/decisions/rfc-4-evidence-strength.md` | 原位保留 | `docs/decisions/rfc-4-evidence-strength.md` | 方案/规格或决策背景保留；仅状态行与交叉链接收口，不把文首历史语境当现行实现。 |
| `docs/decisions/rfc-5-evidence-drift.md` | 原位保留 | `docs/decisions/rfc-5-evidence-drift.md` | 方案/规格或决策背景保留；仅状态行与交叉链接收口，不把文首历史语境当现行实现。 |
| `docs/decisions/structured-continuous-knowledge-base.md` | 原位保留 | `docs/decisions/structured-continuous-knowledge-base.md` | 方案/规格或决策背景保留；仅状态行与交叉链接收口，不把文首历史语境当现行实现。 |
| `docs/design/board-to-session-jump.md` | 原位保留 | `docs/design/board-to-session-jump.md` | 方案/规格或决策背景保留；仅状态行与交叉链接收口，不把文首历史语境当现行实现。 |
| `docs/design/doc-task-linking-implementation.md` | 原位保留 | `docs/design/doc-task-linking-implementation.md` | 方案/规格或决策背景保留；仅状态行与交叉链接收口，不把文首历史语境当现行实现。 |
| `docs/design/flow-view.md` | 原位保留 | `docs/design/flow-view.md` | 方案/规格或决策背景保留；仅状态行与交叉链接收口，不把文首历史语境当现行实现。 |
| `docs/design/frontend-layering.md` | 拆入模块后归档 | `docs/archive/design/frontend-layering.md（本机）；现行 docs/modules/client/design.md` | 六层矩阵、装配与兼容冻结面由 client design/contract 定义，依赖门禁回指实现。 |
| `docs/design/history-knowledge-read-model.md` | 拆入模块后归档 | `docs/archive/design/history-knowledge-read-model.md（本机）；现行 docs/modules/knowledge/design.md` | knowledge design/contract 补齐留存重建、稳定来源、FTS/扫描降级、worker/预算/一致性边界；验证记录保留。 |
| `docs/design/invariant-i7-state-handoff.md` | 原位保留 | `docs/design/invariant-i7-state-handoff.md` | 方案/规格或决策背景保留；仅状态行与交叉链接收口，不把文首历史语境当现行实现。 |
| `docs/design/multi-session-concurrency.md` | 原位保留 | `docs/design/multi-session-concurrency.md` | 方案/规格或决策背景保留；仅状态行与交叉链接收口，不把文首历史语境当现行实现。 |
| `docs/design/oss-minimal-identity-loop.md` | 原位保留 | `docs/design/oss-minimal-identity-loop.md` | 方案/规格或决策背景保留；仅状态行与交叉链接收口，不把文首历史语境当现行实现。 |
| `docs/design/project-access-lifecycle-boundaries.md` | 原位保留 | `docs/design/project-access-lifecycle-boundaries.md` | 方案/规格或决策背景保留；仅状态行与交叉链接收口，不把文首历史语境当现行实现。 |
| `docs/design/prompt-literal-section.md` | 原位保留 | `docs/design/prompt-literal-section.md` | 方案/规格或决策背景保留；仅状态行与交叉链接收口，不把文首历史语境当现行实现。 |
| `docs/design/reject-redo-preserve-assignee.md` | 原位保留 | `docs/design/reject-redo-preserve-assignee.md` | 方案/规格或决策背景保留；仅状态行与交叉链接收口，不把文首历史语境当现行实现。 |
| `docs/design/review-governance-v6.md` | 原位保留 | `docs/design/review-governance-v6.md` | 方案/规格或决策背景保留；仅状态行与交叉链接收口，不把文首历史语境当现行实现。 |
| `docs/design/task-delivery-workflow.md` | 移动 | `docs/governance/task-delivery-workflow.md` | 治理 §13：方针/流程/测试/工具链属于 L0 治理。 |
| `docs/design/test-implicit-contracts.md` | 拆入模块后归档 | `docs/archive/design/test-implicit-contracts.md（本机）；现行 docs/governance/TEST-ENV.md` | 验证矩阵与隔离/平台 skip 风险吸收至治理 TEST-ENV；历史计数和逐项评估留本机原件，不作为现行规则。 |
| `docs/design/worktree-isolation-serial-integration.md` | 原位保留 | `docs/design/worktree-isolation-serial-integration.md` | 方案/规格或决策背景保留；仅状态行与交叉链接收口，不把文首历史语境当现行实现。 |
| `docs/research/history-constraint-recovery.md` | 归档 | `docs/archive/research/history-constraint-recovery.md（本机）；现行 docs/modules/knowledge/design.md` | 历史调研；当前检索实现与未承诺约束恢复边界见 knowledge 模块及验证记录。 |
| `docs/runbooks/projectboard-usage.md` | 移动 | `docs/operations/runbooks/projectboard-usage.md` | 治理 §13：安装/发布/恢复/迁移/操作清单属于 L5 运维。 |
| `docs/runbooks/recovery-backup-then-repair.md` | 移动 | `docs/operations/runbooks/recovery-backup-then-repair.md` | 治理 §13：安装/发布/恢复/迁移/操作清单属于 L5 运维。 |
| `docs/runbooks/render-regression-samples.md` | 移动 | `docs/operations/runbooks/render-regression-samples.md` | 治理 §13：安装/发布/恢复/迁移/操作清单属于 L5 运维。 |
| `docs/specs/concurrency-phases-acceptance.md` | 原位保留 | `docs/specs/concurrency-phases-acceptance.md` | 方案/规格或决策背景保留；仅状态行与交叉链接收口，不把文首历史语境当现行实现。 |
| `docs/specs/d5-autoshell-spec.md` | 拆入模块后归档 | `docs/archive/specs/d5-autoshell-spec.md（本机）；现行 docs/modules/evidence/contract.md` | 已实施：fixed-auto.js 的 autoExternalEvidence/fixedEvents、evidence.js 的 normalizeEvidence 与 test/docs/doc-fixed-auto.test.mjs 对应自动来源、pin/降级和原子屏障；现行口径进入 evidence 内部契约。 |
| `docs/specs/filter-rules-v1-1-addendum.md` | 原位保留 | `docs/specs/filter-rules-v1-1-addendum.md` | 方案/规格或决策背景保留；仅状态行与交叉链接收口，不把文首历史语境当现行实现。 |
| `docs/specs/filter-rules-v1.md` | 原位保留 | `docs/specs/filter-rules-v1.md` | 方案/规格或决策背景保留；仅状态行与交叉链接收口，不把文首历史语境当现行实现。 |
| `docs/specs/query-module-v2.md` | 原位保留 | `docs/specs/query-module-v2.md` | 方案/规格或决策背景保留；仅状态行与交叉链接收口，不把文首历史语境当现行实现。 |
| `docs/specs/ui-2-spec.md` | 拆入模块后归档 | `docs/archive/specs/ui-2-spec.md（本机）；现行 docs/modules/client/design.md` | 已交付；当前字号/控件/样式源及页面边界进入 client 模块，不保留单文件/无构建的旧约束。 |

## 3. 新增、非旧文

下列新增均不属于 deb8637 旧文全集；它们可由 INDEX 到达（SVG 由图集与模块文档引用）。

| 路径 | 结论 | 去向 | 依据 |
|---|---|---|---|
| `docs/COMPATIBILITY.md` | 新增，非旧文 | 原位 | 治理、横向切面或操作入口。 |
| `docs/DOC-GOVERNANCE.md` | 新增，非旧文 | 原位 | 治理、横向切面或操作入口。 |
| `docs/GLOSSARY.md` | 新增，非旧文 | 原位 | 治理、横向切面或操作入口。 |
| `docs/TRUST-BOUNDARIES.md` | 新增，非旧文 | 原位 | 治理、横向切面或操作入口。 |
| `docs/decisions/contract-l1-reorganization.md` | 新增，非旧文 | 原位 | 治理/交付核对与历史决策记录。 |
| `docs/decisions/contract-legacy-surfaces.md` | 新增，非旧文 | 原位 | 治理/交付核对与历史决策记录。 |
| `docs/decisions/doc-disposition-2026-11-14.md` | 新增，非旧文 | 原位 | 治理/交付核对与历史决策记录。 |
| `docs/decisions/mvp-scope.md` | 新增，非旧文 | 原位 | 治理/交付核对与历史决策记录。 |
| `docs/diagrams/command-write.svg` | 新增，非旧文 | 原位 | 软件工程图资产，随源码保留。 |
| `docs/diagrams/context.svg` | 新增，非旧文 | 原位 | 软件工程图资产，随源码保留。 |
| `docs/diagrams/doc-evidence.svg` | 新增，非旧文 | 原位 | 软件工程图资产，随源码保留。 |
| `docs/diagrams/layers.svg` | 新增，非旧文 | 原位 | 软件工程图资产，随源码保留。 |
| `docs/diagrams/module-map.svg` | 新增，非旧文 | 原位 | 软件工程图资产，随源码保留。 |
| `docs/diagrams/read-isolation.svg` | 新增，非旧文 | 原位 | 软件工程图资产，随源码保留。 |
| `docs/diagrams/store-recovery.svg` | 新增，非旧文 | 原位 | 软件工程图资产，随源码保留。 |
| `docs/diagrams/task-plan-state.svg` | 新增，非旧文 | 原位 | 软件工程图资产，随源码保留。 |
| `docs/modules/client.md` | 新增，非旧文 | 原位 | 四层模块路由或 L3/L4 细则。 |
| `docs/modules/client/contract.md` | 新增，非旧文 | 原位 | 四层模块路由或 L3/L4 细则。 |
| `docs/modules/client/design.md` | 新增，非旧文 | 原位 | 四层模块路由或 L3/L4 细则。 |
| `docs/modules/command.md` | 新增，非旧文 | 原位 | 四层模块路由或 L3/L4 细则。 |
| `docs/modules/command/contract.md` | 新增，非旧文 | 原位 | 四层模块路由或 L3/L4 细则。 |
| `docs/modules/command/design.md` | 新增，非旧文 | 原位 | 四层模块路由或 L3/L4 细则。 |
| `docs/modules/documents.md` | 新增，非旧文 | 原位 | 四层模块路由或 L3/L4 细则。 |
| `docs/modules/documents/contract.md` | 新增，非旧文 | 原位 | 四层模块路由或 L3/L4 细则。 |
| `docs/modules/documents/design.md` | 新增，非旧文 | 原位 | 四层模块路由或 L3/L4 细则。 |
| `docs/modules/evidence.md` | 新增，非旧文 | 原位 | 四层模块路由或 L3/L4 细则。 |
| `docs/modules/evidence/contract.md` | 新增，非旧文 | 原位 | 四层模块路由或 L3/L4 细则。 |
| `docs/modules/evidence/design.md` | 新增，非旧文 | 原位 | 四层模块路由或 L3/L4 细则。 |
| `docs/modules/host.md` | 新增，非旧文 | 原位 | 四层模块路由或 L3/L4 细则。 |
| `docs/modules/host/contract.md` | 新增，非旧文 | 原位 | 四层模块路由或 L3/L4 细则。 |
| `docs/modules/host/design.md` | 新增，非旧文 | 原位 | 四层模块路由或 L3/L4 细则。 |
| `docs/modules/knowledge.md` | 新增，非旧文 | 原位 | 四层模块路由或 L3/L4 细则。 |
| `docs/modules/knowledge/contract.md` | 新增，非旧文 | 原位 | 四层模块路由或 L3/L4 细则。 |
| `docs/modules/knowledge/design.md` | 新增，非旧文 | 原位 | 四层模块路由或 L3/L4 细则。 |
| `docs/modules/plan.md` | 新增，非旧文 | 原位 | 四层模块路由或 L3/L4 细则。 |
| `docs/modules/plan/contract.md` | 新增，非旧文 | 原位 | 四层模块路由或 L3/L4 细则。 |
| `docs/modules/plan/design.md` | 新增，非旧文 | 原位 | 四层模块路由或 L3/L4 细则。 |
| `docs/modules/project.md` | 新增，非旧文 | 原位 | 四层模块路由或 L3/L4 细则。 |
| `docs/modules/project/contract.md` | 新增，非旧文 | 原位 | 四层模块路由或 L3/L4 细则。 |
| `docs/modules/project/design.md` | 新增，非旧文 | 原位 | 四层模块路由或 L3/L4 细则。 |
| `docs/modules/read.md` | 新增，非旧文 | 原位 | 四层模块路由或 L3/L4 细则。 |
| `docs/modules/read/contract.md` | 新增，非旧文 | 原位 | 四层模块路由或 L3/L4 细则。 |
| `docs/modules/read/design.md` | 新增，非旧文 | 原位 | 四层模块路由或 L3/L4 细则。 |
| `docs/modules/shared.md` | 新增，非旧文 | 原位 | 四层模块路由或 L3/L4 细则。 |
| `docs/modules/shared/contract.md` | 新增，非旧文 | 原位 | 四层模块路由或 L3/L4 细则。 |
| `docs/modules/store.md` | 新增，非旧文 | 原位 | 四层模块路由或 L3/L4 细则。 |
| `docs/modules/store/contract.md` | 新增，非旧文 | 原位 | 四层模块路由或 L3/L4 细则。 |
| `docs/modules/store/design.md` | 新增，非旧文 | 原位 | 四层模块路由或 L3/L4 细则。 |
| `docs/modules/task.md` | 新增，非旧文 | 原位 | 四层模块路由或 L3/L4 细则。 |
| `docs/modules/task/contract.md` | 新增，非旧文 | 原位 | 四层模块路由或 L3/L4 细则。 |
| `docs/modules/task/design.md` | 新增，非旧文 | 原位 | 四层模块路由或 L3/L4 细则。 |
| `docs/operations/CLI.md` | 新增，非旧文 | 原位 | 治理、横向切面或操作入口。 |

## 4. CONTRACT 链接重指

仅改文档引用目标或路径文字；章节、领域语义、命令/错误/工具表规则均不改。下列行号以 s7 输入 `76c5fd4` 为准，D1 不变。

| 旧行 | 旧目标/文字 | 新目标 |
|---|---|---|
| 357 | `docs/EXTERNAL-DOCS.md` | `docs/modules/documents/contract.md` |
| 446 | `PLAN-V2.md`、`MIGRATION.md` | `modules/plan/contract.md`、`operations/MIGRATION.md` |
| 582 | `EXTERNAL-DOCS.md` | `modules/documents/contract.md` |
| 613 | `DOC-EXTERNAL-EVIDENCE.md` | `modules/evidence/contract.md` |
| 626 | `MIGRATION.md` | `operations/MIGRATION.md` |
| 662 | `RELEASE.md` | `operations/RELEASE.md` |
| 687 | `IDENTITY.md` | `modules/project/contract.md` |
| 985 | `DOC-EXTERNAL-EVIDENCE.md` | `modules/evidence/contract.md` |
| 995 | `MIGRATION.md` | `operations/MIGRATION.md` |

库内链接统一尖括号语法仅影响 Markdown 目标解析，不改变目标文件的产品语义。此处不得为旧目标保留跳转文件，也不在检查器增加旧路径白名单。

## 5. 收口与口径冲突

- 治理文字曾把链接/隐私机器检查列为后续事项；本次按验收明确接 CI，并将治理改成现行门禁。测试验证矩阵归治理 TEST-ENV，而非不存在的 operations/TEST-ENV。
- 多篇旧方案含单文件/无构建、显式批准或待实施的历史口径；归档原件保留背景，现行解释归模块/L1，不沿用旧文作为能力证明。D5 实现的原因集合含 HEAD 竞争等细分，按 pinReason 及测试核对，不复制旧规格原因清单。
- CONTRACT 旧链接与“不留旧路径占位”冲突，按机械路径重指裁定处理；不改任何行为规则，D1、lib/src/test 保持零 diff。README 随包自包含，源码治理/运维目标保留代码格式，不新增包外链接。
- 公共隐私范围为 docs 下文档和根 README/AGENTS；test 下是合成 fixture 文档，链接仍全库检查，隐私不把测试说明当公开产品文档。真实反例仅用同一行说明性注释豁免，不设文件/路径白名单。
- 框架约束曾链接不存在的集成 runbook，改路由至现行发布边界。旧文件名只在本记录以代码映射留存，INDEX 不路由本机档案。

delegation: no — 受限子代理直接执行本次文档/脚本收口，未再委派；不操作看板，不提交。
