# 文档治理：分层、归属与维护规则

> 状态：现行。本文规定文档怎么分层、每层写什么、旧文档怎么处置；产品行为以 [实现契约](CONTRACT.md) 为准，方案取舍以各模块文档与 `decisions/` 为准。

## 1. 要解决的问题

1. **目录名与内容状态脱钩**：`design/` 里既有现行流程，也有未实施方案；`specs/` 里既有已交付规格，也有待评审规格。
2. **契约与设计混装**：`CONTRACT.md` 同时装对外契约、MVP 范围、目录结构、CLI 与测试清单、验收和子代理边界；`DESIGN.md` 同时装领域模型、架构、模块细节和交付路线。
3. **模块没有文档落点**：改一个模块要翻契约、设计、专题文档和后端基线多处，同一事实存在多个副本。

本文用**按读者与稳定性分层**解决这三件事；不新增产品承诺，不改冻结契约。

## 2. 分层模型

| 层 | 目录 / 文件 | 读者 | 写什么 | 不写什么 |
|---|---|---|---|---|
| L0 治理 | `governance/`、本文件、[项目框架约束](CONSTRAINTS.md) | 先定边界的人 | 方针、约束、交付流程、测试分级、工具链、自治边界 | 产品行为、模块实现 |
| L0 设计背景 | [DESIGN.md](DESIGN.md) | 想理解取舍的人 | 问题定义、设计立场、总体取舍、历史路线入口 | 逐条行为承诺、当前参数表 |
| L1a 领域模型 | `CONTRACT.md` 前半 | 外部集成者、Agent | 词汇表、任务/计划状态机、不变量、可信度口径 | 函数级实现细节 |
| L1b 对外契约 | `CONTRACT.md` 主体 | 外部集成者、Agent | 命令、事件、错误、查询、HTTP、工具、MCP、存储格式、兼容与降级 | 内部函数、设计论证 |
| L1c 冻结子契约 | [D1 冻结契约](WORKSPACE-DOCUMENTS-CONTRACT.md) | 改文档能力的人 | 身份、四维状态、读取边界、固定证据（只登记不改写） | 实现细节 |
| L2a 架构地图 | [ARCHITECTURE.md](ARCHITECTURE.md) | 新会话、改架构的人 | 分层、arch-map、入口、不变量、构建产物 | 模块内部设计 |
| L2b 运行时路径 | `ARCHITECTURE.md` 运行时小节 + 模块文档时序说明 | 排障、改链路的人 | 写入时序、读取与隔离、恢复路径 | 逐函数说明 |
| L3 模块设计 | `modules/<slug>/design.md` | 改这个模块的人 | 职责与非职责、内部结构、数据流、取舍、失败与降级、I/O 成本、阅读顺序 | 逐条对外承诺 |
| L4 模块内部契约 | `modules/<slug>/contract.md` | 调用这个模块的人 | 导出 API 与语义、输入校验域、不变量、副作用与提交边界、并发/幂等、错误分类、隐含契约、兼容类别 | 产品级承诺、设计论证 |
| L5 运维 | `operations/` | 操作的人 | 发布、恢复、迁移、安装、演示、runbook、验收清单 | 模块设计 |
| L6 档案 | `decisions/`、`design/`、`specs/`、`archive/` | 查沿革的人 | 决策背景、未实施方案、未实施规格、历史材料 | 现行规则 |

横向切面（跨模块、不归属任何单层）：

- `GLOSSARY.md`（一期建立）：全仓唯一词汇表，替代 `DESIGN.md` §3.1 的分散定义。
- `TRUST-BOUNDARIES.md`（一期建立）：鉴权、只读 Git、证据只记录不执行、human-only 操作。
- `COMPATIBILITY.md`（一期建立）：schema、事件兼容类别、迁移与回退口径。
- 测试与验证矩阵：放在 `operations/TEST-ENV.md` 与各模块 `contract.md` 的验证小节，不另立总表。
- 容量与性能：`decisions/capacity-100k-boundary.md` 是决策背景，现行口径写在 L1 与模块文档。

## 3. 目录布局

