# 任务、租约与意图

文档定位：L2 模块入口；L1 行为权威为下列契约链接。代码层级：core：任务领域层。

## 职责

实现任务元数据、工作流与治理命令，并维护租约、执行意图和验收记录。

## 代码入口

| 入口 | 结构职责 |
|---|---|
| [task.js](<../../lib/core/commands/task.js>) | 任务命令注册表 |
| [task-intake.js](<../../lib/core/commands/task-intake.js>) | 创建、编辑、就绪与审计门 |
| [task-work.js](<../../lib/core/commands/task-work.js>) | 领取、开始、提交与验收 |
| [task-gov.js](<../../lib/core/commands/task-gov.js>) | 阻塞、中断、对账等治理 |
| [lease.js](<../../lib/core/lease.js>) | 租约与领取资格 |
| [intent.js](<../../lib/core/intent.js>) | 意图结算 |
| [audit.js](<../../lib/core/audit.js>) | worker 独立性和审查范围指纹 |

## 对外面

- [CONTRACT §1.2 任务状态机](<../CONTRACT.md#12-任务状态机>)。
- [CONTRACT §2.2 任务命令](<../CONTRACT.md#22-命令清单>)。
- [CONTRACT §2.2.1 Intent 结算](<../CONTRACT.md#221-intent-结算rfc-3>)。
- [CONTRACT §2.6.3 原生工具](<../CONTRACT.md#263-工具>)。
- [CONTRACT §2.6.7.2 MCP 任务工具](<../CONTRACT.md#2672-任务写操作>)。

## 依赖方向

经 [command](<command.md>) 调度，使用 [evidence](<evidence.md>) 做材料归一化与内容审计；[read](<read.md>) 复用 lease 的资格判定，不另建领取守卫。

## 关键不变量与读图指针

- 持久 owner 与运行时 lease 不是同一事实；资格预览不替代命令校验，意图停止声明不等于外部副作用回滚。
- [读图](<../diagrams/task-plan-state.svg>)：状态图同时给出任务转移和阶段提示；验收权与独立性限制见 L1，不从箭头推导额外权限。
- 全局文件清单与依赖规则见[架构地图](<../ARCHITECTURE.md#21-机器可校验的清单arch-map>)；领域不变量见[CONTRACT §1.4](<../CONTRACT.md#14-不变量>)。
