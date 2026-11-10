# 工作区文档外置 · D1 冻结契约

> 状态：**冻结 v1**。按用户“一次纠偏后冻结”的指令完成单轮审查；后续变更须显式复议，不继续滚动扩展。
> 本文是待实施契约，不声明能力已实现；冻结不代替看板 D1 的人审验证，也不授权实现、真实迁移、合入、部署或发布。

## 0. 范围与变更

冻结：身份、四维状态、读取边界、内容校验域、固定证据、事件兼容和接口语义。物理结构、索引、分页、UI布局和命令实现留给后续任务，不得改变语义。

项目工作区/Git持有正文；看板持有登记、关系、人工状态、确认基线和审计。看板自身状态继续用户级存储，不引入自动同步。新文档不持久化正文blob，不强制目录或frontmatter，不自动Git提交/推送。

偏离本文须回D1复议并人审，不能在D2–D9中顺手改契约。公开文件名单、真实数据授权与去向属于D7，不是未决架构问题。

## 1. 身份与存储

| 名称 | 含义 |
|---|---|
| `docId` | 随机生成的稳定登记身份，`doc_`前缀，与路径无关 |
| `bindingId` | 本机工作区根与项目的绑定；角色main/worktree，可失效但不原地改指 |
| `locator` | `{ bindingId, relPath }`；路径用`/`，相对绑定根，变更须显式重定位 |
| `metaRev` | 元数据乐观锁版本，成功元数据操作递增；读取不递增 |
| `contentHash` | 工作区原始字节SHA-256，小写hex64 |
| `gitOid` | Git commit/blob对象名，使用该仓库自身sha1或sha256格式 |

外置与内嵌登记使用同一`state.docs`集合，以`source: inline | external`显式区分；无source的合法旧记录仅按内嵌兼容规则读取。external的`rev`与`metaRev`是同一计数，不维护两个独立版本。bindingId只在locator中维护，禁止重复字段产生不同指向。

一个docId只有一个当前locator。多worktree不隐式产生多个locator；首版默认读取该locator的绑定，切换文档绑定须显式重定位，不按请求临时套用另一工作区根。未支持的上下文明示拒绝。

绝对路径只在本机绑定中；同名、同标题或相同hash不构成重绑定理由。绑定根移动须创建/确认新绑定并显式重定位，不能改指旧binding。正式固定证据不把易失效的本机bindingId作为内容身份。

缺失或非法external结构→`invalid-external-doc`；命令拒绝，回放也须失败并可诊断，不能跳过或按inline解释。解除登记保留可审计墓碑和历史引用，不删除文件、不物理删除被证据引用的身份；归档不删除文件。

## 2. 四维状态

| 维度 | 枚举 | 持久化 |
|---|---|---|
| 管理 | `draft`、`in_review`、`adopted`、`archived` | 是，显式操作 |
| 可用性 | `readable`、`missing`、`root_unavailable`、`missing_binding`、`permission_denied`、`outside_root`、`not_regular`、`oversize`、`unsupported_format`、`undecodable`、`unstable`、`security_rejected` | 否，有界缓存 |
| 确认情况 | `unconfirmed`、`matches_baseline`、`changed_since_confirm`、`not_comparable` | 基线持久化，比较结果不落盘 |
| Git | `untracked`、`ignored`、`modified`、`committed`、`not_a_repo`、`git_unavailable` | 否 |

### 2.1 管理转换

主线`draft → in_review → adopted`；允许`in_review → draft`、`adopted → in_review`；任意非归档态可显式归档，`archived → draft`重开须原因。每次转换记事件。读取、刷新、确认和内容变化不自动改变管理状态。

### 2.2 观测与不可用

缓存默认最长30秒，返回observedAt和实际上下文；确认及正式证据不得信任缓存。missing不说明删除/改名/换分支，禁止跨绑定找同名文件补读。安全拒绝与看板存储损坏分别表达，不把普通文件缺失升级为store损坏。

不可用时保留登记、标题、关系、管理状态与确认引用。无基线为unconfirmed；有基线但无法取得完整可靠内容hash、上下文不一致或校验域不同为not_comparable，不伪报一致或变化。

### 2.3 确认

工作区确认基线：

```text
{ domain: workspace-bytes, contentHash, bindingId, relPath,
  gitHeadOid|null, confirmedAt, confirmedBy, readerVersion }
```