```text
docs/
  INDEX.md                     # 唯一路由入口
  DOC-GOVERNANCE.md            # 本文件
  CONTRACT.md                  # L1，唯一随 npm 包发布的文档
  ARCHITECTURE.md              # L2
  DESIGN.md                    # L0 设计背景
  GLOSSARY.md                  # 横向：术语表
  TRUST-BOUNDARIES.md          # 横向：安全与信任边界
  COMPATIBILITY.md             # 横向：兼容与数据
  governance/                  # L0：方针、约束、流程、测试、工具链
  modules/<slug>/              # L3 + L4，每个模块一个目录
    design.md
    contract.md
  operations/                  # L5：发布、恢复、迁移、安装、演示、runbook
  diagrams/                    # 架构图资产（SVG）
  design/                      # 未实施方案，实施完成后迁出并归档
  specs/                       # 未实施规格，交付后并入模块文档并归档
  decisions/                   # 决策与复议背景，只登记不改写
  archive/                     # 历史材料，本机保留、不入库
```

顶层只保留四层入口与三个横向切面；其余按目录归位。模块目录名用单数小写 slug，与架构地图的模块划分一致。

## 4. 单一事实源

一条事实只在一个文件定义，其他地方只链接。判定方法：**这个事实变化时要改几个文件**。

- 定义处：1 个；引用处：若干，只写路径与一句话用途，不复制表格、字段清单或错误码全集。
- 同一事实出现两处完整描述，即视为缺陷；即使两处当前一致，也按缺陷登记。
- 契约先改 [实现契约](CONTRACT.md)，再改模块 `contract.md`，最后改实现；设计文档只解释为什么。

允许的重复只有三种：背景一句话、指向定义的链接、示例中必要的片段（须标注来源）。

## 5. 模块划分与代码对应

| 模块 | 代码范围 | 现有素材（迁移来源） |
|---|---|---|
| `shared` | `lib/shared/` | 契约枚举、事件分类 |
| `project` | `service.js`、`identity/`、`project-list-*`、`project-reader*` | [项目身份](IDENTITY.md)、契约 §2.1 |
| `command` | `handle.js`、`contracts.js`、`normalize.js`、`schema.js`、`command-shape.js` | 契约 §2.2、[设计背景](DESIGN.md) §4 |
| `task` | `commands/task*`、`lease.js`、`intent.js`、`audit.js` | 契约 §2.4、§2.6 |
| `plan` | `commands/plan*`、`plan-stages.js` | [计划 v2](PLAN-V2.md) |
| `documents` | `commands/doc*`、`documents/external*`、`inline-doc-access.js`、`documents/migration*` | [外置文档](EXTERNAL-DOCS.md)、[内嵌迁移](DOC-MIGRATION.md)、[D1 契约](WORKSPACE-DOCUMENTS-CONTRACT.md) |
| `evidence` | `evidence.js`、`documents/fixed*`、`git-exec.js` | [固定内容证据](DOC-EXTERNAL-EVIDENCE.md)、[Git 执行边界](GIT-EXECUTION.md) |
| `store` | `store/`、`fsck.js`、`repair.js` | 契约 §2.9、[恢复](RECOVERY.md) |
| `read` | `views.js`、`digest.js`、`health*.js`、`model.js` | 契约 §2.5、§2.10 |
| `knowledge` | `knowledge/` | [历史知识读取](design/history-knowledge-read-model.md) |
| `host` | `lib/index.js`、`host/*` | 契约 §3 |
| `client` | `src/client/` | [UI 重做](UI-REDESIGN.md)、[前端分层](design/frontend-layering.md) |

模块文档的 design 与 contract 各写一份；`shared` 只有 `contract.md`（它没有独立运行逻辑，设计见 L1a）。

## 6. 文件规范

- **标题**：`# 中文标题`，与文件用途一致；标题变更须全库修引用。
- **状态行**：`design/`、`specs/`、`decisions/` 与带日期的报告必须在文首写 `> 状态：…`，取值限定为 `待实施`、`实施中`、`已实施`、`已否决`、`已替代（指向新文档）`。顶层现行文档默认就是现行，不强制写状态行；一旦不再是现行，必须移动或改状态。
- **链接**：库内一律相对路径；不写本机绝对路径、真实 task/project/session id、私网地址；指向实现文件时写仓库相对路径。
- **长度**：单篇超过约 400 行先按读者拆分，不靠目录层级掩盖；模块文档超过约 250 行按子域拆 `modules/<slug>/<sub>.md`，并在 `design.md` 开头列子文档。
- **命名**：顶层现行文档用大写短横线（沿用现状）；`design/`、`specs/`、`decisions/` 用小写短横线；模块目录用单数小写 slug。
- **语言**：中文为主，领域名词保留契约原名（`cmdId`、`projectRev`、`fencing-stale`），首次出现给中文解释。

