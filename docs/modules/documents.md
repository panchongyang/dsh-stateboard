# 文档登记与读取

文档定位：L2 模块入口；L1 行为权威为下列契约链接。代码层级：core：文档领域与文件读取层。

内部细节：[模块设计](<documents/design.md>) · [内部契约](<documents/contract.md>)。

## 职责

维护 inline 档案和 external 登记元数据，并在绑定根内读取正文及文档引用图片。

## 代码入口

| 入口 | 结构职责 |
|---|---|
| [doc.js](<../../lib/core/commands/doc.js>) | inline 操作与准入 |
| [doc-external.js](<../../lib/core/commands/doc-external.js>) | 外置登记、定位、管理状态及基线 |
| [inline-doc-access.js](<../../lib/core/inline-doc-access.js>) | 获取 writer 前的 inline 写准入 |
| [external-model.js](<../../lib/core/documents/external-model.js>) | 外置记录与回放校验 |
| [external-observe.js](<../../lib/core/documents/external-observe.js>) | 绑定观测与缓存 |
| [locate.js](<../../lib/core/documents/locate.js>) | 路径与链接边界 |
| [read.js](<../../lib/core/documents/read.js>) | 有界字节读取与解码 |
| [assets.js](<../../lib/core/documents/assets.js>) | 引用图片的只读读取 |

## 对外面

- [CONTRACT §2.4 文档与资源](<../CONTRACT.md#24-文档>)。
- [CONTRACT §2.6.3 文档工具](<../CONTRACT.md#263-工具>)。
- [CONTRACT §2.6.5 HTTP](<../CONTRACT.md#265-http>)。
- [CONTRACT §3 冻结子契约索引](<../CONTRACT.md#3-冻结子契约索引1c>)。

## 依赖方向

命令经 [command](<command.md>) 提交，定位使用 [project](<project.md>) 的绑定；固定 Git 字节与证据交由 [evidence](<evidence.md>)，读取不依赖 client。

## 关键不变量与读图指针

- 登记元数据与正文版本分开；读取失败保留登记，不跨 binding 找替代文件，图片只读路径不打开 writer。
- [读图](<../diagrams/doc-evidence.svg>)：图中管理状态、可用性、确认和 Git 观测彼此独立；冻结边界见[D1](<../WORKSPACE-DOCUMENTS-CONTRACT.md>)。
- 全局文件清单与依赖规则见[架构地图](<../ARCHITECTURE.md#21-机器可校验的清单arch-map>)；领域不变量见[CONTRACT §1.4](<../CONTRACT.md#14-不变量>)。