基线包含确认时路径，不能仅记录binding。确认须携带预期metaRev与预期contentHash，服务端重新读取验证后提交；变化则拒绝。重定位后保留原基线作审计，但在新上下文重新确认前不比较为matches_baseline。

观察、预览、刷新和重试不推进基线。changed_since_confirm是日常引用信息，不是证据损坏。截断预览须明确显示，不能据此声称已阅读全文；确认完整文件须显式确认其完整hash与截断事实。

### 2.4 Git观测

modified表示该路径存在staged或unstaged修改，细节可带staged/unstaged/eolTransformed/filtered/lfs。ignored与untracked分开；真正不在仓库中为not_a_repo；Git缺失、执行失败、超时等为git_unavailable，不混同无仓库。

## 3. 安全有界读取

### 3.1 路径与句柄

- relPath拒绝绝对路径、盘符、UNC、`..`段、空段、`.`段、NUL、反斜线、Windows ADS冒号、设备名及各段末尾空格/点。不做Unicode规范化；保留原路径表示，不将大小写或字符等价当成文件身份。
- 在明确绑定根内解析，根与目标realpath做containment；路径缺失与安全拒绝分别分类。首版不承诺支持经符号链接/junction/reparse组件读取，无法证明安全时拒绝。
- 打开句柄后fstat验证普通文件，读取前后复核路径/根与对象身份。realpath与stat不是原子安全保证；平台无法验证重解析安全时须限制支持范围并拒绝，不能声称抵抗任意恶意换链。
- 不读取设备/FIFO，不提供任意宿主路径读取；文件不存在、权限不足不得静默伪装为空正文。单写者锁不锁住外部编辑器。

### 3.2 大小、编码与预览

| 边界 | 契约 |
|---|---|
| 单次完整读取 | 最大16 MiB；流式计数，最多探测一个额外字节判断超限，超限不返回正文/hash作为完整内容 |
| 内联预览 | 最大256 KiB UTF-8输出；在完整字符边界截断，返回truncated和totalBytes；不提供分段API |
| 编码 | 严格UTF-8；展示可剥离UTF-8 BOM，但原始字节hash包含BOM；非法序列undecodable |
| 格式 | 首版仅文本/Markdown；UTF-16、二进制、PDF、图片不作正文预览，可登记 |

16MiB内的完整字节用于hash与严格解码；256KiB仅是展示上限。不能把预览前缀hash当完整内容hash。相对链接/图片仍须通过工作区和获准资源边界检查，默认不支持的资源明示不可预览；不执行文档代码或任意外部解析器。

### 3.3 读取中变化

对同一打开句柄执行`fstat → 有界读取 → fstat`，并复核路径仍指向该对象；比对对象身份、size、mtime/ctime等可用字段。发现变化重试一次，仍变化则unstable且不返回正文。字段检查只能发现可观察变化，不等于原子文件快照，不宣称能检测保留全部元数据的恶意同尺寸改写。

hash与预览必须来自同一次读取的字节。需要不可变、可重放内容时使用Git blob；不得用文件观测冒充固定快照。读取不持全局写锁，不因读取失败写状态/事件。

## 4. 内容身份与固定证据

### 4.1 校验域

工作区域为SHA-256(raw bytes)，Git域为commitOid/pathAtCommit/blobOid及SHA-256(blob bytes)。blobOid包含Git对象格式语义，不等于裸字节SHA-256；`blobContentHash`与工作区contentHash分开命名。

同一份原始字节与既有file证据使用同一SHA-256算法；分两次读取且文件可变时，不保证hash相等，不能将这种竞争差异写成内部断言失败。

内嵌正文hash为SHA-256(utf8字符串)。只有导出的字节与被引用原正文严格一致时hash才相等；换行/BOM/编码转换、正文演化后不得假设相等。旧证据必须按其记录hash和历史内容映射解析，不拿迁移后当前文件hash替代。

### 4.2 脏工作区与转换

正式证据要求提交已存在；该路径有staged/unstaged变更时拒绝dirty-worktree。不得把未经Git clean规则处理的工作区字节直接与index blob比较并据此判脏，否则干净的CRLF工作区也会误判。

