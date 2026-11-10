# 外置文档登记（核心层与对外表面）

本文写的是外置文档现在怎么工作。语义以 [D1 冻结契约](<WORKSPACE-DOCUMENTS-CONTRACT.md>) 为准，本文只补充实现上的衔接决定。工具、HTTP 与查询视图见 §6；固定内容证据见 [文档固定内容证据](<DOC-EXTERNAL-EVIDENCE.md>)；内嵌迁移、授权、备份、幂等与恢复流程见 [D6 runbook](<DOC-MIGRATION.md>)。

## 1. 记录与事件

外置记录和内嵌文档放在同一个 `state.docs` 集合里，用 `source: 'external'` 区分。`source: 'inline'` 或没有 `source` 的记录，只有满足内嵌结构才按内嵌兼容规则读取：id、正整数 rev、标题、kind、正文 hash（小写 hex64）、非负整数 size 和 links 对象必须合法（`taskIds`/`planRefs` 只校验实际出现的字段，旧记录可缺 `planRefs`），不得携带 locator、顶层 bindingId/relPath、baseline、baselineInContext、status 或 unregistered 等外置专有字段；可选的时间戳和来源信息不作补写。

```text
{ id: doc_…, source: 'external', rev, title, kind, status,
  locator: { bindingId, relPath }, links: { taskIds, planRefs },
  baseline: null | { domain: 'workspace-bytes', contentHash, bindingId, relPath,
                     gitHeadOid|null, confirmedAt, confirmedBy, readerVersion },
  baselineInContext: boolean,
  unregistered: null | { at, by, reason }, createdAt, updatedAt, createdBy }
```

- `rev` 就是 metaRev，两者是同一个计数。每次成功的元数据写入加 1；读取、观测、刷新都不加。
- 记录里没有 `hash`、`body`、顶层 `bindingId`/`relPath`。bindingId 只放在 `locator` 中，`locator` 只能有这两个键。
- `baselineInContext`：只有 confirm 把它置为 true；register、relocate、rebind 都置为 false。基线为 null 时它必须是 false。
- 事件（全部注册为 `applied`）：`doc/external-registered`、`-updated`、`-relocated`、`-unregistered`、`-confirmed`。每条事件都带完整记录（`data`），可能附带审计字段 `change`（变更字段、状态转换和原因、重定位的 from/to、上一份基线），投影时忽略这些审计字段。
- `doc/content-fixed` 为 applied，登记不可变 Git 内容引用；新增 task fixed 证据要求同 commit 屏障，包含 inline 文档。读取和证据域见 [固定内容证据](<DOC-EXTERNAL-EVIDENCE.md>)。
- `doc/external-migrated` 为 applied，带完整 external 记录及 `sourceDocId/sourceRev/sourceHash`、目标 locator/内容身份和逐历史 rev 的原 hash 只读档案映射；来源、历史、关联与目标不匹配均拒绝。保持同一 docId，精确同映射重跑/重放不重复创建；与不同来源或目标冲突时显式报告，不覆盖用户文件。pre-D6 读方按 `incompatible-event` 拒开（含快照覆盖段），其 salvage 前缀停在该 commit 前。详见 [D6 runbook](<DOC-MIGRATION.md>)。
- 回放时任何一项不满足都会以 `invalid-external-doc` 失败，不会跳过，也不会按内嵌文档解释：
  - 记录结构非法；
  - 事件 `docId` 与记录 id 不一致；
  - 重复登记；
  - 对不存在的外置记录或内嵌记录做普通外置更新（只有严格迁移事件允许 inline → external）；
  - rev 不是正好加 1（精确重复迁移映射作为幂等无变化重放）；
  - `doc/created`/`doc/updated` 的内嵌结构非法、携带外置专有字段，或覆盖已有的外置记录。
- 冷开对整个日志按顺序做一次文档结构扫描（`assertDocEventsInLog`），规则与回放相同，**包括快照覆盖的那段 commit**。
  - 扫描投影 docId → 文档记录，并捕获快照自身 seq/hash 位置的文档集合，不把快照与日志末尾的较新状态比较。
