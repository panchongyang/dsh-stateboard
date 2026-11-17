# 任务、租约与意图模块设计

> 文档定位：L3 模块设计；L1 权威：[任务状态机](<../../CONTRACT.md#12-任务状态机>)、[任务命令](<../../CONTRACT.md#22-命令清单>)、[Intent 结算](<../../CONTRACT.md#221-intent-结算rfc-3>)。

本文供修改任务领域的人阅读；调用方看[内部契约](<contract.md>)，定位见[L2 入口](<../task.md>)。

## 1. 职责与非职责

任务模块把工作流、执行权、意图结算和验收记录连接成事件批次。
任务是唯一工作单元；计划和阶段只提供归属及推进提示。

**非职责**：

- 不执行文件修改、shell 命令、网络请求或 evidence.ref。
- 不证明工作正确，不把内容 hash 相等等同结论通过。
- 不创建计划成员关系，不为 step 建立第二套任务状态机。
- 不认证 host 身份，不管理跨进程文件锁。
- 不回滚外部副作用，不把 abandoned 解释成“什么都没发生”。

## 2. 内部结构

| 部件 | 维护关注点 |
|---|---|
| [task.js](<../../../lib/core/commands/task.js>) | TASK_HANDLERS 注册表 |
| [task-intake.js](<../../../lib/core/commands/task-intake.js>) | create/update/gate/ready，队列元数据与依赖 |
| [task-work.js](<../../../lib/core/commands/task-work.js>) | claim/begin/submit/verify/reject |
| [task-gov.js](<../../../lib/core/commands/task-gov.js>) | block/unblock/interrupt/reconcile/release/cancel/reopen/override |
| [lease.js](<../../../lib/core/lease.js>) | CAS、资格、租约时钟、WIP、到期投影 |
| [intent.js](<../../../lib/core/intent.js>) | 治理结算的唯一公共构造路径 |
| [audit.js](<../../../lib/core/audit.js>) | worker 身份、独立性、验收范围指纹 |

[model.js](<../../../lib/core/model.js>)提供 fold 和共享状态辅助函数。
[evidence 模块](<../evidence.md>)负责材料归一化、固定引用与内容观测。
本模块决定何时调用观测，不复制 Git 或文档安全读取算法。

## 3. 正常工作数据流

claim 调用共享领取资格判定，授予新 token，返回 lease 与任务快照事件。
begin 在已有执行权下建立 open intent，记录本次 attempt 与预期产物。
新 attempt 退休旧证据、重算覆盖并清最近审查，避免返工沿用旧材料。

submit 先归一化整批证据，再按 identity 退休旧 active 行。
补完验收覆盖后构造固定证据事件，在进入 review 的边界做一次内容审计。
观测失败会让整个工作投影丢弃；成功才关闭 intent、进入 review 并释放执行权。
这里不做自动 verify，也不在每加一行材料时重复全量审计。

verify 先检查状态、角色、验收覆盖与报告，再重新观测内容。
成功写验收记录，并在同批中级联推进依赖已完成的 backlog 任务。
“同批”避免 done 已公开但其直接派生队列仍是旧状态的间隙。
所有产品转移细节在 L1，不从[状态示意图](<../../diagrams/task-plan-state.svg>)推导额外权限。

## 4. 三种身份数据不能混用

owner 是任务快照中的持久执行痕迹，不是运行时 TTL 的事实源。
lease Map 是当前进程执行权，touch/renew 的 expiresAt 不逐次写回任务快照。
assignee 是工作归属，review/blocked 可保留它以支持自动接回。

worker 集合还包含证据来源与历史工作者，用于审计门的独立性判断。
createdBy 不因为“创建了卡片”就成为 worker。
因此从“谁创建任务”或“当前没有 owner”都不能推断独立审查资格。

## 5. 关键取舍

### 租约与 fencing，而不是永久拥有者

会话可以失联，永久 owner 会把任务永久卡死。
仅 TTL 又无法排除同会话旧尝试迟到，所以 grant 分配单调 token。
运行时活性按注入时钟判断，持久 grant 只记录关键边界。
这让测试能精确推进时间，也避免工具读取把日志变成心跳流水。

### 宽限与无进展上限同时存在

短暂超时不立即剥夺执行权，避免长工具执行后只能人工解锁。
但读取/touch/renew 不能无限延长无进展工作，因此续期受绝对期限约束。
真实 begin/submit 等进展才重置进展时钟，拒绝命令不算进展。
宽限是恢复机会，不是额外无限续期额度。

### 意图 WAL，而不是崩溃后猜测

begin 的 intent 在外部副作用之前留下计划记录。
进程死后系统只知道“可能执行过”，不能从文件是否存在推断全部副作用。
因此有 intent 的回收进入 interrupted，要求显式 reconcile。
无 intent 则可以回 ready，但这不证明调用方没有违规提前执行外部动作。

### stopped 声明，而不是治理按钮隐式清场

block/release/cancel 不能抹掉 open intent 的不确定性。
共用 settleOpenIntent 要求调用方明确停止并列已知副作用。
结果不明就保留 intent，走 interrupt/reconcile，不伪装成功回滚。
这使用户看到的是责任交接，而不是“点按钮世界恢复原样”。

### 验收范围指纹，而不是只存最后一次 pass

计划修订能改任务实质范围；仅保留旧 pass 会把旧结论贴到新交付上。
scopeDigest 锚定实质验收范围，不把归档、排序与计划归属误当重新验收。
因此行政调整可保留历史锚点，实质变化必须 reopen 后重新交付。
审计报告仍是验收者自述，不升级为系统执行证明。

## 6. 中断、恢复与降级

回收先由总线在工作投影执行，随后业务守卫基于回收后的状态运行。
后续失败会连同回收一起丢弃，旧 lease/token 不被半提交改变。
可回收且有 intent 的原 session/epoch 可按受限路径 interrupt/reconcile。
renew/begin/submit 不享受这条恢复例外；不能拿旧 token 复活新 lease。

writer 冷启时 lease Map 为空，由 handle.recover 批量终止持久 in_progress。
重建记录仅复制 task.owner 已知信息，不能编造续租次数或进展时间。
archived 不独立写恢复 commit；unarchive 同一批收尾。

unblock 根据 resumeTo 与原 assignee 能否恢复分流，不自动 begin。
reopen 也按依赖及 assignee 条件分流，不能假定总回 ready。
reject 可自动接回仍有效的原 assignee；MCP 工作会话要求显式 claim。
这些路径的可执行分支必须重新读取，不缓存先前 allowedOps。

内容固定不可观测可产生 warning；结构/身份/hash 不符不冒充降级成功。
人工 verify 的 refresh/waive 留责任与告警；agent 没有这条自助逃生权。

## 7. I/O 成本与热路径

- claim/ready/gate 的领域计算主要是内存检查，提交 I/O 由总线和 store 完成。
- update 依赖图检查会遍历任务；阶段新增路径检查还跨计划当前版本。
- submit/verify/reconcile completed 会执行文件或文档内容读取与 hash。
- fixed Git 观测经证据层，只读并受它自己的读取限额约束。
- begin 退休历史材料、auditWorkers 和 scopeDigest 随任务材料数量增长。
- touch/renew 不产生 commit；不能因此把它们忽略为“没有状态变化”。

完整 health 与 submit/verify 的边界审计不同，不能每次读卡片都同步做全量磁盘审计。

## 8. 阅读顺序

1. [task.js](<../../../lib/core/commands/task.js>)定位 op，再读对应 intake/work/gov 函数。
2. [lease.js](<../../../lib/core/lease.js>)先看 assertRev、assertClaimAllowed、assertLease。
3. 同文件再看 leaseRenewalExpiry、normalizeExpiredLeases、assertRecoverable。
4. [intent.js](<../../../lib/core/intent.js>)看 settleOpenIntent 与 normalizeSideEffects。
5. [audit.js](<../../../lib/core/audit.js>)看 verificationRoleProblem、auditScopeDigest、makeAuditRecord。
6. [handle.js](<../../../lib/core/handle.js>)看工作投影丢弃与 recover。

回归按[租约回收](<../../../test/core/lease-reclaim.test.mjs>)、[意图结算](<../../../test/core/intent-settlement.test.mjs>)、[任务生命周期](<../../../test/core/task-lifecycle.test.mjs>)、[重启终止审计](<../../../test/core/restart-expiry-audit.test.mjs>)的边界阅读。
