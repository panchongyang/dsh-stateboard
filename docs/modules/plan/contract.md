# 计划与阶段模块内部契约

> 文档定位：L4 模块内部契约；L1 权威：[计划模型](<../../CONTRACT.md#13-计划模型>)、[Plan v2 命令](<../../CONTRACT.md#223-plan-v2-命令>)、[不变量](<../../CONTRACT.md#14-不变量>)。

本文面向 core/适配器调用方，不复制全部产品参数表。结构取舍见[模块设计](<design.md>)。

## 1. 职责与非职责

计划处理器生成 head、版本和任务归属的原子事件批次。
**非职责**：不直接 append、不授租约、不执行任务、不删除实体、不写手工进度。
计划归档不等同项目 archived 写闸，focus 也不构成任务执行授权。

## 2. 导出 API 与内部入口

| 入口 | 语义 |
|---|---|
| [PLAN_HANDLERS](<../../../lib/core/commands/plan.js>) | 计划 op → 同步 handler(handle, cmd) |
| [plan-life handlers](<../../../lib/core/commands/plan-life.js>) | create/publish/revise/rename/archive/unarchive/focus |
| requireHead / assertHeadRev / assertTitleUnique | head 存在性、实体 CAS、项目标题唯一域 |
| [planMembership](<../../../lib/core/commands/plan-members.js>) | active head、当前版本及 baseVersion 共用守卫 |
| planMembershipTaskIds | taskIds 字符串化、去空、去重；空集合拒绝 |
| planAdopt / planRelease | 产生 version+1 与受影响任务事件 |
| [assertPublishStageDependencies](<../../../lib/core/plan-stages.js>) | 发布前按计划 key 检查阶段分组 |
| assertNoNewStageDependencies | 总线出口按候选事件检查新增成员/依赖路径 |
| stageWorkOf(state, task?) | 只读阶段提示或 null，不授执行权 |

所有写入必须经 handle.command 获得 staging、去重与提交边界。
读模型完整返回结构见[L1 查询](<../../CONTRACT.md#查询>)，不从 handler 返回值拼出第二套视图。

## 3. 输入校验域

create/publish/revise 经[shape 准入](<../../../lib/core/command-shape.js>)，其他计划命令依各自守卫。
草稿可省略 steps；发布需要 normalizeSteps 成功。

- 定义层 shape 拒未知属性，限制 step/task 集合，并严格检查 requiresAudit/gate 标签。
- 发布新任务必须有标题和验收项；复用 taskId 的修订可继承原验收项。
- 初次发布的 deps 是计划内 key；active revise 还可引用本项目已有 taskId。
- 未知 taskId 不能默默当成新任务；不存在的依赖不能自动创建。
- active revise 是完整定义重建，不是逐字段 patch；normalizeSteps 对省略的 priority/weight/deps 使用 100/1/[]，不要推断省略即保留。
- description 可继承，acceptance 按文本合并；title 仍需非空。精确归一化见[normalizeSteps](<../../../lib/core/normalize.js>)。
- 同阶段直接/间接新增路径检查在发布与总线出口执行，不只看 deps 是否直接相邻。

key 唯一、成员单归属和无环是[L1 不变量](<../../CONTRACT.md#14-不变量>)，不能以底层结构容忍某输入为新授权。

## 4. 三个修订域

head 级命令由 assertHeadRev 比较 cmd.expected.entityRev 与 head.rev。
active revise/adopt/release 比较 baseVersion 与 head.currentVersion。
projectRev 是可选的总线 CAS；focus 不要求强制提供，但提供旧值仍拒绝。

handler 的 entityRev 不总表示 head.rev：

- create/publish、draft revise、rename、archive/unarchive 返回 head 修订号。
- active revise/adopt/release 的成功变更返回内容 version。
- adopt 全部跳过时返回 head.rev，且不提交事件。
- focus 变更的 entityRev 采用新项目 rev。

调用方应以重读的 head/currentVersion 为下一次 CAS 来源，不盲用上一次 entityRev。

## 5. 不变量与成员语义

head 管理面和版本快照分离；rename 不改历史版本标题。
发布和修订把版本、head、任务快照放同批，不能逐条独立追加。
计划标题在项目内去空白/大小写归一后唯一，archived 也占名。

adopt 接纳计划外或本计划旧版本孤儿，不通过它移动当前成员到另一个 step。
当前版本已含的成员跳过；换阶段应 revise。
跨计划移动按[L1](<../../CONTRACT.md#13-计划模型>)先 release 再 adopt，不承诺两个命令原子完成。
release 只接受当前版本成员；清 planRef，实体与历史证据都保留。
revise 移除则 orphaned=true 并保留旧 planRef，不是 release。

未变成员可能保留旧 planRef.version；当前阶段以当前版本 steps 为准。
归属不能用任务指针版本号与 head.currentVersion 必须相等的简化判断。
active revise 未给计划 title 时采用旧版本标题；若此前只 rename head，调用方应显式传入当前标题，见[revisedTitle](<../../../lib/core/commands/plan-life.js>)。
计划内 task 的生命周期仍由 task 模块负责，不从计划是否“完成”强制推 task 状态。

## 6. 副作用、提交与审计范围

处理器只产生内存结果，实际提交统一由总线和 store 完成。
无成功 commit 不得公开新版本、半套任务或候选 focus。
新任务与新验收项 id 在 staging 中生成，失败后不构成已公开实体。

active revise 对复用任务调用 assertAuditScopeUnchanged。
agent 已验收任务的实质范围变化拒绝；计划归属和排序变化不伪造重新验收。
adopt/release 不改实质任务定义，不能把它们当编辑 acceptance 的后门。
阶段守卫还会在出口检查，处理器返回 events 不等于可直接提交。

## 7. 并发、幂等与租约

同项目所有计划仍共享一条日志串行写；不同计划可使用各自版本 CAS。
若调用方额外要求 projectRev，则别的计划写入也可能造成项目级冲突。
已提交 cmdId 去重由总线完成；不是计划函数自行缓存返回值。

重复 adopt 的 no-op 发生在 head/baseVersion/step 检查之后。
重复 focus 也先通过角色、目标状态与总线 CAS；新 cmdId 的 no-op 不落盘。
归档要求当前成员无 in_progress/运行时 lease；不在归档里强行撤租。
需要进入执行态的任务路径另查计划归档闸，不能把 ready 卡片当执行许可。

## 8. 错误分类与调用提醒

完整错误表见[L1](<../../CONTRACT.md#错误码>)；这里只区分处理动作：

- head/版本冲突：重读后重新构造定义，不自动改 baseVersion 重试旧方案。
- 标题、目标 step、归属冲突：修输入或先显式 release/unarchive。
- 在途工作拒绝：先按任务流程收口，不能靠归档或成员改写取消执行权。
- 新阶段依赖：拆阶段或解除路径；details 定位任务与依赖成员。
- 审计范围锁：human reopen 后返工重提，不覆盖 lastAudit 指纹。

未知计划的 query 返回空投影与命令的 plan-not-found 不同，以[L1 查询](<../../CONTRACT.md#查询>)为准。
focus 只授 human；普通 agent 不能把管理偏好写成执行顺序强约束。

## 9. 兼容与验证

计划 v2 是领域能力名，不是 store schemaVersion=2。
运行时 schema 准入见[L1 兼容域](<../../CONTRACT.md#4-兼容与降级>)；不在运行时自动迁移旧门。
normalizePlanHeads 只派生缺失管理面，不自动归位计划外/孤儿任务。
事件类别来自[EVENT_REGISTRY](<../../../lib/shared/events.js>)；applied/additive/migration/refuse 不能由 handler 私自解释。
[PLAN-V2](<../../PLAN-V2.md>)是背景，旧的 focus 强制项目 CAS、未知查询报错等措辞不能覆盖 L1。

边界回归见[计划生命周期](<../../../test/core/plan-lifecycle.test.mjs>)、[并发](<../../../test/core/plan-concurrency.test.mjs>)、[阶段依赖](<../../../test/core/plan-stages.test.mjs>)与[验收项](<../../../test/core/plan-acceptance.test.mjs>)。
