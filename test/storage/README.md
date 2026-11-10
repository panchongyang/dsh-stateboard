# storage 模块测试

## 范围

store、日志完整性、提交边界、回放、迁移、修复与 salvage；隔离 worker 保持在 ../faults、../salvage。

| 文件 | 职责 | suite |
|---|---|---|
| [commit-boundary.test.mjs](commit-boundary.test.mjs) | 区分已持久化的业务提交与后续 meta/快照写失败，避免误报回滚或重复项目。 | `test:core` |
| [event-compat.test.mjs](event-compat.test.mjs) | 冻结事件分类与未知事件 fail-closed 的重放/修复边界。 | `test:core` |
| [migration-replay.test.mjs](migration-replay.test.mjs) | 保证 store 副本的版本、任务、计划、焦点和健康结果可重复重放，源目录保持只读。 | `test:core` |
| [repair-log.test.mjs](repair-log.test.mjs) | 保证分叉日志修复规划只选可验证链，对非分叉损坏拒绝猜测修复。 | `test:core` |
| [replay-snapshot.test.mjs](replay-snapshot.test.mjs) | 兼容缺 planHeads/currentPlans 的旧快照，使后续计划事件仍可正确重放。 | `test:core` |
| [salvage-log.test.mjs](salvage-log.test.mjs) | 确保日志抢救和显式修复 worker 只在合成隔离环境执行。 | `test:core` |
| [store-faults.test.mjs](store-faults.test.mjs) | 确保 R3 存储故障与 framing 测试在最小隔离子进程运行。 | `test:core` |
| [stores-replay.test.mjs](stores-replay.test.mjs) | 验证 store 门禁的事件覆盖、定位诊断、基线比较与副本隔离。 | `test:core` |

## 不覆盖

不访问真实用户 store/profile，不替代其他模块的领域测试或人工 UI 验收；本目录不是产品运行入口。

## 外部前置

Node 22+，可写临时目录和 Node 子进程；具体 Git/链接等前置见文件头。

## 运行

在仓库根执行：

```powershell
node --test test/storage/*.test.mjs
```

suite 归属不由目录名推断，以表格和根 [测试索引](../README.md) 为准；默认 core/client/host 接线由递归 discovery 门禁检查。
