# ProjectBoard 实现契约

> 状态：现行；随 npm 包发布。

本文是 core / host / client 的项目级 L1 契约：领域模型（1a）、对外承诺（1b）与冻结子契约索引（1c）。命令、守卫与返回值以本文件为准；仓库设计背景和模块地图不是新增产品能力的授权。核心语义均在本文，仓库链接只提供细节。所有时间为 ISO 字符串，id 带类型前缀，代码路径相对仓库根目录。

## 1. 领域模型（1a）

### 1.1 词汇表

| 术语 | 领域含义 |
|---|---|
| 项目 Project | 持久状态机的边界；绑定工作区身份，包含任务、计划、文档与策略。phase 为 active/paused/archived；active 可新 claim，paused 禁新 claim 但已有 lease 可 submit/release，archived 只允许 unarchive 写。 |
| 任务 Task | 唯一工作单元，拥有状态、rev、验收项、证据、依赖及至多一个计划归属。 |
| 计划 Plan | initiative 级容器；可写 head 与不可变版本分开，step 是有序推进/集中审查单元，没有独立状态机。 |
| 证据 Evidence | 提交者材料和服务端内容观测；file/doc 可记录内容指纹，command/test/note/url 不执行、不探测、不担保结论。 |
| 文档 Doc | 稳定 docId 与关联；inline 是 blob 正文档案，external 是 locator 登记，元数据修订不代表正文版本。 |
| 会话 SessionBinding | 受信入口的 sessionId/agentId、epoch 与活性绑定；会话不是项目事实的所有者。 |
| 租约 Lease | 单任务执行权，带 TTL、宽限期与递增 fencing token；持久 owner 不等于运行时有效租约。 |
| 意图 WorkIntent | 副作用前的 WAL，open 表示执行尚未结算；closed/abandoned 保留结算记录，abandoned 不表示已回滚。 |

关系：Project 1→N Plan/Task/Doc/SessionBinding；Task 1→N Evidence，至多 1 个 live lease 和 1 个 open intent；文档通过 links 关联任务/计划。

<a id="26-plan--task-规则"></a>

### 1.2 任务状态机

状态全集：`backlog / ready / in_progress / review / done / blocked / canceled / interrupted`。`done` 与 `canceled` 为终态；submit 不等于完成，验收是显式记录而非正确性证明。

| 起点 | 命令/触发 | 终点 |
|---|---|---|
| 无 | create | 无未完成依赖时 ready，否则 backlog |
| backlog | ready / 前置 done 级联 | ready |
| ready | claim | in_progress |
| in_progress | begin | in_progress（写 open intent） |
| in_progress | submit | review |
| review | verify | done |
| review | reject | 可自动接回时 in_progress，否则 ready |
| in_progress / review | block | blocked（保存 resumeTo） |
| blocked | unblock | resumeTo=review 时 review；其余在原 assignee 可恢复时授新租约回 in_progress，否则 ready；不重建 intent |
| in_progress | release | ready |
| in_progress | interrupt / 可回收租约 / writer 重启恢复 | 有 open intent 时 interrupted，回收且无 intent 时 ready；显式 interrupt 总到 interrupted |
| interrupted | reconcile resume / completed / discard | in_progress / review / ready |
| 非终态 | cancel | canceled |
| done / canceled | reopen（human） | ready |

普通任务允许任意授权 agent（含提交者）显式 verify；审计门要求独立 agent 与 audit.report。human 始终可验收，不要求报告。下列守卫与结算规则限定所有转移。

**依赖级联**

- 任务 done 时，同一 commit 内把 deps 已全部 done 的 backlog 任务置 ready（`task/readied`）。
- ready 需要所有 deps 为 done，且 acceptance 非空。

**update**

- 无租约也能改的前提：agent 在 backlog/ready 且无 live lease 时可改（重排队列/修前置不必先认领）；human 无租约可改任意非终态。
- agent 在 in_progress / review / blocked 必须持租约（否则 lease-held）；terminal 状态一律拒绝（reopen 才是回头路）。
- deps 校验：未知 id / 自依赖 / 成环 → 400 invalid-command；加未完成前置会让 ready 降回 backlog（ready→backlog 是唯一的自动降级方向，反向升级仍走 task.ready）。
- requiresAudit：agent 只能在非 review 打开、不能关闭（forbidden-role）；review 中 agent 不得通过字段或标签改变门。human 可开关。
- 事件：`task/updated`；有实际字段变化时再追加 `task/meta-edited {taskId, by, fields[], reason, at}`。

**归属（createdBy）**

- 创建者不存在于事件 payload，权威来源是 commit.actor。replay 时对 `task/created`、`plan/created`、`plan/published`、`plan/revised` 缺失 createdBy 的数据回填 `{kind, sessionId, agentId, at}`，所以旧日志零迁移即可读。
- 只读：不存在修改 createdBy 的命令，`task.update` 传入 createdBy 作为未知字段返回 `invalid-command`。
- 暴露：task card / taskView / planSummary（计划列表与计划详情的 head 摘要）。

**claim**

- project active；task ready；无 live lease；actor session 的 lease 数 < policy.maxPerSession（默认 1）；项目 in_progress 数 < policy.maxInProgress（默认 5）。
- 分配 `token = ++counters.leaseToken`（持久化，重启后从 max+1）。
- 事件：`lease/granted` + `task/claimed`。
- task.owner = `{sessionId, agentId, epoch, fencingToken, leaseUntil}`。

**begin**

- 必须有 live lease + token；无 open intent。
- 事件：`work/intent` + `task/updated`（task.work）。

**submit**

- 必须有 live lease + token；有 open intent（或 policy 允许无 intent）。
- 每条 acceptance 至少一条 active evidence（带 acceptanceId）；note/url 也可作为材料满足覆盖，只有 `requiredKinds` 非空时额外要求至少一条证据的 kind 落在其中。覆盖只表示材料存在，不表示结论正确。
- **进入 review 前做一次硬审计**：证据全部加入/替换后跑一次 `auditEvidence`（不是逐条、不是每次加证据）；任一 hard（file/doc 漂移、missing/unreadable、pinned doc blob 丢失/损坏、留存对象缺失/损坏或历史固定记录结构/身份不符）→ 409 `evidence-drift`，details 带 `warnings` 与 `stage:'submit'`，整条命令不落盘，lease 保留，agent 可在同一租约内修正后立即重提。不可观测 warning 随结果返回并进入 review。
- 关闭 intent（work/result）；task → review。
- **不自动完成**：`policy.verification` 只有 `manual`，submit 一律停在 review，由获授权的验收者显式 verify。旧 `auto` 配置与历史 `task/verified` 事件只按原数据读入、不迁移、不改写；`project.update` 新写 `auto` → `invalid-command`。verify 是验收者的背书/验收记录，不是系统对交付正确性的证明。

**verify**

- 普通任务允许任意拥有项目写权限的 agent 显式验收，包括开发或提交者，不需要独立会话。审计门（`requiresAudit` / `gate:audit`）仍要求独立 agent：worker 集合为 assignee + 所有 evidence.producedBy（含 superseded）+ workers；审计者 sessionId/agentId 均不能命中，缺 worker 返回 worker-unknown，命中返回 not-independent；createdBy 不算 worker。独立性只在 session 级，不抵抗新 session/子代理分身。
- `audit={report,checklist?:[{item,ok,note?}]}` 用于 verify/reject。审计门的 agent verify 必须提供报告；普通任务的 agent 和 human 可直接 verify，或传 reason/note（入口支持时）。传入 audit 时 report 去空白后 20–4000 字；清单最多 50 项、item ≤200 字、note ≤500 字。
- `lastAudit={id,at,gate,by:{kind,sessionId,agentId,via},verdict,report,checklist,evidence:{count,digest},scopeDigest,workers,warnings,taskRev}`；evidence.digest 锚定 active evidence 的 id/kind/ref/hash。`scopeDigest` 是独立的验收范围指纹，绑定标题/说明、依赖、验收项及材料覆盖、审计门、active evidence 与来源身份、worker 集合；不绑定 planRef/orphaned/priority/weight/rev 等管理元数据。`taskRev` 保留审计命令写后修订号，作为不可变的正整数历史锚点，不大于当前 rev，不随元数据编辑重写。warnings 最多 20 条。human pass 覆盖旧 fail；begin/reopen 清记录，同 attempt 的 submit 保留 fail。报告与指纹均不证明内容正确，agent 报告为自述，不能显示为系统核验或人类核验。
- agent 显式传 refreshDrift/acknowledgeDrift 返回 403；hard 漂移返回 409，canRefresh/canAcknowledgeDrift 均 false，下一步是 reject 返工或 human 处理。固定 Git 不可观测 warning 仍可放行，保留在 lastAudit。I23 检查 agent done 必须有可追溯的 pass、匹配任务的 gate、有效历史 taskRev 锚点（正整数且 ≤ 当前 rev）、与当前实质验收范围匹配的 scopeDigest、匹配当前 active evidence 的 count/digest 与 worker 快照；审计门另检查报告与独立性，普通验收不检查独立性。历史 human/policy 不追溯。元数据调整不冒充重新验收；对 agent 已验收任务通过 plan.revise 改动实质范围返回 409 audit-scope-locked，应先由 human reopen，再返工、重提与显式验收。继续使用 schema v3 和已有事件；只能由支持普通 agent 验收的构建正确检查这类新增记录的 I23，不能用旧构建回退后忽略健康错误。

- 获授权的验收者只能验收 review 且所有 acceptance met 的任务。verify 前重新审计内容观测：file 漂移/缺失/不可读、无 `@rev` 的 doc head 漂移、pinned doc blob 丢失/损坏、留存对象缺失/损坏或旧固定记录结构/身份不符 → `evidence-drift`（409，details.warnings；`canRefresh` 表示存在可刷新的 file 漂移）。旧 Git 固定记录不给出正文核验结论；不可观测 warning 不阻断 verify。**verify 不复核命令执行结论**：不重跑 command/test、不判断退出码，命令/测试材料只按提交者记录保留。写 `task/verified` 与最近验收记录 `lastAudit`；这是验收操作记录，不是系统对交付正确性的担保。
- **人工刷新（file 内容漂移）**：hard 错误里有 `file-drift`（内容变、文件仍可读）时，human 传 `refreshDrift:true` + `reason`（去空白后 ≥4 字），服务端重读文件、重算 hash、追加新证据并退休旧行，再复核；`missing`/`unreadable` 与固定 Git 不可观测不可刷新。刷新后仍有 hard 且未 `acknowledgeDrift` → 409；两者同用则先刷新、剩余按豁免规则。刷新写入任务 `refreshedDrift = {at, by, reason, items[{evidenceId, supersededIds, ref, oldHash, newHash}]}` 并随 `task/verified` 持久化。
- **人工豁免（解阻塞）**：硬审计错误存在时，human 传 `acknowledgeDrift:true` + `reason`（去空白后 ≥4 字）可照常 done；豁免写入任务的 `waivedDrift = {at, by, reason, warnings[]}` 并随 `task/verified` 事件持久化。不带 ack 仍 409（details 里 `canAcknowledgeDrift:true`）；带 ack 但 reason 缺失/过短 → 400 `invalid-command`。豁免是显式的人类决定，不隐藏漂移：health 仍按原样报告。

**人工豁免的适用边界**

- **定位**：`acknowledgeDrift` 不是绕过安全策略的小路，也不是“检查失败就点一下”的降级开关；它是把本次验收的严谨度判断交还给项目所有者。系统保证事实被如实呈现，是否接受由 human 签字负责。
- **适用（freshness / 呈现变化，且 human 已另行核对）**：提交后内容有小改（设计稿、文档、生成物、格式化）；文件移动/重命名；历史 review 任务因提交后漂移卡住，重做成本高于人工复核；hash/路径变化但语义未变，human 确认是同一交付。
- **能 refresh 的优先 refresh**：file 内容漂移且有可读文件时，`refreshDrift` 更新链头、health 干净；`acknowledgeDrift` 保留旧快照并由 human 背书，health 仍如实报告。两者同用时先刷新、剩余再豁免。
- **机制允许但不作为默认**：`missing`/`unreadable`。只有 human 另有独立证据证明交付存在、并愿意为记录负责时才用；不能据此宣称“文件存在”或“内容正确”。
- **不适用**：acceptance 未 met（verify 先拒绝，豁免不改变 met）；agent 自助放行；绕过审计门的独立性限制；用一次 waiver 覆盖之后的新漂移；要求板为 command/test 的执行结果背书（板不判断，也不因此拒绝）。
- **只适用于 human verify**：AI/worker 在 submit/reconcile 阶段遇到 hard 错误没有豁免入口（直接 409、零落盘、lease 保留，必须自修）；agent 审计遇到 hard 漂移同样不可豁免，应 reject 返工或请 human 处理。
- **留痕与失效**：`waivedDrift = {at, by, reason, warnings[]}` 随 `task/verified` 持久化；health 不静默；waiver 只对本次审计快照有效，任何新变化都要重新判断。submit/reconcile 已在进入 review 前拒绝 hard 错误，所以豁免只出现在 review→done 的 human verify。
- 证据的 `file` 路径按项目 workspace 解析并只在该工作区内取证；项目板不检查其他分支/worktree，也不要求先合并回某个工作区。开发者可自行选择分支与 worktree，这属于工程流程，不是产品担保。

**reject**

- review 无 live lease 时任意 agent/human（含 worker 自驳）可 reject，reason 必填；有 live lease 时非 human 仅持有者且校验 fencingToken。原 assignee 可自动接回时授予新租约并回 in_progress，其余回 ready；unassign 仅 human。两端共享同一自动恢复策略，不按传输来源分支。rejection 记录 reason/at/by/byKind/auditId（可选）。带 audit 写 fail lastAudit；无 audit 不新建记录。事件仍为 task/rejected。任意 agent 驳回带来的乒乓 DoS 是接受的边界，没有自动限流。

