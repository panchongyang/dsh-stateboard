# 任务、租约与意图模块内部契约

> 文档定位：L4 模块内部契约；L1 权威：[任务状态机](<../../CONTRACT.md#12-任务状态机>)、[命令面](<../../CONTRACT.md#22-命令清单>)、[结算协议](<../../CONTRACT.md#221-intent-结算rfc-3>)。

本文约束 handler/helper 调用；产品转移与参数完整表不在此复制。设计见[模块设计](<design.md>)。

## 1. 职责与非职责

任务模块返回任务、意图与租约事件，并维护工作投影中的执行权。
**非职责**：不直接 append、不认证 actor、不执行证据或自动撤销外部副作用。
调用方必须经 ProjectHandle.command，不能直接调用 handler 后把工作副本当已提交状态。

## 2. 导出 API 与内部入口

| 入口 | 语义 |
|---|---|
| [TASK_HANDLERS](<../../../lib/core/commands/task.js>) | 注册任务 op；override 在总注册表独立编排 |
| [intake handlers](<../../../lib/core/commands/task-intake.js>) | 创建、编辑、门控、就绪；同步返回事件结果 |
| [work handlers](<../../../lib/core/commands/task-work.js>) | 领取、开始、提交、验收与驳回 |
| [governance handlers](<../../../lib/core/commands/task-gov.js>) | 结算、中断、恢复与终态重开 |
| [lease helpers](<../../../lib/core/lease.js>) | requireTask/assertRev/assertLease/grantLease 等，以 handle 为首参 |
| previewClaimDenial | 与命令共享领取判定；读预览不提交回收 |
| normalizeExpiredLeases | 仅供命令工作投影，返回 preceding 回收事件 |
| renewLease | 返回 events=[]、memoryOnly=true 的运行时结果 |
| [intent helpers](<../../../lib/core/intent.js>) | normalizeSideEffects / settleOpenIntent |
| [audit helpers](<../../../lib/core/audit.js>) | 角色/独立性、报告形状、记录与范围指纹 |

handle 的同名下划线方法是委托壳，不是另一个授权层。

## 3. 输入校验域

已有任务先 requireTask，再按 committed rev 执行 assertRev。
实体 rev 必须是整数且匹配；缺失也不能跳过 CAS。
到期投影的临时 rev 由 _lapsed.baseRevs 还原为已提交比较域。

- intake 经过[shape 白名单](<../../../lib/core/command-shape.js>)；不能把它推广到全部工作命令。
- 创建需要非空标题和非空验收项；deps 要存在，编辑还检查全任务图无环。
- mergeAcceptance 按文本继承原条目；省略或空数组表示保留，不是清空。
- requiresAudit 与保留 gate 标签必须通过共用归一化；不能在入口自行解释别名。
- begin 需要 summary；interrupt/reconcile 的 note 以及 reject 的 reason 有独立检查。
- 报告、sideEffects 与证据的范围分别由 audit/intent/evidence 模块强制。

actor 身份由可信入口建立；helper 不为调用方自报的 human 授权背书。

## 4. 不变量与副作用边界

任务快照、open intent 与 lease Map 是不同结构，不能只更新其中一个就发布。
进入 in_progress 的路径必须检查计划未归档；此闸不等于归档计划所有元数据禁写。
owner 只用于持久任务状态，不可替代运行时 leaseOf。

授租时 token 在工作 state.counters 中递增，由 lease/granted 持久延续。
begin 写意图并退休旧 attempt 证据；失败不发布其工作计数和新记录。
submit/reconcile completed 的内容审计在进入 review 前运行一次，hard 错误整体拒绝。
verify 的内容复核与材料覆盖不证明 command/test 执行成功。

治理命令关闭 open intent 必须经 settleOpenIntent，返回的事件和任务迁移同批。
声明 unknown 不能关闭；无 open intent 却提交 settlement 也非法。
sideEffects 的形状/数量/字节域见[L1](<../../CONTRACT.md#221-intent-结算rfc-3>)与[intent 实现](<../../../lib/core/intent.js>)，它是声明而非宿主证明。

## 5. 并发、续期与恢复

assertLease 校验执行 session 与 fencingToken；human 特例必须按具体命令理解。
只传正确 entityRev 不足以替代 fencing；只传 token 也不能绕过 CAS。

leaseOf 对“到期仍可续”与“应回收”分开判断，不能仅比较 expiresAt 与当前时间。
时钟运算通过注入 clock；touch/renew 共用无进展期限，二者都不算真实进展。
显式 renew 消耗续租次数，touch 不按每次读取消费次数。
renew 无事件、不推进 rev；MCP 同 cmdId 仅在当前 lease 内运行时去重。

回收与业务在同一工作投影、同一 commit；业务被拒连回收一起丢弃。
原持有者对可回收 open intent 的恢复例外仅适用 interrupt/reconcile。
例外要求同 session/live binding epoch 与原 token；其他会话不能终止继任 lease。
重启后旧 lease 不复活，recover 记录从持久 owner 重建的已知终止信息。

## 6. 验收与审查约定

普通 agent verify 不要求独立性；审计门用 verificationRoleProblem 检查独立性。
worker 集合包括 superseded 证据的 producedBy，不能只看 active 证据。
报告是自述；human 不因缺 worker 或缺报告而失去验收出口。

agent done 的 lastAudit 由 makeAuditRecord 绑定 active 材料、worker 和实质范围。
taskRev 是历史锚点，不随管理元数据调整重写。
assertAuditScopeUnchanged 阻止 plan.revise 把旧 agent pass 贴到新范围。
行政归属、排序不在 scopeDigest 域；精确域以[audit.js](<../../../lib/core/audit.js>)为准。

agent 显式传漂移刷新/豁免字段即拒绝，不能用 false 试探 human 分支。
human 的刷新和豁免按[L1 verify](<../../CONTRACT.md#12-任务状态机>)留痕，不能放宽 acceptance 或独立性约束。

## 7. 错误分类

完整 code/status 见[L1 错误码](<../../CONTRACT.md#错误码>)。
调用方分别处理参数拒绝、非法转移、依赖/CAS、租约/角色、材料覆盖与内容漂移。
forbidden-role 的 details.reason 可区分 worker-unknown/not-independent；不要误当租约冲突。
submit/reconcile 漂移拒绝不发布任务或租约变化；修正内容后按当前合法状态重提。
租约恢复提示优先使用服务端 details.next/hint，不自动补新 token 或绕过 intent。

## 8. 隐含契约与已知实现边界

1. planRef 不属于 task.create 契约，成员关系只能经计划版本变化；当前实现未拦截该字段，调用方不得依赖。位置见[shape](<../../../lib/core/command-shape.js>)及[taskCreate](<../../../lib/core/commands/task-intake.js>)。
2. 不把 update 的 human 无租约特例扩展为 agent 权限；具体编辑域见[L1](<../../CONTRACT.md#12-任务状态机>)。
3. unblock 不重建 intent；恢复外部副作用前需 begin。
4. reopen 可能重授租约或回 backlog；返回后重读，不假定固定 ready。
5. requiredKinds 是材料覆盖条件，不是命令执行或内容正确性等级。
6. 成功的 stopped/abandoned 只结算本次尝试，不代表世界已回滚。

## 9. 兼容类别与验证

任务使用运行时 schema v3 准入和布尔 requiresAudit；不识别旧门别名作为新输入。
事件的 applied/additive/migration/refuse 取自[唯一注册表](<../../../lib/shared/events.js>)，不在处理器自行降级。
审计字段/I23 的语义变化可不新增事件类型；旧构建能打开不代表能安全验收。
历史 execution/auto/policy 只按[L1 兼容域](<../../CONTRACT.md#4-兼容与降级>)读取，不驱动新执行或自动完成。

边界回归见[租约编辑](<../../../test/core/lease-edit.test.mjs>)、[续期](<../../../test/core/lease-renew.test.mjs>)、[意图结算](<../../../test/core/intent-settlement.test.mjs>)与[任务生命周期](<../../../test/core/task-lifecycle.test.mjs>)。
