# 项目与身份

文档定位：L2 模块入口；L1 行为权威为下列契约链接。代码层级：core：项目装配与身份层。

模块细节：[设计](<project/design.md>) · [内部契约](<project/contract.md>)。

## 职责

把工作区身份、本机绑定与项目目录映射到可复用的项目句柄，并提供不打开 writer 的项目读取端口。

## 代码入口

| 入口 | 结构职责 |
|---|---|
| [service.js](<../../lib/core/service.js>) | ProjectService、共享句柄与项目生命周期 |
| [discover.js](<../../lib/core/identity/discover.js>) | 绑定、标记与关联 worktree 发现 |
| [bindings.js](<../../lib/core/identity/bindings.js>) | 本机绑定索引 |
| [registry.js](<../../lib/core/identity/registry.js>) | 绑定注册表 |
| [ops.js](<../../lib/core/identity/ops.js>) | 身份写操作 |
| [project-list-reader.js](<../../lib/core/project-list-reader.js>) | 项目列表冷读调度 |
| [project-reader.js](<../../lib/core/project-reader.js>) | 专用项目只读端口 |

## 对外面

- [CONTRACT §2.3 服务与句柄](<../CONTRACT.md#服务与句柄>)。
- [CONTRACT §2.2 项目命令](<../CONTRACT.md#22-命令清单>)。
- [CONTRACT §2.6.2 DSH 生命周期](<../CONTRACT.md#262-生命周期>)。
- [CONTRACT §2.6.7 MCP 读取](<../CONTRACT.md#267-可选本机-mcp>)。

## 依赖方向

service 装配 [command](<command.md>) 与 [store](<store.md>)；身份发现调用只读 Git；专用 reader 使用 [read](<read.md>) 投影和 [knowledge](<knowledge.md>) 读取器，不反向依赖 host。

## 关键不变量与读图指针

- 项目身份与本机目录绑定分开；只读端口不通过 service.open 获取 writer，工作区发现也不等于授权创建项目。
- [读图](<../diagrams/context.svg>)：上下文图区分宿主身份、core 与工作区；绑定细节入口见[项目身份](<../IDENTITY.md>)。
- 全局文件清单与依赖规则见[架构地图](<../ARCHITECTURE.md#21-机器可校验的清单arch-map>)；领域不变量见[CONTRACT §1.4](<../CONTRACT.md#14-不变量>)。
