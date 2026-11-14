# 证据与固定内容

文档定位：L2 模块入口；L1 行为权威为下列契约链接。代码层级：core：内容观测层。

## 职责

归一化证据、审计内容指纹，并为外置文档生成和读取固定 Git 内容身份。

## 代码入口

| 入口 | 结构职责 |
|---|---|
| [evidence.js](<../../lib/core/evidence.js>) | 证据归一化、替换与审计 |
| [fixed-auto.js](<../../lib/core/documents/fixed-auto.js>) | 自动固定与 current-only 降级 |
| [fixed-reference.js](<../../lib/core/documents/fixed-reference.js>) | fixedContents 与同 commit 屏障 |
| [fixed-content.js](<../../lib/core/documents/fixed-content.js>) | 固定来源和对象审计 |
| [fixed-git.js](<../../lib/core/documents/fixed-git.js>) | 有界 Git 对象读取 |
| [fixed-worktree.js](<../../lib/core/documents/fixed-worktree.js>) | 工作区干净度与转换域检查 |
| [git-exec.js](<../../lib/core/git-exec.js>) | 可信 Git 可执行文件与只读命令白名单 |

## 对外面

- [CONTRACT §2.4 验收项与证据](<../CONTRACT.md#验收项与证据>)。
- [CONTRACT §1.2 验收与漂移处理](<../CONTRACT.md#12-任务状态机>)。
- [CONTRACT §4 兼容与降级](<../CONTRACT.md#4-兼容与降级>)。

## 依赖方向

由 [task](<task.md>) 与完整 health 调用；复用 [documents](<documents.md>) 的有界读取、[project](<project.md>) 的绑定及 [shared](<shared.md>) 的 fixed schema。

## 关键不变量与读图指针

- command/test 证据不执行；固定身份不追当前分支或 metaRev，无法观测和身份/hash 不符不是同一结果。
- [读图](<../diagrams/doc-evidence.svg>)：图中 pinned 与 current-only 代表不同观测能力，不代表交付正确性；Git 细节见[执行边界](<../GIT-EXECUTION.md>)。
- 全局文件清单与依赖规则见[架构地图](<../ARCHITECTURE.md#21-机器可校验的清单arch-map>)；领域不变量见[CONTRACT §1.4](<../CONTRACT.md#14-不变量>)。