- 采用快照之前，同时检查其内嵌与外置记录结构、集合键与记录 id 一致，并与对应日志位置的文档集合逐项比较。缺失、额外记录、source 降级、locator 或其他元数据不一致均以 `invalid-external-doc` 拒绝；集合差异的 details 包含 `origin: snapshot`、seq、docId 和 `reason: snapshot-doc-mismatch`。
- 日志扫描和快照文档校验都在尾部规范化之前完成；拒绝时不改写日志或快照，也不自动修复不一致快照。
- `fsck`/health 对外置记录检查 `doc-external:<id>` 结构，不检查正文 hash。工作区文件不可用不是存储故障。

## 2. 命令（`handle.command`，均需 `cmdId`）

| op | 参数 | 说明 |
|---|---|---|
| `doc.external.register` | `title`, `kind?`（默认 note）, `bindingId?`, `relPath`, `links?` | 新建 draft 记录，rev=1。返回值包含 `docId`（cmdId 重复导致去重时不返回，可从事件中取） |
| `doc.external.update_meta` | `docId`, `expectedMetaRev`, `title?`, `kind?`, `links?`, `status?`, `reason?` | 必须有实际变化，否则返回 invalid-command。状态转换见 §2.1 |
| `doc.external.relocate` | `docId`, `expectedMetaRev`, `bindingId?`（默认当前绑定）, `relPath?`（默认当前路径） | 两项都未变化时返回 invalid-command。新目标的检查规则与登记相同 |
| `doc.external.rebind` | `fromBindingId`, `toBindingId`, `expected.projectRev` | 仅 human/system 可用。在同一个 commit 内，为每个匹配的未解除登记文档各写一条 `doc/external-relocated`，relPath 不变。返回 `matched` 和 `docIds`；没有匹配时 `committed:false`。不检查文件 |
| `doc.external.confirm` | `docId`, `expectedMetaRev`, `expectedContentHash` | 服务端不走缓存，重新完整读取一次。读取失败时按 §5 返回错误码；hash 不同返回 `stale-revision`（details.currentContentHash） |
| `doc.external.unregister` | `docId`, `expectedMetaRev`, `reason?` | 写入墓碑 `unregistered`。记录、历史和关联都保留，不删除文件 |
| `doc.external.migrate` | `sourceDocId`, `sourceRev`, `sourceHash`, `locator`, `authorized:true`, `backup` | human/system 专用；检查实际一致性备份、原历史 blob 和已有目标的等字节身份，保持 docId 转外置；见 [D6 runbook](<DOC-MIGRATION.md>) |

通用规则：

- register 以外的普通外置写入要求 `expectedMetaRev === doc.rev`，否则返回 `stale-revision`（details.currentMetaRev）；rebind 用项目级 `expected.projectRev`。迁移以 `sourceRev/sourceHash` 作来源乐观锁，精确同映射重跑无写入。
- 已解除登记的文档拒绝普通外置写入，返回 `illegal-transition`。对内嵌文档调用普通外置命令返回 invalid-command；专用 migrate 必须走严格来源/备份校验。
- register、relocate、rebind、confirm 在校验绑定之前，先执行 `service.refreshFromDisk({ strict: true })`，按磁盘上的 meta 和绑定注册表判断。
  - 另一个进程刚退役的绑定会被拒绝为 `missing-binding`，刚新增的绑定可以直接使用。
  - 注册表不可读时这些命令失败（`bindings-unreadable` 等，503），与身份写操作一致。
- 没有任何命令会写正文 blob、创建、修改、移动或删除工作区文件。

### 2.1 管理状态

- 主线是 `draft → in_review → adopted`。
- 允许 `in_review → draft` 和 `adopted → in_review`。
- 任何非归档状态都可以转到 `archived`。
- `archived` 只能转到 `draft`，且必须给出 `reason`，否则返回 invalid-command。
- 其他转换返回 `illegal-transition`。
- 状态转换随 `doc/external-updated` 的 `change.transition {from,to,reason}` 一起记录。
- 读取、确认、内容变化都不会改变管理状态。

