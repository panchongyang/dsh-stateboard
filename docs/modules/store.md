# 存储、重放与诊断

文档定位：L2 模块入口；L1 行为权威为下列契约链接。代码层级：core：持久化层。

模块细节：[L3 设计](<store/design.md>) · [L4 内部契约](<store/contract.md>)。

## 职责

以哈希链事件日志保存权威状态，提供快照、blob、锁及显式诊断/修复基础。

## 代码入口

| 入口 | 结构职责 |
|---|---|
| [store.js](<../../lib/core/store.js>) | JsonlStore、MemoryStore 与锁外回放 |
| [format.js](<../../lib/core/store/format.js>) | commit 格式、哈希与重放 |
| [lock.js](<../../lib/core/store/lock.js>) | 合作式 writer 锁与心跳 |
| [writes.js](<../../lib/core/store/writes.js>) | 追加与尾部规范化 |
| [files.js](<../../lib/core/store/files.js>) | 快照与 blob |
| [fsck.js](<../../lib/core/fsck.js>) | 只读不变量诊断 |
| [repair.js](<../../lib/core/repair.js>) | 显式修复基础函数 |

## 对外面

- [CONTRACT §2.5 存储格式与兼容](<../CONTRACT.md#25-存储格式与事件兼容>)。
- [CONTRACT §2.1 提交结果](<../CONTRACT.md#21-命令信封错误码与-http-映射>)。
- [CONTRACT §2.3 只读诊断](<../CONTRACT.md#health--fsck-只读诊断>)。
- [CONTRACT §4 回退边界](<../CONTRACT.md#4-兼容与降级>)。

## 依赖方向

接收 [command](<command.md>) 的事件批次；使用 core model、schema、文档身份与固定引用校验，事件类别来自 [shared](<shared.md>)；不依赖 host/client。

## 关键不变量与读图指针

- 日志验证覆盖快照之前的记录；快照不是兼容性豁免，诊断不修复，锁外回放不修尾或恢复任务。
- [读图](<../diagrams/store-recovery.svg>)：图按冷开验证顺序阅读；恢复与修复的维护授权见[恢复 Runbook](<../RECOVERY.md>)。
- 全局文件清单与依赖规则见[架构地图](<../ARCHITECTURE.md#21-机器可校验的清单arch-map>)；领域不变量见[CONTRACT §1.4](<../CONTRACT.md#14-不变量>)。
