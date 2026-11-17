# 命令总线

文档定位：L2 模块入口；L1 行为权威为下列契约链接。代码层级：core：应用编排层。

模块细节：[L3 设计](<command/design.md>) · [L4 内部契约](<command/contract.md>)。

## 职责

串行执行命令，在工作副本上调用领域处理器，并把事件提交结果发布为句柄状态。

## 代码入口

| 入口 | 结构职责 |
|---|---|
| [handle.js](<../../lib/core/handle.js>) | ProjectHandle、串行队列与提交边界 |
| [index.js](<../../lib/core/commands/index.js>) | op → handler 注册表 |
| [command-shape.js](<../../lib/core/command-shape.js>) | 入口字段校验 |
| [normalize.js](<../../lib/core/normalize.js>) | 输入归一化与策略 |
| [contracts.js](<../../lib/core/contracts.js>) | 事件构造 |
| [schema.js](<../../lib/core/schema.js>) | 运行时 schema 准入 |

## 对外面

- [CONTRACT §2.1 命令信封](<../CONTRACT.md#21-命令信封错误码与-http-映射>)。
- [CONTRACT §2.2 命令清单](<../CONTRACT.md#22-命令清单>)。
- [CONTRACT §2.3 句柄 API](<../CONTRACT.md#服务与句柄>)。

## 依赖方向

由 [project](<project.md>) 创建句柄，调用 [task](<task.md>)、[plan](<plan.md>)、[documents](<documents.md>) 处理器，再提交 [store](<store.md>)；不依赖 host/client。

## 关键不变量与读图指针

- handle 显式采用 store.append 返回的 state，assertStateAttached 检查两者未脱钩；守卫失败不发布 staging state。
- [读图](<../diagrams/command-write.svg>)：写入图把入口鉴权、领域守卫和日志发布分开；文档 blob 等旁路 I/O 不等于事件已提交。
- 全局文件清单与依赖规则见[架构地图](<../ARCHITECTURE.md#21-机器可校验的清单arch-map>)；领域不变量见[CONTRACT §1.4](<../CONTRACT.md#14-不变量>)。