### 2.2 登记规则（契约未写明，这里的决定）

登记要求目标此刻是绑定根内一个存在的普通文件。

- **可以登记**：可用性为 `readable`、`unsupported_format`、`oversize`、`undecodable` 的文件（契约 §3.2：不可预览的格式也可以登记）。
- **拒绝登记**：`file-missing`、`root-unavailable`、`missing-binding`、`permission-denied`、`outside-root`、`security-rejected`、`not-regular`、`unstable`。

理由：登记是人显式指向一个已经存在的文件。登记之后文件变得不可用，按契约保留登记即可。登记时只做分类读取，不记录 hash，登记本身不构成确认。

## 3. 绑定与读取上下文

- `locator.bindingId` 的来源：
  - 显式传入时，必须是本项目的 active 绑定；
  - 不传时，用 `service.bindings().mainOf(projectId).bindingId`。旧项目的主绑定是内存中隐式的 `bnd_legacy_<hash>`，可以直接使用；`identity migrate` 持久化后 ID 不变。
- 读取、观测、确认一律在 `service.bindings().activeFor(projectId)` 中按 locator 的 bindingId 查找根目录：
  - 找不到 → `missing_binding`；
  - 根目录不存在 → `root_unavailable`（由 D2 读取器分类）。
- 不从会话 cwd 推导绑定，不临时换用别的工作区根，不跨根查找同名文件。
- 观测（inspect）每次都先重新读取绑定注册表（`service.reloadBindings()`，非严格）再解析绑定，缓存命中也一样。
  - 注册表不可读时退回隐式主绑定，worktree 绑定的文档因此显示 `missing_binding`，不会沿用旧索引。
- 项目 relocate 或跨机 import 后，主绑定换成新 ID，原有文档全部变为 `missing_binding`。需要显式执行 `doc.external.rebind`（批量）或 `doc.external.relocate`（单个）。
- 重定位会保留原基线作审计。每次 relocate 或 rebind 都算新上下文，包括移回原 locator 的情况。在新上下文中重新 confirm 之前，比较结果都是 `not_comparable`（reason `relocated`），不会出现 `matches_baseline`。

## 4. 观测（不落盘）

`inspectExternalDoc(handle, docId, { fresh?, preview? })` 返回：

```text
{ schemaVersion: 1, doc, metaRev, projectRev, unregistered,
  availability, code,                       // 契约 §2 枚举 / §6.2 code，readable 时 code=null
  observation: { observedAt, cached, context: { bindingId, root|null, relPath, role|null },
                 contentHash|null, size|null, previewable, detail, preview? },
  confirmation: { state: unconfirmed|matches_baseline|changed_since_confirm|not_comparable, reason?, baseline },
  git: null | { state: untracked|ignored|modified|committed|not_a_repo|git_unavailable,
                staged?, unstaged?, filtered?, lfs?, detail? } }
```

- 文件不可用时仍正常返回登记、关联和状态，不抛错。只有以下情况抛错：
  - 未知 doc → not-found；
  - 内嵌 doc → invalid-command；
  - handle 已关闭。
- 已解除登记的文档只返回记录，`observation`/`git` 为 null，确认情况为 `unconfirmed` 或 `not_comparable`（reason unregistered）。
- 缓存按 handle 区分，键为 `docId+rev+bindingId+root+relPath`，最长保留 30 秒，以 `handle.clock()` 计时。`fresh:true` 跳过缓存。confirm 从不使用缓存。
  - 根目录是在重新读取绑定之后才解析的，所以绑定退役后，键里的 root 跟着变化，旧的缓存条目不会再被命中。
- 确认情况的判定：
  - 没有基线 → unconfirmed；
  - `baselineInContext` 为 false（重定位后未重新确认）、基线上下文与 locator 不一致、校验域不同、拿不到完整 hash → not_comparable；
  - 其余情况比较 hash。