**block**

- in_progress/review → blocked；记 `resumeTo`；释放 lease（in_progress 时）；task/blocked。
- 有 open intent 时必须带 `intent.outcome=stopped` + sideEffects，同一 commit 写 `work/abandoned`；否则 `intent-unresolved`，任务/日志/lease 不变。
- 非 human 需 live lease + 正确 `fencingToken`；human 可强制。block 不重建 intent。

**interrupt**

- in_progress → interrupted；撤销 lease；`work/intent` 保持 open；task/interrupted。
- note 必填；in_progress 非 human 需 lease + token；human 可强制。
- 遗留 `blocked/review/ready/backlog + open intent` 仅 human 可 interrupt（修复 I6 旧数据）。
- 之后只能 `reconcile` 收口。

**unblock**

- blocked：resumeTo==='review' 时回 review；否则原 assignee 可恢复时（绑定存活、epoch 匹配、WIP 有余量）检查计划未归档，授新租约回 in_progress；不能恢复时回 ready。清 blocker，写 task/unblocked 与 assignment；不重建 intent，继续副作用前必须 begin。
- 有 open intent 时拒绝 `intent-unresolved`（旧数据先 human interrupt）；不重建 intent。

**release**

- in_progress → ready；撤销 lease；task/released。
- 有 open intent 时必须带 `intent.outcome=stopped` + sideEffects，否则 `intent-unresolved`。

**reconcile**

- 只允许 interrupted。
- `choice='resume'`：旧 intent → abandoned（resolution=redo）；拿新 lease；新 intent（attempt+1）；→ in_progress。
- `choice='completed'`：旧 intent → closed（resolution=applied）；task → review；可附 evidence。与 submit 同一套替换规则，并在进入 review 前做一次 hard 审计（hard → 409 `evidence-drift`，details.stage='reconcile'，零落盘）；成功后按 active 证据重算 acceptance.met。
- `choice='discard'`：旧 intent → abandoned（resolution=discarded）；→ ready。
- note 必填；task/reconciled；清 `task.interrupt`。

**cancel**

- 非终态 → canceled；撤销 lease；reason。已开启审计门（requiresAudit）的任务只能由 human 取消。
- 有 live lease 时非 human 校验 `fencingToken`；有 open intent 时必须带 `stopped` + sideEffects，否则 `intent-unresolved`。

**reopen**

- done/canceled → in_progress/ready/backlog：仅 human；reason。deps 满足且原 assignee 仍可恢复（绑定存在且未分离、epoch 匹配、非 explicit-claim、未超 TTL+宽限、会话未满额）时重授租约回 in_progress；deps 满足但不能恢复则 ready；deps 不满足则 backlog。清 verified/owner/work/lastAudit/blocker/canceledReason/rejection。

**过期 / 恢复**

- 进程启动后 lease 表为空；`recover()` 把所有 in_progress 任务：
  - 有 open intent → `task/interrupted` + `lease/expired`
  - 无 open intent → `task/readied` + `lease/expired`
- 重启回收把租约终止和任务处置记录在同一笔提交中。显式打开 writer 可以独立恢复；普通业务写首次打开冷项目时，按调用者读到的已提交版本检查，在该业务事务的工作副本中准备恢复。业务成功需要持久化时一起发布；拒绝、重复命令或空操作不会因为打开 writer 而改变任务、版本或日志。同一物理 writer 已处理的重启回收不因服务重载或其他调用者复用而重做。
- **重启回收与常规到期回收的语义/审计差异**：常规 sweep 终止的是运行时 lease，`lease/expired.data` 是它的完整快照（`grantedAt`/`expiresAt`/`renewCount`/`progressAt` 等）；重启后 lease 表是进程状态、已为空，记录只能从持久化 `task.owner`（`sessionId`/`agentId`/`epoch`/`fencingToken`/`leaseUntil`）重建——已知字段原样写入（`token` 取自 `fencingToken`，`expiresAt` 取自 `leaseUntil`），未知字段（`acquiredAt`/`grantedAt`/`renewCount`/`progressAt`/`lastRenewedAt`）一律省略，绝不虚构续租历史，并写 `reason:'restart'` 与常规回收区分。`lease/expired` 仍是 additive：投影只消费 `lease/granted` 的 token 计数，payload 不参与状态推导。
- archived 项目不写独立 recover commit：`recover()` 直接返回，恢复事件由 unarchive 的 `project/updated` 提交携带（archived 上出现 in_progress 只可能来自旧数据）。
- TTL 过期不等于立刻死：`leaseTtlSec + leaseGraceSec` 内，且 binding 未 detached、epoch 匹配、`lastSeenAt` 未超过 `leaseTtlSec + leaseGraceSec`，lease 仍可续；health 标“过期可续”。
- 宽限内 `task.renew` 只改内存（新 expiresAt，不写 commit）；默认 `maxRenewalsWithoutProgress=2`，显式续租次数耗尽后拒绝续租。
- `touch` 和 `task.renew` 共享绝对无进展期限：`progressAt + (1 + maxRenewalsWithoutProgress) * leaseTtlSec`（统一使用注入时钟）。续期的 expiresAt 不超过该期限；到达期限后不得继续延长，原 expiresAt + grace 到达后由 sweep 回收（有 intent → interrupted，无 → ready）。默认无进展最多 3 个 TTL，宽限不提供额外续期额度。
- claim/grant 初始化 progressAt；成功 begin/submit 等既有真实进展重置 progressAt 和显式 renewCount。普通读取既不记录活性，也不重置进展或消耗续租次数。显式 renew 与可信生命周期活动均受绝对无进展期限约束。
- 只有“可回收”（detached / epoch 变了 / 超过宽限 / lastSeen 太旧）才写 `lease/expired` + `task/interrupted|readied`；回收后旧 token/epoch 的 renew/touch 不得复活。
- 回收先于命令计算：通过校验的写命令先在工作投影上应用可回收 lease 的回收，再基于回收后的状态计算自身事件；回收事件排在前面，与业务事件、token 变化同一 commit。命令被拒（含后续 choice 或证据审计失败）时回收整体丢弃，不写日志，state/lease/token 不变。实体 `expectedRev` 仍按已提交的 rev 校验。
- 回收的恢复路径只有 `task.interrupt` / `task.reconcile`：lease 可回收且有 open intent 时，持有原 lease 的 session（binding 未 detached、epoch 未变）带原 fencing token 可一次完成；`interrupt` 只写 `lease/expired` + 一条 `task/interrupted`，open intent 留待 reconcile 明确结算；human 的 interrupt/reconcile 同样适用。begin/submit/release/renew 仍以 `lease-expired` 拒绝；旧 token、其他 session、epoch 已变或 detached 都不能恢复，也不能终止新 lease。
- 租约到期结果由传入时间及已接受的运行时事实派生。普通查询（含管理视图、知识工具、HTTP、Prompt）不得建立 binding、延长租约或调用 touch。显式 `task.renew` 校验会话、epoch、fencing、资格与次数，成功仅更新运行时；可信生命周期活动只能影响自身有效 binding。readOnly、closed、archived 或失效的 binding 不得续期。

### 1.3 计划模型

**publish**

- 至少 1 个 step（step 可为空）；每个 task 至少 1 条 acceptance。
- `key` 在 plan 内唯一；deps 必须存在；deps 无环。
- 无 deps 的 task 直接 `ready`，有 deps 的 `backlog`。
- 同一 commit：`plan/published` + 每个 `task/created`；project 不存在则先 `project/created`。
- 生成的 task id：`tsk_` + ULID；plan id：`pln_` + ULID。

**计划 head 与不可变版本**

- 一个项目可有多个计划；`planHeads[id]` 保存 status/rev/currentVersion，版本表仍按 `id@version` 不可变。
- draft 存在 head.draft，不占版本号；publish 物化为 version 1 并原子建任务；active revise 产生 version+1。
- 归档要求计划内无 in_progress 且无 live lease；archived 计划的任务拒绝 claim；focus 指向 archived 时清空。
- `plan.adopt` / `plan.release` 都产生 version+1；adopt 接受 planRef=null 或指向本计划旧版本（orphaned）的任务，release 把 planRef 置空；跨计划移动走 release → adopt。
- 计划标题项目内唯一（含 archived）；计划不删除。
- `task.create` 不接受 planRef：成员关系只能通过计划版本变化（publish/revise/adopt/release）。
- 发布、修订、归位或任务依赖编辑不得在当前计划版本内新增任何连接同阶段任务的直接或间接依赖路径。阶段成员以版本的 steps 为准。已有路径可以保留或解除，解除后不得重建。修订和归位可把有先后关系的任务拆到不同阶段。
- agent 优先推进当前阶段的可执行任务并逐项提交，之后集中独立审查。同阶段未全部提交时可先处理阻塞，包括存量依赖需要先验收的任务。阶段提示不改变领取资格或单任务验收规则。
- 并发：head 级命令用 expectedRev，版本级命令用 baseVersion；focus 不强制提供 projectRev，若提供则沿用命令总线 CAS（旧值仍 stale-revision），重复聚焦在前置通过后无事件。

`focusPlanId` 是 human 的关注偏好，不限制项目只能有一个 active 计划。`plan.unarchive` 恢复 archivedFrom（draft 或 active）；draft 不建任务、不计进度；计划外任务与 orphaned 任务均合法。

`steps` 形状：

~~~js
[{
  id: 's1', title: '阶段一',
  tasks: [{
    key: 't1',                 // plan 内唯一；revise 可改用 taskId
    taskId: 'tsk_...',         // 仅 revise：保留原任务身份
    title: '...',
    description: '...',
    priority: 1,
    weight: 1,
    labels: ['gate:audit'],       // 可选；审计门标签
    requiresAudit: true,    // 可选；第三方审计门
    deps: ['t2'],                 // plan 内 key 或已有 taskId
    acceptance: [{ text: '...', requiredKinds: ['file'] }]
  }]
}]
~~~

`acceptance` 在生成 Task 时分配 `acc_` id；evidence 用 `acceptanceId` 对应。

### 1.4 不变量

下表收拢领域不变量；命令守卫拒绝非法写入，重放验证格式/兼容，health/fsck 只诊断，不修复或自动执行材料。各路径的具体检查范围见相应条款，不宣称每个不变量都在每次读取执行完整 I/O 审计。

| 编号 | 约束 |
|---|---|
| I1 | commit seq 连续，prev/hash 链正确；坏链冷开拒绝，salvage 只读可理解前缀。 |
| I2 | 实体 rev 按已提交变化递增；身份不复用，外置文档 metaRev 与 rev 是同一计数。 |
| I3 | 任务状态属于八状态；跃迁受状态机与守卫限制，不能直接设置 done。 |
| I4 | 每个任务至多一个 live lease；live lease 对应 in_progress，token 只增。 |
| I5 | in_progress 必须有 owner；进程内执行权以运行时 lease 为准，冷开须恢复/对账。 |
| I6 | open intent 必须属于存在的 in_progress/interrupted 任务；work.intentId 必须指向同任务的存在 intent。关闭遵循 §2.2 结算，不能用 unknown 关闭。 |
| I7 | 新 done 必须由显式 verify，verifiedAt 非空且 acceptance 全满足；内容审计或 human 显式漂移处理不证明交付正确。 |
| I8 | ready 的 deps 全部 done；新增未完成前置使 ready 降 backlog。 |
| I9 | 依赖存在、无自依赖、无环；当前计划版本禁止新增同阶段直接或间接依赖路径。 |
| I10 | 内嵌 doc 历史 rev/hash 指向完整内容寻址 blob；外置结构、定位与确认域独立，不因缺 blob 当 inline。 |
| I11 | 发布计划的阶段任务存在，任务归属由对应版本决定；移除任务保留为 orphaned。 |
| I12 | cmdId 幂等；重复命令不再写事件，不重复副作用。 |
| I13 | commit 带 actor；身份由受信入口建立，命令执行角色守卫。 |
| I14 | archived 项目禁止写事件，唯一例外是 unarchive 及其同 commit 恢复。 |
| I15 | 相同 state/sessionId/includeRules 的 digest 逐字节一致，不取当前时间。 |
| I16 | task.planRef 指向存在的 plan@version，且版本阶段含该 task。 |
| I17 | head.currentVersion 指向存在版本；active ≥1，draft 为0；版本快照不作为可写管理面。 |
| I18 | focusPlanId 为空或指向 active 计划；归档清对应 focus。 |
| I19 | 项目内计划标题大小写不敏感唯一，包含 archived；计划不删除。 |
| I20 | 任务最多属于一个计划；同一版本内任务只出现于一个阶段。 |
| I21 | 计划归档前无 in_progress/live lease；进入 in_progress 的路径检查计划未归档，不把它扩大为所有元数据禁写。 |
| I22 | 新 intent 关闭带 status、closeReason/resolution、closedBy、closedAt；治理结算带 stopped+sideEffects，历史不追补。 |
| I23 | agent done 有 pass、匹配 gate、有效历史 taskRev、scopeDigest、active evidence digest/count 与 worker 快照；审计门另校验报告及独立性，历史 human/policy 不追溯。 |

### 1.5 进度与派生量

`progress = { total, done, ready, inProgress, review, blocked, interrupted, canceled, weightTotal, weightDone, percent, verifiedPercent, attention }`。
不存字段；每次 query 计算。

项目 total 是全部任务数（含 canceled）；weightTotal 排除 canceled，正数 weight 按值计，否则按1；weightDone 是 done 权重和，percent=weightDone/weightTotal，分母0时为0。verifiedPercent=带 verifiedAt 的 done 数/done 数，分母0时为0；attention=blocked+interrupted。计划与阶段的 total 排除 canceled，done 只计 done，percent=done/total（0分母为0）；不使用项目的加权公式。不存在可写 progressPercent，也没有“设置进度”命令。

