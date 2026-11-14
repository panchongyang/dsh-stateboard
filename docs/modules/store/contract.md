# 存储模块内部契约

> 文档定位：L4 模块内部契约；L1 权威：[存储格式](<../../CONTRACT.md#25-存储格式与事件兼容>)、[提交结果](<../../CONTRACT.md#21-命令信封错误码与-http-映射>)、[schema 与降级](<../../CONTRACT.md#4-兼容与降级>)。

本文约束 core 内部调用；不是 npm 新增导出承诺。设计理由见[模块设计](<design.md>)。

## 1. 责任边界与非职责

调用方负责构造经领域守卫认可的事件批次；store 负责持久化与折叠。
**非职责**：不替调用方校验业务权限、执行证据、领取任务或迁移旧数据。
只读诊断不修复；完整检查域见[L1 health/fsck](<../../CONTRACT.md#health--fsck-只读诊断>)。

## 2. 导出 API 与入口

[store.js](<../../../lib/core/store.js>)是内部持久化门面：

| 导出/方法 | 调用语义 |
|---|---|
| JsonlStore(dir, meta, opts) | 指定项目目录；opts.lock=false 为锁外只读；opts.fs 是局部写故障注入端口 |
| MemoryStore(meta, commits) | 合成内存后端，不模拟真实磁盘持久性 |
| open() | 同步加载并返回 state/commits/timeline/lastSeq/lastHash/cmdIds/readOnly |
| append(commit) | 同步追加、应用事件，返回 store.state 本体 |
| refresh() | JsonlStore 追读增长部分；无新增完整行或已关闭时返回 null |
| saveSnapshot() | best-effort 派生快照；只读时不写 |
| writeBlob(body) / readBlob(hash) | 写内容寻址正文；读取失败为 null |
| readMigrationBlob(hash) | JsonlStore 的严格迁移读取端口，语义见[实现](<../../../lib/core/documents/migration-blob.js>) |
| close() / touchLock() | 生命周期与合作锁维护；close 只清自身 acquisition |
| readStateWithoutLock(dir, meta) | 临时 lock=false store 的持久状态投影，不获取 writer、不 recover |
| makeCommit / commitHash / SUPPORTED_COMMIT_VERSION | 从[format.js](<../../../lib/core/store/format.js>)重导出 |

MemoryStore 没有磁盘 follower refresh；close/touchLock/saveSnapshot 为测试用 no-op。
不能据其测试通过推出 fsync、跨进程锁或断电恢复通过。

## 3. 输入校验域

冷开完整链验证由 validateCommit 和事件注册表共同执行。
commit 信封字段与哈希算法只在[L1](<../../CONTRACT.md#25-存储格式与事件兼容>)定义。

- commit.v 必须受支持，seq/prev/hash/events 必须通过逐条校验。
- 所有日志事件，包括快照覆盖段，都必须可理解。
- 外置文档结构与固定索引另有全日志/快照校验，不能跳过。
- 最终 state 必须通过[schema.js](<../../../lib/core/schema.js>)的准入检查。
- append 不是重新运行命令守卫，也不是完整 fsck 的替代。
- JsonlStore 的写前 seq/prev/size/锁检查不能由 MemoryStore 行为替代。

meta 必须由 service 或合成 fixture 正确提供；store 不从任意目录猜项目身份。
新增 store adapter 应保持 open/append 返回值和状态别名约定。

## 4. 不变量与提交边界

state 的拥有对象是 store，handle 必须采用 append 返回的同一引用。
commits、cmdIds、timeline 与末端信息只能在已接受的批次之后推进。
调用方不能把 handler 的工作副本直接安装成已提交投影。

日志行 append + fsync 并通过链约束，才可声明 committed。
快照失败不使日志回滚；blob 的存在也不构成文档公开提交。
追加后的文件大小不符时拒绝继续，不能自动接续陌生尾。

写异常时只有本次尾部身份、大小、前缀和锁归属均可确认才回退。
回退已确认则抛原错误；未确认则 log-write-uncertain 并只读。
close 异常同样可能使结果不明，不允许宣称确定未写。
完整无 LF 的合法记录冷开仍会进入 cmdIds，不能因曾报错重复落盘。

## 5. 并发、幂等与锁

store 不提供命令并发队列；调用方经 ProjectHandle 的串行入口写入。
cmdId 去重由 handle 使用 open 返回的 Set 实施；不要绕过总线直接重放副作用。

- 同进程第二个独立 writer 受 OPEN_STORES 目录保护。
- 锁不可得的打开可能成功但 readOnly=true；调用方必须检查。
- acquisition 临界区、锁 nonce 与心跳文件的规则见[lock.js](<../../../lib/core/store/lock.js>)。
- 同机活 PID 不按心跳年龄接管；跨主机锁需要人工维护决策。
- append 前检查 pid/nonce，失锁后不能用旧心跳夺回写权。
- 这是合作协议，不是对任意外部 OS 写者的强制隔离。

readStateWithoutLock 不注册 writer，返回的不是运行时 lease 表。
refresh 只处理增长后的完整 LF 记录，不承诺检测同大小替换或日志缩短。

## 6. 错误分类

错误 code/status 的唯一表在[L1 错误码](<../../CONTRACT.md#错误码>)。
此处只说明调用方处理策略，不复制整表：

- 格式/链损坏：保留原数据，按 details 的合法前缀定位，不自动 salvage。
- 版本/事件/schema 拒读：换用匹配构建或显式迁移，不跳过记录。
- 锁忙、失锁或日志分叉：停止当前写路径，不能无条件重试 append。
- 结果不明：冷开核对实际日志与原 cmdId，不把异常翻译成确定未提交。
- readBlob 的 null 不是空正文；上层必须保留 missing 与 hash 错误语义。

底层 I/O 异常也可能原样抛出，不承诺所有故障均包装为 BoardError。

## 7. 隐含契约

1. open 可能创建锁/目录，service.open 还可能 recover；零写读取应选锁外端口。
2. open 失败会 close 自身资源，但不能据此认定没有任何旁文件曾被创建。
3. readOnly 同时约束 handle 与 store；结果不明时两层都应阻断后续写入。
4. 先预写 blob 后事件提交允许物理孤儿；没有自动 GC，不枚举目录公开文档。
5. 引用快照不意味着跳过兼容扫描；快照不是回退备份。
6. append 接收可信内部 commit；新增入口必须在进入此层前完成领域验证。

## 8. 兼容类别与版本域

事件分类唯一来源是[EVENT_REGISTRY](<../../../lib/shared/events.js>)。
applied 才投影，additive 可 no-op，migration/refuse 拒读；细则见[L1 兼容分类](<../../CONTRACT.md#事件兼容契约fail-closed>)。
commit.v/snapshot.v 与运行时 schemaVersion 是不同版本域；fixed.v 也独立。
运行时 schema 准入不是“版本号大于等于3就保证所有字段安全”。
additive 事件不代表旧构建理解审计门或验收范围；回退须匹配完整数据与代码。
维护步骤见[迁移说明](<../../MIGRATION.md>)，阅读本文不授予真实 store 修复权限。

## 9. 验证入口

- [提交边界](<../../../test/storage/commit-boundary.test.mjs>)：已提交、确定失败与不确定窗口。
- [事件兼容](<../../../test/storage/event-compat.test.mjs>)：未知事件与快照覆盖段。
- [锁竞争](<../../../test/core/lock-race.test.mjs>)：并发 acquisition 与归属。
- [存储完整性](<../../../test/core/store-integrity.test.mjs>)：链和格式反例。