首版不执行不可信clean/smudge filter、textconv、hook或远程LFS操作，不自动add/commit/stash。自定义filter及LFS内容的正式取证返回unsupported-content-transform，不把指针当目标正文。

普通换行转换可观测标记，但不声称工作区原始字节等同Git字节。正式取证重新读取并展示指定提交的blob，要求调用者确认预期commit/path/blobContentHash；与工作区字节不同时明确提示并显式确认该Git版本。不能只确认工作区hash就悄悄换成HEAD正文。必要的Git调用须有超时、输出限额并禁用不可信外部辅助执行。

首版不提供unfixed弱证据开关；草稿可以阅读和确认，但不借此满足正式固定文档证据。

### 4.3 固定证据结构

```text
{
  kind: doc,
  ref: docId,
  hash: sha256(blob bytes),
  fixed: {
    v: 1, projectId, commitOid, pathAtCommit, blobOid,
    objectFormat: sha1|sha256, blobContentHash: hex64
  }
}
```

首版每个项目只支持一个显式获准的Git内容仓库；嵌套/多仓库取证明示拒绝，不猜来源。该项目仓库与本机读取绑定由身份方案显式关联；bindingId可作读取提示但不是固定内容身份，重绑须核验同一来源并显式获准。

所有固定字段由服务端验证/生成，不能信任客户端自报。commit须可解析为提交，path须存在于该提交且为获准普通blob，blobOid/objectFormat/hash必须互相一致；hash必须等于fixed.blobContentHash。路径按仓库相对路径记录，不假设等于绑定根相对路径。

kind仍使用doc，但有fixed时只能走严格版本化固定解析；fixed未知版本/结构非法须拒绝，不能退回旧docId@rev解析。无fixed的旧证据维持旧格式并使用历史映射，不重解释rev。

审计分开报告：固定提交/blob不可取fixed-object-missing；提交无路径fixed-path-missing；对象身份不符fixed-object-mismatch；字节校验失败content-hash-mismatch。当前文件修改、重定位、分支切换不改变固定证据。

须说明Git对象持久ref保留/备份要求。固定内容只证明指定版本，不证明已合入、部署或通过验收，不改变既有file证据根和合入守卫。

## 5. 事件兼容与恢复

