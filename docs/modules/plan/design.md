# 计划与阶段模块设计

> 文档定位：L3 模块设计；L1 权威：[计划模型](<../../CONTRACT.md#13-计划模型>)、[计划命令](<../../CONTRACT.md#223-plan-v2-命令>)、[进度派生](<../../CONTRACT.md#15-进度与派生量>)。

本文面向计划领域实现者；调用方见[内部契约](<contract.md>)，整体位置见[L2 入口](<../plan.md>)。

## 1. 职责与非职责

计划管理 initiative 的可写 head、不可变内容版本和任务归属变化。
阶段是有序的工作分组与集中审查提示，不是可领取的容器任务。

**非职责**：

- 不建立父子任务、嵌套 step、跨项目计划或排期系统。
- 不执行任务，不授予 lease，不改变 task.verify 的授权规则。
- 不直接写完成百分比，不因完成自动归档。
- 不删除任务或计划，不把 orphaned 当丢弃指令。
- 不管理 Git 分支，不自动把会话 plan mode 文本导入计划。

## 2. 内部结构

| 部件 | 结构职责 |
|---|---|
| [plan.js](<../../../lib/core/commands/plan.js>) | PLAN_HANDLERS 注册表 |
| [plan-life.js](<../../../lib/core/commands/plan-life.js>) | 生命周期、发布/修订与共享 head 守卫 |
| [plan-members.js](<../../../lib/core/commands/plan-members.js>) | adopt/release 的版本构造与任务归属更新 |
| [plan-stages.js](<../../../lib/core/plan-stages.js>) | 新阶段依赖路径检查、stageWorkOf 投影 |
| [normalize.js](<../../../lib/core/normalize.js>) | normalizeSteps、依赖环与验收项归一化 |
| [model.js](<../../../lib/core/model.js>) | 计划版本键、head 兼容派生和事件折叠 |

head 是管理面；plans 的 id@version 键是历史内容面。
currentPlans/currentVersion 用于找到当前版本，不是复制一份可写 steps。
[PLAN-V2](<../../PLAN-V2.md>)提供背景；现行参数与语义不从背景旧表推导。

## 3. 草稿与发布数据流

create 只产生 draft head，草稿步骤可以尚不具备发布条件。
入口 shape 检查未知字段和门定义，草稿发布时还会重新验证。
不为 draft 分配实体任务，所以未决定的方案不污染工作队列。

publish 先 resolvePublishInput：有 planId 则取现存 draft，无则兼容 create+publish。
normalizeSteps 后展开任务定义，校验依赖与同阶段新增路径。
建立 key→新 taskId 映射，再将定义转换为版本 steps.taskIds 与任务快照。
发布 head、版本、任务和必要的自动 focus 在同一批返回给总线。
中途任一拒绝都不会公开半个计划或只生成部分任务。

publish 时的 key 是计划内定义身份，不是永久 taskId。
发布后成员只由版本的 steps 表达；之后不能靠 task.create 偷塞归属。

## 4. 修订与成员数据流

草稿 revise 仅更新 head.draft；active revise 构造新 version。
active 路径通过 taskId 复用已有身份，否则生成新任务身份。
候选任务带新的 planRef，移除成员保留旧引用并标 orphaned。
任务的验收材料和范围还会触发 auditScopeUnchanged，不能借计划编辑绕过验收记录。

adopt/release 复用 head 查找与 baseVersion 守卫，但有独立处理函数。
它们复制当前 steps 构造新版本，不经 revise 的完整定义重写路径。
adopt 只修改被接纳任务的归属，不改 title/acceptance/deps。
release 清被移出任务的 planRef，不删除实体。
未变成员可以保留旧 planRef.version；当前阶段成员必须从当前版本 steps 读取。

旧版本带 superseded 记录保留追溯，不因 head.rename 重写历史标题。
管理列表显示 head.title，历史内容仍能回答发布当时的标题与范围。

## 5. 阶段依赖与工作提示

发布前，assertPublishStageDependencies 在计划内 key 图上检查分组。
其他写入在总线出口调用 assertNoNewStageDependencies，联合看候选成员与 deps。
它比较旧/新路径，不把存量阶段内依赖追溯判为拒读条件。
移除已有路径合法，移除后重建则属于新增路径，要重新拒绝。

stageWorkOf 读当前任务所属活动计划，或无当前任务时读焦点计划。
按 step 顺序找到第一个有非终态成员的阶段，再生成 implement/audit/waiting 提示。
ready/review ID 列表有界，不能把提示列表长度当任务总数。
提示不改变资格：当前阶段 blocked 时可以先处理前置或其他合法解阻工作。
[任务与计划图](<../../diagrams/task-plan-state.svg>)中的阶段箭头不是另一套 task 状态机。

## 6. 关键取舍

### head 与版本分离，而不是可变计划大对象

标题、归档和焦点是管理操作；不应每次重命名都伪造新交付版本。
内容版本独立保留，便于任务引用、历史比较与并发编辑。
代价是调用方必须分清 head.rev、currentVersion 和 project.rev 三个比较域。

### 成员变化生新版本，而不是可变成员表

可变成员表会让同一历史计划在不同时间代表不同任务集合。
版本化变更给成员关系一个可追溯时间点，并与任务指针同批提交。
代价是不能仅凭单个任务 planRef 的版本号猜当前阶段列表。

### orphan 与 release 分离，而不是统一清空

修订删除某项不等于明确放弃该任务，保留旧指针可解释它从哪里来。
release 则明确移出，成为合法计划外工作，可随后 adopt 到另一个计划。
跨计划移动因此是两个显式命令，不是跨计划原子移动承诺。

### 分组依赖守卫，而不是事后排程器

同阶段保持独立有利于逐项提交后集中审查，减少每项都等待另一项验收。
真正先后关系应拆阶段，而不是在分组内部藏执行顺序。
守卫只禁止新增关系，保留旧项目可读可继续的兼容边界。

### 显式归档，而不是完成即退役

计划完成与是否还需查看、维护和接纳成员不是同一决策。
归档先确认没有在途执行，不在归档动作里偷偷撤销工作者执行权。
focus 是人的偏好而不是 active 唯一性，多个 initiative 可以并存。

## 7. 失败、恢复与降级

CAS 冲突要求重读 head 或当前版本，不自动 merge definitions。
发布与成员批次经总线 staging，拒绝不会公开部分版本。
恢复数据后由 normalizePlanHeads 补派生管理面，不自动 adopt 计划外任务。

归档计划拒绝进入执行态，但不把它扩大为所有任务元数据全面禁写。
归档时清对应 focus；unarchive 还原 archivedFrom，不自动重新聚焦。
审计范围锁定时先 human reopen 再返工，不强写新指纹盖过旧记录。

输入看似未变也可能触发前置校验；只有已提交 cmdId 才走总线持久去重。
重复 adopt 的语义 no-op 不等于忽略 baseVersion 或不存在的 step。
错误分类与精确调用域见[内部契约](<contract.md>)。

## 8. I/O 成本与热路径

- 领域处理本身主要是内存归一化、图遍历和事件构造。
- publish 的任务数决定事件批次大小和 taskId/验收项分配成本。
- revise 会复制候选任务，生成 orphan 事件，并计算已验收任务的范围指纹。
- adopt/release 复制 steps 并写被改变成员，不给全部任务重写 planRef。
- 阶段守卫建立依赖/反向依赖索引；新增路径检查受图规模影响。
- 阶段提示只派生当前版本，进度由读模型计算，不写“缓存百分比”。

真正 append/fsync、快照与全 state staging 成本由[命令总线](<../command/design.md>)和[store](<../store/design.md>)承担。
不把纯内存处理描述成无成本，也不在此给容量 SLA。

## 9. 阅读顺序

1. [plan.js](<../../../lib/core/commands/plan.js>)找到操作入口。
2. [plan-life.js](<../../../lib/core/commands/plan-life.js>)：planPublish、resolvePublishInput、reviseActive、assertHeadRev。
3. [plan-members.js](<../../../lib/core/commands/plan-members.js>)：planMembership、planAdopt、planRelease。
4. [plan-stages.js](<../../../lib/core/plan-stages.js>)：两个 assert 入口与 stageWorkOf。
5. [normalize.js](<../../../lib/core/normalize.js>)及[model.js](<../../../lib/core/model.js>)：定义归一化、版本 fold/head 派生。

回归先读[计划生命周期](<../../../test/core/plan-lifecycle.test.mjs>)、[计划并发](<../../../test/core/plan-concurrency.test.mjs>)与[阶段依赖](<../../../test/core/plan-stages.test.mjs>)，再读[验收项继承](<../../../test/core/plan-acceptance.test.mjs>)。