## 2. 对外契约（1b）

<a id="22-命令信封"></a>

### 2.1 命令信封、错误码与 HTTP 映射

~~~js
{
  cmdId: 'cmd_...',              // required, unique; retry-safe
  projectId: 'prj_...',          // optional; handle injects
  actor: {
    kind: 'agent' | 'human' | 'system',
    sessionId?: string,
    agentId?: string,
    callId?: string,
    via?: 'tool' | 'web' | 'system' | 'mcp'
  },
  expected: {
    projectRev?: number,
    entityRev?: number
  },
  fencingToken?: number,
  op: 'task.claim',              // see 2.2
  ...payload
}
~~~

`CommandResult`：
~~~js
{
  ok: true,
  committed: true,
  deduped: false,
  projectRev: 42,
  entityRev: 3,                  // optional
  events: [{ type, taskId?, rev?, data? }],
  warnings: [{ code: 'relocate-meta-failed', message: '...' }] // optional
}
~~~

执行顺序是项目串行 → `commandStart` 生成稳定身份及值准备操作 → `beginCommand` 核对幂等/CAS 并在私有态准备 → `assembleCommand` 根据一次性只读样本组装值操作 → `submitOperations` 执行、整批校验和派生正式记录 → 单一物理回执后发布。稳定身份不含公开 `op`；模型不解释公开命令、不接收或调用命令回调，命令不传预制事件或后置实体。

新写入的 `committed:true` 表示整笔操作已成功：模型从操作结果派生的事实同批持久化，JSONL 已追加、同步并核对回执，才发布对应状态。任一操作被拒，项目版本、原有租约和权威日志均保持原值；诊断不写成已提交事实。字段值必须能按 JSON 原样保存，非有限数字返回 `invalid-command`。`project.relocate` 已提交后的 meta/registry 写失败只产生 `warnings`，重开从日志自愈；快照写失败不影响提交。

append/write/fsync 异常时，仅在仍持锁、文件 identity 相同、尾部大小在本次追加范围且字节匹配本次行前缀时，截断到已知原大小并 fsync；恢复确认后抛原错误，同一 `cmdId` 可重新提交。恢复失败、陌生尾/锁接管或 close 异常返回 `log-write-uncertain`（details 含原错误、恢复错误与 phase），当前 store/handle 降为只读，不能继续写或声称确定未提交。冷开以实际日志为准：经完整 version/seq/hash 校验的 JSON 尾记录即使缺少 LF 也保留并回放，使该 `cmdId` 去重；不可解析的乱码半尾才丢弃。可写打开在仍持锁时先原子写入并 fsync 经验证的完整 JSONL、确认分隔和锁后才返回可追加句柄；规范化写入/sync/rename 失败则关闭 open 并 fail-closed。只读打开不写入尾分隔、不修复日志。此窗口内可能存在完整或半行，不能把 I/O 错误等同于确定未落盘。锁为合作式协议，不声称可原子阻挡无视锁的外部 OS 写者。

重复 `cmdId`：返回 `{ ok:true, committed:true, deduped:true, projectRev: current, events: [] }`，绝不重复写。

失败：抛 `BoardError`。

#### 错误码

~~~js
export class BoardError extends Error {
  constructor(code, message, { status = 409, details = null } = {})
  code; status; details;
}
~~~

可用 code/status：

| code | status | 触发 |
|---|---|---|
| stale-revision | 409 | expected 不匹配 |
| illegal-transition | 409 | 状态机不允许 |
| lease-held | 409 | 别人持有 lease |
| lease-expired | 409 | lease 过期 |
| fencing-stale | 409 | token 不是当前 lease |
| dependency-unmet | 409 | deps 未 done |
| plan-stage-dependency | 409 | 写入会引入同阶段任务间的直接或间接依赖。details 含 planId、stepId、taskId、dependencyId，发布时 planId 为 null，任务用计划内 key 表示 |
| acceptance-unmet | 422 | 验收未满足 |
| missing-evidence | 422 | 没有合格 evidence |
| evidence-drift | 409 | verify/submit/reconcile 时 file/doc 内容漂移或不可读；不包含命令执行结论 |
| audit-scope-locked | 409 | plan.revise 试图改变 agent 已验收任务的实质验收范围；先由 human reopen，再返工重提 |
| verification-required | 403 | 需要获授权的显式验收 |
| forbidden-role | 403 | 角色不允许 |
| project-inactive | 409 | paused/archived |
| log-busy | 503 | 同一进程里第二次打开同一项目日志（插件重载） |
| log-forked | 503 | 写入前发现日志尾被别人追加过，拒绝分叉 |
| log-write-uncertain | 503 | 日志追加恢复、关闭、物理回执或发布结果无法确认；封闭写者，冷开核对实际日志及 `cmdId`，不猜测成功或失败 |
| not-found | 404 | 实体不存在 |
| already-exists | 409 | 重复创建 |
| plan-not-found | 404 | 计划不存在 |
| plan-title-taken | 409 | 计划标题重复 |
| plan-not-draft | 409 | 需要 draft 状态 |
| plan-not-active | 409 | 需要 active 状态 |
| plan-archived | 409 | 计划已归档 |
| plan-has-live-work | 409 | 归档时存在 in_progress / live lease |
| plan-task-in-use | 409 | 任务已属于其他计划 |
| plan-step-not-found | 400 | adopt 的目标 step 不存在 |
| plan-task-in-progress | 409 | adopt/release 的任务正在执行 |
| incompatible-event | 409 | 日志含本版本无法理解的事件（fail-closed）；details = projectId/seq/type/compatibility/hint |
| intent-unresolved | 409 | 关闭 open intent 时缺 `intent.outcome=stopped` + sideEffects，或声明 unknown；应改用 task.interrupt |
| project-archived | 409 | archived 项目上的非 unarchive 写 |
| project-has-live-work | 409 | 归档时存在 in_progress / live lease / open intent |
| hash-chain-broken | 503 | 日志 JSON/seq/prev/hash/events 损坏；冷开 details 含 validSeq、validHash、line（物理行）、reason |
| unsupported-version | 409 | 不支持的 commit.v；冷开含同样前缀定位及 found、supported，不自动修复 |
| read-only | 503 | 锁被其他进程持有 |
| invalid-command | 400 | 参数/op 非法 |
| binding-required | 409 | 目录带项目标记但本机未绑定（移动/复制）；须显式 relocate/bind/fork，不自动建项目 |
| board-data-missing | 409 | 标记或绑定指向本机没有看板数据的项目；须显式 import |
| identity-conflict | 409 | 绑定/标记对同一目录的归属不一致，或目标已被绑定；不静默择一 |
| invalid-project-marker | 400 | `.dsh-project.json` 畸形/未知 schema/多余字段/非普通文件 |
| bindings-unreadable / bindings-unsupported | 503 | 本机绑定注册表损坏或版本未知；已有项目按 meta 兼容可读，身份写入拒绝 |
| bindings-locked | 503 | 注册表锁被占用或陈旧；不自动删锁 |
| invalid-external-doc | 400 | 外置记录/locator 或兼容 inline 结构非法、快照文档与其 seq/hash 对应日志投影不一致；回放与快照载入同码失败，不跳过、不将外置伪装按 inline 解释（见 docs/modules/documents/contract.md） |
| missing-binding | 409 | 外置文档指定的 bindingId 不是本项目 active 绑定。审计历史 fixed 时降 warning（不可观测），不回退到其他绑定/worktree |
| external-doc-operation-required | 409 | 旧 doc.put/doc.link、inline doc 视图或无 fixed 的 doc 证据触及 source=external 记录 |
| invalid-workspace-version | 400/503 | 留存版本结构/身份/序不合法，或 locator 与登记不符；快照留存投影与日志不一致按 503 |
| content-object-missing | 404 | 留存正文对象不存在 |
| content-object-corrupt | 503 | 对象字节/长度与内容地址不符，或读取期间被替换 |
| history-capacity | 409 | 留存对象超出每项目预算或对象数上限；不清历史、不自动淘汰 |
| write-capability-unavailable | 503 | 文件系统无法以 no-replace 方式发布不可变对象，不降级覆盖 |
| space-home-unavailable | 409 | 没有获准的所属工作区，或该根在请求期间改变；不退回集中布局 |
| locator-already-registered | 409 | 所属工作区的同一文件已有活动登记 |
| inline-write-disabled | 409 | 内嵌写入默认禁用（新建、既有编辑与 doc.link）；迁移后档案永远只读。仅 human 的 doc.inline_policy 可按项目恢复未迁移文档的旧写语义 |
| invalid-fixed-reference | 400 | 兼容 Git 固定引用的结构、版本、项目身份或 OID/path 非法；历史同提交屏障无效也拒绝，不降级为 docId@rev |
| file-missing / root-unavailable / permission-denied / outside-root / security-rejected / not-regular / oversize / undecodable / unsupported-format / unstable | 404/503/403/403/403/400/413/400/400/409 | 外置文档 register/relocate/confirm 读取失败（D1 §6.2） |

旧 Git 固定记录只审可验证的结构和记录身份，正文不可得时给非阻断 warning。不访问 Git 对象，不声称重新核验；结构或记录身份错误仍属硬错误。

### 2.2 命令清单

所有 task 命令的 payload 都含 `taskId`（除 create），修改已有实体的命令必须带 `expected.entityRev`。

`task.create/update/gate` 与 `plan.create/publish/revise` 的顶层字段，以及计划 step/task 定义使用字段白名单；未知字段返回 `invalid-command`（400），不静默丢弃调用意图。上述路径中显式提供的 `requiresAudit` 必须是 boolean；保留命名空间 `gate:*` 只允许 `gate:audit`，其他门标签返回同码。草稿写入前校验，publish 时重新校验已存草稿；不是对全部命令施加全局字段白名单，也不识别旧门别名。这些输入校验不增加使用者配置或人工技术批准。

| op | payload | 说明 |
|---|---|---|
| project.update | name?, phase?, policy? | human/system；→ archived 前要求无 in_progress/live lease/open intent（`project-has-live-work`）；archived 上只允许 phase=active/paused（unarchive，可同带 name/policy），其余写 `project-archived`；unarchive 同 commit 携带恢复事件；`policy.verification` 只接受 `manual`，写 `auto` → `invalid-command`（旧 auto 数据只读不改） |
| plan.publish | planId + expectedRev（发布草稿）；或无 planId 时 title, goal?, assumptions?, risks?, steps（旧式 create+publish；项目已有计划时创建第二个计划） | 原子创建 plan + tasks；无 focus 时自动聚焦 |
| plan.revise | planId, expectedRev（draft）/ baseVersion（active）, title?, goal?, assumptions?, risks?, steps | draft 只改 head.draft；active 产生 version+1；移除的任务标 orphaned |
| task.create | title, description?, acceptance, priority?, weight?, labels?, requiresAudit?, deps? | 独立任务；requiresAudit=true 或 labels 含 gate:audit 时开启第三方审计门 |
| task.update | title?, description?, priority?, weight?, acceptance?, labels?, requiresAudit?, deps?, reason? | 元数据编辑。backlog/ready 无租约也可改（agent 重排队列不用先认领）；in_progress/review/blocked 仍要租约。deps 走校验（未知 id / 自依赖 / 成环 → 400），加未完成前置会把 ready 降回 backlog。requiresAudit 仍是 agent 只能开不能关。每次实际改动追加 `task/meta-edited {by, fields[], reason, at}` |
| task.gate | taskId, requiresAudit | 只切审计开关；agent 只能在非 review 开门，human 可开关；不需要租约 |
| task.ready | — | backlog → ready |
| task.claim | — | 拿 lease → in_progress |
| task.begin | summary, plannedSteps?, expectedArtifacts? | 写 open intent |
| task.renew | — | 显式续租（owner；内存态不写 commit；宽限期内/已过期可续；默认最多 2 次无进展） |
| task.submit | note?, evidence | 关 intent → review；先做一次内容审计（内容 hard 409，不可观测 warning 随结果返回）；同 identity 的新证据退休旧行（见 §2.4） |
| task.verify | audit?, note?, reason?, acknowledgeDrift?, refreshDrift? | review → done（human、普通任务的任意授权 agent，或审计门的独立 agent）；漂移参数仅 human；`refreshDrift:true` + `reason` 重算 file 漂移并退休旧行；`acknowledgeDrift:true` + `reason` 豁免剩余漂移 |
| task.reject | reason, audit?, unassign?（仅 human）, intent?（仅遗留 intent 防御用） | review → in_progress/ready；有 live lease 时非 human 校验 token |
| task.block | code, note, intent? | → blocked；有 open intent 时必须 `intent.outcome=stopped` + sideEffects |
| task.interrupt | note, sideEffects? | in_progress → interrupted（保留 open intent）；遗留异常状态仅 human |
| task.unblock | note? | blocked → in_progress/ready/review（见 §1.2）；有 open intent 时拒绝，不重建 intent |
| task.release | note?, intent? | in_progress → ready；有 open intent 时必须 `stopped` |
| task.reconcile | choice, note, evidence? | interrupted → in_progress/review/ready；写 resolution=redo/applied/discarded |
| task.cancel | reason, intent? | 非终态 → canceled；有 live lease 时非 human 校验 token；有 open intent 时必须 `stopped` |
| task.reopen | reason | done/canceled → ready（human） |
| doc.put | docId?, title, kind, body, baseRev?, links? | 创建/更新 |
| doc.link | docId, links | 只改 links；目标为 external 时拒绝 external-doc-operation-required（doc.put 同） |
| doc.external.register | title, kind?, bindingId?, relPath, links?, purpose?, scope?, supersedes? | 登记外置文档（不写 blob、不碰文件）；返回 docId |
| doc.external.update_meta | docId, expectedMetaRev, title?, kind?, links?, status?, reason?, purpose?, scope?, supersedes? | 职责元数据与管理状态（archived→draft 须 reason）；不写正文、不确认正文 |
| doc.external.relocate | docId, expectedMetaRev, bindingId?, relPath? | 单文档显式重定位；需重新确认 |
| doc.external.rebind | fromBindingId, toBindingId, expected.projectRev | human/system；批量换绑定，relPath 不变 |
| doc.external.confirm | docId, expectedMetaRev, expectedContentHash | 服务端重新完整读取后写确认基线；内容变化 stale-revision |
| doc.external.unregister | docId, expectedMetaRev, reason? | 墓碑；不删文件、保留历史与关联 |
| doc.workspace_capture | docId | 读取当前登记文件原始字节并追加一次已观测正文版本；不改文档元数据/确认基线；同内容同定位不重复追加。`document.retainVersion` 是内部模型操作，不由端调用 |
| doc.relation.add | from, to, expectedRev, replacesId? | 在授权空间内精确关联文档版本；可替代同一来源的活动关系，不改任务/证据状态或当前 links |
| doc.relation.remove | relationId, expectedRev | 追加关闭记录，已记录的版本和关联仍可查 |
| session.checkpoint | note, nextActions? | 会话交接审计 |
| session.handoff | note, nextActions? | 同上 |
| project.relocate | workspacePath | human/system；退役旧主绑定并新建主绑定（不原地改指），保留 id/历史；目标已被他项目绑定→`already-exists`，带他项目标记→`identity-conflict` |
| override | taskId, toState, reason, intent? | human 强制；有 open intent 时必须 `stopped`；审计 |