## 7. 图

架构图是文档的一部分，不是装饰，也不是字符画的替代品。

- **位置与格式**：`docs/diagrams/<主题>.svg`，矢量、纯文本可 diff；不引入外部图床、位图截图或构建期图片处理。需要位图预览时在本机临时生成，不提交。
- **内容**：分层与依赖、模块数据流、写入时序、读取与审计隔离、存储与恢复、文档与证据状态、任务/计划状态机、客户端分层、宿主装配。每张图只回答一个问题，标题写在图内。
- **视觉**：统一画布与配色（层级色块、正交连线、2px 描边），最小字号 13px，宽度不超过 1200；白底深字，保证亮暗主题下都能读；不依赖外部字体。
- **嵌入**：文档中用 `![完整句子描述](../diagrams/xxx.svg)` 引用，图片必须可被文档页渲染；图后紧跟 3–6 行“读图要点”，再给结构表。
- **文本可读性**：删掉图，正文仍能完整表达；图不替代契约条款、错误码或不变量表。
- **准确性**：图必须与基线代码和契约核对；图与文字冲突时以契约和实现为准，并修图。

反例：用 `┌──┐` 字符画代替架构图；用 UI 截图冒充架构图；图里写满字段清单却没有文字说明。

## 8. 归档

- 归档 = 从入库树移除，本机保留在 `docs/archive/`（该目录在 `.gitignore` 中，不入库）；不硬删工作副本。
- 归档前确认：已有替代文档；没有现行文档链接它；`INDEX.md` 不再路由它。
- 归档后在 `decisions/` 留一份本次处置记录，列出旧路径、去向（新路径或归档）与原因；不为旧路径保留跳转占位文件，避免出现第二个事实源。
- 冻结文档（D1）与决策档案只登记，不因重构改写内容。
- 看板任务、计划记录里的历史路径不改写；追溯以决策记录和 Git 历史为准。

## 9. 维护流程

| 场景 | 动作 |
|---|---|
| 改代码行为 | 先改 L1（若对外可见），再改模块 `contract.md`，最后改实现；模块 `design.md` 只在取舍变化时改 |
| 改模块内部实现 | 只改模块 `design.md` 与 `contract.md` 的相关段落；不动 L1 |
| 新增能力 | 按 L1 → L4 → L2 的顺序登记；在 `INDEX.md` 加一行 |
| 移动或改名 | 同一提交内修全库引用（含 `AGENTS.md`、`README.md`、`INDEX.md`）；移动后跑链接检查 |
| 方案实施完成 | 把结果并入模块文档，原文移到 `design/` 之外的归档；`specs/` 同上 |
| 新决策 | 写 `decisions/<主题>.md`，只记背景与取舍，不复制契约 |

## 10. 验收与检查

一期完成时逐条核对：

1. 每篇现行文档能归入 L1–L5 之一，没有“哪层都不像”的文档。
2. 同一事实不再有两处完整描述；抽查契约、模块契约、设计三者的字段清单。
3. `INDEX.md` 的路由与磁盘一致，链接全部可解析。
4. 每篇 `design/`、`specs/`、`decisions/` 文档有状态行。
5. 图能在文档页显示，每张图有 alt、读图要点与结构表。
6. 归档文档不在入库树，决策记录列出旧路径与去向。

后续机器检查（不属于一期）：链接存在、INDEX 覆盖、状态行、公共文档不含真实 id 与绝对路径；检查脚本不得以注释或字数比例作为质量指标。

## 11. 归属判定示例

- “`task.claim` 需要有效租约且 token 匹配” → L4 `modules/task/contract.md`（调用方必须遵守的内部不变量）。
- “命令返回 `{ ok, committed, projectRev, entityRev, events }`” → L1 命令信封（对外可观察）。
- “为什么单写者 + 心跳锁” → L3 `modules/store/design.md`（设计理由）；锁文件格式 → L4。
- “错误码 `fencing-stale` 的触发条件” → L1 错误表；模块 `contract.md` 只链接，不复制整表。
- 反例：在 `ARCHITECTURE.md` 写租约回收算法（应下沉 L3/L4）；在模块 `design.md` 复制命令参数表（应链接 L1）。

