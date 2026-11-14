# 证据模块设计

> 文档定位：L3 模块设计；L1 权威：[验收项与证据](<../../CONTRACT.md#验收项与证据>)、[兼容与降级](<../../CONTRACT.md#4-兼容与降级>)；[D1 冻结 v1](<../../WORKSPACE-DOCUMENTS-CONTRACT.md>)。

本文解释证据归一化、内容观测和固定 Git 取舍；调用约定见[内部契约](<contract.md>)，模块定位见[L2 入口](<../evidence.md>)。
D1 与自动跟随的既有复议关系只引用[现行补充 §2](<../../DOC-EXTERNAL-EVIDENCE.md#2-自动记录项目内容来源>)，不在此改写冻结语义。

## 1. 职责与非职责

证据模块把提交材料规范化为可审计记录，并在任务进入 review/verify 时复查内容观测。
file/doc 可有服务端字节指纹；command/test/note/url 保持提交者材料身份。
覆盖验收项只说明材料存在与种类满足要求，不说明交付结论正确。

**非职责**：

- 不执行 command/test，不检查退出码、不签名或把自报标为宿主观测。
- 不探测 URL，不替提交者下载或保存正文副本。
- 不自动验收任务，不把 pinned 解释成已合入、部署或发布。
- 不管理 Git 分支/worktree、仓库配置、持久 ref、GC、远程 fetch 或 LFS 下载。
- 不修改文档的管理状态、确认基线或 metaRev。
- 不用当前正文补历史 inline blob 或丢失的固定对象。

## 2. 内部结构与分工

| 实现 | 维护时关注点 |
|---|---|
| [evidence.js](<../../../lib/core/evidence.js>) | 归一化、identity 替换、验收项覆盖和 active 内容审计 |
| [fixed-auto.js](<../../../lib/core/documents/fixed-auto.js>) | 自动 pin/降级、待写来源与 fixed 事件批次 |
| [fixed-content.js](<../../../lib/core/documents/fixed-content.js>) | 来源同源证明、明确引用读取和历史固定审计 |
| [fixed-git.js](<../../../lib/core/documents/fixed-git.js>) | 有界 Git 调用、原始 commit/tree/blob 读取与 OID 重算 |
| [fixed-worktree.js](<../../../lib/core/documents/fixed-worktree.js>) | 属性/索引/工作区比较、模式和 HEAD 复核 |
| [fixed-reference.js](<../../../lib/core/documents/fixed-reference.js>) | 结构、不可变 fixedContents、同 commit 屏障及快照核对 |
| [git-exec.js](<../../../lib/core/git-exec.js>) | 绝对可执行文件解析与只读参数白名单 |

文件/绑定安全读取复用[documents](<../documents/design.md>)，任务状态转换留给 task。
fixed schema 的共享字段源是[fixed-schema.js](<../../../lib/shared/fixed-schema.js>)，不是客户端自报对象。

## 3. 从提交材料到事件批次

1. normalizeEvidence 解析 kind/ref 与 acceptanceId，生成服务端证据行和 producedBy。
2. file 路径在 workspace 内 stat/realpath 后流式 hash；不把全文装进证据行。
3. doc 区分 inline 历史映射、外置自动壳与迁移档案；不混用三种内容身份。
4. 外置自动壳先新鲜读取 locator，再尝试固定 Git，返回 pinned 或 current-only。
5. 替换旧 identity 的 active 证据、检查验收项覆盖，并构造来源与 fixed 屏障批次。
6. 来源在预审计前投影到工作副本，对完整新 active 集合做一次 review 前审计。
7. task 处理器把来源、屏障、证据及任务结果放在一个 commit 中提交。

来源事件暂存在证据行的 WeakMap 关联上，不是立刻写 project。
fixedEvents 只修改命令工作投影，让同批预审计能看到拟记录来源。
若覆盖或内容硬审计失败，整批不发布；不能把 staging 状态视为已提交事实。
同一 identity 只退休提交前的旧 active 行，避免同批新材料互相替换。
返工 attempt 的 supersede 与重提替换不同，具体规则见[L1](<../../CONTRACT.md#验收项与证据>)。

## 4. pinned 与 current-only 的生成图景

### 自动固定路径

pinCurrent 只选项目主绑定，确定仓库与文档的仓库相对路径。
先读待固定 HEAD 的原始对象，再证明来源、路径干净和转换可安全解释。
干净性检查比较 HEAD、index、工作区和文件模式，并在所有检查结束后再读 HEAD。
读到的 HEAD 与目标提交不一致时降级，不把不同提交的正文混成一份引用。

首次成功时来源锚点与证据同 commit 记录；同源新主绑定通过证明后才追加 bindingIds。
非主绑定、嵌套仓库或无法证明来源时不猜仓库，进入降级路径。
固定身份留在 commit/path/blob/format/hash，bindingId 只服务本机读取。
当前文档重定位、改管理元数据或切分支不重算既有 pinned 身份。

### 当前文件路径

固定前提不足时保留新鲜工作区原始字节 hash，生成 current-only 与 fixedReason。
不会伪造 fixed、写来源事件或写内容屏障；降级原因闭集只在[补充 §3.2](<../../DOC-EXTERNAL-EVIDENCE.md#32-自动提交标准路径>)定义。
非法 UTF-8 但完整字节 hash 可得时也能降级；没有可靠字节则不能凭空生成证据。
current-only 后续审计跟随 locator 的当前字节，变化报 drift，不把“当前”冒充不可变快照。

### 三个容易混淆的身份

- 工作区 hash 是 raw bytes SHA-256，含 BOM 与换行。
- Git blobContentHash 是 blob bytes SHA-256；Git OID 另含对象头语义。
- inline 的 docId@rev 解析历史 blob；external 的元数据 rev 不构成正文版本。

文档四维状态由[documents §3](<../documents/design.md#3-四维状态为何分开>)解释；确认匹配、adopted 或 committed 都不能替代上述固定证明。
自动固定仍是采样快照，不抵抗最后 HEAD 复核之后到事件提交前的外部修改。
残留竞争不改变钉住的提交身份；查看当前字节差异应调用明确固定读取，不在 verify 重钉。

## 5. Git 只读与明确读取

[Git 执行边界](<../../GIT-EXECUTION.md>)区分“选择哪个程序”和“程序能执行哪些参数”。
解析器只从禁止根之外的 PATH 取得绝对程序路径，cwd 只表达仓库语义。
调用点再用只读白名单、超时和输出上限限制 Git；不能把可信程序等同于可信仓库配置。
固定 Git 层清理继承 GIT_*，禁 replace、fsmonitor、hook、交互、lazy fetch 和 transport。

对象读取不走 checkout/filter/textconv；属性只用于拒绝不支持的转换。
LFS 指针不作为目标正文，也不联网取内容；普通 CRLF 比较只实现已知 text/eol/autocrlf 语义。
未知转换/歧义自动文本判定宁可降级，不执行 clean/smudge/process 获取“正确”字节。
路径沿原始 tree 遍历，重算对象头+字节的 Git OID，再单独计算内容 SHA-256。

get_fixed 只按完整提交与路径或完整 fixed 读取，不用 HEAD/分支名猜正文。
无来源时可纯读引导；有来源时同源新绑定可只读核验，不借读取写授权。
工作区比较独立返回 matches/differs/not_comparable；当前文件缺失不替代固定对象读取。
它不写证据、屏障、baseline、rev 或正文 blob；外层打开方式仍需另行判断副作用。

## 6. 失败、降级与恢复

生成时，Git 缺失、脏路径、HEAD 变化或转换不支持折叠为 fixedReason，不要求安装或审批。
审计时则保留具体 code，区分“不可观测”和“已经证明不符”：

- Git/根/绑定/对象不可观测是 warning，不阻断 submit/verify，也不声称内容匹配。
- 结构、来源身份、OID/type 或内容 hash 真不符仍为 error。
- fixed-path-missing 与 fixed-object-missing 不混同，前者仍是实质错误。
- current-only 的缺失、不可读或字节变化仍按内容硬错误处理，不能套固定 Git warning。

错误责任与人工处理入口见[L1 验收](<../../CONTRACT.md#12-任务状态机>)，模块不自行放宽角色或 acceptance。
verify 不重新 pin；需要新材料时返工重提，旧行保留历史。
读取接口的对象缺失仍报错，warning 策略仅用于审计，不把失败回读成空正文。

Git 对象恢复依赖持久 ref 与完整对象备份，固定索引本身不是 GC 保留根。
系统不自动 fetch、创建 ref 或修复仓库；精确恢复后重新审计。
新事件不被旧构建理解时需匹配 store 快照回退，Git 文件与外部副作用不会随看板回滚。
保留/恢复步骤只在[补充 §6](<../../DOC-EXTERNAL-EVIDENCE.md#6-保留备份与回退>)维护。

## 7. I/O 成本与性能边界

- file hash 是 64 KiB 缓冲流读；16 MiB 是归一化调用侧 stat 上限，不是流函数自带限额。
- doc 自动壳读取完整工作区字节，即使只需一个很短预览；同次提交还会再做内容审计。
- pinned 每次审计重新执行对象类型/大小/OID、tree 路径、属性及来源检查，无 fixed 内容缓存。
- 每次 Git 调用最长3秒，普通输出1 MiB，单个对象读取上限16 MiB；这是每调用限额，不是整次任务预算。
- 源码路径深度与证据条数都会增加 Git 调用；同源重绑还会逐个验证既有 fixedContents。
- get_fixed 除 Git 对象读取，还独立读当前 locator 比较，并输出有界文本预览。
- 图片字节不进入取证流水线；[图片旁路](<../documents/design.md#6-图片是只读资源旁路>)自己的正文+资源读取成本另计。
- 事件只保存 hash/定位，既不保存 external 正文，也不保证对象长期可取。

不能把“证据只记录”理解为 file/doc 零 I/O，也不能把单进程超时当整批延迟承诺。

## 8. 阅读顺序

1. [evidence.js](<../../../lib/core/evidence.js>)：normalize、identity、覆盖、审计四条主路径。
2. [fixed-auto.js](<../../../lib/core/documents/fixed-auto.js>)：从 readLocator 到 pinReason/fixedEvents。
3. [fixed-worktree.js](<../../../lib/core/documents/fixed-worktree.js>)：属性、index、字节与最后 HEAD 复核。
4. [fixed-git.js](<../../../lib/core/documents/fixed-git.js>)：原始对象验证与 transport 禁用。
5. [fixed-content.js](<../../../lib/core/documents/fixed-content.js>)：纯读引导、同源证明与不可观测严重度。
6. [fixed-reference.js](<../../../lib/core/documents/fixed-reference.js>)：append 前屏障、全日志与快照一致性。
7. [自动壳测试](<../../../test/docs/doc-fixed-auto.test.mjs>)、[HEAD 竞争测试](<../../../test/docs/doc-fixed-head-race.test.mjs>)：核对采样与零落盘失败。
