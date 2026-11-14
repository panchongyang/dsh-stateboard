# 存储模块设计

> 文档定位：L3 模块设计；L1 权威：[存储格式与事件兼容](<../../CONTRACT.md#25-存储格式与事件兼容>)、[提交边界](<../../CONTRACT.md#21-命令信封错误码与-http-映射>)、[冻结子契约索引](<../../CONTRACT.md#3-冻结子契约索引1c>)。

本文面向修改持久化实现的人；调用约定见[内部契约](<contract.md>)，全局路由见[L2 入口](<../store.md>)。

## 1. 职责与非职责

存储把事件批次变成可验证、可重放的持久事实。
它同时提供内容寻址 blob、可丢弃快照和合作式 writer 锁。

**非职责**：

- 不判断 task/plan 命令是否合法；领域守卫在命令处理器。
- 不把持久 owner 当运行时租约，也不自行恢复在途任务。
- 不执行证据命令、不抓取 URL、不校验交付结论。
- 不自动迁移 schema，不把坏链读成当前健康状态。
- 不负责备份授权、外部副作用回滚、物理孤儿 blob 清理。

## 2. 内部结构

| 实现 | 维护时关注点 |
|---|---|
| [store.js](<../../../lib/core/store.js>) | JsonlStore 门面、MemoryStore、open/refresh/append 发布 |
| [format.js](<../../../lib/core/store/format.js>) | commit 构造、哈希、格式验证和 replay |
| [writes.js](<../../../lib/core/store/writes.js>) | append 失败恢复与尾部规范化 |
| [lock.js](<../../../lib/core/store/lock.js>) | acquisition、心跳、归属复核与只读降级 |
| [files.js](<../../../lib/core/store/files.js>) | 快照和 blob 旁文件 |

门面集中维护 state、commits、timeline、cmdIds 与日志末端信息。
子文件接收 store 对象；它们不是各自拥有一份状态的仓储。
[handle](<../../../lib/core/handle.js>)采用 append 返回的 state，不能另留脱钩副本。

## 3. 冷开数据流

冷开首先判断是否请求 writer；只读 peek 使用 lock=false。
请求 writer 可在业务验证前创建项目目录、blobs 目录和自身锁。
同进程 OPEN_STORES 防止第二个独立写者持有陈旧日志末端。
跨进程锁不可得时保留只读读取能力，不抢占活写者。

验证与发布按以下顺序组织：

1. 逐物理行扫描完整日志，验证 commit 格式、链与事件可理解性。
2. 检查快照 seq/hash 是否对应日志；不对应的缓存不使用。
3. 全日志扫描文档身份及固定证据屏障，检查可用快照相应内容。
4. normalizePlanHeads 后回放快照尾段；无可用快照则全量回放。
5. assertCurrentSchema 检查最终投影的运行时准入条件。
6. 仅仍可写且尾未终止时执行 repairLogTail。
7. 保存文件大小，发布 state、timeline、cmdIds 与链末端。

不能为了尽早得到一个可读句柄而把修尾提到验证之前。
快照减少 reducer 工作，不免除前段日志的格式和兼容扫描。
[恢复图](<../../diagrams/store-recovery.svg>)辅助阅读，准确行为以 L1 和代码为准。

## 4. 追加数据流

命令总线先在工作投影上生成事件，store 接收的是已构造 commit。
append 在真实存储投影上工作，而不是在命令 staging 对象上工作。

1. 检查 readOnly、seq/prev、磁盘 size 和锁归属。
2. 验证迁移事件与固定引用的同 commit 约束。
3. 序列化单行，appendCommitLine 写字节并 fsync、关闭句柄。
4. 再检查磁盘大小，避免在陌生尾上继续建立哈希链。
5. 更新 commits/cmdIds，逐事件折叠到 state 与 timeline。
6. 更新末端，触碰锁心跳，按周期尝试保存快照。

存储不生成业务级联；多实体原子性来自调用方提交一个事件批次。
这里的原子批次是日志事实边界，不是跨文件数据库事务。
文档 blob 预写和后置 meta/registry 更新不在同一个原子文件写里。

## 5. 为什么选择这些结构

### JSONL 而不是可变状态文件

每次修改整份 state 会把历史、幂等和损坏定位混在一次覆盖里。
JSONL 保留命令批次，重放能定位到合法前缀和第一处失败。
代价是日志持续增长，冷开仍要扫描；不能将快照当截断日志的许可。
背景取舍见[设计背景](<../../DESIGN.md#43-存储格式>)，格式细节不从背景示例推导。

### 后置快照而不是提交前快照

日志已持久化后，快照失败不能反向把成功提交变成失败响应。
快照只缩短状态折叠路径；失败静默忽略，下次仍能回放。
它不是数据备份，也不是未知事件的兼容逃生口。

### 合作单写者而不是多写者合并

任务领取等操作不能用可交换合并替代排他约束。
进程内句柄复用与目录级保护避免插件重载形成两个 seq 计数器。
跨进程 acquisition 临界区用原子 mkdir，锁自身用 pid/hostname/nonce 区分归属。
活 PID 即使心跳旧也不按年龄剥夺；跨主机无法证死，不自动接管。
心跳落在 nonce 专属文件，避免旧 owner 覆盖新 owner 的活性。

### 失败确认而不是把异常当作未提交

write/fsync/close 报错时，完整行可能已进入日志。
只在锁、文件身份、大小和本次行前缀都匹配时回退本次尾部。
确认不了就停止继续写，交给冷开按实际字节判断。
这比无条件 truncate 更保守，也避免擦除继任写者的记录。

## 6. 失败、恢复与降级

完整 JSON 尾记录缺 LF 时保留；不能误当半行删除。
只有不可解析且未终止的最后片段允许在可写冷开中省略。
中段损坏、坏 hash/seq/version、未知事件不会自动跳过。
尾部规范化先写 tmp、fsync、rename，再复核内容和锁。

append 的确定回退成功会抛原 I/O 错误，允许原 cmdId 重试。
回退失败或 close 异常为结果不明，store/handle 降为只读。
失锁与陌生尾也拒绝继续追加；只读状态不等于数据健康。

快照身份不对应日志时回放日志；可用快照的文档身份不一致则拒绝。
blob 读失败返回 null，完整性诊断和文档读取方负责解释缺失/hash。
没有自动 GC；未被事件引用的预写 blob 不会因存在于目录而公开。

任务重启恢复在 service 创建 handle 后执行，不在 store.open 内。
锁外 readStateWithoutLock 只重放持久状态，不 recover、不修尾。
真实恢复步骤见[恢复 Runbook](<../../RECOVERY.md>)；schema 升级见[迁移说明](<../../MIGRATION.md>)。

## 7. I/O 成本与热路径

- 冷开读取完整日志及快照，保留 commits 和 cmdIds，内存也随历史增长。
- 快照覆盖段仍有验证成本；不能承诺冷开只读取 tail。
- refresh 按文件大小增长读新增完整 LF 行；未完成尾留给后续读取。
- refresh 不是通用文件替换监视器；同大小改写和缩短不会触发该增量路径。
- append 的同步磁盘写、fsync、stat 和锁检查是写入热路径。
- 每 200 commit 的快照另有完整 state 序列化与旁文件写成本。
- 相同 hash 的 blob 不重写；已有 blob 的正确性不由存在性检查证明。
- 锁心跳是 best-effort 旁路 I/O，不产生业务 commit。

不在此给生产容量或延迟承诺；测量必须区分冷开、热写和只读追尾。

## 8. 阅读顺序

1. [store.js](<../../../lib/core/store.js>)：先读 _open、_validatedDocSnapshot、append。
2. [format.js](<../../../lib/core/store/format.js>)：validateCommit、commitHash、replay。
3. [writes.js](<../../../lib/core/store/writes.js>)：appendCommitLine、restoreTail、repairLogTail。
4. [lock.js](<../../../lib/core/store/lock.js>)：acquireLock、tryClaim、ownsLockFile。
5. [files.js](<../../../lib/core/store/files.js>)：saveSnapshot、writeBlob、readBlob。
6. [service.js](<../../../lib/core/service.js>)与[handle.js](<../../../lib/core/handle.js>)：区分存储打开和任务 recover。

修改失败窗口时联合阅读[提交边界测试](<../../../test/storage/commit-boundary.test.mjs>)、[存储故障测试](<../../../test/storage/store-faults.test.mjs>)与[快照回放测试](<../../../test/storage/replay-snapshot.test.mjs>)。