#### 2.2.1 Intent 结算（RFC-3）

关闭 open intent 的治理命令（block/release/cancel/override，以及 reject 的遗留防御路径）必须带：

```json
{
  "intent": {
    "outcome": "stopped",
    "sideEffects": [
      { "kind": "file|command|network|other", "ref": "非空字符串", "note": "可选", "hash": "可选 sha256" }
    ],
    "note": "可选，结算说明"
  }
}
```

- `outcome` 只接受 `stopped|unknown`；`unknown` 一律拒绝（`intent-unresolved`），应改用 `task.interrupt`。
- `sideEffects` 必填（可为 `[]`，表示已确认没有已知副作用）；最多 50 条、序列化后 ≤16 KiB；这是声明，不是宿主验证。
- 没有 open intent 却传 `intent` → `invalid-command`。
- `abandoned` 只表示“这次尝试停止”，不表示没有副作用或已回滚；事件必须带 `closeReason`、`outcome`、`sideEffects`、`closedBy`、`closedAt`。
- `task.interrupt` 不关闭 intent：任务转 `interrupted`，open intent 保留，由 `task.reconcile` 收口。

#### 2.2.2 Archived 写闸（RFC-3）

- archived 项目上唯一允许的写：`project.update` 且 `phase ∈ {active, paused}`（unarchive，可同带 name/policy）。
- 其余 mutating op（task/plan/doc/project.relocate/session checkpoint/override）在 entry 阶段返回 `project-archived`；`_appendEvents` 再做一次出口兜底。
- `attach`/`detach` 在 archived 上只更新内存 binding，不落事件；`recover`/`expire` 跳过，不追加事件。
- unarchive 的同一 commit 先写 `project/updated`，再对每个 in_progress 写 `task/interrupted`（有 open intent）或 `task/readied`（无 open intent）；随后由人 reconcile。
- unarchive 判定必须看**更新前** phase：只有 archived → active/paused 才恢复并清租约；active → paused / active → active 保留 owner 与 lease。
- 旧 archived 数据（已有 in_progress/open intent）打开只告警，不自动改写；unarchive 时恢复。

#### 2.2.3 Plan v2 命令

一个项目可有多个计划；计划是 initiative 级容器（draft/active/archived + focusPlanId），任务是唯一工作单元，最多属于一个计划。以下命令按 [计划模块](<modules/plan/contract.md>) 冻结的设计实现，全部走 `handle.command`；迁移核对入口见 [MIGRATION.md](<operations/MIGRATION.md>)。

| op | payload | 说明 |
|---|---|---|
| plan.create | title, goal?, assumptions?, risks?, steps? | 创建 draft，不建任务 |
| plan.revise | planId, expectedRev?（draft）/ baseVersion?（active）, title?, goal?, assumptions?, risks?, steps | draft 改 head.draft；active 产生 version+1 |
| plan.publish | planId, expectedRev | draft → active，原子创建任务；不带 planId 的旧 publish = create + publish |
| plan.rename | planId, expectedRev, title | 只改 head.title，不产生版本；标题唯一 |
| plan.archive | planId, expectedRev | → archived；无 in_progress / live lease；清 focus |
| plan.unarchive | planId, expectedRev | 回到 archivedFrom（draft/active） |
| plan.focus | planId \| null | human-only；写 project.focusPlanId（不强制提供 projectRev；提供则走命令总线 CAS，旧值仍 stale-revision；重复聚焦无事件） |
| plan.adopt | planId, baseVersion, taskIds, stepId | 把计划外/孤儿任务加入 step；version+1 |
| plan.release | planId, baseVersion, taskIds | 把任务移出计划；version+1；任务保留 |

| op | payload | 说明 |
|---|---|---|
| doc.external.migrate | sourceDocId, sourceRev, sourceHash, locator, authorized:true, backup | human/system；检查一致性备份、历史 blob、目标等字节身份，保持 docId 转 external；精确同映射幂等，不覆盖文件 |
| doc.inline_policy | authorized:true, expected.projectRev, disabled | 严格 human；显式启停未迁移内嵌写入，不改变迁移档案只读性 |

<a id="25-query"></a>

### 2.3 Query 与视图

#### 服务与句柄

`ProjectService`（`service.js`：项目注册表、handle 复用）：

~~~js
export class ProjectService {
  constructor({ rootDir, clock, idgen, storeFactory } = {})
  async init()                          // scan rootDir/projects/*/meta.json
  async close()
  listProjects()                        // ProjectSummary[]
  async openByWorkspace(workspacePath)  // ProjectHandle | null
  async open(projectId)                 // ProjectHandle (throws not-found)
  async createProject({ workspacePath, name, actor }) // ProjectHandle
  async command(projectId, cmd)         // convenience: open + handle.command
  // 无 query 便捷方法：读查询先 open(projectId)，再 handle.query(view, params)
}
~~~

`ProjectHandle`（`handle.js`：命令总线、读模型、会话生命周期；
`service.js` re-export 它，旧的 `import { ProjectHandle } from '.../service.js'` 仍可用）：

~~~js
export class ProjectHandle {
  get id()                              // 'prj_...'
  get workspacePath()
  get name()
  get rev()                             // last commit seq
  get readOnly()
  async command(cmd)                    // CommandResult
  query(view, params)                   // QueryResult (sync)
  async attach({ sessionId, agentId, source, role }) // Binding
  async detach(sessionId, reason)       // void; releases leases
  touch(sessionId)                      // void; updates binding lastSeenAt and extends live/grace leases
  digest(sessionId, options)            // string (bounded); options.includeRules
  health()                              // Health
  async refresh()                       // re-read tail if file changed
}
~~~

`ProjectSummary`：
~~~js
{ id, name, workspacePath, phase, rev, counts: {total, ready, inProgress, review, done, blocked, interrupted}, lastAt, readOnly }
~~~

#### 查询

`handle.query(view, params)`：

| view | params | 返回 |
|---|---|---|
| brief | sessionId? | `{project, plans: {active, draft, archived, focusPlanId}, counts, session, focus, attention, next, stageWork, health, rev}` |
| board | sessionId? | `{project, plan, focusPlanId, plans: PlanSummary[]（仅 active）, columns, attention, readyOrder, counts, rev}` |
| task | taskId, sessionId? | `{task, acceptance, evidence, timeline, plan, allowedOps, rev}` |
| plan | planId? | `{plan, head, steps, progress, rev}`；不带 planId 返回 focus；未知 planId 返回 `{plan:null}`（不抛错） |
| plans | includeArchived? | `{plans: PlanSummary[], focusPlanId, rev}`；默认含 archived，传 `false` 只留 active + draft |
| docs | query? | `{docs, rev}` |
| doc | docId, maxBytes? | `{doc, body, truncated, rev}` |
| events | after?, limit? | `{events, rev}` |
| health | — | `Health` |

`columns`：`{backlog:[Card], ready:[], in_progress:[], review:[], done:[]}`。
`attention`：`{blocked:[Card], interrupted:[Card]}`。

`Card`：
~~~js
{ id, title, state, rev, priority, labels, requiresAudit, lastAudit, planRef, owner, acceptance: { total, met }, evidenceCount, blocked, updatedAt,
  deps: string[], intent: { summary, startedAt } | null, verifiedAt, verifiedBy }
~~~

- `deps` 是任务的前置任务 ID，缺失时为 `[]`。`PlanSummary.steps` 包含 `{id, title, taskIds}`，`taskIds` 按已发布版本的步骤成员顺序投影，草案摘要为 `[]`。
- `intent` 仅投影进行中任务的开放执行意图，包含最多 160 个 UTF-16 单元的单行摘要与开始时间（缺失时为 `null`）。会话身份继续取 `owner`。board 的进行中卡片另外携带 `leaseExpiresAt` 和 `leaseExpired`，由读取时的运行时租约与服务端时钟得出。无可观测的到期时间时两项均为 `null`。
- `verifiedAt`、`verifiedBy` 来自任务的实际验收记录，缺失时为 `null`。`human` 表示人工验收，`agent` 表示 AI 验收（`lastAudit.gate:false`）或 AI 审计（`lastAudit.gate:true`），`policy` 表示历史自动验收。
- `readyOrder` 是全部 ready 任务 ID，复用 brief 的派发排序（priority 升序，同优先级按 createdAt 升序）。brief 仍只返回前三项，board 列仍按原有顺序展示。

`stageWork` 取当前任务所属的活动计划，无当前任务时取焦点计划。在其当前版本中，按 steps 顺序取首个仍有非终态任务的阶段。无匹配阶段时为 `null`。它包含 `planId`、`stepId`、`title`、`mode`、`remainingCount`、`readyCount`、`reviewCount`、`readyTaskIds`、`reviewTaskIds`。剩余量不计已提交 review 的任务和终态任务，两组 ID 各取最多五项。尚有 ready 或 in_progress 时为 `implement`，所有非终态任务均到 review 时为 `audit`，其余为 `waiting`。

`TaskView` = 完整 Task + `allowedOps: [{op, enabled, reason?}]`。

`allowedOps` 规则：

- `claim` 使用与命令共用的资格判定：项目 active、计划未归档、到期投影中的 ready、无有效租约、依赖已完成且项目/会话 WIP 有余量（human 不受会话上限）。读取只预览回收，提交仍独立校验 committed entityRev。
- in_progress + lease 属于该 session → `begin`（无 open intent）、`submit`、`release`、`block`
- review → `verify`（human、普通任务的任意授权 agent，或审计门的独立 agent）、`reject`（任意 agent/human，无 live lease 或为持有者）；第三方 agent 无租约不能 block
- blocked → `unblock`
- interrupted → `reconcile`
- done/canceled → `reopen`（human）
- 非终态 → `cancel`
- 人类可以 `override`

#### Health / fsck 只读诊断

- `checkState` 与 `health` 不修改输入状态、不修数据、不追加事件、不执行 evidence 命令；兼容性 plan head 派生只发生在私有投影。
- I6：每个 open intent 必须对应存在的任务，且任务状态只允许 `in_progress|interrupted`。`task.work.intentId` 存在时必须指向存在且属于同一任务的 intent。诊断的检查名/详情定位 taskId、intentId，失败使 `health.ok=false`。
- I6 是单向约束：claim 后尚未 begin、unblock 后没有 open intent，以及指向 closed/abandoned intent 的历史 work 都合法；恢复清空 work 但保留 open intent 也合法。
- owner 只允许出现在 `in_progress`，该状态要求 owner；fsck 不把 owner 的持久 `leaseUntil` 当成运行时租约有效期。
- I22 只校验带 RFC-3 标识字段（`closeReason|closedBy|outcome|sideEffects|settlementNote`）的结算：status 为 closed/abandoned，closeReason/resolution、closedBy.kind、closedAt 完整；治理结算要求 stopped + sideEffects。仅 status/closedAt/resolution 不能区分格式，不追溯缺字段记录；未带上述标识的 submit 结果也属于不可区分范围。
- archived 项目存在 `in_progress`、open intent 或运行时 live lease 均告警。live 以注入时钟下 `expiresAt > now` 判断，到期可续不算 live，既有续租/回收提示保留。独立 `checkState(state)` 无运行时 lease 表，只检查持久状态；health 传入 lease 表与同一次取样的时钟。

brief 只带内存健康摘要，evidence unchecked 不表示完整审计已通过；显式完整 health 使用隔离审计。知识检索/回读是独立只读入口，参数、来源、预算与 coverage 见 §2.7，不作为 command 或普通 query view。

<a id="28-文档"></a>

### 2.4 文档

#### 内嵌、外置与图片只读资源