事件类型唯一注册表为[events.js](<../lib/shared/events.js>)，兼容遵循[存储契约](<CONTRACT.md#28-文档>)；未知事件为incompatible-event，HTTP 409，不另造unsupported-event语义。

新增事件类型：

```text
doc/external-registered
doc/external-updated
doc/external-relocated
doc/external-unregistered
doc/external-confirmed
doc/external-migrated
doc/content-fixed
```

全部作为改变投影的applied事件实现。doc/content-fixed登记不可变内容引用；首次写入含fixed的task证据时，必须在同一原子commit内携带匹配的doc/content-fixed，不能只在既有task/updated里新增fixed字段而让旧读方静默接受。即使关联的doc仍是inline，也必须满足此屏障。

external写入不得复用doc/created或doc/updated；旧读方遇新事件须拒绝打开。快照覆盖部分同样检查事件类型，不能绕过拒读门。

迁移映射携带sourceDocId/sourceRev/sourceHash及目标locator、目标内容身份；同一映射重放不重复创建，来源hash或目标冲突明确报告，不覆盖用户文件。旧正文/证据所需字节按原hash保留或导出到用户指定Git归档，缺失须显式不可恢复，不能用最新正文补齐。

| 面 | 要求 |
|---|---|
| 回放 | 拒绝未知/不兼容事件，保留原日志；不跳过或近似投影 |
| 快照 | 在相同seq/hash位置比较全量回放与快照，再回放尾部；不将旧快照与日志最新状态直接比较 |
| health/fsck | 结构/rev/历史引用一致性与工作区可用性分开；根缺失/文件变化不是日志损坏；固定对象可取性单列 |
| repair/salvage | 保持现有显式离线流程：未知事件所在commit不能纳入有效前缀，prefix repair拒绝未知事件；默认零写，不自动quarantine或改原日志 |
| 回退 | 代码回退与切换前一致性数据快照一起恢复，明确RPO；不能只换代码、不恢复不可读的新日志 |

内嵌与外置可以同集合，但不混用正文解析路径；旧快照缺source依明确兼容规则处理，external记录不能因为blob不存在而被当空正文。

## 6. 接口与错误

### 6.1 工具和HTTP

project_doc保留旧读取/列表解析，增量操作为register、inspect、update_meta、relocate、confirm、unregister、get_fixed；精确参数使用本文身份、预期metaRev/hash与固定内容字段，不允许同名参数跨域猜测。

HTTP在`/project-board/api/projects/:id/docs`下增加`/external`与`/external/:docId`：POST登记，GET列表/inspect，PATCH元数据；`/external/:docId/relocate`、`/confirm`、`/unregister`使用POST；`/fixed`使用POST按明确的固定引用查询正文，读取不得隐式生成证据。全部返回schemaVersion=1；未知版本拒绝写入并显示只读提示。

既有`/docs/:docId`保持内嵌正文解析，不借该路径猜external正文；external使用新接口，旧接口访问external须明确拒绝并指向新入口。旧doc.put/doc.link不得写external；首发不允许通过旧put新增inline，返回inline-write-disabled。未迁移inline的兼容更新保留原body/baseRev语义；迁移后的inline档案只读。这是明确的写入能力收口，不宣称所有旧写行为兼容。

inspect返回登记+观测：只要登记存在，普通文件不可用仍HTTP 200并携带availability/code；store损坏、鉴权、未知doc等仍是真正请求失败。下表状态适用于命令拒绝或明确请求正文失败，不替代inspect的元数据展示。

### 6.2 错误码

code统一使用下表形式；availability枚举使用下划线形式，两者须有明确映射。

| 场景 | code | HTTP |
|---|---|---|
| 根不存在/不可访问 | root-unavailable | 503 |
| 绑定不存在/失效 | missing-binding | 409 |
| 路径不存在 | file-missing | 404 |
| 无权限 | permission-denied | 403 |
| 词法/realpath越界 | outside-root | 403 |
| 链接/reparse或非法路径安全拒绝 | security-rejected | 403 |
| 非普通文件 | not-regular | 400 |
| 超16MiB | oversize | 413 |
| 非法UTF-8 | undecodable | 400 |
| 不支持格式 | unsupported-format | 400 |
| 读取不稳定 | unstable | 409 |
| 脏工作区正式取证 | dirty-worktree | 409 |
| filter/LFS正式取证 | unsupported-content-transform | 422 |
| 未明确确认目标Git字节 | fixed-confirmation-required | 409 |
| 非首版获准内容仓库 | unsupported-repository | 422 |
| binding与locator冲突/缺失 | invalid-external-doc | 400 |
| metaRev/确认hash发生变化 | stale-revision | 409 |
| 固定对象/路径缺失 | fixed-object-missing / fixed-path-missing | 404 |
| 固定对象身份/内容不符 | fixed-object-mismatch / content-hash-mismatch | 409 |
| fixed结构/版本不支持 | invalid-fixed-reference | 400 |
| 旧接口访问或修改external | external-doc-operation-required | 409 |
| 旧接口新增inline/写只读档案 | inline-write-disabled | 409 |
| 未知事件 | incompatible-event | 409 |

禁止按同名跨根补读、返回空正文冒充成功、替换非法UTF-8、将预览前缀当完整内容、用当前正文补固定对象、跳过未知事件。错误HTTP粗分类不代替code。

## 7. 单写者与公开边界

v0.1是单机、单用户、单写者；使用现有store锁/心跳和只读降级，写拒绝read-only/503。metaRev处理同一写者内并发请求，不取代store锁，不锁住外部文件/Git修改，也不声称多实例并发写安全。

会话cwd不决定文档根或file证据根。跨机是显式数据导出/导入及本机重绑，不是同步；无看板数据的clone只有正文，不伪造管理状态。

公开名单由用户在D7逐项确认，未确认材料默认private；候选名单不是公开授权。本机绝对路径、真实凭据、用户名、会话/store数据、内网部署细节和真实导出须审查。通用占位符、公开配置示例和文档文件名本身不属于必须删除的秘密，不能无差别脱敏破坏安装说明。

本次只审查并纠偏一次、冻结本文件；未改业务代码、未迁移数据、未运行实现门禁。D1任务的人审、后续实现与D7公开/迁移授权分别执行。

delegation: no — 单文件有界快速审查，按用户额度约束不委派、不扩展扫描。
