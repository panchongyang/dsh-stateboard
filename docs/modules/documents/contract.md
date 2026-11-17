# 文档模块内部契约

> 文档定位：L4 模块内部契约；L1 权威：[文档](<../../CONTRACT.md#24-文档>)、[HTTP](<../../CONTRACT.md#265-http>)；[D1 冻结 v1](<../../WORKSPACE-DOCUMENTS-CONTRACT.md>)。

本文约束 core 与 host 内部调用，不新增产品承诺；理由见[模块设计](<design.md>)。
固定证据接口与同 commit 屏障见[evidence 内部契约](<../evidence/contract.md>)。

## 1. 导出入口与调用语义

| 入口 | 内部调用约定 |
|---|---|
| [DOC_EXTERNAL_HANDLERS](<../../../lib/core/commands/doc-external.js>) | 处理器返回 events/entityRev/result，由总线提交，不自行 append |
| [assertExternalRecord / applyExternalDocEvent](<../../../lib/core/documents/external-model.js>) | 写入与回放验证同一记录域；非法 external 不回退 inline |
| [assertDocEventsInLog / assertExternalDocsInState](<../../../lib/core/documents/external-model.js>) | 全日志文档扫描及快照自身 seq/hash 锚点检查 |
| [readLocator](<../../../lib/core/documents/external-observe.js>) | 返回 context/read，新鲜读取指定活动绑定，不走观测缓存 |
| [inspectExternalDoc / listExternalDocs](<../../../lib/core/documents/external-observe.js>) | 登记+可用性组合 / 纯元数据列表；要求未关闭 handle |
| [confirmationOf / clearObservationCache](<../../../lib/core/documents/external-observe.js>) | 派生基线比较 / 丢弃可重建缓存，不修改权威状态 |
| [validateRelPath / locateDocument](<../../../lib/core/documents/locate.js>) | 词法判断 / 根内物理解析，返回分类结果 |
| [readDocument / interpretDocumentBytes / previewOf](<../../../lib/core/documents/read.js>) | 句柄有界读取 / 已有字节解释 / 字符边界预览 |
| [peekReadOnlyState / readImageAsset](<../../../lib/core/documents/assets.js>) | service 锁外投影 / 被正文引用的图片字节，不提供命令句柄 |
| [observeGit / gitHeadOid](<../../../lib/core/documents/external-git.js>) | 路径状态观测 / 可空 HEAD；不是正式固定证据校验 |

host 的 prepareExternalWrite 在 service.open 前检查 body、schemaVersion、URL/docId 一致性。
具体工具与 HTTP 字段只在[L1 对外面](<../../CONTRACT.md#263-工具>)定义，不从本表推导新参数。

## 2. 输入校验域

### 登记身份与 locator

- source 显式区分 inline/external；合法缺 source 旧记录仅按 inline 规则兼容。
- external 的 rev 与 metaRev 是同一个计数，locator 恰为 bindingId/relPath，不重复根字段。
- bindingId 必须属于本项目活动绑定；会话 cwd、标题或 hash 不授予根访问权。
- 路径词法与 Windows 特殊名称拒绝域见[D1 §3.1](<../../WORKSPACE-DOCUMENTS-CONTRACT.md#31-路径与句柄>)；不规范化 Unicode 或猜测等价身份。
- locateDocument 同时验证根/目标 realpath 包含与链接组件；普通根内链接也不承诺支持。
- 根 realpath 的 ENOENT/ENOTDIR 分为 root-unavailable/503；EACCES/EPERM 经 classifyFsError 分为 permission-denied/403，对应[D1 §6.2](<../../WORKSPACE-DOCUMENTS-CONTRACT.md#62-错误码>)的根不可用/无权限两行，见[locateDocument 与 classifyFsError](<../../../lib/core/documents/locate.js>)。
- register/relocate 通过 checkedLocator 选择可登记读取分类；不能将非预览格式当作缺文件。
- 标题、kind、links 与状态转换以[命令实现](<../../../lib/core/commands/doc-external.js>)的归一化和关系校验为准。

### 正文与确认

- readDocument 的 maxBytes/previewBytes/attempts 只能收紧；越过硬上限或非法选项抛 RangeError。
- 完整正文读取 ≤16 MiB，预览 ≤256 KiB；上限不是分段阅读接口，字段域见[D1 §3.2](<../../WORKSPACE-DOCUMENTS-CONTRACT.md#32-大小编码与预览>)。
- hash 覆盖原始字节；展示剥 BOM 或字符边界截断不改变 hash 域。
- 不支持格式可返回 ok=true 且 previewable=false；调用方不能据 ok 推断有 text。
- 非法 UTF-8 返回 undecodable，可能仍携带完整原始 hash；不以替换解码生成正文。
- confirm 需要匹配 expectedMetaRev 与小写 hex64 expectedContentHash，重新读完整文件后比较。
- previewBytes=1 只收紧展示，不能省略完整文件 hash 或把前缀当基线。

### 图片资源

图片规则来自[L1 图片只读资源](<../../CONTRACT.md#内嵌外置与图片只读资源>)，与 locator 不是同一词法域：

1. rawPath 必须相对文档目录，拒绝反斜线、冒号、控制字符、空段与绝对路径。
2. 允许点段规范化，但结果必须在该文档 binding 根内，再复用物理路径与句柄校验。
3. 必须被当前完整正文的独占一行图片语法引用；围栏代码不算，未引用一律 not-found。
4. 扩展名仅 .png/.jpg/.jpeg/.webp/.gif/.svg，单图 ≤4 MiB；MIME 按扩展名，不是内容鉴定。
5. 不接受任意 URL；客户端外部 http(s)、data 与绝对 src 退回文本，不发取图请求。

## 3. 四维不变量

完整定义见[D1 四维状态](<../../WORKSPACE-DOCUMENTS-CONTRACT.md#2-四维状态>)，调用方必须保持独立：

- 管理状态只由显式事件改变，不被 readable、确认匹配或 Git committed 替代。
- availability 是观测；失败保留身份、关系、状态和基线，不把 missing 解释成已删除登记。
- confirmationOf 先看基线与上下文，再比完整 hash；不可比较不得伪报一致/漂移。
- Git 状态是另一条观测，不可用与不在仓库分开；不能代替工作区 hash 或固定对象证明。
- relocate/rebind 保留旧基线但置 baselineInContext=false；不得仅因新路径字节相同自动恢复匹配。
- unregistered 墓碑不物理删文件或历史身份；列表默认不含墓碑，显式参数才能列出。

readDocument 的 hash 与预览来自同次读取；失败不是空正文。
前后 stat 与对象身份检查只是可观察稳定性，不是外部文件锁或原子快照。

## 4. 副作用、提交与只读

external 处理器不写正文 blob、不触碰用户文件，只构造经校验的完整记录事件。
总线串行计算，store 提交成功后才推进权威投影；metaRev 不取代 store writer 锁。
inline 兼容写入的预写 blob 和失败窗口见[L1 inline 边界](<../../CONTRACT.md#内嵌外置与图片只读资源>)。
默认 inline 禁写、迁移档案永远只读；不能通过旧 put/link 改 external。

inspect 的观测缓存可写内存，但不写事件、基线或元数据 rev。
确认与取证绕过缓存；普通读函数无写行为不代表其外层 service.open 无恢复副作用。
图片必须走 peekReadOnlyState，不调用 open、不获取 writer、不恢复任务、不修尾或写快照。
readImageAsset 直连 readLocator，不写 inspect 缓存；成功响应原始字节与 no-store。
鉴权在 host 分派前完成，不能因资源只读而省掉 token/来源校验。

新增 pinned task 证据必须携带同 commit 的 doc/content-fixed，不能由单独文档读取代替。
该屏障不推进 doc rev/baseline，也不把 Git 正文写入 blob；详见[evidence 提交边界](<../evidence/contract.md#4-副作用与同-commit-固定屏障>)。

## 5. 并发与隐含调用约定

1. 已有记录变更携带预期 metaRev，rebind 使用项目 CAS；冲突先重读，不覆盖猜测的新值。
2. 管理命令幂等归总线 cmdId；重复调用函数并不等于已提交命令去重。
3. 外部编辑器/Git 不受单写者锁控制，读取可重试但不保持跨调用快照。
4. inspect 缓存键包含修订与真实绑定上下文；缓存最长30秒，fresh 不是确认。
5. 读取前刷新绑定是避免使用退役根的必要步骤；不得缓存活动 binding 永久有效。
6. 图片每次重读正文再读资源；正文与资源不是同一个原子快照。
7. readLocator 的失败为分类对象；readFailure 用于需要正文的拒绝面，不应把 inspect 的正常不可用转成请求失败。
8. readDocument 的 io 端口只用于局部测试注入，不作为业务参数暴露。
9. 根级错误按 errno 分流，调用方不能只按 availability 字符串猜测根缺失、无权限或 store 故障。

## 6. 错误分类与恢复策略

code/status 全表见[L1 错误码](<../../CONTRACT.md#错误码>)、[D1 §6.2](<../../WORKSPACE-DOCUMENTS-CONTRACT.md#62-错误码>)；此处只分处理责任：

- 路径安全拒绝：不换根重试、不泄露宿主绝对路径、不返回空正文。
- 文件观测不可用：保留登记并展示分类；恢复文件/根/权限后重新观测。
- 修订或确认 hash 冲突：重新取元数据与完整 hash，再明确确认。
- external/inline 入口混用：改用正确入口，不猜 source 或静默走旧解析。
- 记录/回放/快照身份损坏：保留日志并诊断，不按普通文件缺失降级。
- 图片未引用与不存在统一拒绝，不暴露是否存在；格式拒绝是资源 415，不复用正文 400。

## 7. 兼容类别与验证入口

[D1 v1](<../../WORKSPACE-DOCUMENTS-CONTRACT.md>)冻结身份、读取、四维与内容域，不因模块拆文改写。
fixed schema v1 属[evidence](<../evidence/contract.md#8-兼容类别>)；现行自动跟随按[L1 冻结索引](<../../CONTRACT.md#3-冻结子契约索引1c>)指定补充口径，不恢复显式批准/确认流程。
external schemaVersion=1 与[运行时 schema](<../../../lib/core/schema.js>)是不同域。
外置事件均为 applied；未知事件拒读，含快照覆盖段，分类只取[注册表](<../../../lib/shared/events.js>)。
合法旧 inline 历史与迁移映射保留原字节域，不重解释为当前 external 正文。

- [文档读取](<../../../test/docs/doc-read.test.mjs>)：路径/句柄/限额/解码与竞争。
- [外置状态](<../../../test/docs/doc-external.test.mjs>)、[兼容](<../../../test/docs/doc-external-compat.test.mjs>)：四维、CAS 与回放。
- [图片资源](<../../../test/docs/doc-asset.test.mjs>)：根内引用、围栏、限额与冷读零写。
- [inline 写边界](<../../../test/docs/doc-inline-write-boundaries.test.mjs>)：开 writer 前拒绝与 blob/事件副作用。