- 只要能读到完整字节就给出 hash，包括 unsupported_format。oversize、undecodable 不给 hash。
- Git 观测（`lib/core/documents/external-git.js`）：
  - 每次调用超时 3 秒，输出上限 1 MiB；
  - 设置 `GIT_TERMINAL_PROMPT=0`、`GIT_OPTIONAL_LOCKS=0`，关闭 fsmonitor 和 untrackedCache，清除 `GIT_DIR` 等环境变量；
  - 把配置中出现的每个 filter 驱动的 clean/smudge/process 置空、required 置 false，因此 status 不会执行仓库配置里的过滤器；
  - pathspec 使用 `:(literal)`。
- 路径带 filter 属性（包括 `filter=lfs`）、又处于 tracked 状态时，返回 `git_unavailable`，`detail: 'unsupported-content-transform'`，并保留 `filtered`/`lfs` 标记。原因是禁用 filter 之后，status 比较的字节不可信，所以不报告 modified 或 committed。这类路径的 untracked/ignored 照常报告。
- Git 状态的来源：
  - `git status --porcelain=v1 --ignored=matching`：`??` → untracked，`!!` → ignored，其余 → modified（附 staged/unstaged）；
  - status 无输出时再看 `ls-files`：在索引中 → committed，不在 → untracked（detail not-in-index）。
- 不在仓库中 → not_a_repo；git 缺失、超时或执行失败 → git_unavailable。
- 可用性为 missing_binding、root_unavailable、security_rejected、outside_root 时不运行 git，`git:null`。
- 未实现：`eolTransformed` 标记目前不报告，只有 `filtered`/`lfs` 来自 check-attr。
- `listExternalDocs(handle, { includeUnregistered? })` 只返回登记记录，不读工作区。

## 5. 错误码

| code | HTTP | 场景 |
|---|---|---|
| invalid-external-doc | 400 | 外置/兼容内嵌记录结构非法、locator 非法、bindingId 为空字符串，或快照文档与其日志位置不一致；回放与快照载入同码（details 带 seq/type/docId/reason 或 origin=snapshot） |
| missing-binding | 409 | 指定的 bindingId 不是本项目的 active 绑定；项目没有主绑定 |
| stale-revision | 409 | expectedMetaRev 不符；confirm 时内容 hash 已变化 |
| illegal-transition | 409 | 管理状态转换非法；对已解除登记的文档写入 |
| external-doc-operation-required | 409 | 旧 `doc.put`/`doc.link`、内嵌 doc 视图（`query('doc')`）与 `GET /docs/:docId`、无 fixed 的 `kind:doc` 证据涉及外置记录 |
| inline-write-disabled | 409 | 内嵌写入默认禁用（新建、既有编辑与 `doc.link` 一律拒绝），或迁移后的只读档案；仅 human 的 `doc.inline_policy` 可按项目恢复未迁移文档的旧写语义 |
| forbidden-role | 403 | agent 调用 rebind；非 human 调用 `doc.inline_policy` |
| file-missing / root-unavailable / permission-denied / outside-root / security-rejected / not-regular / oversize / undecodable / unsupported-format / unstable | 404 / 503 / 403 / 403 / 403 / 400 / 413 / 400 / 400 / 409 | register/relocate/confirm 读取失败时的拒绝；inspect 中只作为 `code` 字段出现 |

`inline-write-disabled` 是内嵌文档的默认策略：新项目创世即禁用内嵌写入，缺失该字段的旧项目同样按禁用处理；`doc.put`（新建与既有编辑）、`doc.link` 在写 blob/事件之前拒绝，store 字节与事件数不变。宿主入口（`project_doc` 工具、`POST /commands`）把命令交给 core。core 在获取 writer 之前校验形态和无锁投影上的文档准入条件，保留 title 的 `String` 强制转换，以及 put 的 links 先于项目策略的校验顺序。被这一步拒绝的请求不创建项目、不触发冷开恢复。串行命令基于最新投影重新校验。link 的 links 校验在目标、策略和命令信封检查之后执行。`project_doc put` 不隐式创建项目。迁移文档无论开关如何都是只读档案，迁移工具是唯一转换通道。唯一逃生口是 human 显式调用 `doc.inline_policy`（`authorized:true`、当前 `expected.projectRev`、`disabled:false|true`），状态变化落为 `project/updated` 事件；`disabled:false` 只恢复未迁移内嵌文档的旧 baseRev 语义。agent/system 调用返回 `forbidden-role`；没有环境变量或其他后门。看板 UI 对内嵌档案只显示只读提示，新建、编辑与关联入口整体移除；新内容走工作区文件 + 外置登记。回退与 RPO 见 [D6 runbook](<DOC-MIGRATION.md>)。外置 doc 证据走[自动固定/显式 current-only 降级](<DOC-EXTERNAL-EVIDENCE.md>)；历史 inline hash/@rev 与既有 fixed 行不重解释。

