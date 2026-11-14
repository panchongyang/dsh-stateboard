# 读模型、简报与健康

文档定位：L2 模块入口；L1 行为权威为下列契约链接。代码层级：core：查询投影层。

模块细节：[设计](<read/design.md>) · [内部契约](<read/contract.md>)。

## 职责

把已发布状态与运行时租约投影成视图和简报，并将完整内容审计隔离到 worker。

## 代码入口

| 入口 | 结构职责 |
|---|---|
| [views.js](<../../lib/core/views.js>) | board/task/plan/docs 等 DTO |
| [model.js](<../../lib/core/model.js>) | 事件应用与共用派生规则 |
| [digest.js](<../../lib/core/digest.js>) | 确定性提示词简报 |
| [health.js](<../../lib/core/health.js>) | 内存健康摘要与完整检查 |
| [health-audit.js](<../../lib/core/health-audit.js>) | 显式隔离审计调度 |
| [health-audit-worker.js](<../../lib/core/health-audit-worker.js>) | 完整内容审计 worker |
| [project-read-handle.js](<../../lib/core/project-read-handle.js>) | 脱离 writer 的查询句柄 |
| [project-reader-views.js](<../../lib/core/project-reader-views.js>) | 专用读端口视图适配 |

## 对外面

- [CONTRACT §2.3 Query 与视图](<../CONTRACT.md#23-query-与视图>)。
- [CONTRACT §2.7 Digest](<../CONTRACT.md#digest>)。
- [CONTRACT §2.6.4 Prompt](<../CONTRACT.md#264-prompt>)。
- [CONTRACT §2.6.7.3 完整 MCP 视图](<../CONTRACT.md#2673-计划文档会话与完整视图>)。

## 依赖方向

由 [command](<command.md>) 的 handle 或 [project](<project.md>) 的 reader 使用；复用任务/计划领域派生规则；完整 health 调用 [evidence](<evidence.md>)，不依赖 host/client。

## 关键不变量与读图指针

- brief 不调度完整文件/Git 审计；docView 和完整 health 存在 I/O，不能把所有 view 都称为纯函数。
- [读图](<../diagrams/read-isolation.svg>)：图区分内存摘要、隔离内容审计和锁外冷读；冷读展示水位不授予写入资格。
- 全局文件清单与依赖规则见[架构地图](<../ARCHITECTURE.md#21-机器可校验的清单arch-map>)；领域不变量见[CONTRACT §1.4](<../CONTRACT.md#14-不变量>)。