- `body` ≤ 256 KB；hash = sha256(utf8 body)。
- blob 路径 `blobs/<hash>`；写 tmp + rename。
- blob 先于 baseRev 校验和 commit 写入；确定未提交或确认回滚成功的失败不产生 doc 事件或公开 doc，但可能遗留物理 tmp 或未被事件引用的 hash blob。`log-write-uncertain` 不能保证未提交：合法完整 doc 事件（包括缺 LF 的完整 JSON 尾记录）冷回放后可以公开文档，此时正文已被引用，不是物理孤儿。公开 doc 只来自已提交事件，不通过 blob 目录发现。health/fsck 检查状态与引用，不枚举磁盘物理孤儿；没有自动 blob GC。已提交 doc 的 snapshot/meta 后置失败不撤销其引用，也不能称该正文是孤儿。
- `doc.put` 新文档不需要 baseRev；更新必须 `baseRev === doc.rev`，否则 `stale-revision`（details 带当前 rev/hash）。
- 内嵌写入默认禁用：`doc.put`（新建与更新）与 `doc.link` 在写 blob/事件之前返回 `inline-write-disabled`(409)，store 字节与事件数不变。只有项目 `inlineWritesDisabled === false`（human 用 `doc.inline_policy` 显式开启，事件 `project/updated`）才恢复未迁移内嵌文档的旧写语义；迁移后档案永远只读。新项目创世记录即 `inlineWritesDisabled:true`，缺字段的旧项目按禁用处理。
- HTTP 和工具对 `doc.put/link` 由 core 在获取 writer 前校验形状与可判定的拒绝条件，再由串行命令用最新状态重验。`put` 的 links 在目标类型和策略之前检查，`link` 的 links 在串行阶段通过目标与策略检查后处理。日志回放失败直接报错。工具在成功命令后跟踪项目值；普通业务所需的首次 binding 与业务同批，不在命令前独立 attach/touch。
- 事件只存 `{id, rev, title, kind, hash, size, links, createdAt, updatedAt}`。
- 工作区正文历史：对外命令是 `doc.workspace_capture`（仅 `docId`；服务端读取当前文件并计算 contentHash），内部模型 `document.retainVersion` 只对已登记外置文档追加 `doc/workspace-retained`（applied，一条事件携带完整版本），投影为 `state.workspaceVersions` 与 `counters.workspaceVersionSeq`，不建 journal、不改文档 rev/metaRev/确认基线。原始字节存 `.projectboard/objects/workspace-bytes/<hash 前两位>/<sha256>`：临时文件、flush、读回校验后以 no-replace 链接发布，已有对象逐字节核对复用、绝不覆盖；每项目预算 1 GiB、单对象 16 MiB、对象数上限 65,536，超限返回 `history-capacity` 且不清历史。版本引用为 `{v:1,kind:"workspace-body",projectId,docId,versionId,contentHash}`，versionId 由 `docId~seq~完整SHA-256` 稳定生成。compare 对未留存/未知版本返回 `state:"unavailable", reason:"version-not-retained"`（不透露归属），read_version 对同一情形返回 `not-found`(404)。登记、读取、搜索和比较都不采集；集中布局不新增正文历史。
- 工作区发现是只读、可丢弃的投影，仅原生 owning space 与 MCP full 可调用。`project_doc discover(cursor?)` 流式枚举当前授权根下的 Markdown/文本，不分配 docId、纳管、确认或采集历史。分页区分枚举、实读、缓存复用与索引计数，报告观测时间、排除/失败原因、`partial` 与 `nextCursor`。续扫成功取得的各页用 `coverageGaps` 保留本代已遇到的读取失败、因忽略规则或深度限制而未遍历的子树原因；末页没有游标，不代表早页缺口已补齐。扫描不代表全树在同一时刻的状态。路径/权限必须重新核验，未变化的文件可复用上次格式与元数据观测，不能据此声称正文已复核。`read_current(relPath,maxBytes?)` 与 `refresh_current(relPath)` 只核验指定文件，返回当前内容或当前观测，不以旧缓存补缺。失败的游标不能换根或换凭据续扫；`restart-required` 表示重新开始。规则、硬预算及忽略语义见[文档模块的发现读取](<modules/documents/contract.md#发现与留存>)。后台发现与普通任务命令分离，宿主进程内共用一个扫描执行槽，不因打开工作区而同步全扫。没有 Git 或监听时仍可发现、明确回读及补扫。
- 外置文档（`source: 'external'`）与内嵌同集合，事件 `doc/external-registered|updated|relocated|unregistered|confirmed`，不存正文；冷开对整条日志（含快照覆盖段）做文档结构扫描；`query('docs')`/任务 `linkedDocs` 的行带 `source`（`inline`/`external`），外置行没有 `hash`/`size`；语义、工具/HTTP 表面、观测与回退见 [文档模块](<modules/documents/contract.md>)。
- 文档内图片只读：外置文档正文引用的图片按该文档所在目录解析，经 `GET /projects/:id/docs/external/:docId/assets?path=<相对路径>` 读取原始字节；只接受 `.png`/`.jpg`/`.jpeg`/`.webp`/`.gif`/`.svg`，单文件 ≤ 4 MiB，与文档读同一鉴权；通过统一只读端口读取发布态或锁外回放，不调用 open、不获取 writer、不写事件或快照、不恢复在途工作，也不发起命令或写观测缓存，响应 `Cache-Control: no-store`。`path` 必须是相对路径：拒绝反斜杠、盘符、控制字符、空段与绝对路径（`security-rejected` 403）；允许 `..` 段，但按文档目录规范化后必须仍在该文档的 binding 根内，越界为 `outside-root` 403。缺文件 404、非普通文件 400、超限 413、非白名单扩展名 `unsupported-format` 415、binding 根不可用 503、活动绑定无法确认或退役为 `missing-binding` 409（读取与交付前都复核）；内嵌文档没有图片资源（404）。只允许正文中以独占一行图片语法引用的路径；未引用（含围栏代码块内的同形文本）按 `not-found`(404) 拒绝，不透露文件是否存在。客户端只把相对 `src` 渲染为图片，`http(s)`、`data:` 与绝对路径按文本处理，不发起请求。
- 当前关联是外置/内嵌记录的 `links.taskIds`、`links.planRefs`；它不是正文版本引用，移除它不改历史。文档职责为 `kind`、可选用途 `purpose` 和适用范围 `scope`（各 512 字符内）、显式的 `supersedes`（最多 50 个已存在、互异、非自身的文档 ID，无循环）。职责与管理 `status`、观测和确认基线分列；相似度或模型线索不写替代事实。
- 精确关联只在获准工作区内通过显式 `doc.relation.add/remove` 写。`from={kind:'task'|'plan'|'evidence'|'audit', id, seq, event}` 指日志序号和零基事件序号；证据/审查由所属任务版本定位。`expectedRev` 比较所属任务或计划头的**当前**修订，用于防止过期写入，不替换选定的历史来源。目标 `to` 只能是 `{kind:'workspace-current',docId}`、`{kind:'workspace-body',docId,versionId}`、`{kind:'inline',docId,rev}` 或只读回放 `{kind:'git-fixed',docId,fixed}`（已记录的固定证据）。新关系不创建 Git 目标；外置 `@rev` 仍是元数据，不是正文。
- 选当前正文时，关联动作读取和留存实际字节，正文留存事件与关联事件在同一日志提交内生效；保存对象失败或正文暂不可留存时回 `relationState:'current-only'` 与原因，不添加精确关系，不自动改变当前链接。权限/修订冲突明确拒绝。已有版本核验后只记引用；重复的活动关联不创建第二条事实。替代或关闭只追加记录，既有证据、审查、任务状态、正文确认与引用不随之改写。
- `doc/relation-added`、`doc/relation-closed` 为 applied；历史双向视图只派生自日志。采用的快照必须与日志中的关系和项目原始来源身份一致；内嵌版本绑定原字节 hash，拒绝同版本异 hash。不把旧链接提升为快照。通用知识只在有界上下文内逐来源校验并投影明确的精确关系，不公开这些原始关系事件。读取工作区正文按保存版本的原始来源、当前权限校验，不以现行登记或路径代替；查询不写事实。历史对象缺失或损坏如实标记，不回退到当前正文。构建回退遵守 §2.5 的事件兼容规则。
- `doc/content-fixed` 是历史 applied 事件；继续校验原有引用与同提交屏障，不写新 Git 事实，不读 Git 字节。
- `doc get` 读 blob；hash 不符 → `hash-chain-broken`。

外置登记身份为 docId，定位为 `{bindingId,relPath}`，rev=metaRev；管理状态 draft/in_review/adopted/archived 与 availability、confirmation 分列；兼容 Git 字段仅说明没有核验。主线 draft→in_review→adopted，可退回上一评审态；任意非归档态可归档，archived→draft 须 reason。内容变化/读取/确认不自动改管理状态。

正文完整读取 ≤16 MiB，严格 UTF-8，预览 ≤256 KiB，在字符边界截断并带 truncated/totalBytes；原始字节 hash 包含 BOM。locator 拒绝绝对路径、反斜线、空段、`.`/`..`、ADS/设备名等；realpath、普通文件句柄与前后身份复核，不跨 binding 兜底、不冒充原子快照。图片资源采用上文独立路径规则（可规范化 `..`，仍必须在根内）。观测缓存最长30秒，confirm/正式取证不信任缓存，读取失败保留登记；confirm 用预期 metaRev/hash 重读后写基线。

#### 验收项与证据

`evidence` 项：

~~~js
{
  kind: 'file'|'command'|'doc'|'url'|'note'|'test',
  ref: string,
  hash?: string,
  workspaceVersion?: object,    // 留存的 workspace-body 版本引用
  fixed?: object,               // 仅历史 Git 固定记录
  fixedState?: 'pinned'|'current-only', // 兼容字段
  fixedReason?: string,         // current-only 的降级原因
  summary: string,
  acceptanceId?: string,
  supersededAt?: string,       // a later begin supersedes prior-attempt evidence
  supersededBy?: string,
  execution?: object|null      // 历史字段：只回放旧日志；新提交恒为 null，不执行、不签名
}
~~~

- `file`：相对本次开库的工作区根，服务端检查根包含、普通文件及原始字节 SHA-256；所属空间布局不回退到记录的旧路径或其他副本。越界、缺失或 hash 不符拒绝。
- 内嵌 `doc`：ref=`'docId@rev'`；doc 必须存在，submit 时 rev 必须是 head。审计时带 `@rev` 的证据校验**该 rev 的不可变 blob**（content-addressed，重算 sha256）：head 前进不算漂移；blob 丢失/内容不符为 error。省略 `@rev` 时仍按 head hash 比对。
- **外置 `doc`**：调用方只传 `{kind:'doc',ref:docId}`；外置 `@rev` 是元数据，不能指定正文。拒绝自报的 `fixed`、`fixedConfirmed`、`bindingId`。所属空间内成功留存时证据指向 `workspaceVersion`；集中布局或正文不能留存但已安全观测到 hash 时，记录 `current-only` 及原因。审计留存对象核对原始 locator 授权、内容地址和字节，不追当前正文；current-only 重新读当前文件。
- **旧 Git 固定证据**：`fixed` 及来源原样回放，`doc/content-fixed` 的同提交屏障继续校验。`get_fixed` 只查精确已记录身份（`fixed` 或完整 `commitOid` + 已记录 `pathAtCommit`），返回 `legacy-git-record-only`、`reverified:false`、`body:null`；不探测仓库或新建来源。兼容字段/接口计划弃用，不接受新 Git 固定写入。参见[证据模块](<modules/evidence/contract.md>)。
- `command`/`test`：只登记 `ref`（命令文本/测试名）、`summary`、`acceptanceId`。服务端不执行 `ref`、不重跑、不签名、不校验退出码；成功与失败报告同样只是提交者材料，不作为宿主观测。`execution` 只用于回放旧日志，不参与新提交、审计或完成判定。
- `url`/`note`：只登记提交者材料；不执行、不判强弱。
- `begin` 开启新 attempt 时会把旧 evidence 标 `supersededAt/supersededBy`，并把每条 acceptance 的 `met` 重置为「是否有 active evidence」；submit 的 acceptance 覆盖检查只认 active evidence。历史仍保留在任务/事件里。这样返工必须为新 attempt 重提每条 acceptance 的证据。
- **重提即替换**：submit（以及 `task.reconcile(choice=completed)`）里的新证据按 identity 退休同 identity 的 active 旧行，写 `supersededAt/supersededBy`、`supersedeReason='resubmitted'`；退休旧行不重新读取或改写其来源；已留存的历史引用仍保留。identity：`file` = realpath/canonical，`doc` = docId（忽略 `@rev`），`command`/`test` = ref；`url`/`note` 不参与。批量作用域先算旧行再统一标，避免同批新行互相 supersede。若某条 acceptance 因此失去全部 active 证据且本次提交没有补上，整条命令 422（details: acceptanceId/refs/hint），不落盘。审计只看 active evidence。
- **审计只审内容观测**：file 或 current-only 漂移/不可读、内嵌历史或留存对象缺失/损坏为硬错误 `evidence-drift`；旧 Git 正文不可核验为非阻断警告，结构或记录身份错误仍是硬错误。command/test/note/url 不执行，也不因其结论拒绝 submit/verify。human 可显式刷新 file 漂移或按规则豁免。

<a id="29-存储"></a>

### 2.5 存储格式与事件兼容

默认集中布局使用 `rootDir/projects/<projectId>/`。显式 `storageLayout: space` 按宿主确认的物理工作区根选库，不以历史项目 ID 选库；同一日志格式位于 `.projectboard/state/`，留存的正文对象位于 `.projectboard/objects/workspace-bytes/`。未自动迁移集中库；只读查询不创建看板、不拿写锁。两种布局的项目状态 schema 均为 v3。项目目录中的文件：
~~~text
meta.json      {schemaVersion:3, projectId, workspacePath, name, createdAt}（v2 必须离线迁移；见 operations/MIGRATION.md）
commits.jsonl  一行一个 commit
snapshot.json  {v:1, seq, hash, state}
blobs/<sha256>
lock.json      {pid, hostname, nonce, startedAt, heartbeatAt}
lock.json.claim 获取锁的原子目录（owner.json；同机活 pid 不按年龄回收）
lock.json.hb.<nonce> 当前 acquisition 的心跳文件
~~~

commit：
~~~js
{ v:1, seq, prev, hash, at, actor, cmdId, baseRev, events:[...] }
~~~

- `prev` 首条为 `'genesis'`。
- `hash = 'sha256:' + sha256(prev + '\n' + canonicalJSON(commitWithoutHash))`。
- canonicalJSON：递归排序 key；无 undefined；UTF-8。
- 冷开：逐物理行解析并即时校验 version/seq/prev/hash/events 数组，第一处错误带 `validSeq/validHash/line/reason` 拒绝加载；空行不计 commit，但计物理行。顺序为：读取并逐条校验完整日志 → 校验 snapshot 对应 seq/hash 的文档身份与固定索引 → normalize snapshot state → 回放 snapshot+tail（无 snapshot 则全量 replay）→ assertCurrentSchema → 仅 writer 执行 repairLogTail（只读跳过）→ 发布 state。坏 snapshot、回放或 schema 拒绝均不得先修尾。缺 LF 的合法完整 JSON 记录保留，可写打开补 LF；仅不可解析且未终止的最后片段允许丢弃。中段坏 JSON、坏 hash/版本等都不得先改原日志再报错。规范化使用 tmp + fsync + rename 并确认完整 JSONL 后才可追加；无法确认则 fail-closed。`JsonlStore({lock:false})` 对两种尾部均零写；普通可写 open 在校验前可能创建项目/blobs 目录及自身 lock/heartbeat，失败关闭时只清自身锁，不改 meta/snapshot/日志，不生成日志修复 tmp。
- 普通回放、MemoryStore 与快照尾部回放均拒绝未登记事件（`incompatible-event`，见 §2.5），不默默忽略未知类型。离线 salvage 严格检查事件类型（包括当前发出的已知审计 no-op），未知事件所在整个 commit 不纳入前缀；prefix repair 拒绝任何可解析行中的未知事件/不支持版本。salvage 与显式 repair 的操作边界见仓库[运维 CLI §1](<operations/CLI.md#1-开发-cli>)。
- 每 200 commit 写 snapshot（tmp + rename）。
- 锁：获取先原子创建 `lock.json.claim` 目录（`mkdir` + owner.json）；同机 pid 存活时，无论 mtime 多旧都不回收（活进程可能暂停）；同机 dead pid 才能把整个 claim 目录 rename 成 tombstone。rename 后必须复核 tombstone 里的 owner nonce 与被判死的 owner 一致：不一致说明已被其他 contender 替换，立即 rename 回，绝不删除；无 owner 的旧空 claim 也只有 tombstone mtime 仍过期才删除。临界区内读/决定/写 `lock.json`；跨主机不自动接管（需人工 force-unlock）。心跳写 `lock.json.hb.<nonce>`，旧 owner 不能靠心跳覆盖新 owner；append 前复核 `lock.json` 的 pid+nonce。
- `MemoryStore` 用于测试，接口相同。

#### 事件兼容契约（fail-closed）

`lib/shared/events.js` 的 `EVENT_REGISTRY` 是唯一分类表。读到未登记的类型时**拒绝打开**，不做任何猜测。

| 类 | 含义 | 读方行为 |
|---|---|---|
| applied | 本版本理解并投影 | 正常应用 |
| additive | 本版本不需要；同一 commit 的已知事件携带完整状态 | 允许 no-op |
| migration | 语义无法推导，需要显式迁移 | 拒绝，提示迁移 |
| refuse（默认） | 未登记/未知 | 拒绝打开 |

- additive 必须可证明：同一 commit 有携带完整实体的已知事件（`task/updated`、`task/rejected` 等），并有测试覆盖。当前 additive：`task/meta-edited`、`task/assignment`、`session/checkpoint`、`session/handoff`、`lease/expired`、`lease/revoked`。
- 拒绝时抛 `incompatible-event`（409），details = `{projectId, seq, type, compatibility, hint}`；不写状态、不改日志。
- 快照是 writer 的状态快照，不替代日志兼容检查；冷开先检查整个日志的事件类型（含快照覆盖部分），通过后才允许尾部规范化和快照回放。切换代码前保留快照（见 operations/RELEASE.md）。
- 降级规则：日志出现 refuse/migration 事件时只能恢复切换前快照，不能只换代码目录；两种布局的新确认记录也可能缺少旧构建要求的 Git 基线字段，即使没有新事件类型也不保证旧构建可回放。只含 additive 事件不代表字段语义可降级：schema v3 审计门虽不增加事件类型，旧代码可能静默丢门，只能恢复迁移前备份 + 旧构建。

### 2.6 Host 表面

#### 2.6.1 入口

`lib/index.js` 命名导出：

~~~js
export const name = 'project-board'
export const inject = ['tools', 'systemPrompt', 'agents', 'sessions']
export function apply(ctx, config) { ... }
~~~

- 不导出 default（会丢 inject）。
- `config.rootDir` 默认 `~/.dsh/project-board`（优先 `DSH_HOME`）。`config.mcp` 为可选本机 MCP 配置，见 §2.6.7。
- `ctx.get('webServer')` 可选。默认集中布局有网页时注册路由；显式所属空间布局只装配 Agent 入口，不挂载无法绑定可信空间根的 Web 路由。
- `ctx.effect(() => () => service.close(), 'project-board.close')`。

#### 2.6.2 生命周期

`agent/created`（async，必须快且不抛）：

1. `cwd = agent.session?.header?.cwd`；无则返回。
2. 调用独立生命周期 capability `ensureAgentProject`：按工作区发现既有项目，内部打开 writer；不存在则不建项目。发现规则见[项目身份](<modules/project/contract.md>)。
3. 在项目串行位置检查 binding：不存在才首次 attach；已有 binding（包括 detached）不因此旋转 epoch。显式 `handle.attach` 是另行授权的重挂能力。
4. 只记录会话到项目的值引用，并安装动态 Prompt section；Prompt 按项目引用读已发布值，不保存 writer、不冷开项目。

`agent/disposed`：清理值引用、context 与 Prompt，独立 capability 仅复用已打开 writer 解绑各已接触项目。`apply` 时对已有 agent 也执行生命周期挂接。普通工具请求不重复这个独立挂接流程。

#### 2.6.3 工具

7 个，按域在 `lib/host/tools/*.js` 注册（`lib/host/tools.js` 是兼容壳；运行时经
`lib/index.js` → `lib/host/tools/index.js` 注册）：

| 工具 | 关键参数 |
|---|---|
| `project_board` | view: brief/board/task/plan/plans/docs/doc/events/health/tasks/task_overview/work_context/task_detail; taskId?; docId?; planId?; limit?; maxBytes?; fresh?; section?/sections?; offset?; atRev?; evidenceId?; acceptanceId?; kind?; includeSuperseded? |
| `project_plan` | op: create/publish/revise/rename/archive/unarchive/focus/adopt/release; planId?; expectedRev?; baseVersion?; stepId?; taskIds?; title?; goal?; assumptions?; risks?; steps? |
| `project_task` | op: create/update/gate/ready/claim/begin/renew/submit/verify/reject/block/interrupt/unblock/release/reconcile/cancel/reopen; taskId?; expectedRev?; requiresAudit?; audit?; unassign?（human-only）; intent?; sideEffects?; ... |
| `project_doc` | op: get/put/list/link + register/inspect/update_meta/relocate/confirm/unregister/list_external/get_fixed + capture/history/read_version/compare + discover/read_current/refresh_current + relate/unrelate/relations；参数见 §2.2、§2.4 与本节 |
| `project_session` | op: init/checkpoint/handoff/projects/open; name?; note?; nextActions?; projectId?; limit?; after? |
| `search_project_knowledge` | query; kinds?; limit?; cursor?; relatedLimit?; historyRef?; discovery? |
| `read_project_knowledge` | refs; mode?; maxBytes?; cursor?; relatedLimit? |

- `project_doc relate` 透传 `from/to/expectedRev/replacesId?`；`unrelate` 透传 `relationId/expectedRev`。`relations` 只读，须且只能选 `from`、`docId`（可加 `versionId`）、精确 `to` 或 `relationId`。列表支持 `after/limit`，返回 `relations/nextCursor` 且可查已关闭关系；先过滤不可见来源。`relationId` 可附 `maxBytes`；工作区与内嵌版本返回精确正文、版本与截断信息；旧的 `git-fixed` 目标只按记录返回引用，未重新核验、不读 Git。对象不可恢复时给出 `state:'unavailable'` 与原因。三 op 均要求原生的获准工作区或 MCP full 工作区授权；metadata 与旧集中项目不能读写版本关系。
- **双入口一致性**：唯一 `agentTools` 目录同步注册两端，名称、描述、参数 schema、校验、执行、来源/覆盖、分页、模型文本与领域错误相同。所有工具都有共同的可选 context；入口身份与授权差异仅见 §2.6.7。禁止另建独立工具映射或单端业务适配，变更必须通过两侧实际注册、schema 和调用门禁。
- DSH PTC 的 schema 类型渲染只支持结构子集：知识工具把共享 schema 的数值/长度/数量范围机械转换为字段 description；两端使用完全相同的转换结果，范围由共同 core 强制。测试使用固定的真实 DSH SDK 校验 schema、TypeScript/Python SDK、特殊 JSON 值和原始输出，缺依赖不跳过。
- 解析 cwd：`exec.agent.session.header.cwd`；无 agent → 抛错。
- 管理写走统一命令入口；管理读、元数据和知识查询走各自的授权只读端口，不自动打开 writer、创建项目/绑定或续租。
- 知识工具传递 DSH `exec.signal`；取消只结束该次请求，等待 worker 退出并释放全局读取名额，不关闭其他请求或禁用后续读取。取消信号是内部执行选项，不进入业务参数或来源引用；缓存可能已产生可重建进度，取消不构成权威写入或完整读取证明。
- actor：`{kind:'agent', sessionId: exec.agent.id, agentId: exec.agent.id, callId: exec.callId, via:'tool'}`。
- 原生会话的 cwd 尚无项目时，`project_task create`、`project_plan create`、不带 `planId` 的 `project_plan publish` 可以在首笔业务写入中创建项目。若提供项目版本，首写按新项目版本 `1` 校验；成功的创建、首次会话绑定和业务事实在同一条提交中。业务拒绝不创建项目或占用工作区。`project_session init` 是显式创建空项目的入口；MCP 不根据客户端路径建项，普通工具调用仍需先打开已登记项目的 context。
- 工具错误：共同封装 `BoardError` 为带品牌的 `{ok:false,code,message,status,details,next}`；两端保留相同领域信息，MCP 不解析任意异常字符串冒充领域错误。未知内部异常不透传。
- 管理工具使用短文本 renderer，调用卡片为 generic。知识工具执行结果仍是有界结构对象；模型文本按 §2.7 呈现，MCP 机器传输选择见 §2.6.7。
- 工具描述必须写清：先读后写、expectedRev、submit 不带 done；普通任务可由任意授权 agent verify（含提交者）；审计门需独立 agent 带 audit.report，human 始终可验收。

<a id="34-prompt"></a>

#### 2.6.4 Prompt

`lib/host/prompt.js` 提供 `installPrompt(runtime, agent)`（装配期调用，`disposePrompt` 对称清理）：

- 用 `agent.ctx.inject(['systemPrompt'], ...)`。
- section name `project:brief`，order 9000，text 动态：每次按会话项目引用读取已发布值，不取得 writer；没有可用项目时返回空字符串。
- **这是规则块的唯一权威投递点**：digest 的 RULES 段经由这里进入模型上下文；section 每请求重建，压缩后仍然在。
- 同一个 section 的存在也是"该会话已持有规则"的判据：`runtime.promptFibers.has(sessionId)`。host 工具据此决定 `view=brief` 要不要再带 RULES。
- 不注册第二个规则 section；新增或修改规则一律改 `lib/core/digest.js` 的 RULES 块。

##### 2.6.4.1 brief 的去重契约

`project_board view=brief` 的结果是系统提示那段 digest 的**兜底副本**：

| 会话状态 | 传入简报读取器 | 输出 |
|---|---|---|
| `runtime.promptFibers.has(sessionId)` 为真（已挂 section） | `{ includeRules: false }` | 不含 RULES；其余各行与系统提示逐字节同一 |
| 为假（非 agent 会话 / 注入失败 / 无 agent） | 默认 `true` | 完整 digest，规则不能丢 |

- 两条路径都走同一个 digest 投影；`view=brief` 的返回结构（`digest` 字段 + brief 视图字段）不变。
- 本节只负责 RULES 段去重；整段视图的重复投递见 §2.6.4.2。两者都**只允许在生成时去重，不允许事后裁剪**——事后裁剪会让裁剪点之后的 KV cache 全失效。

##### 2.6.4.2 只读视图的同参同文短路

`project_board` 的只读视图（除 `brief`）在同一会话、同一组参数、且**本次渲染结果与上次逐字节相同**时，只回一行：

~~~text
board rev <N> unchanged since <seq> (fresh=true to reprint)
~~~

- 判据是**渲染结果的逐字节比较**，不是 `rev` 相等：租约过期这类只随时间变化的状态不产生事件，用 `rev` 判会漏。
- 记忆只在 host 适配层（`lib/host/tools/board.js`），不进 core；core 的 digest 仍是 `(state, sessionId, includeRules)` 的纯函数。
- `fresh: true` 永远重印全文——压缩可能已经丢掉先前那次输出，agent 需要能拿回来。
- 文本有任何变化（卡片、计数、租约、计划状态）→ 照常全量返回；短路只省重复，不改内容。

#### 2.6.5 HTTP

`lib/host/routes.js` 注册 prefix `/project-board/api`：本文件负责鉴权、body 上限和
按资源分发，具体处理函数在 `lib/host/routes/*.js`（board / tasks / plans / docs /
events / health / projects / commands / shared）。

鉴权：
- 进程启动生成 `token = crypto.randomBytes(24).toString('hex')`。
- `ctx.on('webserver/index-inject', table => table.push({kind:'global', name:'__PROJECT_BOARD__', value:{token, base:'/project-board/api'}}))`。
- 请求必须携带与当前非空 token 匹配的 `x-project-board-token`。
- 来源头分别校验。`Sec-Fetch-Site` 出现时只接受 `same-origin` 或 `none`。`Origin` 非空且不是字符串 `null` 时，要求可解析且 host 与 `Host` 一致。先判断来源，再判断 token，拒绝均返回 403。
- 鉴权通过后，由服务端授予网页写入能力。项目创建、命令与外置文档写入统一从该能力生成 `{kind:'human',via:'web'}`。请求 body、query 和 header 中自报的身份不参与授权。工具按各自受信入口取得身份。
- 不设置 CORS 头。
- body 上限 1 MB。

路由：

| method | path | 说明 |
|---|---|---|
| GET | /ping | 健康 |
| GET | /projects | 列表 |
| POST | /projects | {workspacePath,name} 创建 |
| GET | /projects/:id/board | board |
| GET | /projects/:id/tasks/:taskId | task |
| GET | /projects/:id/plans?includeArchived=0/1 | 计划列表（PlanSummary[]，默认含 archived） |
| GET | /projects/:id/plans/:planId | 计划详情（plan + head + steps + progress） |
| GET | /projects/:id/plans/current | plan（focus 别名，兼容保留） |
| GET | /projects/:id/docs | docs |
| GET | /projects/:id/docs/:docId | doc + body |
| GET | /projects/:id/events?after=&limit= | events |
| GET | /projects/:id/health | health |
| POST | /projects/:id/commands | 命令信封，actor 来自通过鉴权的网页写入能力 |
| GET | /projects/:id/docs/external?includeUnregistered=0/1 | 外置文档登记列表（不读工作区） |
| POST | /projects/:id/docs/external | 登记外置文档；body 为 doc.external.register 参数 |
| GET | /projects/:id/docs/external/:docId?fresh=&preview= | 登记 + 观测；登记存在即 200（文件不可用只填 availability/code） |
| GET | /projects/:id/docs/external/:docId/assets?path= | 文档内图片原始字节；只读、binding 根内、图片白名单、≤ 4 MiB |
| PATCH | /projects/:id/docs/external/:docId | 元数据与状态（doc.external.update_meta） |
| POST | /projects/:id/docs/external/:docId/relocate | 重定位（doc.external.relocate） |
| POST | /projects/:id/docs/external/:docId/confirm | 写确认基线（doc.external.confirm） |
| POST | /projects/:id/docs/external/:docId/unregister | 解除登记墓碑（doc.external.unregister） |
| POST | /projects/:id/docs/external/:docId/fixed | 旧固定记录的兼容读取入口；fixed 或完整 commitOid/pathAtCommit，bindingId?；schemaVersion=1，不生成证据；只查已记录引用，返回 `legacy-git-record-only`，不读 Git、不返回正文 |

外置端点登记在 `lib/shared/contract.js` 的 `API_PATHS`（`docsExternal`、`docsExternalDoc`、`docsExternalAsset`）。外置接口的返回带 `schemaVersion:1`；写入 body 必须是 JSON 对象，字段白名单是 `DOC_EXTERNAL_WRITE_FIELDS` + 信封字段 `cmdId`/`schemaVersion`，未知字段、非 1 的 `schemaVersion`、与 URL 不一致的 `docId` 都在调用命令入口之前以 `invalid-command`(400) 拒绝，因此 400 不会触发冷项目恢复写入。`GET /projects/:id/docs/:docId` 仍只解析内嵌正文，访问外置记录返回 `external-doc-operation-required`(409)；`GET /projects/:id/docs` 两种来源都列，行内 `source` 为 `inline`/`external`，外置行没有 `hash`/`size`。`assets` 是唯一返回非 JSON 的文档端点：成功时响应体是原始字节，`Content-Type` 按扩展名给出（`.svg` 为 `image/svg+xml`），并带 `Content-Length` 与 `Cache-Control: no-store`；失败仍走统一 JSON error envelope。它只读、不登记写入面、不产生事件或证据。

返回：成功 `{ok:true, ...}`；失败 HTTP status + `{ok:false, error:{code,message,details}}`。

task/board/brief 的审计门摘要使用 `audit=1`，最近验收使用 `lastAudit` 与 `by.kind`；agent 的普通通过标为「AI验收（自述）」，审计记录标为「AI审计（自述）」，human 标为「人类验收记录」。UI gate/verify/reject 服从当前 allowedOps；已授权的网页操作使用 human actor。人类在 review 仍可开门，human verify 不要求报告。抽屉展示验收者、时间、报告、清单、证据 digest 和 warnings。

#### 2.6.6 工具返回里的 projectId

所有 `project_board` / `project_task` 返回必须带 `projectId`，供内联卡片使用。

#### 2.6.7 可选本机 MCP

DSH 与 MCP 发布完全相同的七个工具（§2.6.3）：名称、描述、业务参数 schema、校验、执行函数和模型文本渲染都来自唯一的 `agentTools` 注册目录。MCP 只处理传输与凭据，不能自建领域命令、回执或投影。工具默认返回共享 renderer 的模型文本。MCP 知识工具每次只在 `content` 交付一种表示；不附 `structuredContent`。程序调用通过 `_meta:{"project-board/knowledge-output":"json"}` 显式取相同业务对象的单块 JSON 文本。不按协议版本推断用途；未显式请求 JSON 时，结果及失败提示均使用模型文本。此元数据不进入领域参数，也不改变授权。普通写调用沿用 DSH：每次生成新命令 ID，调用 ID 不是幂等键；不确定结果必须先读卡和对账，不能盲重试创建。

`mcp.enabled` 默认关闭，仅自身布尔值 true 启用。端口默认 33109，绑定 IPv4 loopback，每个请求校验本机来源与 Bearer，拒绝跨域；协议与卸载行为两种布局共用。 支持 JSON Streamable HTTP 2025-11-25、2025-06-18、2025-03-26；配置不合法时安全关闭 MCP，不影响原生工具。卸载等待在途操作后关闭资源。

集中布局使用 32 字节小写 hex 的独立环境读票和写票（PROJECT_BOARD_MCP_TOKEN、PROJECT_BOARD_MCP_WRITE_TOKEN），写票还须 mcp.write.enabled=true 及非空 projectIds，不接收空间授权记录。显式 `storageLayout: space` 的双端入口不打开集中库，也不挂载只有历史 ID、没有所属 space 的 Web 路由。空间凭据由维护者在本机使用匹配源码的签发脚本私下生成：grant 放到工作区外的 `mcp.spaceGrants`，只将 token 交给调用方；旧环境票无效。`project_session op=open` 不需要 projectId；若传历史 ID，只能核对所选空间的记录。原生和 MCP 业务参数保持一致，拒绝从参数传入 spaceRoot。

##### 2.6.7.1 共同接口与身份上下文

七个 schema 都带同一个可选 `context` 字段；它只选定项目和已授权逻辑工作会话，不是角色、actor、cwd 或绕过授权的参数。

- `project_session op=projects` 支持 limit/after，读取项目元数据；`op=open projectId` 返回私密 context、projectId、scope 和 expiresAt，不打开 writer。原生 DSH 的 open 可省略 projectId，默认已绑定工作区。
- DSH 普通调用省略 context 时继续使用宿主 owning agent/cwd。提供 context 时必须属于同一 owning agent；不能借 MCP 或其他 agent 的 context 更换审计身份。
- MCP 普通调用必须带 context。每次 open 无既有 context 时创建独立逻辑 agent；携带已有 context 切换项目保留该逻辑 agent。连接/传输会话不能作为 agent 身份，多 agent 共用连接也不混用状态。
- context 有效期 24 小时、进程内有效、最多 2048 个未过期句柄；每次调用重查当前入口权限与项目 allowlist。过期或重启后先读卡，对账未完成意图，再恢复工作。读取凭据不能使用完整凭据的 context。
- 可信宿主的普通写可在命令私有准备中建立首次 worker binding；首次挂接与业务同成同败。显式 grant-only 模式只在 claim 或 reconcile/resume 需要授租时首绑，标 `autoResume:false`，且整批必须实际产生授租；它不是普通业务首绑或 activity 的同义词。管理读取与元数据读取不隐式附着、touch 或回收任务。
- 已存在的 detached binding 保持 detached：普通业务准备、查询和 activity 都不能隐式重挂，也不能向其授租。合法显式 `attach` 可建立新 epoch，随后依正常资格授租；不得要求从未绑定会话或冷读先自证已绑定。已知拒绝／未提交不留下首绑、租约、版本或成功记录；独立生命周期 attach/activity 是自身动作，不与另一次业务的提交结果混算。显式续租及返工、解阻的领域语义对两个 Agent 入口相同。
- 初始化新工作区仍需要可信宿主 cwd；MCP open 仅选择已登记项目。human-only 操作沿用同一个 core 拒绝与人工兜底，不开放角色伪装。
- 原生显式跨项目调用不改变 owning cwd 的系统提示与默认目标，退出时释放所有已接触项目。MCP 完整凭据实例关闭时先拒绝新调用、等待在途请求，再 detach 本实例的工作者、释放租约并废止 context；不影响其他入口或凭据实例，不能自动把返工交给已关闭身份。

##### 2.6.7.2 权限、错误与迁移

读取凭据保留原元数据权限：projects/open，以及 project_board 的 tasks、task_overview、work_context；不能读取证据正文、文件路径或租约令牌。完整凭据可在 allowlist 内调用全部七工具。不同权限使用同一目录，操作准入发生在业务执行和 writer/touch 之前；readOnlyHint 不是鉴权。原生与 MCP 在同一授权业务上下文下返回相同领域错误 `{ok:false,code,message,status,details,next}`。未知内部异常不透传任意异常信息。

旧 MCP 原子工具不再注册或执行。迁移映射：list_projects → project_session projects；open_work_session → project_session open；list_tasks/get_task/get_work_context → project_board tasks/task_overview/work_context；*_task → project_task op=*；manage_plan → project_plan；manage_document → project_doc；checkpoint/handoff_work_session → project_session checkpoint/handoff；get_project_view 的文档扩展操作 → project_doc，其余 → project_board。知识工具名称保留，移除 projectId/sessionToken，改用共同 context。旧 requestId 幂等语义不延续；客户端刷新 tools/list、重开 context，并在重试任何变更前核对已提交状态。此切换不迁移、删除或改写项目数据与事件历史。

##### 2.6.7.3 有界摘要与精读

project_board view=task 和任务写回执渲染使用同一有界文本摘要；附 source 水位、摘要覆盖标记与精读入口。view=task_detail 接收 taskId、section 或 1–3 个唯一 sections（description/acceptance/evidence/audit/timeline/operations/documents/intent），多个部分共用一个响应预算；可以直接读已知目标，无须强制先取摘要。evidence 可按 evidenceId、acceptanceId、kind、includeSuperseded 过滤，默认包含历史证据。timeline 明确只覆盖最近 30 条任务事件。

精读按 UTF-8 字节 offset/maxBytes 分页，默认 8192、上限 24576，最小 4；不拆 UTF-8 字符。返回 source（项目/任务修订）、scope（过滤范围）、coverage（总字节、实际返回、nextOffset、truncated）。续读携带 atRev，任务变动返回 stale-revision，不能拼接不同任务版本。空匹配明确总字节与过滤范围，不伪装为读完全部证据。摘要之后的第二次读取不得隐式扩展计划全文、全部 evidence 或 audit；调用者明确选择 section。完整历史可用知识读取入口。

旧 Git 固定记录的读取在双端使用同一只读兼容实现。已有原生视图的默认值和领域行为由共同 handler 决定，不能在 MCP 再施加不同参数上限、裁剪、错误映射或额外幂等。


#### 浏览器表面

源码在 `src/client/**`；`lib/client.js` 是 `npm run build:client` 生成的**唯一运行时 bundle**
（esbuild 只在开发期跑，产物提交进仓库）。构建外壳：

~~~js
window.__ModuleLoader__.load({
  id: 'dsh-stateboard',
  factory: (require) => {
    const React = require('react')
    ...
    const inject = ['slots', 'layout']
    function apply(ctx) {
      // 4 个 slot：main / sidebar.panellist /
      // conversation.session.header.utilities / tool.call.toolview
    }
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
~~~

- 4 个 slot：`main`（key `project-board`）、`sidebar.panellist`（id `project-board`, order 50, label「项目板」）、
  `conversation.session.header.utilities`（id `project-board-jump`，`inject().onOpen(cwd)`）、
  `tool.call.toolview`（key `project_board`，`inject().openPanel()`）。
- 只 require `react`；不 require ui-primitives，不新增运行时依赖。
- 命令与端点白名单**不**由 client 导出：`COMMAND_OPS` / `API_PATHS` / `TOOL_NAMES` 在
  `lib/shared/contract.js`，`test/client/client-smoke.mjs` 直接 import 共享契约做冻结断言
  （`exports.COMMANDS` / `exports.API_PATHS` 必须为 `undefined`）。
- 样式从 `src/client/styles.css` 幂等注入 `<style data-plugin-css="dsh-project-board/ui.css">`，`.pb-*` 与 `--pb-*` 映射宿主 `--dsw-*` 并有回退，暗色走 `[data-ds-dark-theme]`；支持 hover/focus-visible/container/reduced-motion。
- 禁止 `dangerouslySetInnerHTML` / `innerHTML`；文档正文按纯文本/简单 markdown 渲染
  （标题/列表/代码块/粗体/表格/chart DSL）。
- 唯一 fetch 入口 `src/client/api/transport.ts` 从 `globalThis.__PROJECT_BOARD__` 取 token；常规读取2s轮询，页面隐藏暂停，请求票据阻止迟到响应覆盖；完整 health 独立5s轮询。
- 项目选择：localStorage `projectBoard.lastProject`；列表来自 `GET /projects`；无项目时显示创建表单
  （workspacePath + name）。
- TaskDrawer 动作按钮：claim/begin/submit/block/release/reconcile/verify/reject/cancel，
  以及 gate/reopen/override（按 `allowedOps`）；submit 用简单表单（summary + kind=note + acceptanceId）；
  按钮根据 `allowedOps` 禁用。
- 证据行只做轻量来源区分：file/doc 内容观测显示「内容指纹已记录」，历史 Git 来源显示「Git 不可观测」，不表示重新核验；command/test 显示「提交者自报」，历史 `execution` 行显示「历史执行记录」。不使用 success 徽标把哈希采样标成「已校验」。漂移豁免面板只列 file/doc 内容漂移（file-drift/doc-drift/file-missing/doc-missing），命令执行失败或执行凭据不属于豁免。
- 冲突 409：显示当前 rev 与消息，提供“刷新”。
- ToolCard：从 block content 取文本摘要；按钮 `props.openPanel()` 调 `ctx.layout.selectPanel('project-board')`。

<a id="81-历史知识读取与检索"></a>

### 2.7 历史知识送达与摘要规则

#### 历史知识读取与检索

知识读取是独立派生读模型，检索任务板已保留的任务、计划、事件、登记文档、证据、审查及可授权的关系。有 owning space 读授权时，也读取工作区发现允许的当前 Markdown/文本及已留存正文；发现进度、留存缺损与日志水位分开报告。纯查询不采集历史、写权威数据、执行证据命令或抓取任意 URL。仅对实际保留且仍可读取的材料重建，未记录/未保留的历史不补造。

DSH 原生工具与 MCP 项目授权通道均提供 `search_project_knowledge` 与 `read_project_knowledge`。两端使用共同 context 选择授权项目；DSH 省略时从受信 owning agent 的 cwd 解析，不接受任意路径或角色覆盖。MCP 必须带由完整凭据 open 得到的 context，概览凭据不获得正文权限。两侧均不要求任务租约或写入 intent，MCP 两工具 `readOnlyHint=true`；核心无权威写入，独立缓存可写且可失效。原生注册不依赖 MCP 开关，卸载时关闭其读取器；两侧共用宿主知识 worker 并发上限。

- search 业务参数：`query`；可选 `kinds[]/limit/cursor/relatedLimit/historyRef`。带修订或内容版本的任务、计划和文档记录按实体折叠，重复出现的证据或审查按记录身份折叠。活动事件独立保留。每组展示最新匹配来源，按组内最佳相关性排序。可用该组的 `ref` 作为 `historyRef`，带相同查询和类型条件列出匹配的历史来源。原有引用仍可直接回读。扫描降级在当前窗口内折叠。可选 `discovery:{parents[],reason}` 仅说明调用 Agent 的扩展搜索线索，标为 caller-suggested，不落项目关系。`related` 附带明确记录关系，`via.fromHit` 为本页 `hits` 的零基下标。历史相邻事件在 read 的 context 模式中展开。Agent 可以自由提出新关键词、跨概念继续搜索，不设置累计联想轮数、总跳数或搜索方向门禁。
- 优先执行完整词项查询。已索引范围或扫描窗口零命中时，才尝试有界词组放宽；`queryMatch` 标明搜索阶段，放宽命中带 `matchedGroups/missingGroups`。显式词组最多 6 个；连续短中文可用相邻双字作为词组。至少匹配两个词组且匹配数超过半数；完整标识符照常作为单组匹配。放宽结果不是语义推断或拼写纠正。
- read 业务参数：`refs[]`；可选 `mode=source|context|compact/maxBytes/cursor/relatedLimit`。每个来源返回公开原始字段或正文范围、来源身份与状态、续读游标；context 在同一预算内列出已有关系，不自动递归或裁决适用性。`compact` 保持同一正文、引用、版本、状态、覆盖及关系；省去重复定位和空字段，关联的 `via.fromIndex` 指 `records` 中的零基序号，无法折叠时仍给 `via.from`。
- `kb1` 继续标识日志中的项目、commit seq/hash、事件位置、字段选择与必要正文 hash；固定 Git 引用仅公开既有来源记录；`kb2` 区分工作区当前文件与已留存正文。当前引用绑定物理工作区观测身份、相对路径、读取版本和完整原始字节 hash；留存引用绑定项目、文档和已提交版本。正文分块附分块版本及 UTF-8 字节区间，能沿整源引用回读。两者都不使用数据库行号或授权代作来源身份；索引和分页则绑定当前授权作用域。响应不公开租约令牌、本机根目录或绝对文件引用。
- 正文当前观测与固定历史分别读取。metaRev 不代表正文版本；原文变化、缺失、撤销登记、绑定失效、超限或不可解码均显式返回，不用当前字节替代历史。原文默认/最多 24 KiB 一块，分页不截断 UTF-8；单次最多 8 个引用、总响应 256 KiB。结构化返回的摘录与额度保持不变；模型呈现以整次总字符预算输出原文块，优先当前请求的关键主证据与少量一跳关联。引用、来源、版本、覆盖与未展开原因仍明示；模型呈现不读新的来源、不跳过已有正文分页或权限校验。
- 搜索默认 20 条、最多 50 条；默认附带最多 10 条关联、上限 20，均计入总条数。为直接命中保留至少一半位置，可用直接命中补足未使用的关联名额。查询最长 500 字符/64 词项。游标绑定查询、历史范围、授权作用域、索引代与水位；降级扫描续页还绑定本次发现页。任一身份改变拒绝旧页。FTS 续页读取原索引代，本次不推进派生索引。原文续读游标绑定引用与内容身份。
- coverage 分别说明已验证/已索引日志水位、已知材料范围、外置观测/不可用/未索引数量、工作区扫描和留存范围、返回截断。工作区词项命中在交付时再核验；失效或无法授权的缓存命中只计缺口，不交付正文或路径。`coverage.log.unterminatedTail` 表示源日志末行未结束，读取不修尾；`coverage.relatedBodies` 记录上下文正文的尝试/可用/不可用数量。`relatedUnavailable` 给出未能展开的来源记录引用、关系理由与可用性，不把“读不到正文”伪装成“没有关联”。完整只相对于声明范围成立；零命中不证明无约束，BM25 与关联理由不表示事实权威性或约束有效性。
- 独立 worker 按需建索引与追赶，索引不参与任务提交、验收、快照或恢复事务，不获取 writer 锁。FTS5 contentless 索引只持久化词项、来源定位与进度；工作区索引的固定槽在授权不匹配时以新代事务重建，旧代不可交付。不可用时使用有界关键词扫描并标记降级。缓存失效/损坏/不可写、超时或 worker 失败只影响检索，不能使任务操作失败。
- 同一宿主最多一个知识读取 worker；其执行截止时间为 30 秒，完成或取消后释放。读取已有发现页续接工作区；发现扫描受独立的工作区发现调度预算约束。每个索引观测批次最多处理 4000 条记录、32 份/32 MiB 正文；超出返回未覆盖范围并可后续追赶。命中回读、上下文和直接原文读取另受数量、既有单文件 16 MiB 及请求时限限制，32 MiB 不表示全请求总 I/O 上限。关联正文另有 32 MiB 批次预算。每次验证源日志，文件上限 64 MiB；超过返回资源限制，不宣称已读取完整历史。预算不等于容量或性能承诺。

搜索返回业务原文字段的摘录及可回读 `ref`。折叠组的 `historyCount` 表示本次范围内匹配的来源数量。`version` 为已记录内容版本，`revision` 为实体修订，`state` 仅表示该来源当时保存的状态。read 返回完整来源定位、actor 和 `contentHash/hashDomain`，外置正文另有 `observedAt`。这些字段都不表示约束至今有效。`records[].content` 是原始公开事件 JSON 或正文块，`range/nextCursor` 说明本次范围。记录投影剔除了内部字段，不能声称它等于整个内部 commit。

搜索游标用于同一查询继续取结果；索引落后时重复查询可追赶。扫描降级的 `coverage.scanWindow` 与游标用于继续遍历未扫描窗口，即使当前页零命中也可能有下一页。只按调用产生实际观测；不会捕获两次调用之间被覆盖且未留存的外置正文。

#### Digest

`handle.digest(sessionId, options?)` 返回 ≤ 1200 tokens 的纯文本。

`options.includeRules`（默认 `true`）：`false` 时**只**省略末尾 RULES 段，其余各行逐字节不变。规则全文只在 `lib/core/digest.js` 生成一次。

含规则时至少包含：

~~~text
## Project: <name> · rev <n> (<phase>)
<counts 一行>
SESSION <sessionId> (epoch <n>, <role>)
RESUME CHECKLIST ... (仅 interrupted/open intent)
FOCUS ... (自己的 lease 或 review)
NEXT READY ... (最多 3)
ATTENTION ... (blocked/interrupted/health)
RULES ...
~~~

- 确定性口径约束的是输入三元组：`(state, sessionId, includeRules)` 相同 → 输出逐字节相同；不含当前时间。
- digest 不读调用历史、不读上一条工具结果、不读会话外状态。
- RULES 的权威副本在系统提示（§2.6.4）；`includeRules:false` 是 `view=brief` 的去重通道，不是"取消规则"。细则见 §2.6.4.1。

#### 历史送达与归属

- digest 三段（顺序固定在 `NEXT READY` 之后、`RULES` 之前）：
  - `LAST CHECKPOINT <seq> <at> <note≤160>`
  - `LAST VERIFIED <seq> <taskId> "<title>"`（最近 3 条 `task/verified`）
  - `FOCUS PLAN <planId> "<title>" v<n> <pct>%`（当前 focused plan）
- 所有字段过 `sanitizeField`（单行化 + 截断）；`at` 取事件里记录的 at，不读系统时钟；同状态同 session 必须字节相同。
- 事件渲染（`project_board view=events`）必须带 `actor.kind[:sessionId 尾 6]` 与 `cmdId` 尾 6；`view=task` 必须带 timeline 末 5 条。
- 历史摘要只允许可机械核对的形态（state from→to、acceptance m/n、doc rev n→m、plan version n→m 等）；数据在查询期从 `commits` 的 `data` 取，不写回 timeline 投影、不落盘。
- 索引只认事件自带归属（`event.taskId` / `event.data.id`）；跨实体查询一律查询期 join；禁止用 `doc.links` / `plan.steps.taskIds` / `task.deps` 回填归属（RFC-1 R2）。

## 3. 冻结子契约索引（1c）

本节只登记权威原文，不复制冻结全文；随包使用者可按 §1–§2 的现行语义操作。

| 子契约 | 原文 | 范围/适用口径 |
|---|---|---|
| D1 外置文档 v1 | [冻结原文](<WORKSPACE-DOCUMENTS-CONTRACT.md>) | 原文按冻结口径保留；其中运行时 Git 身份推断、观测、固定生成和正文读取不适用于现行实现。现行证据与正文以 §2.4 为准。 |
| 固定证据 schema v1 | [schema 定义](<../lib/shared/fixed-schema.js>)；[D1 §4.3](<WORKSPACE-DOCUMENTS-CONTRACT.md#43-固定证据结构>) | fixed 字段、对象格式、OID/path/hash 校验；仅用于历史 Git 记录的结构和同 commit 屏障校验，见 §2.4。 |
| 事件兼容分类 | [唯一 EVENT_REGISTRY](<../lib/shared/events.js>)；本文 §2.5 | applied/additive/migration/refuse；拒读优先，不靠快照绕过全日志校验。 |

## 4. 兼容与降级

- JS/TS 共存：后端 ESM 直接加载，Node ≥22；TypeScript 仅开发期 noEmit。客户端 TS/TSX 由开发期 esbuild 生成唯一运行 bundle，安装/运行无需构建或额外第三方运行时。
- 产品运行时不调用 Git。工作区发现允许读取忽略规则文件，不执行 Git；留存正文和旧 Git 来源的区别见 §2.4。
- 缺 webServer 只注册工具/提示词；MCP 默认关闭，配置/凭据失败只禁该入口；知识 FTS5/缓存不可用时有界扫描并标 coverage 降级，不影响任务事务。
- schema：运行时要求 `schemaVersion` 为整数且 ≥3，且所有任务带布尔 `requiresAudit`；非整数、<3 或字段不齐返回 `schema-migration-required` 并在修尾前拒绝。不设显式版本上限：>3 不会仅因版本号被拒，但未知事件与字段语义仍由 EVENT_REGISTRY 和构建兼容决定，不能据此认为更高版本可安全运行。外置端点 schemaVersion=1，未知版本拒写；commit.v 与 snapshot.v 为1，未知 fixed.v 拒绝不回退旧解析。
- 字段兼容与事件兼容分开：additive 事件可 no-op 不代表旧构建理解审计门/I23；回退须匹配切换前一致性数据备份和构建，不仅换代码。离线迁移、salvage、repair 与测试步骤见仓库[运维 CLI](<operations/CLI.md>)及[迁移说明](<operations/MIGRATION.md>)，维护授权不由契约阅读产生。
- 历史兼容字段：`execution` 仅回放，不执行、不签名、不判成败；`rootDir/execution.key` 不读取、不创建、不参与判定。历史 auto/policy 验收与既有 fixed 记录保留原数据，不驱动新自动完成。
- 安全边界：单机单用户、每项目单写者；锁是合作协议，不抵抗任意外部 OS 写者。文档读取不执行仓库驱动、hook 或其他外部程序，不管理分支/worktree。正文、标题、事件与证据是数据而非指令；不抓取任意 URL，不执行 command/test，不用空正文伪装失败。
- 人工兜底不降低事实标准：human verify 可显式处理漂移，保留责任与告警；agent 自述不得标成人工/系统核验。