## 6. 对外表面（工具 / HTTP / 查询）

### 6.1 `project_doc` 工具

旧 op（`get`、`put`、`list`、`link`）保留：`get`/`put`/`link` 指向普通外置记录时由 core 返回 `external-doc-operation-required`（409）；迁移文档的旧 `put`/`link` 返回 `inline-write-disabled`，`get` 仍明确要求外置入口。外置 op 一律通过 `handle.command` 写入，不直接改投影，也不写正文 blob。

| op | 参数 | 返回 |
|---|---|---|
| register | `title`, `kind?`（默认 note）, `bindingId?`, `relPath`, `links?` | `{ ok, projectId, schemaVersion: 1, doc, result }`；`doc` 为登记记录，`result.docId` 来自命令 |
| inspect | `docId`, `fresh?`, `preview?` | inspect 视图原样展开：`{ ok, projectId, schemaVersion: 1, doc, metaRev, projectRev, unregistered, availability, code, observation, confirmation, git }` |
| update_meta | `docId`, `expectedMetaRev`, `title?`, `kind?`, `links?`, `status?`, `reason?` | `{ ok, projectId, schemaVersion: 1, doc, result }`（`doc` 为写入后的记录） |
| relocate | `docId`, `expectedMetaRev`, `bindingId?`, `relPath?` | 同上 |
| confirm | `docId`, `expectedMetaRev`, `expectedContentHash` | 同上，`doc.baseline` 为新的确认基线 |
| unregister | `docId`, `expectedMetaRev`, `reason?` | 同上，`doc.unregistered` 为墓碑 |
| list_external | `includeUnregistered?` | `{ ok, projectId, schemaVersion: 1, docs, projectRev }` |
| get_fixed | `docId`, `fixed` 或 `commitOid/pathAtCommit`，`bindingId?` | `{ ok, projectId, schemaVersion:1, docId, fixed, hash, body, truncated, totalBytes, domain:'git-blob-bytes', workspaceComparison }`；只读，不生成证据 |

- 不暴露 `rebind`：工具的 actor 恒为 agent，而 `doc.external.rebind` 仅 human/system 可用。需要批量换绑定时走 `POST /projects/:id/commands`（网页鉴权提供 human actor）或 UI。
- `get_fixed` 接受 docId 加完整 fixed，或显式完整 commitOid/pathAtCommit，bindingId 可作已记录来源的读取提示；`POST /docs/external/:docId/fixed` 是对应的 HTTP 入口。两者返回 schemaVersion=1，读取不生成证据，具体确认与屏障见 [固定内容证据](<DOC-EXTERNAL-EVIDENCE.md>)。
- 写 op 的字段白名单由 `lib/shared/contract.js` 的 `DOC_EXTERNAL_WRITE_FIELDS` 定义，工具 handler 与 HTTP 共用同一张表：出现白名单外字段（例如把 `bindingId` 拼成 `bindingID`，或给 `register` 带 `status`）一律 `invalid-command`（400，details 含 `fields`/`allowed`），不会静默回退默认值。工具 schema 只是第一道门，handler 会再校验一次，schema 漂移也不会让错字段穿过去；校验发生在解析项目句柄之前，冷项目不会被坏请求打开。
- `inspect` 的文本渲染逐项列出：docId、metaRev、locator（bindingId/relPath）、availability 与 code、observedAt 与 cached、完整 contentHash（不可用时写 `null`）、size、previewable、`preview:true` 时的预览正文与 truncated/totalBytes、确认情况（state/reason）与基线摘要、Git 状态与 detail。不可确认的空值写成 `null`，不省略。
- 已知限制：`cmdId` 重复触发去重时 `register` 不返回 `docId`（D3a 行为），此时 `doc` 为 null，调用方需从先前响应或事件取得 id。
- 写失败沿用 `BoardError` → `NEXT` 映射；新增的外置错误码提示见 `lib/host/tools/shared.js` 的 `NEXT`（文件不可用时提示 relocate/unregister，而不是重建文件）。

