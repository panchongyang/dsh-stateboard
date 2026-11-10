# 文档固定内容证据

## 1. 身份与校验域

固定引用遵循 [冻结契约 §4–§6](<WORKSPACE-DOCUMENTS-CONTRACT.md#4-内容身份与固定证据>)。固定内容只证明指定 Git 版本的字节，不证明已合入、已部署、已发布或已通过验收。验收状态机、file 证据根、合入守卫和人工门不因固定文档证据而改变。

| 内容 | 身份与 SHA-256 域 |
|---|---|
| 当前工作区 | `contentHash = SHA-256(raw workspace bytes)`，包含 BOM 和 CRLF |
| Git 固定内容 | `commitOid + pathAtCommit + blobOid + objectFormat`；`blobContentHash = SHA-256(blob bytes)` |
| 内嵌历史 | `docId@rev` 和该版本已记录的正文 hash；UTF-8 字符串域，不拿当前外置文件补历史 |

Git OID 包含 `blob <长度>\0` 等 Git 对象头，不等于裸字节 SHA-256，即使仓库使用 sha256 格式也是如此。路径是**仓库根相对路径**，不是默认的绑定根相对路径。`docId` 是登记身份，`metaRev` 是元数据版本；两者都不是正文版本。

工作区字节就是文档身份，仓库必须固定检出字节。外置文档的 `contentHash` 按工作区原始字节计算，所以同一提交在任何机器和工作树上都必须检出相同的 LF 字节。仓库根 `.gitattributes` 用 `* text=auto eol=lf` 固定换行，图片等二进制显式 `binary` 豁免；不得依赖本机的 `core.autocrlf`。否则 Windows 上的 `git restore` 会把已提交的 LF 写成 CRLF，让干净文件报“内容已变化”，并在审计中制造假 drift。回归测试 [gitattributes-eol.test.mjs](<../test/git/gitattributes-eol.test.mjs>) 在临时仓库里校验 restore 前后字节不变。

外置文档的 doc 证据由服务端自动选择一种形态，并写入两个显式字段：

| `fixedState` | 含义 | `hash` 域 | `fixed` |
|---|---|---|---|
| `pinned` | 已证明该路径在某个提交中干净且可还原 | `fixed.blobContentHash`（Git blob 字节） | 必有，结构见下 |
| `current-only` | 无法安全固定，降级为当前工作区文件证据 | 本次提交时工作区文件字节 | 必无 |

`current-only` 行必须带 `fixedReason`，取值限定为 §3.2 的闭集；`pinned` 行没有 `fixedReason`。绝不把 `current-only` 写成 `pinned`，也不生成伪造的 `fixed`。

`pinned` 的证据内容如下（任务证据另有 id、acceptanceId、时间与 producedBy 等常规字段）：

```text
{ kind: 'doc', ref: 'doc_…', hash: '<完整 blob 字节 SHA-256>',
  fixedState: 'pinned',
  fixed: { v: 1, projectId: 'prj_…',
    commitOid: '<完整提交 OID>', pathAtCommit: 'docs/spec.md',
    blobOid: '<普通 blob OID>', objectFormat: 'sha1' | 'sha256',
    blobContentHash: '<同一个完整 blob 字节 SHA-256>' } }
```

`hash === fixed.blobContentHash`。固定结构必须恰有上述七个字段；未知版本、多余字段、OID 长度/格式不符、项目身份不符均拒绝。`bindingId` 只是本机读取提示，不进入固定内容身份。

## 2. 自动记录项目内容来源

**用户没有「批准仓库」这个动作。** 第一次能证明某个外部文档可固定时，系统在**同一个 commit** 里自动记录项目内容来源：

```text
{ type: 'project/updated', data: <完整项目记录，含 gitContentRepository>,
  actor: { kind: 'system', reason: 'auto-approve-git-content-repository' } }
```

- `gitContentRepository = { v:1, objectFormat, anchorCommitOid, bindingIds }`，锚点是首次固定时的 HEAD，绑定是本项目主绑定。
- 事件自带 `actor.kind = 'system'`，可审计地标明来源是系统自动记录的；commit 级 actor 仍是触发命令的调用方。时间线按事件 actor 展示（无事件 actor 时退回 commit actor）。
- 只在固定尝试的全部检查（干净、可还原、属性/内容可固定）通过后才写来源；降级为 `current-only` 时不写来源、不写事件。
- 幂等：项目已有来源（或同一批证据里已记录一次）时不再写第二个 `project/updated`，也不推进项目 rev 之外的多余事件。
- 只支持主绑定：外部文档挂在其它绑定上时降级为 `multiple-repositories`。
- 搬迁或本机重建绑定后，新主绑定若不在 `bindingIds` 中，自动壳先做同源核验：对象格式一致、来源锚点提交可解析、所有既有 fixed 对象逐一验证通过。全部通过就在**同一个 commit** 里追加 `bindingIds`（事件仍为 system，reason 为 `auto-rebind-git-content-repository`），随后照常 pin；任一核验失败才降级（`multiple-repositories`/`unsupported-format`/`not-a-repo`），绝不并入不同仓库或缺失锚点的仓库。
- 读取 `get_fixed` 对"不在 `bindingIds`、但同源核验通过"的绑定只读放行（含 worktree 绑定）：不写事件、不追加来源、不推进任何状态；核验失败仍报 `unsupported-repository`。

来源锚点证明持有相同 Git 提交对象，不证明远程 URL、仓库所有权、签名或主线归属；共享历史的 clone/fork 不会自动串用，除非主绑定本身能证明同一锚点与既有固定引用。Git 对象来源不靠网络探测。

> **与冻结契约的关系**：冻结契约 §4.2/§4.3 使用「显式确认 Git 版本」「显式批准来源」的措辞。本实现有意偏离该措辞：这些动作由系统在提交证据时自动完成，用户无感；实现已不再注册任何显式批准/确认入口（命令、证据字段、工具参数均不暴露）。该偏离已在看板复议记录登记；`docs/WORKSPACE-DOCUMENTS-CONTRACT.md` 正文保持不变。

## 3. 自动固定与静默降级

### 3.1 读取（不生成证据）

工具：

```text
project_doc { op: 'get_fixed', docId: 'doc_…',
              commitOid: '<完整提交 OID>', pathAtCommit: 'docs/spec.md', bindingId?: 'bnd_…' }
project_doc { op: 'get_fixed', docId: 'doc_…', fixed: <先前返回的完整 fixed>, bindingId?: 'bnd_…' }
```

HTTP：`POST /project-board/api/projects/:id/docs/external/:docId/fixed`，body 为上述读取字段（不含 op，可带 `schemaVersion:1`）。即使登记仍为 inline，也可以通过此明确固定引用入口读取；旧 `/docs/:docId` 不猜外置内容。

两种形式不能混用。第一种从明确的 commit/path 解析出服务端固定引用；第二种严格核验已知引用。响应会重新读取当前 locator（inline 使用同仓库当前路径）作独立原始字节比较，显示 matches_git_bytes、differs_from_git_bytes 或 not_comparable；字节不同时 notice 说明 Git 版本与工作区不同。当前文件不可用只影响比较，不阻止固定正文回读。完整 commit OID 是必须的，不接受 HEAD、分支名或缩写替代固定身份。

返回：

```text
{ schemaVersion: 1, docId, fixed, hash,
  body, truncated, totalBytes, domain: 'git-blob-bytes',
  workspaceComparison: { state, domain:'workspace-bytes', contentHash|null, availability, notice } }
```

单 blob 最大 16 MiB；正文严格 UTF-8，BOM 可从展示中剥离但仍计入 hash。输出最多 256 KiB UTF-8，在字符边界截断并标记 `truncated`；`totalBytes` 是原 blob 字节数。读取不写证据、不登记 `doc/content-fixed`、不写正文 blob、不更新确认基线或 metaRev。不得把截断预览当作已读完整正文。非法 fixed、未知 fixed.v 或未知 schemaVersion 在工具/HTTP 打开项目之前拒绝。

`get_fixed` 是**纯读、无前置授权**：项目还没有 `gitContentRepository` 时也可以直接按给定 `bindingId`（缺省主绑定）读取——服务端解析该活动绑定根，核验仓库对象格式、`commitOid` 是提交、`pathAtCommit` 是普通 blob、`blobOid`/`blobContentHash` 自洽；全程不写 `gitContentRepository`、不写事件、不推进 rev、不把本次读取缓存成授权。已有来源时仍走同源核验（含自动追加绑定），异源或缺失锚点拒绝。无来源的纯读复用与写路径相同的 `readGitContent`/`verifyInRepository` 校验，不另起一套。

### 3.2 自动提交（标准路径）

外置文档的证据只需要：

```text
{ kind: 'doc', ref: 'doc_…', acceptanceId?: 'acc_…' }
```

外置文档的 `@rev` 后缀（`doc_…@3`）是**元数据版本**，不是内容身份：服务端忽略它，按当前 locator 走自动壳，落盘证据的 `ref` 是裸 `docId`。内嵌文档的 `docId@rev` 仍按历史不可变 blob 映射，语义不变。

`task.submit` 与 `task.reconcile(choice=completed)` 在服务端完成全部判断。调用方**只传** `{kind:'doc', ref:docId, acceptanceId?}`：不接受 `fixed`、`fixedConfirmed`、`bindingId`（出现即 `invalid-command`），也没有单独的批准/确认命令。

- 干净性校验使用的 HEAD 必须与待固定的提交一致，并在全部干净性检查（含文件模式）结束后再次读取 HEAD 核对该提交；检测到切换时静默降级为 `current-only`，`fixedReason:'head-changed'`，不记录来源或固定内容屏障。该保证同时适用于 `task.submit` 和 `task.reconcile(choice=completed)`；`get_fixed` 只按明确的不可变提交读取，不以 HEAD 选择正文。
- 固定证据是**采样快照**：钉住的是通过上述校验的那个提交，不承诺抵抗最后一次 HEAD 读取之后、事件提交之前发生的外部 checkout 或工作区修改。这种残留不会把别的提交的正文记成该提交：固定身份仍是 A，pinned 审计只校验不可变 Git 对象、不比较工作区；需要看当前文件与 Git 字节的差别时，用 `get_fixed` 的独立工作区比较（`differs_from_git_bytes`），它不改写固定身份。
- 目标路径已提交、工作区干净、属性与内容可安全还原 → 生成 `fixed`，证据行 `fixedState:'pinned'`，并在同一 commit 写匹配的 `doc/content-fixed` 屏障，必要时先写自动来源事件。
- 任一前提不成立 → 不失败、不弹错、不要求安装任何东西，静默降级为当前工作区证据：`fixedState:'current-only'` + `fixedReason`，不写 `fixed`、不写 `doc/content-fixed`、不写来源事件。
- 非 UTF-8（例如 GBK 编码的 `.md`）同样降级而不是拒绝：读取结果里的原始字节 SHA-256 直接作为证据 hash，`fixedReason:'unsupported-format'`，与 file 证据的字节哈希规则一致。
- 降级的证据仍按既有 doc 证据规则校验：提交时的 hash 是当时工作区字节；之后文件变化会在审计中报 drift。

降级矩阵（`fixedReason` 闭集，按实际命中原因取第一个可判定项）：

| `fixedReason` | 触发条件 |
|---|---|
| `no-git` | 本机没有可执行的 Git（spawn ENOENT） |
| `git-unavailable` | Git 调用失败、超时、输出/对象超限，或其它无法证明固定的情况 |
| `uncommitted` | HEAD 不存在，或该路径不在 HEAD（新增/未提交；锚点提交对象也不可取） |
| `dirty-worktree` | 该路径 staged/unstaged、冲突、模式变化或跟踪文件缺失 |
| `head-changed` | 干净性校验中读取的 HEAD 或全部检查后的 HEAD 与待固定提交不一致 |
| `content-transform` | 路径命中 filter/working-tree-encoding/ident、未知或不可确定 EOL |
| `lfs-pointer` | HEAD blob 或 index 内容是 LFS 指针 |
| `not-a-repo` | 绑定根不是 Git 仓库，或路径在仓库根之外 |
| `nested-repository` | 路径位于嵌套仓库或文档在外层仓库根之外 |
| `multiple-repositories` | 文档不在项目主绑定，或主绑定无法证明与已记录来源同源（异仓库、锚点缺失或既有 fixed 对象不一致） |
| `unsupported-format` | 文档不是合法 UTF-8、子模块、不支持的 Git 对象格式，或已记录来源的对象格式不再匹配 |
| `oversize` | 待固定 blob 超过 16 MiB |

固定尝试只运行有界只读 Git 调用，不执行 clean/smudge/process/filter/textconv/hook，不访问远程 LFS，不自动 add/commit/stash。普通换行转换只做已知 text/eol/core.autocrlf 语义的 CRLF→LF 比较；`text=auto` 遇到无法确定的控制字符/孤立 CR 时降级。

历史数据仍然可读：旧版本用显式入口写下的 `fixed` 证据行、`doc/content-fixed` 事件和 `project.gitContentRepository` 都只是数据，回放、审计、快照载入和冷开按原规则校验，不要求补做任何确认或批准。本次移除的是写入口：`normalizeEvidence` 对 `kind:'doc'` 拒绝调用方传入的 `fixed`/`fixedConfirmed`/`bindingId`，`doc.repository.approve` 命令、`normalizeFixedEvidence` 与 `fixed-confirmation-required` 错误码均已删除。固定版本只能由自动壳生成；读取 `get_fixed` 依旧只读回读、不生成证据。

## 4. 校验与事件屏障

实现只运行有界只读 `rev-parse`、`cat-file`、`ls-files`、`check-attr` 和配置读取：每次 Git 调用最长 3 秒，常规输出上限 1 MiB，blob/tree 对象上限 16 MiB。原始对象以 Git 对象头重新计算 sha1/sha256 OID，再单独计算 blob 字节 SHA-256。commit 必须真的是提交；沿原始 tree 遍历路径，只允许普通 blob 模式，拒绝链接和子模块。需要本机 Git 支持 `check-attr --source`；不支持时降级。禁用 replace、fsmonitor、hook 路径、交互与 lazy fetch，并用空协议白名单禁止 Git transport（本地配置不能重新允许 fetch）；清理继承的 GIT_* 位置/配置环境变量。

`doc/content-fixed` 在 [事件注册表](<../lib/shared/events.js>) 中为 applied，投影到 `state.fixedContents` 的不可变索引；不修改文档 rev 或 baseline，不持久化正文副本。

- task.submit 与 reconcile 为新增 `pinned` 证据产生匹配的 `doc/content-fixed`；`current-only` 不产生。
- [assertFixedCommit](<../lib/core/documents/fixed-reference.js>) 在 MemoryStore/JsonlStore append **写入之前**校验；新证据行必须在同一个 commit 内携带完全匹配的屏障，缺失为 `invalid-fixed-reference`。
- 自动来源 `project/updated` 与 fixed 行同 commit 时，先投影来源、再投影 fixed 索引；`assertFixedCommit`/`assertFixedLog` 接受该组合，并在冷开与快照锚点校验中保持一致。
- 更早单独存在的内容登记不能代替新 task 证据行的同 commit 屏障。已有任务证据随普通 task 事件保留时无需重复屏障，不改变既有事件投影结果。
- 普通回放、直接 applyEvent、冷开的全日志扫描（含快照覆盖段）、快照固定索引和证据结构校验使用同一规则。当前文档仍是 inline 也不能绕过屏障。
- 当前文件编辑、重定位、元数据变更、HEAD/分支变化不会重算固定身份。审计只验证明确固定的对象，不比较当前正文或当前 metaRev；`current-only` 证据则按工作区 hash 审计 drift。
- **verify 不重新钉版本**：`task.verify` 比对的是证据里已固定的内容，不是当前工作区；内容变了应报 drift，由人决定接受、刷新还是驳回。不要为了消除 drift 在 verify 时重钉，否则会掩盖证据与工作区不一致的事实。
- **Git 不可观测是非阻断 warning**：审计时遇到 `git-unavailable`、`root-unavailable`、`missing-binding`、`fixed-object-missing`，或来源仓库确实不可达，保留原错误 code 但降为 `severity:'warning'`，message 明确 "Historical Git content is not observable; no content match is asserted"；不阻断 submit/verify，也不声称内容匹配。真实结构/来源身份不符、hash/OID/type 不符仍是 error。固定审计只使用项目主绑定，不回退到其他 worktree 或其他绑定。

## 5. 失败码与场景

自动提交把固定失败折叠为 `current-only` + `fixedReason`，不向用户抛错；读取、审计与历史数据回放仍保留以下具体 code。

| code | HTTP | 场景与处理 |
|---|---|---|
| dirty-worktree | 409 | 该路径 staged/unstaged、模式变化、未追踪、冲突或当前跟踪文件缺失；自动壳降级 `dirty-worktree`，不静默取 HEAD |
| unsupported-content-transform | 422 | 路径实际命中 filter（含 LFS 与自定义 driver）/内容为 LFS 指针/encoding/ident、未知或不可确定 EOL；自动壳降级 `content-transform` 或 `lfs-pointer`，不运行转换器（diff/textconv 放行且不执行） |
| unsupported-repository | 422 | 未记录来源、非主绑定、嵌套/子模块、格式或来源不支持；自动壳降级 `multiple-repositories`/`nested-repository`/`not-a-repo`/`unsupported-format` |
| fixed-object-missing | 404 | 固定提交、tree 或 blob 本地不可取；恢复精确 Git 对象，不补当前正文。审计时该 code 降为 warning（不可观测），读取接口仍报错 |
| fixed-path-missing | 404 | 提交中没有该路径/中间目录 |
| fixed-object-mismatch | 409 | 对象类型、Git OID 重算、路径对应 blobOid 或 objectFormat 不符；始终 error |
| content-hash-mismatch | 409 | 实际 blob 字节 SHA-256 不符，或 evidence.hash 与 fixed.blobContentHash 不同；始终 error |
| invalid-fixed-reference | 400 | 未知 fixed.v、缺/多字段、项目身份或 OID/path 结构非法，或新 task fixed 证据缺少同 commit 屏障；不退回 docId@rev；始终 error |
| git-unavailable | 503 | Git 不可执行、超时、输出限额等本机读取失败；不冒充对象缺失。审计时降为 warning（不可观测） |
| missing-binding | 409 | 已记录来源的本机绑定已失效。审计时降为 warning（不可观测），历史 fixed 不被判为内容不符 |
| oversize / unsupported-format | 413 / 400 | Git 对象超读取上限，或无法提供严格文本展示；自动证据在读取阶段遇到不可解码时降级 `unsupported-format`，不失败 |
| undecodable | 400 | 读取/预览接口的严格文本失败；自动 doc 证据不抛此错，改用原始字节 hash 降级 |

未知 schemaVersion 为 `invalid-command`（400，提示保持只读直到客户端升级）。审计保留上述具体 code：Git/绑定/对象不可观测类返回 warning，真实结构、来源身份、hash/OID/type 不一致返回 error；review/verify 总门禁只把 error 包装成 `evidence-drift`，details.warnings 中各类固定失败互不吞并。既有 file 证据行为和接受/豁免策略不变。

## 5.1 已知限制与性能边界

- **pathAtCommit 不与文档绑定**：`pathAtCommit` 记录的是自动固定时该文档 locator 对应的仓库相对路径。文档改名/重定位后，既有 `pinned` 证据继续指向原路径，系统不会自动改写或关联；之后重新提交证据会按新的 locator 自动固定新路径。
- **固定证据审计无缓存**：fixed 证据每次判定（review/verify 门禁与审计）都会重新执行完整 Git 审计（对象重算、路径遍历、属性与配置检查，每次 Git 调用最长 3 秒）。证据条数较多时耗时线性增长。没有按 (commitOid, pathAtCommit, blobOid) 的进程内缓存：缓存会掩盖审计之后才发生的对象丢失、本地 filter 配置或 gitattributes 变化，与「每次都从 Git 重新证明」的语义冲突；需要时应另行设计带失效条件的缓存。该审计是可选增强：Git 或历史对象不可得时只产生非阻断 warning。

## 6. 保留、备份与回退

固定引用不是 Git GC 保留根。管理员必须为来源锚点及所有被引用提交建立持久 ref，并备份完整可达 commit/tree/blob；只备份看板 store、当前分支文件或浅 clone 不够。可在人工管理流程中为每个被引用提交建立 `refs/project-board/fixed/<完整commitOid>`，再验证离线 bundle/mirror 能取回全部对象。系统不自动创建 ref、联网 fetch、修复 Git 或运行 GC。浅克隆、部分克隆、丢失 alternates、被 GC 的不可达提交须显式恢复本地对象；读取绝不自动拉远程。

恢复时分开处理：看板日志/快照恢复登记和审计；获准 Git 仓库恢复正文对象；本机身份层重建绑定（`project.relocate`、`doc.external.rebind` 或新增同源绑定）后，下一次可证明的固定尝试会自动同源核验并在同一 commit 追加绑定、记录来源，既有固定引用按对象逐一校验。`get_fixed` 对同源新绑定可直接只读回读；不同仓库或缺失锚点不会被自动并入。

**新事件旧代码不可读。** 日志含 `doc/content-fixed` 时，不认识该事件的读方必须 `incompatible-event` 拒绝，包括快照覆盖段。salvage 的未知事件所在 commit 不纳入前缀，prefix repair 不跳过未知事件。代码回退须配合切换前一致性的 **store 全量快照**；不能只换代码。**RPO＝快照时点**，之后所有看板写入均可能丢失；Git 文件和外部副作用不会因此回滚。

**上线与回退预案必须包含 store 快照。** 现在「已提交且干净」的文档在第一次提交证据时就会静默自动 pin，项目随即包含 `doc/content-fixed`；旧版代码对该事件 fail-closed，因此没有快照的纯代码回退会被拒开。纯降级项目（只产生 `current-only`、没有 `doc/content-fixed`）仍可直接回退旧代码，已实测。升级前先做 store 全量快照并验证可恢复，是发布门禁的一部分，不是可选项。

未含 fixed 的合法旧证据维持原 docId@rev 语义；没有历史 blob 时明确报缺失，不用当前正文伪造。D6 的迁移映射保留原 hash/blob 的只读档案；迁移后的历史 @rev 不改指当前外置文件，既有 fixed 行继续按 Git 身份审计。迁移、inline-write-disabled 项目策略和恢复授权见 [D6 runbook](<DOC-MIGRATION.md>)。

## 7. 自动化覆盖

- [Git 校验矩阵](<../test/docs/doc-fixed-git.test.mjs>)：sha1/sha256、普通 blob、对象/路径缺失、staged/unstaged、干净 CRLF、filter/process/LFS 拒绝、textconv 放行且不执行、global 配置、嵌套仓库及转换拒绝。
- [固定证据矩阵](<../test/docs/doc-fixed-evidence.test.mjs>)：拒绝调用方自报 fixed/fixedConfirmed/bindingId（零落盘）、自动钉版本、四类错误、读取无证据副作用、无来源纯读 bootstrap、不漂移、同源新绑定自动追加、异源/缺锚点拒绝、读取对同源绑定只读放行、重启/快照、历史 fixed 行与 `gitContentRepository` 回放、旧 docId@rev、inline 历史语义、缺屏障拒绝与旧注册表拒读。
- [自动壳矩阵](<../test/docs/doc-fixed-auto.test.mjs>)：无 Git、干净自动固定、未提交/脏工作区、filter、LFS 指针、多仓库降级、非 UTF-8 降级、外置 `docId@rev` 忽略元数据版本、内嵌 `docId@rev` 不变、自动来源幂等、多文档单次批准、审计失败不落盘、reconcile 同 commit、冷开/快照一致与旧注册表拒读。
- [HEAD 一致性](<../test/docs/doc-fixed-head-race.test.mjs>)：注入两次 HEAD 读取之间的切换，验证自动固定、submit、reconcile 静默降级且无来源/屏障副作用，并验证 HEAD 复核位于全部干净性检查之后。
- [固定引用边界](<../test/docs/doc-fixed-edges.test.mjs>)：更早登记不可代替屏障、实际 blob 丢失、快照索引/来源篡改、历史属性与重定位隔离、历史 inline fixed 行回放与屏障、干净 CRLF 自动固定、嵌套仓库降级、UTF-8/BOM/格式/截断。
- [工具与 HTTP](<../test/docs/doc-fixed-surfaces.test.mjs>)：get_fixed 两种明确输入、schemaVersion、task 证据自动接线且不暴露 fixed 字段、鉴权、坏引用先于冷开拒绝与读取不写日志。

上述测试都接入 test:core；无 DSH 私有 peer 的离线环境仅显式 skip 工具表面测试，本机门禁不跳过它们。

delegation: no — 自动壳接线、文档与隔离验证由受限子代理直接完成，未再委派。
