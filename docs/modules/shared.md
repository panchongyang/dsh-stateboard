# 共享契约

文档定位：L2 模块入口；L1 行为权威为下列契约链接。代码层级：shared：零依赖契约层。

## 职责

提供跨 core、host 与客户端校验使用的枚举、事件分类及共享 schema。

## 代码入口

| 入口 | 结构职责 |
|---|---|
| [contract.js](<../../lib/shared/contract.js>) | 状态、命令、错误码、端点与工具名 |
| [events.js](<../../lib/shared/events.js>) | 事件兼容分类 |
| [knowledge.js](<../../lib/shared/knowledge.js>) | 知识工具 schema 与预算 |
| [fixed-schema.js](<../../lib/shared/fixed-schema.js>) | 固定证据结构 |
| [verification.js](<../../lib/shared/verification.js>) | 验收显示分类 |

## 对外面

- [CONTRACT §2.1 命令信封与错误](<../CONTRACT.md#21-命令信封错误码与-http-映射>)。
- [CONTRACT §2.5 事件兼容](<../CONTRACT.md#25-存储格式与事件兼容>)。
- [CONTRACT §2.6 Host 表面](<../CONTRACT.md#26-host-表面>)。
- [CONTRACT §2.7 知识工具](<../CONTRACT.md#27-历史知识送达与摘要规则>)。

## 依赖方向

无运行时 import；[command](<command.md>)、[store](<store.md>)、[host](<host.md>) 等消费共享定义，禁止 shared 反向依赖它们。

## 关键不变量与读图指针

- 命令注册表与共享命令清单保持一致；未知事件由分类器归为 refuse，不根据名称推断兼容。
- [读图](<../diagrams/layers.svg>)：分层图中 shared 是依赖终点；事件分类的具体语义由 L1 定义。
- 全局文件清单与依赖规则见[架构地图](<../ARCHITECTURE.md#21-机器可校验的清单arch-map>)；领域不变量见[CONTRACT §1.4](<../CONTRACT.md#14-不变量>)。