### 6.2 HTTP

除既有 `/docs` 与 `/docs/:docId` 外，`/project-board/api/projects/:id/docs` 下新增：

| method | path | 说明 |
|---|---|---|
| GET | `/docs/external?includeUnregistered=1` | 列表（只读登记，不读工作区） |
| POST | `/docs/external` | 登记；body 即 §2 register 参数 |
| GET | `/docs/external/:docId?fresh=1&preview=1` | inspect；登记存在即 200 |
| PATCH | `/docs/external/:docId` | `update_meta`；body 用 §2 参数 |
| POST | `/docs/external/:docId/relocate` | `relocate` |
| POST | `/docs/external/:docId/confirm` | `confirm` |
| POST | `/docs/external/:docId/unregister` | `unregister` |
| POST | `/docs/external/:docId/fixed` | `get_fixed`，只读 Git 固定内容，schemaVersion=1 |

这些模板同时登记在 `lib/shared/contract.js` 的 `API_PATHS`（`docsExternal`、`docsExternalDoc`）。

- 响应全部带 `schemaVersion: 1`；list/inspect 直接使用 core 观测视图的 `schemaVersion`。
- 写入 body 必须是 JSON 对象（`null`、数组、非对象都返回 400）。可带 `schemaVersion`；缺省视为当前版本，出现非 `1` 的值时以 `invalid-command`（400，details 含 `schemaVersion` 与 `supported`）拒绝，提示客户端升级或保持只读。
- 写入 body 的字段白名单是 `DOC_EXTERNAL_WRITE_FIELDS` 加上信封字段 `cmdId`、`schemaVersion`；白名单外字段一律 400（details 含 `fields`/`allowed`），不静默忽略。`docId` 只来自 URL；body 里带不同的 `docId` 也拒绝。
- 上述 body 解析、对象形状、`schemaVersion` 与字段白名单在 `service.open` 之前完成（`routes.js` → `prepareExternalWrite`）。冷项目 open 会执行恢复写入，所以校验必须在 open 之前，否则"400 零落盘"不成立。合法请求照常 open 并执行恢复。
- 写入的 `actor` 来自已通过鉴权的网页能力，归因为 `{ kind: 'human', via: 'web' }`。`cmdId` 可自带（重试幂等），缺省由服务端生成。
- `GET /docs/:docId` 仍只解析内嵌正文，访问外置记录返回 `external-doc-operation-required`（409）。`GET /docs` 列表照常同时列出两种来源。
- 文件不可用（file-missing、root-unavailable、oversize、undecodable 等）在 inspect 里是 200 + `availability`/`code`；只有鉴权失败、未知 doc、store 损坏/只读等才是请求失败。
- inspect 的 `availability` 使用读取层枚举（`readable`、`missing`、`root_unavailable`、`missing_binding`、`permission_denied`、`outside_root`、`security_rejected`、`not_regular`、`oversize`、`undecodable`、`unsupported_format`、`unstable`），`code` 使用契约 §6.2 的连字符码（`file-missing` 等），可读时为 null。命令拒绝抛出的始终是 `code`。

### 6.3 查询视图

