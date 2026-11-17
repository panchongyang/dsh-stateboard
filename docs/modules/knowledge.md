# 历史知识读取与检索

文档定位：L2 模块入口；L1 行为权威为下列契约链接。代码层级：core：独立派生读模型层。

## 职责

对已保留记录建立可重建检索索引，并按稳定来源引用回读原文与已有关系。

## 代码入口

| 入口 | 结构职责 |
|---|---|
| [reader.js](<../../lib/core/knowledge/reader.js>) | 专用 worker 生命周期与取消 |
| [worker.js](<../../lib/core/knowledge/worker.js>) | 查询执行与降级 |
| [snapshot.js](<../../lib/core/knowledge/snapshot.js>) | 日志验证与发布水位 |
| [records.js](<../../lib/core/knowledge/records.js>) | 保留记录提取 |
| [content.js](<../../lib/core/knowledge/content.js>) | 正文来源读取 |
| [reference.js](<../../lib/core/knowledge/reference.js>) | 稳定来源身份 |
| [build.js](<../../lib/core/knowledge/build.js>) | 派生索引追赶 |
| [sqlite-index.js](<../../lib/core/knowledge/sqlite-index.js>) | 可重建 FTS 缓存 |
| [search.js](<../../lib/core/knowledge/search.js>) | 搜索与覆盖信息 |
| [read.js](<../../lib/core/knowledge/read.js>) | 原文与上下文交付 |
| [relations.js](<../../lib/core/knowledge/relations.js>) | 已记录关系 |

## 对外面

- [CONTRACT §2.7 知识读取与检索](<../CONTRACT.md#历史知识读取与检索>)。
- [CONTRACT §2.6.3 原生双工具](<../CONTRACT.md#263-工具>)。
- [CONTRACT §4 自动降级](<../CONTRACT.md#4-兼容与降级>)。

## 依赖方向

DSH 与 MCP 的 [host](<host.md>) 适配器共享该读取器和 [shared](<shared.md>) schema；读取 [store](<store.md>)、[documents](<documents.md>) 与固定内容，不回调 writer。

## 关键不变量与读图指针

- 索引和 coverage 不参与任务事务或验收；零命中不证明没有约束，已有关系和调用者线索分别标识。
- [读图](<../diagrams/read-isolation.svg>)：图中知识读取拥有独立 worker 和缓存，不能用检索结果覆盖权威状态；实现素材见[知识读模型](<knowledge/design.md>)。
- 全局文件清单与依赖规则见[架构地图](<../ARCHITECTURE.md#21-机器可校验的清单arch-map>)；领域不变量见[CONTRACT §1.4](<../CONTRACT.md#14-不变量>)。
