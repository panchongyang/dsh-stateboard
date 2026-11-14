# 命令总线模块设计

> 文档定位：L3 模块设计；L1 权威：[命令信封与提交结果](<../../CONTRACT.md#21-命令信封错误码与-http-映射>)、[命令清单](<../../CONTRACT.md#22-命令清单>)、[服务与句柄](<../../CONTRACT.md#服务与句柄>)。

本文解释应用编排；调用约定见[内部契约](<contract.md>)，分层位置见[L2 入口](<../command.md>)。

## 1. 职责与非职责

ProjectHandle 为一个打开项目提供命令串行化、工作副本和提交发布边界。
它把领域处理器、运行时租约与 store 接起来，而不是再定义一套业务状态机。

**非职责**：

- 不代替 host 认证 HTTP/MCP/DSH 调用身份。
- 不在总线里复制 task/plan/doc 的参数表与状态跃迁表。
- 不执行 command/test 证据，不保证外部副作用回滚。
- 不自动合并版本冲突，不把 submit 改成自动完成。
- 不负责跨项目事务；每个 handle 对应一个项目日志。

## 2. 内部结构

| 部件 | 组织目的 |
|---|---|
| [handle.js](<../../../lib/core/handle.js>) | ProjectHandle、队列、staging、append、生命周期 |
| [commands/index.js](<../../../lib/core/commands/index.js>) | 唯一 op → handler(handle, cmd) 注册表 |
| [command-shape.js](<../../../lib/core/command-shape.js>) | intake 顶层与计划嵌套字段准入 |
| [normalize.js](<../../../lib/core/normalize.js>) | 策略、验收项、标签、依赖定义归一化 |
| [contracts.js](<../../../lib/core/contracts.js>) | 事件构造及租约释放记录 |
| [service.js](<../../../lib/core/service.js>) | 项目发现、打开及共享句柄；重导出 ProjectHandle |

队列只属于 handle；独立 service 在插件重载时复用共享 handle。
store 还有目录保护，防止绕开共享表创建第二个独立 writer。
[写入时序图](<../../diagrams/command-write.svg>)用来区分 host 准入、领域守卫和提交。

## 3. 一次命令的数据流

### 进入串行区

command 先检查句柄已打开，然后把回调接到 _chain。
_exclusive 的成功和失败分支都会延续队列，单条失败不会毒化后续命令。
进入后检查 op/cmdId 与只读状态，再查询已提交 cmdIds。
已提交重复命令直接返回去重结果，不重新计算业务。

项目级 CAS 随后校验；archived 写闸在生成 blob 或改租约前拦截。
unarchive 以更新前 phase 判定，不能把普通 active→paused 当恢复。
实体级 CAS 由相应领域处理器校验，不由总线猜实体类型。

### 在工作副本上计算

_executeOnWorkingCopy 克隆整个 state 和 lease Map 中的记录。
normalizeExpiredLeases 先把可回收租约的事件应用到工作投影。
外部工作会话的绑定变化也先加入 preceding 事件，而不直接发布。
_execute 从注册表取 handler，做 intake 形状检查，再计算领域结果。
最后检查候选事件是否新增同阶段依赖路径。

这一步可以有内容观测 I/O，也可能按文档路径预写 blob。
“工作副本”隔离的是内存状态与租约，不是文件系统事务沙箱。
抛错时恢复真实 state/leases，回收事件、token 变化和业务事件一起丢弃。

### 提交与发布

有业务事件时，将 preceding 放在业务事件前面。
先切回真实 state/leases，再由 _appendEvents 构造和追加 commit。
store.append 返回它真正应用事件的 state，总线显式采用该对象。
assertStateAttached 防止 handle/store 的别名关系断裂。

提交成功后才安装工作 lease 表，并处理必要的运行时绑定活性。
unarchive 成功后清运行时租约并标记已恢复。
最后尝试 relocate 的 meta/registry 派生更新，失败仅返回 warning。

## 4. 无事件不是失败

handler 可能返回空事件：例如重复 focus、无变化 gate、重复 adopt。
这种语义 no-op 不追加 commit，也不持久登记新的 cmdId。
不能把 ok=true 一律解释为 committed=true。

task.renew 是特殊 memoryOnly 分支，保留工作 lease 表但不发布工作 state。
该分支会放回本次工作投影回收的其他租约，避免无 commit 的回收泄漏。
显式续期不写日志，与普通事件提交的幂等边界不同。

## 5. 关键取舍

### 全状态克隆而不是处理器就地修改

就地修改后回滚每个字段容易遗漏 lease、counter、binding 等旁状态。
统一克隆让守卫失败具有一致的丢弃边界，处理器只需返回事件。
代价是每条命令付出随 state 大小增长的克隆和临时内存成本。

### 回收与业务同批而不是入口先落一次回收

若先独立回收，再让业务失败，拒绝命令仍改变了日志和实体 rev。
反过来先算业务再回收，又可能把旧快照覆盖回 in_progress。
因此先在 staging 投影回收，业务成功后同一 commit 提交。
CAS 仍对调用方能读到的 committed rev，不能要求它提供临时 rev。

### 显式 state 交接而不是默认共享引用

store adapter 可能改变对象返回方式；隐式假设会让后续读看不到已提交事件。
采用返回值后断言引用，能把这种错误快速暴露为内部一致性故障。
这也是不能直接在 handler 返回后发布 staging 对象的原因。

### 后置 warning 而不是提交成功后抛普通失败

日志已确认成功后，relocate 元数据失败不应诱使调用方重复副作用。
因此主提交结果与派生同步分开；下一次 service.open 可从日志自愈。
快照则由 store 处理，失败静默，不混为 relocation warning。

## 6. 失败、恢复与降级

参数、角色、CAS、租约、验收或阶段依赖失败，不发布 staging 状态。
文件观测可能已经发生；允许的 blob 预写也可能留下物理文件。
这些都不能当作有公开业务事件，不能宣称全文件系统零副作用。

append 若结果不明，store 只读状态同步到 handle，下一条命令在入口拒绝。
不能换 cmdId 绕过这一拒绝；冷开以日志和原 cmdId 判断结果。
锁外读与普通 writer open 的差异见[store 设计](<../store/design.md>)。

recover 每个 writer 一次，按持久任务 owner 重建终止租约审计。
只读或 archived 不单独恢复；archived 的恢复与 unarchive 同批。
attach/detach 也经队列；archived 只变内存 binding，不追加事件。

touch 是内存活性和有界续租，不是业务进展，也不是队列内事件命令。
healthAsync 使用隔离审计；普通 brief 的内存摘要不等同于完整审计。

## 7. I/O 成本与热路径

- 正常热写经过一次全 state/lease 克隆、领域处理与单行同步 append/fsync。
- 同一项目的慢处理器会延迟该项目后续命令；不是所有项目共用一个队列。
- 证据归一化、file/doc 审计可能读磁盘或 Git，对耗时不能只计 append。
- relocate 提交后的元数据写在响应路径上，但不改变提交成败。
- 查询投影通常同步；完整 health 与锁外冷读属于其他受控路径。
- recover 批量收尾避免每个任务各写一个 commit，仍有完整事件批次成本。

不通过缓存“上次 allowedOps”来替代写时守卫；省 I/O 不能改变并发正确性。

## 8. 阅读顺序

1. [handle.js](<../../../lib/core/handle.js>)：command → _executeOnWorkingCopy → _execute → _appendEvents。
2. [commands/index.js](<../../../lib/core/commands/index.js>)：找到目标业务处理器。
3. [command-shape.js](<../../../lib/core/command-shape.js>)和[normalize.js](<../../../lib/core/normalize.js>)：区分形状拒绝与归一化。
4. [lease.js](<../../../lib/core/lease.js>)：normalizeExpiredLeases、assertRev、renewLease。
5. [store.js](<../../../lib/core/store.js>)：append 返回 state 的真实发布边界。
6. [service.js](<../../../lib/core/service.js>)：_openSync、共享句柄、_healMeta。

修改交接顺序时先读[别名守卫测试](<../../../test/core/alias-guard.test.mjs>)和[句柄生命周期测试](<../../../test/core/handle-lifecycle.test.mjs>)，再读具体领域回归。
