# 证据模块内部契约

> 文档定位：L4 模块内部契约；L1 权威：[验收项与证据](<../../CONTRACT.md#验收项与证据>)、[错误与严重度](<../../CONTRACT.md#错误码>)；[D1 冻结 v1](<../../WORKSPACE-DOCUMENTS-CONTRACT.md>)。

本文约束内部调用；设计理由见[模块设计](<design.md>)。
固定生成的现行补充由[L1 冻结索引](<../../CONTRACT.md#3-冻结子契约索引1c>)指定，不恢复显式批准/确认入口。

## 1. 导出入口与语义

| 入口 | 内部语义 |
|---|---|
| [normalizeEvidence](<../../../lib/core/evidence.js>) | 从材料生成服务端行，hash/来源身份不信任自报固定字段 |
| [evidenceIdentity / supersedeResubmitted](<../../../lib/core/evidence.js>) | 识别旧 active identity 并在覆盖不丢失前提下退休 |
| [assertAcceptanceEvidence](<../../../lib/core/evidence.js>) | 检查 active 覆盖和 requiredKinds，再设置工作投影的 met |
| [auditEvidence / assertEvidenceReadyForReview](<../../../lib/core/evidence.js>) | 返回逐行问题 / 将硬错误包装成 review 前拒绝 |
| [hashFileSync / evidenceVerified](<../../../lib/core/evidence.js>) | 原始字节流 hash / 内容观测判定，不认证命令结论 |
| [autoExternalEvidence / fixedEvents](<../../../lib/core/documents/fixed-auto.js>) | 返回 pin 或降级；把待记录来源与屏障放入事件批次 |
| [assertFixedReadArgs / resolveFixedContent / getFixedContent](<../../../lib/core/documents/fixed-content.js>) | 纯参数检查 / 对象解析验证 / 有界正文与独立工作区比较 |
| [approvedRepository / verifyRepositorySource / verifyInRepository](<../../../lib/core/documents/fixed-content.js>) | 来源选择、同源核验、明确 fixed 的对象核验 |
| [auditFixedEvidence](<../../../lib/core/documents/fixed-content.js>) / [auditCurrentOnlyDoc](<../../../lib/core/documents/fixed-auto.js>) | 固定对象 / 当前 locator 字节审计，二者不可互换 |
| [assertFixedReference / assertFixedCommit / assertFixedLog](<../../../lib/core/documents/fixed-reference.js>) | 结构、同 commit 屏障与全日志/快照一致性 |
| [gitRead / readGitContent](<../../../lib/core/documents/fixed-git.js>)、[assertCleanPath](<../../../lib/core/documents/fixed-worktree.js>) | 有界只读对象读取与提交/索引/工作区同一性检查 |

这些是内部实现导出，不是 package exports 扩展。
任务处理器在命令工作副本调用，不能把归一化结果直接写进已发布 state。

## 2. 输入校验域

### 材料、路径与内容身份

- kind/ref/summary/acceptanceId 的业务定义见[L1](<../../CONTRACT.md#验收项与证据>)；acceptanceId 必须属于本任务。
- file 的 ref 可为 workspace 内绝对路径或相对路径，词法与 realpath 都必须包含于该 workspace。
- file 校验与严格 locator 不同，不得为了共用校验器扩大文档读取授权域。
- file 必须普通文件，归一化 stat 大小 ≤16 MiB，hash 不符拒绝；流 hash 函数本身不施加字节上限。
- doc 拒绝调用方出现 fixed/fixedConfirmed/bindingId；fixedState/fixedReason 由服务端选择，不采纳自报固定身份。
- external 普通 ref 的 @rev 是元数据后缀，自动壳落盘裸 docId；有迁移历史映射的旧 inline 引用仍按原 hash/blob 解析。
- inline 提交时显式 rev 必须匹配 head；历史审计不把 head 前进当旧不可变 blob 漂移。
- command/test 新行 execution 恒为 null；不执行 ref，不检查退出码或签名；url/note 同样只登记材料。

### fixed 与明确读取

结构字段唯一源为[fixed schema v1](<../../../lib/shared/fixed-schema.js>)，校验实现见[assertFixedReference](<../../../lib/core/documents/fixed-reference.js>)。
必须匹配项目身份、完整小写 OID 与对象格式、仓库相对合法路径、小写 hex64 内容 hash。
未知版本、缺/多字段、hash 不自洽拒绝，不回退 docId@rev。
Git OID 与 blobContentHash 的域不同；hash 必须等于 fixed.blobContentHash。

get_fixed 的 fixed 与 commitOid/pathAtCommit 两种输入互斥，docId 不带 @rev。
不接受 HEAD、分支名或缩写；bindingId 仅是本机活动绑定的读取提示，不进入固定身份。
无来源时允许纯读对象验证；已有来源时遵守锚点/格式及必要的既有对象同源证明。
对象、预览与文本限额见[补充 §3.1](<contract.md>)，不是任意二进制/远端资源读取接口。

## 3. 不变量与降级

pinned 只能由可证明的干净已提交路径生成，必带合法 fixed，不带 fixedReason。
current-only 不带 fixed，必带闭集 fixedReason，记录本次完整工作区原始字节 hash。
自动固定（D5 自动壳）已实施：主绑定首次 pin 与来源记录、`doc/content-fixed` 屏障同 commit；同源新主绑定须核验锚点和全部既有 fixed 对象后才能追加 bindingIds，`get_fixed` 仅只读放行、不写来源。降级原因闭集及优先命中以 [pinReason](<../../../lib/core/documents/fixed-auto.js>) 为唯一实现定义，覆盖见[自动壳矩阵](<../../../test/docs/doc-fixed-auto.test.mjs>)；没有可靠工作区 hash 的失败不在降级承诺内。

- Git 缺失/路径脏/HEAD 变化/转换不支持只降低固定能力，不伪造 pinned。
- 没有可靠工作区字节 hash 的读取失败仍可拒绝，自动降级不等于空内容也能提交。
- 非 UTF-8 但 hash 完整可降 current-only，之后按原始字节审计。
- 已有 pinned 审计只验固定对象，不追当前 locator、metaRev、HEAD 或管理状态。
- current-only 审计重读当前 locator，变化或不可读仍为硬错误。
- 固定 Git 不可观测保留 code、severity=warning，明确未声称匹配；结构/来源/hash/OID/type 真不符仍为 error。
- 证据不能用文档 adopted、确认匹配或 Git committed 替代固定证明；四维见[documents](<../documents/contract.md#3-四维不变量>)。

## 4. 副作用与同 commit 固定屏障

normalizeEvidence 可读取文件/Git，并用 WeakMap 关联待记录来源；它不 append。
fixedEvents 只能作用于命令工作投影，返回来源事件在前、内容屏障在后的批次。
来源初次记录/同源追加 binding 与新增 pinned task 行须在同一个提交边界。
降级不写来源、不写 doc/content-fixed，也不改文档 baseline/rev。

[assertFixedCommit](<../../../lib/core/documents/fixed-reference.js>)在 store append 写前检查：

1. 新 fixed task 行须有同 commit、内容完全匹配的 doc/content-fixed。
2. 以前单独登记的 fixedContents 不能替代本次屏障；doc 仍 inline 也不能豁免。
3. 既有同 id/内容 fixed 证据随 task 事件保留不需重复屏障。
4. fixedContents 是不可变索引，不存 Git 正文，不允许覆盖不同身份。
5. 全日志、直接事件投影、冷开及快照锚点都维持相同结构/屏障约束。

任务提交在全部证据加入/替换后审计一次，硬失败不发布事件/任务变化，租约保持可修正。
来源/屏障 staging 不能因后续审计失败而单独落盘；提交持久性见[store](<../store/contract.md#4-不变量与提交边界>)。
get_fixed 读取不生成证据、来源或屏障，也不更新文档或正文 blob。

## 5. Git 只读、并发与采样边界

[Git 解析与参数守卫](<../../../lib/core/git-exec.js>)只接受当前读取根与运行代码 checkout 的 realpath 子树之外的普通可执行文件；缓存每次复核禁止根，禁止裸程序名回退。separate-git-dir/linked worktree 须枚举 checkout、gitfile、common-dir 与公共目录 owner，无法解析根/owner 时显式不可观测；[根边界测试](<../../../test/git/git-exec-repo-root.test.mjs>)保留 junction/8.3 与恶意程序反例。
固定读取不经 shell，不执行 filter/clean/smudge/process、textconv、hook 或远程 LFS。
禁止 add/commit/stash、配置写入、ref 写入、分支/worktree 管理及自动 fetch。
Git 调用清理 GIT_*，禁 replace、fsmonitor、交互、lazy fetch 与 transport；不能只靠 OPTIONAL_LOCKS 声称安全。
已知换行转换由内部字节比较处理，歧义降级；diff/textconv 配置存在不表示会执行它。

单次 Git 调用最长3秒、普通输出1 MiB、对象16 MiB；并非整次证据批次超时保证。
HEAD 在全部干净性/模式检查结束后复核；变化降 head-changed，且不得留下来源/屏障。
复核后的外部修改仍可能发生，pinned 只保证记录的提交身份，不宣称锁住 Git/编辑器。
审计默认仅主绑定，不找其它 worktree 兜底；明确读取同源绑定的规则不扩大审计搜索范围。

## 6. 错误分类

code/status 权威见[L1 错误码](<../../CONTRACT.md#错误码>)、[D1 §6.2](<../../WORKSPACE-DOCUMENTS-CONTRACT.md#62-错误码>)及[L1 指定补充](<contract.md>)。
自动生成折叠固定失败为 fixedReason；明确读取与历史审计保留具体 code，不复用生成降级掩盖损坏。

- 参数/结构/来源身份或对象不符：拒绝或硬审计错误，不回退弱解析。
- Git/绑定/根/历史对象不可观测：审计 warning，回读接口仍可失败，不伪称内容可取。
- 提交中无路径不同于对象不可得：fixed-path-missing 仍为 error。
- active file/doc 漂移：review 前拒绝，verify 的人工刷新/豁免归[L1](<../../CONTRACT.md#12-任务状态机>)，模块不自动放行。
- 验收覆盖不齐：补齐本次 active 材料，不能靠 superseded 行满足。

## 7. 隐含契约

1. hashFileSync 是无内置 cap 的流函数；需要限额的调用方先约束，不把它当安全 reader。
2. supersedeResubmitted 会修改旧行，只能传入工作副本；同批新行不互相退休。
3. command/test 共用 ref identity，url/note 不参与替换；精确规则读[evidenceIdentity](<../../../lib/core/evidence.js>)。
4. assertAcceptanceEvidence 会设置 met，但不是内容审计；调用方仍需 review 前硬门禁。
5. fixedEvents 的来源需要在预审计前投影，提交前不得发布 staging 的 project。
6. evidenceVerified 只表示观测；fixed warning 不等于内容已验证，更不证明材料结论。
7. get_fixed 函数纯读不代表所有外层 open 都零写；图片的强零写旁路另见[documents](<../documents/contract.md#4-副作用提交与只读>)。
8. 固定引用不是 Git 保留根，恢复依赖精确对象与持久 ref，不允许当前正文替代。

## 8. 兼容类别

D1 v1 与固定 schema v1 是冻结域；自动跟随/降级只按[已登记复议口径](<contract.md>)，本文不裁定新偏离。
fixed.v、external schemaVersion=1 与[运行时 schema](<../../../lib/core/schema.js>)不同；字段版本不替代事件兼容。
doc/content-fixed 为 applied，唯一分类取[EVENT_REGISTRY](<../../../lib/shared/events.js>)；旧读方不识别必须拒读，快照覆盖段不能绕过。
历史 fixed/来源/inline @rev/execution 保持原数据解析，不恢复已移除的显式写入口或 runner。
回退必须匹配代码和 store 一致性备份，不能只换构建；见[L1 §4](<../../CONTRACT.md#4-兼容与降级>)。

## 9. 验证入口

- [证据审计](<../../../test/docs/evidence-audit.test.mjs>)：内容观测与非执行材料。
- [自动壳](<../../../test/docs/doc-fixed-auto.test.mjs>)、[HEAD 竞争](<../../../test/docs/doc-fixed-head-race.test.mjs>)：pin/降级、采样与零落盘。
- [固定边界](<../../../test/docs/doc-fixed-edges.test.mjs>)：同 commit 屏障、对象丢失、快照与历史。
- [Git 矩阵](<../../../test/docs/doc-fixed-git.test.mjs>)：OID、转换拒绝、CRLF 与 LFS。
- [表面测试](<../../../test/docs/doc-fixed-surfaces.test.mjs>)：读取参数与无证据副作用。
