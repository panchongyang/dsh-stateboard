# 证据与固定内容

文档定位：L2 模块入口；L1 行为权威为下列契约链接。代码层级：core：内容观测层。

内部细节：[模块设计](<evidence/design.md>) · [内部契约](<evidence/contract.md>)。

## 职责

归一化证据、审计内容指纹，并关联留存的正文版本或历史来源记录。

## 代码入口

| 入口 | 结构职责 |
|---|---|
| [evidence.js](<../../lib/core/evidence.js>) | 证据归一化、替换与审计 |
| [fixed-auto.js](<../../lib/core/documents/fixed-auto.js>) | current-only 的内容审计 |
| [fixed-reference.js](<../../lib/core/documents/fixed-reference.js>) | fixedContents 与同 commit 屏障 |
| [fixed-content.js](<../../lib/core/documents/fixed-content.js>) | 历史 Git 来源兼容读取 |
| [retained-documents.js](<../../lib/core/adapters/retained-documents.js>) | 工作区正文采样与对象发布 |




## 对外面

- [CONTRACT §2.4 验收项与证据](<../CONTRACT.md#验收项与证据>)。
- [CONTRACT §1.2 验收与漂移处理](<../CONTRACT.md#12-任务状态机>)。
- [CONTRACT §4 兼容与降级](<../CONTRACT.md#4-兼容与降级>)。

## 依赖方向

由 [task](<task.md>) 与完整 health 调用；复用 [documents](<documents.md>) 的有界读取、[project](<project.md>) 的绑定及 [shared](<shared.md>) 的 fixed schema。

## 关键不变量与读图指针

- command/test 证据不执行；固定身份不追当前分支或 metaRev，无法观测和身份/hash 不符不是同一结果。
- [读图](<../diagrams/doc-evidence.svg>)：留存正文与 current-only 是不同观测身份，不代表交付正确性。
- 全局文件清单与依赖规则见[架构地图](<../ARCHITECTURE.md#21-机器可校验的清单arch-map>)；领域不变量见[CONTRACT §1.4](<../CONTRACT.md#14-不变量>)。
