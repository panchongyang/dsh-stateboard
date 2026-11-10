# core 模块测试

## 范围

状态机、计划、租约、锁、意图、项目身份、fsck 与 handle；包含 R3 矩阵 launcher，worker 保持在 ../matrix。

| 文件 | 职责 | suite |
|---|---|---|
| [alias-guard.test.mjs](alias-guard.test.mjs) | 保证 handle 与 store 共享同一个状态对象，避免提交后读模型丢写。 | `test:core` |
| [archived.test.mjs](archived.test.mjs) | 约束项目和计划归档时的写屏障、活跃工作保护与恢复时机。 | `test:core` |
| [clock-ttl.test.mjs](clock-ttl.test.mjs) | 用注入时钟约束租约 TTL、宽限期与续期截止时间。 | `test:core` |
| [core-matrix.test.mjs](core-matrix.test.mjs) | 确保默认门禁在最小隔离环境的子进程中运行 R3 核心矩阵。 | `test:core` |
| [task-lifecycle.test.mjs](task-lifecycle.test.mjs) | 约束任务发布、领取、交付、驳回与归属恢复。 | `test:core` |
| [plan-lifecycle.test.mjs](plan-lifecycle.test.mjs) | 约束计划草案、发布、版本、焦点与成员。 | `test:core` |
| [store-integrity.test.mjs](store-integrity.test.mjs) | 守住日志重放、完整性、单写者与项目搬迁。 | `test:core` |
| [lease-edit.test.mjs](lease-edit.test.mjs) | 约束租约身份、证据边界、轻编辑与创建者来源。 | `test:core` |
| [delivery.test.mjs](delivery.test.mjs) | 约束交付摘要中的身份尾码、时间线裁剪、检查点和文本净化。 | `test:core` |
| [digest.test.mjs](digest.test.mjs) | 阻止项目和任务文本伪造摘要规则块，并保持可控长度与可省略规则的稳定输出。 | `test:core` |
| [fsck-intents.test.mjs](fsck-intents.test.mjs) | 让健康检查只读诊断意图、工作引用、owner 和归档活跃工作的不变量。 | `test:core` |
| [handle-lifecycle.test.mjs](handle-lifecycle.test.mjs) | 维护同进程多 service 共享 handle 的引用计数与锁释放时机。 | `test:core` |
| [identity-conflicts.test.mjs](identity-conflicts.test.mjs) | 保证项目身份冲突、导入与创建中断不造成覆盖历史或重复看板。 | `test:core` |
| [identity.test.mjs](identity.test.mjs) | 维护随机稳定项目 id、路径绑定、旧路径哈希兼容与 worktree 发现规则。 | `test:core` |
| [intent-settlement.test.mjs](intent-settlement.test.mjs) | 约束开放工作意图退出时必须显式结清，未知结果只能中断后对账。 | `test:core` |
| [lease-reclaim.test.mjs](lease-reclaim.test.mjs) | 防止命令内租约回收投影被旧任务快照覆盖，并提供受限的过期工作恢复入口。 | `test:core` |
| [lease-renew.test.mjs](lease-renew.test.mjs) | 限制显式续租与隐式 touch 的无进展占用时间，保护会话/epoch 边界。 | `test:core` |
| [lock-race.test.mjs](lock-race.test.mjs) | 保证多进程抢锁、死锁接管和 claim 清理不会形成双 writer。 | `test:core` |
| [lock.test.mjs](lock.test.mjs) | 维护 JSONL store 单写锁的活进程保护、死进程接管与 nonce 校验。 | `test:core` |
| [plan-acceptance.test.mjs](plan-acceptance.test.mjs) | 守住计划物化任务必须有验收点，既有任务修订不得无意丢失验收要求。 | `test:core` |
| [plan-concurrency.test.mjs](plan-concurrency.test.mjs) | 保证多个活动计划交错修改时各自版本、成员、焦点与归档互不污染。 | `test:core` |
| [restart-expiry-audit.test.mjs](restart-expiry-audit.test.mjs) | 保证冷启动清理持久 owner 时与任务恢复同提交记录 lease/expired 审计。 | `test:core` |
| [state-machine.test.mjs](state-machine.test.mjs) | 封住终态编辑、依赖成环、过期版本与跨项目任务修订的非法转移。 | `test:core` |

## 不覆盖

不访问真实用户 store/profile，不替代其他模块的领域测试或人工 UI 验收；本目录不是产品运行入口。

## 外部前置

Node 22+，可写临时目录和 Node 子进程；具体 Git/链接等前置见文件头。

## 运行

在仓库根执行：

```powershell
node --test test/core/*.test.mjs
```

suite 归属不由目录名推断，以表格和根 [测试索引](../README.md) 为准；默认 core/client/host 接线由递归 discovery 门禁检查。