## 12. 图与文档的关系

图是 L2/L3 的辅助阅读材料：L2 放全局分层、时序与数据流；L3 放模块内部结构与状态机；L1 不依赖图（随 npm 包发布，保持纯文本）。文档页图片渲染是产品能力，见 [实现契约](CONTRACT.md) 的文档读取小节（渲染落地后在此补链接）。

## 13. 现有文档去向（一期）

下表是一期的处置方向，正式逐篇结论与路径映射在收口任务里登记；`已实施` 以任务与验证记录为准，不按文档标题推断。

| 现有文档 | 去向 | 处理 |
|---|---|---|
| `CONTRACT.md` | L1（路径不变） | 重排为 1a 领域模型 / 1b 对外契约 / 1c 冻结索引 |
| `ARCHITECTURE.md` | L2 | 瘦身，模块叙述下沉 |
| `DESIGN.md` | L0 设计背景 | 压缩为问题定义与取舍；§3 进 L1a，§4 进 L2/L3 |
| `PRODUCT-PRINCIPLES.md`、`CONSTRAINTS.md`、`AUTONOMOUS-DELIVERY.md`、`CONTRIBUTING.md`、`TESTING-POLICY.md`、`TEST-ENV.md`、`TYPESCRIPT.md`、`BACKEND-READABILITY.md` | `governance/` | 移动，内容就地维护 |
| `RELEASE.md`、`RECOVERY.md`、`MIGRATION.md`、`MIGRATION-ENTRY.md`、`INSTALL.md`、`DEMO.md`、`DOC-MIGRATION.md`、`DOCS-UI-CHECKLIST.md`、`CHANGELOG.md`、`runbooks/*` | `operations/` | 移动，内容就地维护 |
| `IDENTITY.md` | `modules/project/` | 拆为 design 与 contract 后归档原文 |
| `PLAN-V2.md` | `modules/plan/` | 拆为 design 与 contract 后归档原文 |
| `EXTERNAL-DOCS.md` | `modules/documents/contract.md` | 迁入后归档原文 |
| `DOC-EXTERNAL-EVIDENCE.md` | `modules/evidence/contract.md` | 迁入后归档原文 |
| `GIT-EXECUTION.md` | `modules/evidence/`（Git 边界） | 迁入后归档原文 |
| `WORKSPACE-DOCUMENTS-CONTRACT.md` | L1c（原位保留） | 冻结，只登记不改写 |
| `UI-REDESIGN.md` | `modules/client/design.md` | 迁入设计系统与组件规范后归档原文 |
| `design/task-delivery-workflow.md` | `governance/` | 提升为现行流程 |
| `design/test-implicit-contracts.md` | `operations/TEST-ENV.md` 验证矩阵 | 提升后归档原文 |
| `design/frontend-layering.md` | `modules/client/design.md` | 迁移完成、架构基线并入后归档 |
| `design/history-knowledge-read-model.md` | `modules/knowledge/design.md` | 已实现，迁入后归档 |
| `specs/ui-2-spec.md` | `modules/client/design.md` | 已交付，迁入后归档 |
| `specs/d5-autoshell-spec.md` | `modules/evidence/` | 先核对实现状态，再迁入或保留 |
| `design/` 其余未实施方案、`specs/` 未实施规格、`decisions/*` | 原位保留 | 只补状态行与链接，不改内容 |
| `research/*`、`CAPACITY.md`、`MAINTAINABILITY.md`、`UI-AUDIT.md`、`ROBUSTNESS-2026-10-22.md`、`RELIABILITY-REVIEW-2026-10-29.md`、`RESEARCH-dsh-tasks-manager.md`、`WORKSPACE-DOCUMENTS-PLAN.md` | `docs/archive/`（本机） | 归档；已交付或带日期的评估/调研 |

移动或归档时，同一提交内更新 `INDEX.md`、`AGENTS.md`、`README.md` 与全库引用；不保留跳转占位文件。
