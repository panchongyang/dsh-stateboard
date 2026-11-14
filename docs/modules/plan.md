# 计划与阶段

文档定位：L2 模块入口；L1 行为权威为下列契约链接。代码层级：core：计划领域层。

## 职责

管理计划 head、不可变版本和成员归属，并计算当前阶段工作提示。

## 代码入口

| 入口 | 结构职责 |
|---|---|
| [plan.js](<../../lib/core/commands/plan.js>) | 计划命令注册表 |
| [plan-life.js](<../../lib/core/commands/plan-life.js>) | 草稿、发布、修订、生命周期与焦点 |
| [plan-members.js](<../../lib/core/commands/plan-members.js>) | adopt/release 成员操作 |
| [plan-stages.js](<../../lib/core/plan-stages.js>) | 阶段依赖守卫与 stageWork 投影 |

## 对外面

- [CONTRACT §1.3 计划模型](<../CONTRACT.md#13-计划模型>)。
- [CONTRACT §1.5 进度与派生量](<../CONTRACT.md#15-进度与派生量>)。
- [CONTRACT §2.2.3 计划命令](<../CONTRACT.md#223-plan-v2-命令>)。
- [CONTRACT §2.3 查询投影](<../CONTRACT.md#查询>)。

## 依赖方向

由 [command](<command.md>) 调度，复用 core 模型和归一化；向 [read](<read.md>) 提供阶段派生量，通过同一事件批次建立/修改任务归属。

## 关键不变量与读图指针

- head 管理面不直接改写版本快照；阶段提示不授予租约，成员移出计划不删除任务。
- [读图](<../diagrams/task-plan-state.svg>)：图中阶段是任务分组和推进提示，不是第二套任务状态机；设计素材见[计划 v2](<../PLAN-V2.md>)。
- 全局文件清单与依赖规则见[架构地图](<../ARCHITECTURE.md#21-机器可校验的清单arch-map>)；领域不变量见[CONTRACT §1.4](<../CONTRACT.md#14-不变量>)。