- `query('docs')` / `project_board view=docs` 的每一行都带 `source`：`inline` 或 `external`。旧行原本没有 `source` 的外置记录继续是 `external`，新增字段向后兼容。
- 外置行保持记录原形：没有 `hash`、`size`、`body`，只有 `locator`、`status`、`baseline`、`unregistered` 等登记元数据。读取文件内容或 hash 只能走 inspect/confirm。
- `docsForTask`（任务视图的 `linkedDocs`）同样带 `source`，调用方据此决定打开 `/docs/:docId` 还是 `/docs/external/:docId`。
- `query('doc')` 对外置记录仍直接拒绝（`external-doc-operation-required`）。

### 6.4 权限与已决定事项

- `rebind`、D6 `migrate` 与 `doc.inline_policy` 仅 human（`rebind`/`migrate` 也接受 system；`inline_policy` 严格 human）；其余普通外置命令 agent 可用，HTTP 一律 human。迁移与策略不新增 project_doc 工具 op，只走显式离线/API 命令。
- **已决定：管理状态 `adopted`/`archived` 暂不收紧**，agent 仍可经 `update_meta` 到达任何合法状态。日后若要收紧为 human/system only，属于契约补充（会改命令校验与本表），不是当前行为。
- **已决定：`rebind` 暂不暴露到工具/UI**，保持只能经 `POST /projects/:id/commands` 的 human 信封调用。

## 7. 兼容、回退与恢复

- **新事件旧代码读不了**：本改动之前的代码遇到 `doc/external-*` 时按 `incompatible-event` 拒绝打开整个项目，快照覆盖的部分也一样。离线 salvage/prefix repair 不会把含这类事件的 commit 纳入有效前缀。测试用注入旧注册表的方式证明了这一点（`test/docs/doc-external-compat.test.mjs`）。
- **代码回退必须配合数据快照**：项目一旦写入外置事件，只回退代码会让项目无法打开。回退时要同时恢复切换前做的一致性 store 快照（见 [RELEASE.md](<RELEASE.md>)）。
- **RPO**：等于该快照时点。快照之后的所有写入（包括非文档写入）都会丢失；被登记的工作区文件本身不受影响，因为看板从不写它们。
- 没有写入外置事件的项目，在新旧代码之间可以自由切换。
- 测试：
  - `test/docs/doc-external.test.mjs`：登记不写 blob、不改文件，docId 与关联稳定，重启一致，metaRev 冲突与并发，转换规则，确认竞态与基线，各种不可用情况，worktree cwd 不改变根，relocate/rebind/unregister/archive 不动文件且需要重新确认，旧操作被拒绝，缓存；
  - `test/docs/doc-external-compat.test.mjs`：注册表（external/content-fixed/migrated 为 applied）、旧读方拒读、salvage 前缀、快照覆盖段非法事件、内嵌最小结构与外置伪装拒绝、快照文档身份及集合一致性、旧锚点加新尾部的兼容回放、genesis 快照、拒绝时日志/快照字节不变、migrated 缺映射拒读及 pre-D6 注册表拒读、fsck、Git 状态；
  - `test/docs/doc-external-edges.test.mjs`：跨进程退役/新增绑定（含缓存）、重定位往返与 rebind 后需要重新确认、确认读取期间文件持续变化、filter/LFS 路径的 Git 状态。
  - `test/docs/doc-external-tools.test.mjs`：工具层 op 映射与返回形状、metaRev/内容 hash 守卫、旧 op 拒绝、登记失败码与 NEXT 提示、写 op 字段白名单（错拼/跨域字段 400 且 rev 与日志字节不变）、inspect 文本渲染（readable 与 missing 输出不同且包含全部观测字段）、docs 视图的 source 与外置行无 hash/size、注册不写 blob。
  - `test/docs/doc-external-routes.test.mjs`：HTTP 登记/列表/inspect/PATCH/relocate/confirm/unregister、写 op 字段白名单与 JSON null/数组 body（400、项目 rev 与 commits 日志字节不变）、冷项目 400 不触发恢复而合法请求仍恢复、未知 schemaVersion 拒绝写入、旧 `/docs/:docId` 409、文件缺失仍 200、未知 doc 与鉴权失败。
