# 文档模块设计

> 文档定位：L3 模块设计；L1 权威：[文档与资源](<../../CONTRACT.md#24-文档>)、[冻结索引](<../../CONTRACT.md#3-冻结子契约索引1c>)；[D1 冻结 v1](<../../WORKSPACE-DOCUMENTS-CONTRACT.md>)。

本文面向修改文档登记与读取实现的人；调用约定见[内部契约](<contract.md>)，定位见[L2 入口](<../documents.md>)。
固定内容的生成与审计由[evidence 模块](<../evidence/design.md>)解释，不从文档管理状态推导取证资格。

## 1. 职责与非职责

文档模块把稳定登记身份与可变工作区文件分开。
看板保存元数据、关系和确认基线；正文由工作区或历史 inline blob 提供。
外置记录只持 locator，不把文件复制为另一份权威正文。

**非职责**：

- 不创建、编辑、删除、改名或同步用户正文文件。
- 不替 Git 提交、切分支、管理 worktree 或保留对象。
- 不执行 Markdown 中的代码、外部解析器或任意 URL。
- 不把 adopted、已确认或 Git committed 解释成验收通过。
- 不用当前文件修补缺失的 inline 历史或固定 Git 内容。
- 不在读取失败时修改登记、管理状态或基线。

## 2. 内部结构

| 实现 | 维护时关注点 |
|---|---|
| [doc-external.js](<../../../lib/core/commands/doc-external.js>) | 登记、管理转换、定位、确认、墓碑的事件构造 |
| [external-model.js](<../../../lib/core/documents/external-model.js>) | 记录校验、事件投影和快照锚点一致性 |
| [external-observe.js](<../../../lib/core/documents/external-observe.js>) | 活动绑定、无缓存读取、inspect 组合与缓存 |
| [locate.js](<../../../lib/core/documents/locate.js>) | 词法校验、物理根包含、链接组件拒绝 |
| [read.js](<../../../lib/core/documents/read.js>) | 句柄读取、稳定性复核、原始字节 hash、展示解释 |
| [external-git.js](<../../../lib/core/documents/external-git.js>) | 可选的路径级 Git 观测，不生成固定身份 |
| [assets.js](<../../../lib/core/documents/assets.js>) | 正文引用图片的锁外只读旁路 |
| [doc.js](<../../../lib/core/commands/doc.js>) | inline 档案与策略控制下的兼容写入 |

元数据通过 command 总线与 store 提交。
文件读取只取得本项目 locator 指定的活动绑定，不借会话 cwd 猜根。
迁移子域保留原 inline 历史映射，操作步骤见[迁移 runbook](<../../DOC-MIGRATION.md>)。

## 3. 四维状态为何分开

四维的定义与枚举只在[D1 §2](<../../WORKSPACE-DOCUMENTS-CONTRACT.md#2-四维状态>)维护。
实现中它们不是一个综合“文档状态”，而是四条独立信息流：

1. 管理状态来自已提交 external 记录，只能经显式管理命令变化。
2. 可用性来自本次文件读取；inspect 可复用短期观测，但不会删除登记。
3. 确认情况由完整字节 hash、基线域与 locator 上下文共同比较。
4. Git 观测单独执行；不可用不冒充 not_a_repo，committed 不等于 pinned。

无基线时不因文件可读而自动确认。
已有基线而文件读不到完整可靠 hash 时，不声称内容一致或变化。
重定位保留原基线用于审计，并令 baselineInContext=false；重新确认前不可比较。
读取、刷新、内容变化与确认都不自动推进管理状态。
确认改变元数据修订，但不是正文版本号，也不是证据快照。

[文档与证据图](<../../diagrams/doc-evidence.svg>)可辅助理解：

- 管理状态在日志里，文件可用性与 Git 观测在读取侧。
- 基线是确认时的完整字节与上下文，不是当前预览。
- pinned/current-only 是证据形态，不是四维状态的新枚举。

## 4. 登记、观测与确认数据流

### 登记与重定位

处理器刷新绑定信息，校验 locator，再用新鲜读取证明目标可登记。
可登记不等于可预览：普通文件超限、非文本或解码失败有独立处理域。
确认实际可登记类别应读[checkedLocator](<../../../lib/core/commands/doc-external.js>)，不能把 reader.ok 当唯一条件。
成功返回完整 external 记录事件；只有 store 接受后才成为公开登记。
重定位更新一个 locator，不查找同名或同 hash 文件，不原地改指旧 binding。
批量 rebind 属身份搬迁管理操作，不是阅读时自动选择另一个根。

### inspect 与列表

列表只列登记，不读取工作区。
inspect 先保留登记，再组合 readLocator、confirmationOf 与 observeGit。
观测缓存按 docId/rev/binding/root/path 区分；读取前重新加载绑定注册表。
缓存是展示优化，最长 30 秒；fresh 重新取样仍不产生事件。
解除登记的墓碑保留元数据与基线，inspect 不再观测正文。

### confirm

confirm 使用预期 metaRev 和完整原始字节 SHA-256，不信任 inspect 缓存。
服务端重读文件，比较 hash 后才构造基线事件。
Git HEAD 可作为基线附带上下文；Git 不可用时为 null，不阻止工作区确认。
预览是否截断与完整 hash 是不同信息；不能把看到预览说成读完全文。
字段与确认边界见[D1 §2.3](<../../WORKSPACE-DOCUMENTS-CONTRACT.md#23-确认>)。

## 5. 安全读取数据流与取舍

locate 先拒绝非法路径，再对根和目标 realpath 做包含检查。
根内链接也拒绝，避免“路径仍相同但链接已改指”的隐含身份变换。
reader 打开句柄后检查普通文件，再做有界读取和前后 fstat。
随后复查根、路径、对象 dev/ino 与链接组件，避免只比较 realpath 字符串。
观察到变化时最多重试一次；仍不稳定就返回分类失败。

hash 与预览由同次读取字节生成，BOM 展示处理不改变原始字节 hash。
不支持格式可以有完整 hash 而没有正文；非法 UTF-8 不用替换字符掩盖。
读前 stat 不是大小证明；读取仍探测最多一个额外字节以判超限。
这些检查不是原子快照，也不承诺识别保留元数据的恶意同尺寸改写。
平台与安全限制以[D1 §3](<../../WORKSPACE-DOCUMENTS-CONTRACT.md#3-安全有界读取>)为准。

## 6. 图片是只读资源旁路

图片不走 inspect，也不借普通 service.open 获得句柄。
[HTTP 分派](<../../../lib/host/routes.js>)在 open 前使用 peekReadOnlyState 取得锁外状态。
随后 readImageAsset 重新读取该文档正文，解析实际引用，再读图片原始字节。
不获取 writer、不恢复在途任务、不修尾、不写事件/快照或观测缓存。

正文只承认独占一行的图片语法，围栏代码内同形文本不算引用。
资源路径按文档目录解析，可规范化父目录，但结果仍须留在 binding 根内。
这与禁止点段的 locator 词法域不同，不能直接扩大 locator 校验器。
扩展名白名单和 4 MiB 上限见[L1 图片边界](<../../CONTRACT.md#内嵌外置与图片只读资源>)。
每次重读正文使移除的引用立即失效，代价是每张图都多一次完整有界正文读。

客户端的[图片块](<../../../src/client/components/content.tsx>)只接收获准资源 URL。
相对路径筛选、鉴权取图与资源释放见[图片 hook](<../../../src/client/hooks/use-doc-images.ts>)。
不抓外部 URL；解码/CSP/响应失败回到原 Markdown 文本，而不是保留破图。
资源服务不扩展成任意文件下载器，也不把图片内容当正文解析。

## 7. 失败、降级与恢复

普通缺失、权限、超限、不可解码和不稳定都属于文件观测，不等于 store 损坏。
inspect 登记存在时以可用性返回，未知文档、鉴权或 store 故障仍是真请求失败。
写命令需要目标可登记或可确认时，以相应分类拒绝，不落半份元数据。

Git 观测缺能力时保持文档阅读可用，明确 git_unavailable。
命中 filter 时不执行转换器，也不猜 modified/committed。
固定证据的自动降级独立于上述展示，见[evidence 失败路径](<../evidence/design.md#6-失败降级与恢复>)。

恢复根或权限后 fresh 重读即可；文件改名需要显式 relocate。
不得跨 binding 兜底、返回空正文或静默推进确认基线。
store/事件兼容失败应恢复匹配数据与构建，不靠忽略记录继续服务。

## 8. I/O 成本

- 列表是投影读取；不做每个 locator 的文件/Git 扫描。
- 正文完整读最大 16 MiB；预览最大 256 KiB，但缩小预览不减少完整 hash 的读取量。
- 文件变化可能重读两次；句柄、realpath、stat 与逐段 lstat 都有同步 I/O 成本。
- inspect 的 Git 观测由多次有界子进程组成；每次最长 3 秒、输出上限 1 MiB。
- confirm 绕过缓存并完整重读，另尝试读 Git HEAD。
- 图片每次包含锁外状态读取、正文读取与 ≤4 MiB 资源读取；响应 no-store，不写观测缓存。
- 冷项目的锁外状态读取可能需要日志回放，不能承诺只付图片字节的成本。
- inline 正文按内容寻址 blob 读取；历史保留成本与外置文件的生命周期分开。

不在此给容量或延迟承诺，尤其不能把 256 KiB 预览限额当文件 I/O 限额。

## 9. 阅读顺序

1. [external-model.js](<../../../lib/core/documents/external-model.js>)：先区分记录、基线和回放身份。
2. [doc-external.js](<../../../lib/core/commands/doc-external.js>)：沿登记、重定位、确认看事件构造。
3. [external-observe.js](<../../../lib/core/documents/external-observe.js>)：区分 fresh read 与展示缓存。
4. [locate.js](<../../../lib/core/documents/locate.js>)、[read.js](<../../../lib/core/documents/read.js>)：沿句柄读与身份复核。
5. [assets.js](<../../../lib/core/documents/assets.js>)、[docs 路由](<../../../lib/host/routes/docs.js>)：核对只读图片旁路。
6. [读取测试](<../../../test/docs/doc-read.test.mjs>)、[图片测试](<../../../test/docs/doc-asset.test.mjs>)：核对错误域与零写断言。
