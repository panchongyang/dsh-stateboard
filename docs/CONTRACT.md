# ProjectBoard MVP — 实现契约（冻结）

> 本文件是 core / host / client 三个实现面的唯一接口契约。  
> 设计背景见 [DESIGN.md](./DESIGN.md)；实现范围是 **M0–M4 的可用 MVP**（结构拆分已完成），不是全部 v2。  
> 目录与模块现状见 [ARCHITECTURE.md](./ARCHITECTURE.md) §2，该清单由
> `npm run check:architecture` 机器校验。所有路径相对本仓库根目录；所有时间 ISO 字符串；所有 id 带前缀。

---

## 0. MVP 范围

必须可用：

- 项目：按 workspace 路径识别；创建/列出；active/paused/archived。
- 计划：一个项目可有多个计划（planHeads + 不可变版本表，命令/读模型见 §2.4.1、§2.5 与 [PLAN-V2.md](./PLAN-V2.md)）；`plan.publish` 原子创建 tasks；`plan.revise` 支持加/改/移除（移除标 orphaned）；draft/active/archived 生命周期、adopt/release 与 focus（human-only）。
- 任务：create/update/ready/claim/begin/submit/verify/reject/block/interrupt/unblock/release/reconcile/cancel/reopen。
- 文档：put/get/list/link；内容寻址 blob；`baseRev` 冲突。
- 进度：只从任务状态推导；不存百分比。
- 证据：file hash 与 doc 内容由服务端观测；command/test/note/url 只登记提交者材料，不执行、不探测、不判定成败。
- 崩溃：intent WAL；重启后 in_progress → interrupted/ready；reconcile 三种选择。
- 并发：进程内单写者；expectedRev CAS；lease + fencing token；cmdId 幂等。
- 模型面：5 个工具；per-agent digest（scoped section）。
- 界面：`main` 整页看板 + `sidebar.panellist` 图标 + `project_board` 内联 toolview；HTTP 轮询。
- 测试：core 单测/重放/并发/幂等；client bundle 冒烟；host 预检。

不做（MVP 明确不做）：

- 拖拽（用按钮/菜单）。
- SSE（2s 轮询）。
- 计划的拖拽排序 / 甘特图 / 模板（计划编辑用表单，非目标见 [PLAN-V2.md](./PLAN-V2.md) §13）。
- 血统级审计身份、autopilot、LAN/多用户、doc export、甘特图、工时。
- 跨进程实时同步（只有 lock 只读降级）。

---

## 1. 目录结构（现状）

> 这里是契约视角的最小目录；完整模块清单（机器校验）在
> [ARCHITECTURE.md](./ARCHITECTURE.md) §2.1。

~~~text
dsh-project-board/
  package.json
  docs/CONTRACT.md
  README.md
  lib/
    index.js                 # cordis host plugin entry（name/inject/apply）
    client.js                # 浏览器 bundle（生成物，勿手改）
    shared/
      contract.js            # 枚举 / 命令 op / 错误码 / API_PATHS / TOOL_NAMES
    host/
      tools.js               # 兼容壳（旧解析路径仍可用）
      tools/                 # board / task / plan / doc / session / shared / index
      routes.js              # 前缀 + 鉴权 + 分发
      routes/                # board / tasks / plans / docs / events / health / projects / commands / shared
      prompt.js              # per-agent scoped section
      lifecycle.js           # agent/created / agent/disposed
      auth.js                # token + origin
      util.js                # json body, errors
    core/
      service.js             # ProjectService（项目注册表、handle 复用）
      handle.js              # ProjectHandle 命令总线
      lease.js               # requireTask / assertRev / assertLease / grant / expire
      model.js               # states / transitions / guards / applyEvent / allowedOps
      normalize.js           # labels / acceptance / steps / evidence / docLinks
      contracts.js           # event constructors（assignment / interrupted / lease 回收）
      evidence.js            # file hash / doc@rev 校验
      store.js               # JsonlStore 门面（锁 / 快照 / blob）
      store/format.js        # commit 格式、哈希、重放
      store/lock.js          # 跨进程写锁
      store/files.js         # snapshot / blob 侧文件
      commands/index.js      # op → handler 注册表
      commands/task-intake.js / task-work.js / task-gov.js / task.js
      commands/plan.js / plan-life.js / plan-members.js
      commands/project.js / doc.js / session.js
      views.js               # board/task/plan/brief/docs/health/events
      digest.js              # bounded digest
      fsck.js                # invariant checks
      repair.js              # 日志分叉修复规划（scripts/repair-log.mjs 用）
      errors.js              # BoardError
      util.js                # ids, canonical JSON, sha256, path
  src/client/                # 浏览器半源码（全量 TS/TSX，React classic JSX）
    index.ts                 # apply + 4 个 slot 注册 + __test/__ui 测试面
    styles.css               # 设计 tokens + primitives + pages（真 CSS 文件）
    styles.ts / css.d.ts      # CSS 文本导入与幂等注入、开发期模块声明
    react.d.ts               # 宿主 React/JSX 最小声明，无运行依赖
    api/*.ts                 # 唯一 fetch、请求票据、取消与页面读生命周期
    hooks/*.ts               # React 读写适配、导航 context、toast、独立 health 轮询
    model/*.ts / utils/*.ts   # 纯投影、payload、策略常量、解析与格式化
    components/*.tsx          # props 驱动的组件与展示
    pages/*.tsx               # 页面/编辑器编排与取数、写入
  test/                      # core / client / host / architecture-map
  scripts/                   # install / build-client / repair-log / audit / check-architecture
  tools/build/               # 仅开发期构建工具链（独立 package.json + lockfile）
  bin/wt.mjs                 # 维护者自用 worktree 工具；不属于产品开源/发布面，打包隔离待完成
~~~

根目录 `node_modules/@deepseek-ai` 是本机 DSH junction（开发期解析宿主包），
不要把 `npm install` 跑在根目录。

---

## 2. Core API

### 2.1 `lib/core/service.js` 与 `lib/core/handle.js`

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
  async query(projectId, view, params)  // convenience
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

### 2.2 命令信封

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
  op: 'task.claim',              // see 2.4
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

`committed:true` 的定义：commit 行已 append + fsync，且哈希链成立。之后的 meta/registry 更新失败不回滚、不返回失败，只放在 `warnings`；snapshot 是纯优化，写失败**静默忽略**（不影响命令结果）；日志写入失败或结果不明不得返回 `committed:true`。`project.relocate` 的 meta/主绑定写失败后，下一次 open 从日志 `workspacePath` 自愈。

append/write/fsync 异常时，仅在仍持锁、文件 identity 相同、尾部大小在本次追加范围且字节匹配本次行前缀时，截断到已知原大小并 fsync；恢复确认后抛原错误，同一 `cmdId` 可重新提交。恢复失败、陌生尾/锁接管或 close 异常返回 `log-write-uncertain`（details 含原错误、恢复错误与 phase），当前 store/handle 降为只读，不能继续写或声称确定未提交。冷开以实际日志为准：经完整 version/seq/hash 校验的 JSON 尾记录即使缺少 LF 也保留并回放，使该 `cmdId` 去重；不可解析的乱码半尾才丢弃。可写打开在仍持锁时先原子写入并 fsync 经验证的完整 JSONL、确认分隔和锁后才返回可追加句柄；规范化写入/sync/rename 失败则关闭 open 并 fail-closed。只读打开不写入尾分隔、不修复日志。此窗口内可能存在完整或半行，不能把 I/O 错误等同于确定未落盘。锁为合作式协议，不声称可原子阻挡无视锁的外部 OS 写者。

重复 `cmdId`：返回 `{ ok:true, committed:true, deduped:true, projectRev: current, events: [] }`，绝不重复写。

失败：抛 `BoardError`。

### 2.3 错误

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
| log-write-uncertain | 503 | append 恢复不能确认或 close 异常；当前写者只读，冷开按实际日志确认结果 |
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
| invalid-external-doc | 400 | 外置记录/locator 或兼容 inline 结构非法、快照文档与其 seq/hash 对应日志投影不一致；回放与快照载入同码失败，不跳过、不将外置伪装按 inline 解释（见 docs/EXTERNAL-DOCS.md） |
| missing-binding | 409 | 外置文档指定的 bindingId 不是本项目 active 绑定。审计历史 fixed 时降 warning（不可观测），不回退到其他绑定/worktree |
| external-doc-operation-required | 409 | 旧 doc.put/doc.link、inline doc 视图或无 fixed 的 doc 证据触及 source=external 记录 |
| inline-write-disabled | 409 | 内嵌写入默认禁用（新建、既有编辑与 doc.link）；迁移后档案永远只读。仅 human 的 doc.inline_policy 可按项目恢复未迁移文档的旧写语义 |
| dirty-worktree | 409 | 固定文档取证路径有 staged/unstaged/模式变化，或未追踪/冲突/缺失 |
| unsupported-content-transform | 422 | filter（含 LFS 与自定义 driver）/LFS 指针/encoding/ident、未知或不可判定 EOL 转换；绝不执行驱动（diff/textconv 放行且不执行） |
| unsupported-repository | 422 | 非自动记录来源/绑定、嵌套或多仓库、来源核验失败 |
| fixed-object-missing / fixed-path-missing | 404 | 固定提交/tree/blob 不可取 / 提交中无指定路径；互不吞并。审计时 fixed-object-missing 降 warning（不可观测），fixed-path-missing 仍是 error |
| fixed-object-mismatch / content-hash-mismatch | 409 | Git 对象类型/OID/路径身份不符 / 完整 blob 字节 SHA-256 不符；始终 error |
| invalid-fixed-reference | 400 | fixed 结构/版本、项目身份、OID/path 非法，或新 task fixed 证据缺同 commit 的 `doc/content-fixed`；不退回旧 docId@rev |
| git-unavailable | 503 | 固定内容 Git 读取超时、限额或不可执行；不伪装对象缺失。审计时降 warning（不可观测） |
| file-missing / root-unavailable / permission-denied / outside-root / security-rejected / not-regular / oversize / undecodable / unsupported-format / unstable | 404/503/403/403/403/400/413/400/400/409 | 外置文档 register/relocate/confirm 读取失败（契约 §6.2） |

固定 Git 审计的严重度：`git-unavailable`、`root-unavailable`、`missing-binding`、`fixed-object-missing` 及来源确实不可达 → warning（message 明确 "Historical Git content is not observable; no content match is asserted"），不阻断 verify；真实结构/来源身份/hash/OID/type 不符 → error。审计只用主绑定，不 fallback 到其他 worktree。读取接口本身仍按上表返回错误。

### 2.4 命令清单

所有 task 命令的 payload 都含 `taskId`（除 create），修改已有实体的命令必须带 `expected.entityRev`。

`task.create/update/gate` 与 `plan.create/publish/revise` 的顶层字段，以及计划 step/task 定义使用字段白名单；未知字段返回 `invalid-command`（400），不静默丢弃调用意图。上述路径中显式提供的 `requiresAudit` 必须是 boolean；保留命名空间 `gate:*` 只允许 `gate:audit`，其他门标签返回同码。草稿写入前校验，publish 时重新校验已存草稿；不是对全部命令施加全局字段白名单，也不识别旧门别名。这些输入校验不增加使用者配置或人工技术批准。

| op | payload | 说明 |
|---|---|---|
| project.update | name?, phase?, policy? | human/system；→ archived 前要求无 in_progress/live lease/open intent（`project-has-live-work`）；archived 上只允许 phase=active/paused（unarchive，可同带 name/policy），其余写 `project-archived`；unarchive 同 commit 携带恢复事件；`policy.verification` 只接受 `manual`，写 `auto` → `invalid-command`（旧 auto 数据只读不改） |
| plan.publish | planId + expectedRev（发布草稿）；或无 planId 时 title, goal?, assumptions?, risks?, steps（旧式 create+publish；项目已有计划时创建第二个计划） | 原子创建 plan + tasks；无 focus 时自动聚焦 |
| plan.revise | planId, expectedRev（draft）/ baseVersion（active）, title?, goal?, assumptions?, risks?, steps | draft 只改 head.draft；active 产生 version+1；移除的任务标 orphaned |
| task.create | title, description?, acceptance, priority?, weight?, labels?, requiresAudit?, deps?, planRef? | 独立任务；requiresAudit=true 或 labels 含 gate:audit 时开启第三方审计门 |
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
| task.unblock | note? | blocked → ready/review；有 open intent 时拒绝，不重建 intent |
| task.release | note?, intent? | in_progress → ready；有 open intent 时必须 `stopped` |
| task.reconcile | choice, note, evidence? | interrupted → in_progress/review/ready；写 resolution=redo/applied/discarded |
| task.cancel | reason, intent? | 非终态 → canceled；有 live lease 时非 human 校验 token；有 open intent 时必须 `stopped` |
| task.reopen | reason | done/canceled → ready（human） |
| doc.put | docId?, title, kind, body, baseRev?, links? | 创建/更新 |
| doc.link | docId, links | 只改 links；目标为 external 时拒绝 external-doc-operation-required（doc.put 同） |
| doc.external.register | title, kind?, bindingId?, relPath, links? | 登记外置文档（不写 blob、不碰文件）；返回 docId |
| doc.external.update_meta | docId, expectedMetaRev, title?, kind?, links?, status?, reason? | 元数据与管理状态（archived→draft 须 reason） |
| doc.external.relocate | docId, expectedMetaRev, bindingId?, relPath? | 单文档显式重定位；需重新确认 |
| doc.external.rebind | fromBindingId, toBindingId, expected.projectRev | human/system；批量换绑定，relPath 不变 |
| doc.external.confirm | docId, expectedMetaRev, expectedContentHash | 服务端重新完整读取后写确认基线；内容变化 stale-revision |
| doc.external.unregister | docId, expectedMetaRev, reason? | 墓碑；不删文件、保留历史与关联 |
| session.checkpoint | note, nextActions? | 会话交接审计 |
| session.handoff | note, nextActions? | 同上 |
| project.relocate | workspacePath | human/system；退役旧主绑定并新建主绑定（不原地改指），保留 id/历史；目标已被他项目绑定→`already-exists`，带他项目标记→`identity-conflict` |
| override | taskId, toState, reason, intent? | human 强制；有 open intent 时必须 `stopped`；审计 |

#### 2.4.2 Intent 结算（RFC-3）

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

#### 2.4.3 Archived 写闸（RFC-3）

- archived 项目上唯一允许的写：`project.update` 且 `phase ∈ {active, paused}`（unarchive，可同带 name/policy）。
- 其余 mutating op（task/plan/doc/project.relocate/session checkpoint/override）在 entry 阶段返回 `project-archived`；`_appendEvents` 再做一次出口兜底。
- `attach`/`detach` 在 archived 上只更新内存 binding，不落事件；`recover`/`expire` 跳过，不追加事件。
- unarchive 的同一 commit 先写 `project/updated`，再对每个 in_progress 写 `task/interrupted`（有 open intent）或 `task/readied`（无 open intent）；随后由人 reconcile。
- unarchive 判定必须看**更新前** phase：只有 archived → active/paused 才恢复并清租约；active → paused / active → active 保留 owner 与 lease。
- 旧 archived 数据（已有 in_progress/open intent）打开只告警，不自动改写；unarchive 时恢复。

#### 2.4.1 Plan v2 命令（C1–C2 已实现）

一个项目可有多个计划；计划是 initiative 级容器（draft/active/archived + focusPlanId），任务是唯一工作单元，最多属于一个计划。以下命令按 [PLAN-V2.md](./PLAN-V2.md) 冻结的设计实现，全部走 `handle.command`；迁移核对入口见 [MIGRATION.md](./MIGRATION.md)。

| op | payload | 说明 |
|---|---|---|
| plan.create | title, goal?, assumptions?, risks?, steps? | 创建 draft，不建任务 |
| plan.revise | planId, expectedRev?（draft）/ baseVersion?（active）, title?, goal?, assumptions?, risks?, steps | draft 改 head.draft；active 产生 version+1 |
| plan.publish | planId, expectedRev | draft → active，原子创建任务；不带 planId 的旧 publish = create + publish |
| plan.rename | planId, expectedRev, title | 只改 head.title，不产生版本；标题唯一 |
| plan.archive | planId, expectedRev | → archived；无 in_progress / live lease；清 focus |
| plan.unarchive | planId, expectedRev | 回到 archivedFrom（draft/active） |
| plan.focus | planId \| null | human-only；写 project.focusPlanId（实现不校验 projectRev，重复聚焦为空操作） |
| plan.adopt | planId, baseVersion, taskIds, stepId | 把计划外/孤儿任务加入 step；version+1 |
| plan.release | planId, baseVersion, taskIds | 把任务移出计划；version+1；任务保留 |

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

`evidence` 项：

~~~js
{
  kind: 'file'|'command'|'doc'|'url'|'note'|'test',
  ref: string,
  hash?: string,
  fixed?: object,               // 外置 doc 自动固定成功时才有
  fixedState?: 'pinned'|'current-only',
  fixedReason?: string,         // current-only 的降级原因
  summary: string,
  acceptanceId?: string,
  supersededAt?: string,       // a later begin supersedes prior-attempt evidence
  supersededBy?: string,
  execution?: object|null      // 历史字段：只回放旧日志；新提交恒为 null，不执行、不签名
}
~~~

- `file`：ref 相对 workspace；服务端 `stat` + sha256；不存在/越界/ hash 不符 → 拒绝。
- 无 `fixed` 的 `doc`：ref=`'docId@rev'`；doc 必须存在，submit 时 rev 必须是 head。审计时带 `@rev` 的证据校验**该 rev 的不可变 blob**（content-addressed，重算 sha256）：head 前进不算漂移；blob 丢失/内容不符为 error。省略 `@rev` 时仍按 head hash 比对。
- `doc` 有 `fixed`：固定版本由服务端在提交外置文档证据时自动生成，调用方只传 `{kind:'doc', ref:docId}`；外置文档的 `@rev` 是元数据。路径已提交且干净、可安全还原时生成 `{v:1,projectId,commitOid,pathAtCommit,blobOid,objectFormat,blobContentHash}`（hash 必须等于 blobContentHash），否则静默降级为不带 `fixed` 的 `current-only` + `fixedReason`。调用方传入 `fixed`/`fixedConfirmed`/`bindingId` 一律 `invalid-command`；没有批准或确认命令。搬迁或本机重建绑定后，新主绑定若不在已记录来源中，自动壳先证明同源（对象格式、锚点提交、既有 fixed 对象）再在同一 commit 追加 `bindingIds`；`get_fixed` 对同源新绑定只读放行，不同仓库或缺失锚点拒绝。读取 get_fixed 不生成证据；项目尚无来源时也可只读引导（不写来源、不写事件、不推进 rev）。新证据行同一原子 commit 必须携带匹配的 `doc/content-fixed`（inline 历史行也不例外），缺屏障拒绝。审计只验固定对象、不追当前正文/分支/metaRev；旧的无 fixed 语义不变，历史 `fixed` 行与 `project.gitContentRepository` 仍按数据回放。详见 [固定内容证据](<DOC-EXTERNAL-EVIDENCE.md>)。
- `command`/`test`：只登记 `ref`（命令文本/测试名）、`summary`、`acceptanceId`。服务端不执行 `ref`、不重跑、不签名、不校验退出码；成功与失败报告同样只是提交者材料，不作为宿主观测。`execution` 只用于回放旧日志，不参与新提交、审计或完成判定。
- `url`/`note`：只登记提交者材料；不执行、不判强弱。
- `begin` 开启新 attempt 时会把旧 evidence 标 `supersededAt/supersededBy`，并把每条 acceptance 的 `met` 重置为「是否有 active evidence」；submit 的 acceptance 覆盖检查只认 active evidence。历史仍保留在任务/事件里。这样返工必须为新 attempt 重提每条 acceptance 的证据。
- **重提即替换**：submit（以及 `task.reconcile(choice=completed)`）里的新证据按 identity 退休同 identity 的 active 旧行，写 `supersededAt/supersededBy`、`supersedeReason='resubmitted'`；旧行只保留历史，不保存字节。identity：`file` = realpath/canonical，`doc` = docId（忽略 `@rev`），`command`/`test` = ref；`url`/`note` 不参与。批量作用域先算旧行再统一标，避免同批新行互相 supersede。若某条 acceptance 因此失去全部 active 证据且本次提交没有补上，整条命令 422（details: acceptanceId/refs/hint），不落盘。审计只看 active evidence。
- **审计只审内容观测**：file 漂移/缺失/不可读、无 `@rev` 的 doc head 漂移、pinned doc blob 丢失/损坏、`current-only` 外置文档变化 → hard `evidence-drift`。command/test/note/url 不产生 self-reported/失败/签名等 warning，也不因它们拒绝 submit/verify。固定 Git 证据在 Git/绑定/对象暂时不可观测时降为 warning（非阻断、如实标明不可观测或历史不可得）；真实结构与来源身份不符、hash/OID/type 不符仍为 error。人类 verify 可用 `refreshDrift`（file 内容漂移）或 `acknowledgeDrift` + `reason` 显式处理 hard 错误（见 verify）。

### 2.5 Query

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

#### 2.5.1 Health / fsck 只读诊断

- `checkState` 与 `health` 不修改输入状态、不修数据、不追加事件、不执行 evidence 命令；兼容性 plan head 派生只发生在私有投影。
- I6：每个 open intent 必须对应存在的任务，且任务状态只允许 `in_progress|interrupted`。`task.work.intentId` 存在时必须指向存在且属于同一任务的 intent。诊断的检查名/详情定位 taskId、intentId，失败使 `health.ok=false`。
- I6 是单向约束：claim 后尚未 begin、unblock 后没有 open intent，以及指向 closed/abandoned intent 的历史 work 都合法；恢复清空 work 但保留 open intent 也合法。
- owner 只允许出现在 `in_progress`，该状态要求 owner；fsck 不把 owner 的持久 `leaseUntil` 当成运行时租约有效期。
- I22 只校验带 RFC-3 标识字段（`closeReason|closedBy|outcome|sideEffects|settlementNote`）的结算：status 为 closed/abandoned，closeReason/resolution、closedBy.kind、closedAt 完整；治理结算要求 stopped + sideEffects。仅 status/closedAt/resolution 不能区分格式，不追溯缺字段记录；未带上述标识的 submit 结果也属于不可区分范围。
- archived 项目存在 `in_progress`、open intent 或运行时 live lease 均告警。live 以注入时钟下 `expiresAt > now` 判断，到期可续不算 live，既有续租/回收提示保留。独立 `checkState(state)` 无运行时 lease 表，只检查持久状态；health 传入 lease 表与同一次取样的时钟。

### 2.6 Plan / Task 规则

**publish**

- 至少 1 个 step（step 可为空）；每个 task 至少 1 条 acceptance。
- `key` 在 plan 内唯一；deps 必须存在；deps 无环。
- 无 deps 的 task 直接 `ready`，有 deps 的 `backlog`。
- 同一 commit：`plan/published` + 每个 `task/created`；project 不存在则先 `project/created`。
- 生成的 task id：`tsk_` + ULID；plan id：`pln_` + ULID。

**Plan v2 生命周期（C1/C2 实现，详见 [PLAN-V2.md](./PLAN-V2.md)）**

- 一个项目可有多个计划；`planHeads[id]` 保存 status/rev/currentVersion，版本表仍按 `id@version` 不可变。
- draft 存在 head.draft，不占版本号；publish 物化为 version 1 并原子建任务；active revise 产生 version+1。
- 归档要求计划内无 in_progress 且无 live lease；archived 计划的任务拒绝 claim；focus 指向 archived 时清空。
- `plan.adopt` / `plan.release` 都产生 version+1；adopt 接受 planRef=null 或指向本计划旧版本（orphaned）的任务，release 把 planRef 置空；跨计划移动走 release → adopt。
- 计划标题项目内唯一（含 archived）；计划不删除。
- `task.create` 不接受 planRef：成员关系只能通过计划版本变化（publish/revise/adopt/release）。
- 发布、修订、归位或任务依赖编辑不得在当前计划版本内新增任何连接同阶段任务的直接或间接依赖路径。阶段成员以版本的 steps 为准。已有路径可以保留或解除，解除后不得重建。修订和归位可把有先后关系的任务拆到不同阶段。
- agent 优先推进当前阶段的可执行任务并逐项提交，之后集中独立审查。同阶段未全部提交时可先处理阻塞，包括存量依赖需要先验收的任务。阶段提示不改变领取资格或单任务验收规则。
- 并发：head 级命令用 expectedRev，版本级命令用 baseVersion，focus 用 projectRev。

**依赖级联**

- 任务 done 时，同一 commit 内把 deps 已全部 done 的 backlog 任务置 ready（`task/readied`）。
- ready 需要所有 deps 为 done，且 acceptance 非空。

**update**

- 无租约也能改的前提：任务属于 backlog/ready 且没有 live lease（agent 重排队列/修前置不必先认领）。
- in_progress / review / blocked 仍然必须持租约（否则 lease-held）；terminal 状态一律拒绝（reopen 才是回头路）。
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
- **进入 review 前做一次硬审计**：证据全部加入/替换后跑一次 `auditEvidence`（不是逐条、不是每次加证据）；任一 hard（file/doc 漂移、missing/unreadable、pinned doc blob 丢失/损坏、固定结构/来源身份/hash/OID/type 不符）→ 409 `evidence-drift`，details 带 `warnings` 与 `stage:'submit'`，整条命令不落盘，lease 保留，agent 可在同一租约内修正后立即重提。不可观测 warning 随结果返回并进入 review。
- 关闭 intent（work/result）；task → review。
- **不自动完成**：`policy.verification` 只有 `manual`，submit 一律停在 review，由获授权的验收者显式 verify。旧 `auto` 配置与历史 `task/verified` 事件只按原数据读入、不迁移、不改写；`project.update` 新写 `auto` → `invalid-command`。verify 是验收者的背书/验收记录，不是系统对交付正确性的证明。

**verify**

- 普通任务允许任意拥有项目写权限的 agent 显式验收，包括开发或提交者，不需要独立会话。审计门（`requiresAudit` / `gate:audit`）仍要求独立 agent：worker 集合为 assignee + 所有 evidence.producedBy（含 superseded）+ workers；审计者 sessionId/agentId 均不能命中，缺 worker 返回 worker-unknown，命中返回 not-independent；createdBy 不算 worker。独立性只在 session 级，不抵抗新 session/子代理分身。
- `audit={report,checklist?:[{item,ok,note?}]}` 用于 verify/reject。审计门的 agent verify 必须提供报告；普通任务的 agent 和 human 可直接 verify，或传 reason/note（入口支持时）。传入 audit 时 report 去空白后 20–4000 字；清单最多 50 项、item ≤200 字、note ≤500 字。
- `lastAudit={id,at,gate,by:{kind,sessionId,agentId,via},verdict,report,checklist,evidence:{count,digest},scopeDigest,workers,warnings,taskRev}`；evidence.digest 锚定 active evidence 的 id/kind/ref/hash。`scopeDigest` 是独立的验收范围指纹，绑定标题/说明、依赖、验收项及材料覆盖、审计门、active evidence 与来源身份、worker 集合；不绑定 planRef/orphaned/priority/weight/rev 等管理元数据。`taskRev` 保留审计命令写后修订号，作为不可变的正整数历史锚点，不大于当前 rev，不随元数据编辑重写。warnings 最多 20 条。human pass 覆盖旧 fail；begin/reopen 清记录，同 attempt 的 submit 保留 fail。报告与指纹均不证明内容正确，agent 报告为自述，不能显示为系统核验或人类核验。
- agent 显式传 refreshDrift/acknowledgeDrift 返回 403；hard 漂移返回 409，canRefresh/canAcknowledgeDrift 均 false，下一步是 reject 返工或 human 处理。固定 Git 不可观测 warning 仍可放行，保留在 lastAudit。I23 检查 agent done 必须有可追溯的 pass、匹配任务的 gate、有效历史 taskRev 锚点（正整数且 ≤ 当前 rev）、与当前实质验收范围匹配的 scopeDigest、匹配当前 active evidence 的 count/digest 与 worker 快照；审计门另检查报告与独立性，普通验收不检查独立性。历史 human/policy 不追溯。元数据调整不冒充重新验收；对 agent 已验收任务通过 plan.revise 改动实质范围返回 409 audit-scope-locked，应先由 human reopen，再返工、重提与显式验收。继续使用 schema v3 和已有事件；只能由支持普通 agent 验收的构建正确检查这类新增记录的 I23，不能用旧构建回退后忽略健康错误。

- 获授权的验收者只能验收 review 且所有 acceptance met 的任务。verify 前重新审计内容观测：file 漂移/缺失/不可读、无 `@rev` 的 doc head 漂移、pinned doc blob 丢失/损坏、固定 Git 的结构/来源身份/hash/OID/type 不符 → `evidence-drift`（409，details.warnings；`canRefresh` 表示存在可刷新的 file 漂移）。固定 Git 在 Git/绑定/对象暂时不可观测时只给 warning，不阻断 verify。**verify 不复核命令执行结论**：不重跑 command/test、不判断退出码，命令/测试材料只按提交者记录保留。写 `task/verified` 与最近验收记录 `lastAudit`；这是验收操作记录，不是系统对交付正确性的担保。
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

- review 无 live lease 时任意 agent/human（含 worker 自驳）可 reject，reason 必填；有 live lease 时非 human 仅持有者且校验 fencingToken。原 assignee 可自动接回时授予新租约并回 in_progress，其余回 ready；unassign 仅 human。MCP 工作会话通过新领取接回，记录 assignment cause 为 `explicit-claim`。rejection 记录 reason/at/by/byKind/auditId（可选）。带 audit 写 fail lastAudit；无 audit 不新建记录。事件仍为 task/rejected。任意 agent 驳回带来的乒乓 DoS 是接受的边界，没有自动限流。

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

- blocked → resumeTo==='review' ? review : ready；清 blocker；task/unblocked。
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

- done/canceled → ready；仅 human；reason；清 verified/owner/work/lastAudit。

**过期 / 恢复**

- 进程启动后 lease 表为空；`recover()` 把所有 in_progress 任务：
  - 有 open intent → `task/interrupted` + `lease/expired`
  - 无 open intent → `task/readied` + `lease/expired`
- 一次 commit 批量写：每个任务的 `lease/expired` 与它的状态迁移属于同一条 commit，重启不允许出现“任务被回收、但日志里没有租约终止证据”。`recover()` 每个 writer 只跑一次；日志里已无 in_progress 后再次冷开不追加事件，重复调用是 no-op，不会重复追加 `lease/expired`。
- **重启回收与常规到期回收的语义/审计差异**：常规 sweep 终止的是运行时 lease，`lease/expired.data` 是它的完整快照（`grantedAt`/`expiresAt`/`renewCount`/`progressAt` 等）；重启后 lease 表是进程状态、已为空，记录只能从持久化 `task.owner`（`sessionId`/`agentId`/`epoch`/`fencingToken`/`leaseUntil`）重建——已知字段原样写入（`token` 取自 `fencingToken`，`expiresAt` 取自 `leaseUntil`），未知字段（`acquiredAt`/`grantedAt`/`renewCount`/`progressAt`/`lastRenewedAt`）一律省略，绝不虚构续租历史，并写 `reason:'restart'` 与常规回收区分。`lease/expired` 仍是 additive：投影只消费 `lease/granted` 的 token 计数，payload 不参与状态推导。
- archived 项目不写独立 recover commit：`recover()` 直接返回，恢复事件由 unarchive 的 `project/updated` 提交携带（archived 上出现 in_progress 只可能来自旧数据）。
- TTL 过期不等于立刻死：`leaseTtlSec + leaseGraceSec` 内，且 binding 未 detached、epoch 匹配、`lastSeenAt` 未超过 `leaseTtlSec + leaseGraceSec`，lease 仍可续；health 标“过期可续”。
- 宽限内 `task.renew` 只改内存（新 expiresAt，不写 commit）；默认 `maxRenewalsWithoutProgress=2`，显式续租次数耗尽后拒绝续租。
- `touch` 和 `task.renew` 共享绝对无进展期限：`progressAt + (1 + maxRenewalsWithoutProgress) * leaseTtlSec`（统一使用注入时钟）。续期的 expiresAt 不超过该期限；到达期限后不得继续延长，原 expiresAt + grace 到达后由 sweep 回收（有 intent → interrupted，无 → ready）。默认无进展最多 3 个 TTL，宽限不提供额外续期额度。
- claim/grant 初始化 progressAt；成功 begin/submit 等既有真实进展重置 progressAt 和显式 renewCount。读取、touch、renew、被拒命令均不重置进展。touch 不按每次工具读取消费显式次数，避免两次查询就耗尽，但只能在上述绝对期限内滑动续期。
- 只有“可回收”（detached / epoch 变了 / 超过宽限 / lastSeen 太旧）才写 `lease/expired` + `task/interrupted|readied`；回收后旧 token/epoch 的 renew/touch 不得复活。
- 回收先于命令计算：通过校验的写命令先在工作投影上应用可回收 lease 的回收，再基于回收后的状态计算自身事件；回收事件排在前面，与业务事件、token 变化同一 commit。命令被拒（含后续 choice 或证据审计失败）时回收整体丢弃，不写日志，state/lease/token 不变。实体 `expectedRev` 仍按已提交的 rev 校验。
- 回收的恢复路径只有 `task.interrupt` / `task.reconcile`：lease 可回收且有 open intent 时，持有原 lease 的 session（binding 未 detached、epoch 未变）带原 fencing token 可一次完成；`interrupt` 只写 `lease/expired` + 一条 `task/interrupted`，open intent 留待 reconcile 明确结算；human 的 interrupt/reconcile 同样适用。begin/submit/release/renew 仍以 `lease-expired` 拒绝；旧 token、其他 session、epoch 已变或 detached 都不能恢复，也不能终止新 lease。
- 任何看板工具调用都会尝试 `touch` 续期（含 submit 自身），但只影响自己的 session/epoch；readOnly、closed、archived 或无效 binding 的 touch 不更新租约，readOnly/closed/archived 也不更新 binding 活性。父会话 touch 不误收子代理租约。

### 2.7 进度

`progress = { total, done, ready, inProgress, review, blocked, interrupted, canceled, weightTotal, weightDone, percent, verifiedPercent, attention }`。  
不存字段；每次 query 计算。

### 2.8 文档

- `body` ≤ 256 KB；hash = sha256(utf8 body)。
- blob 路径 `blobs/<hash>`；写 tmp + rename。
- blob 先于 baseRev 校验和 commit 写入；确定未提交或确认回滚成功的失败不产生 doc 事件或公开 doc，但可能遗留物理 tmp 或未被事件引用的 hash blob。`log-write-uncertain` 不能保证未提交：合法完整 doc 事件（包括缺 LF 的完整 JSON 尾记录）冷回放后可以公开文档，此时正文已被引用，不是物理孤儿。公开 doc 只来自已提交事件，不通过 blob 目录发现。health/fsck 检查状态与引用，不枚举磁盘物理孤儿；没有自动 blob GC。已提交 doc 的 snapshot/meta 后置失败不撤销其引用，也不能称该正文是孤儿。
- `doc.put` 新文档不需要 baseRev；更新必须 `baseRev === doc.rev`，否则 `stale-revision`（details 带当前 rev/hash）。
- 内嵌写入默认禁用：`doc.put`（新建与更新）与 `doc.link` 在写 blob/事件之前返回 `inline-write-disabled`(409)，store 字节与事件数不变。只有项目 `inlineWritesDisabled === false`（human 用 `doc.inline_policy` 显式开启，事件 `project/updated`）才恢复未迁移内嵌文档的旧写语义；迁移后档案永远只读。新项目创世记录即 `inlineWritesDisabled:true`，缺字段的旧项目按禁用处理。
- HTTP 和工具对 `doc.put/link` 由 core 在获取 writer 前校验形状与可判定的拒绝条件，再由串行命令用最新状态重验。`put` 的 links 在目标类型和策略之前检查，`link` 的 links 在串行阶段通过目标与策略检查后处理。日志回放失败直接报错。工具在获取 writer 后维持正常会话活性和项目跟踪。
- 事件只存 `{id, rev, title, kind, hash, size, links, createdAt, updatedAt}`。
- 外置文档（`source: 'external'`）与内嵌同集合，事件 `doc/external-registered|updated|relocated|unregistered|confirmed`，不存正文；冷开对整条日志（含快照覆盖段）做文档结构扫描；`query('docs')`/任务 `linkedDocs` 的行带 `source`（`inline`/`external`），外置行没有 `hash`/`size`；语义、工具/HTTP 表面、观测与回退见 [EXTERNAL-DOCS.md](EXTERNAL-DOCS.md)。
- `doc/content-fixed` 为 applied，投影不可变 `state.fixedContents`；store append 写前、全量回放、快照覆盖段与固定索引都验证新增 task 证据的同 commit 屏障。Git 正文不写入看板 blob；获准来源记录在 project.gitContentRepository，身份层只提供本机绑定根。
- `doc get` 读 blob；hash 不符 → `hash-chain-broken`。

### 2.9 存储

`rootDir/execution.key`：旧版 command/test proof 密钥。新实现不读取、不创建；旧密钥即使留在磁盘上也不参与任何判定，既有日志里的 `execution` 只按数据回放。

`rootDir/projects/<projectId>/...`：
~~~text
meta.json      {schemaVersion:3, projectId, workspacePath, name, createdAt}（v2 必须离线迁移；见 MIGRATION.md）
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
- 冷开：逐物理行解析并即时校验 version/seq/prev/hash/events 数组，第一处错误带 `validSeq/validHash/line/reason` 拒绝加载；空行不计 commit，但计物理行。先完整验证，再做任何可写尾规范化，随后读 snapshot（校验 hash 与 seq）并重放尾部。缺 LF 的合法完整 JSON 记录保留，可写打开补 LF；仅不可解析且未终止的最后片段允许丢弃。中段坏 JSON、坏 hash/版本等都不得先改原日志再报错。规范化使用 tmp + fsync + rename 并确认完整 JSONL 后才可追加；无法确认则 fail-closed。`JsonlStore({lock:false})` 对两种尾部均零写；普通可写 open 在校验前可能创建项目/blobs 目录及自身 lock/heartbeat，失败关闭时只清自身锁，不改 meta/snapshot/日志，不生成日志修复 tmp。
- 普通回放、MemoryStore 与快照尾部回放均拒绝未登记事件（`incompatible-event`，见 §2.9.1），不默默忽略未知类型。离线 salvage 严格检查事件类型（包括当前发出的已知审计 no-op），未知事件所在整个 commit 不纳入前缀；prefix repair 拒绝任何可解析行中的未知事件/不支持版本。salvage 与显式 repair 的操作边界见 §5.1。
- 每 200 commit 写 snapshot（tmp + rename）。
- 锁：获取先原子创建 `lock.json.claim` 目录（`mkdir` + owner.json）；同机 pid 存活时，无论 mtime 多旧都不回收（活进程可能暂停）；同机 dead pid 才能把整个 claim 目录 rename 成 tombstone。rename 后必须复核 tombstone 里的 owner nonce 与被判死的 owner 一致：不一致说明已被其他 contender 替换，立即 rename 回，绝不删除；无 owner 的旧空 claim 也只有 tombstone mtime 仍过期才删除。临界区内读/决定/写 `lock.json`；跨主机不自动接管（需人工 force-unlock）。心跳写 `lock.json.hb.<nonce>`，旧 owner 不能靠心跳覆盖新 owner；append 前复核 `lock.json` 的 pid+nonce。
- `MemoryStore` 用于测试，接口相同。
- 局部真实磁盘故障测试通过 `storeFactory: (dir, meta) => new JsonlStore(dir, meta, { fs: adapter })` 注入每 store 的写适配器，覆盖 append/sync、snapshot、blob 和 relocate meta 写入；默认仍用原生 fs，锁和读保持真实，不修改全局 fs。`test/storage/store-faults.test.mjs` 用最小环境白名单启动合成 fixture worker，纳入默认与 CI 测试。

**2.9.1 事件兼容契约（fail-closed）**

`lib/shared/events.js` 的 `EVENT_REGISTRY` 是唯一分类表。读到未登记的类型时**拒绝打开**，不做任何猜测。

| 类 | 含义 | 读方行为 |
|---|---|---|
| applied | 本版本理解并投影 | 正常应用 |
| additive | 本版本不需要；同一 commit 的已知事件携带完整状态 | 允许 no-op |
| migration | 语义无法推导，需要显式迁移 | 拒绝，提示迁移 |
| refuse（默认） | 未登记/未知 | 拒绝打开 |

- additive 必须可证明：同一 commit 有携带完整实体的已知事件（`task/updated`、`task/rejected` 等），并有测试覆盖。当前 additive：`task/meta-edited`、`task/assignment`、`session/checkpoint`、`session/handoff`、`lease/expired`、`lease/revoked`。
- 拒绝时抛 `incompatible-event`（409），details = `{projectId, seq, type, compatibility, hint}`；不写状态、不改日志。
- 快照是 writer 的状态快照，不替代日志兼容检查；冷开先检查整个日志的事件类型（含快照覆盖部分），通过后才允许尾部规范化和快照回放。切换代码前保留快照（见 RELEASE.md）。
- 降级规则：日志出现 refuse/migration 事件时只能恢复切换前快照，不能只换代码目录；只含 additive 事件不代表字段语义可降级：schema v3 审计门虽不增加事件类型，旧代码可能静默丢门，只能恢复迁移前备份 + 旧构建。

运行时只接受 schema v3。v2/缺失版本返回 `schema-migration-required`，在可写尾修复前拒绝；没有运行时旧门字段解析器。维护者在停宿主后使用发布包外的 `scripts/migrate-gate-v3.mjs --store <absolute-store-dir> [--apply] [--backup <outside-source-dir>]`。默认 dry-run 零写；apply 备份后追加 project/updated schemaVersion3、全量 task/updated，以及受影响草稿的既有 plan/updated；不新增事件，不重写历史。meta/snapshot 升至3；回滚仅恢复迁移前备份 + 旧构建。详细流程见 [MIGRATION](<MIGRATION.md>)。

### 2.10 Digest

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
- RULES 的权威副本在系统提示（§3.4）；`includeRules:false` 是 `view=brief` 的去重通道，不是"取消规则"。细则见 §3.4.1。

---

## 3. Host 集成

### 3.1 入口

`lib/index.js` 命名导出：

~~~js
export const name = 'project-board'
export const inject = ['tools', 'systemPrompt', 'agents', 'sessions']
export function apply(ctx, config) { ... }
~~~

- 不导出 default（会丢 inject）。
- `config.rootDir` 默认 `~/.dsh/project-board`（优先 `DSH_HOME`）。`config.mcp` 为可选本机 MCP 配置，见 §3.7。
- `ctx.get('webServer')` 可选；没有则只注册工具/提示词，不注册路由。
- `ctx.effect(() => () => service.close(), 'project-board.close')`。

### 3.2 生命周期

`agent/created`（async，必须快且不抛）：

1. `cwd = agent.session?.header?.cwd`；无则返回。
2. `handle = await service.openByWorkspace(cwd)`；无则返回。发现规则见 [IDENTITY.md](<IDENTITY.md>)：本机绑定 → 项目标记 → 关联 worktree 映射到主 checkout；未命中再以 lock-free 方式扫描各项目日志的 `project.workspacePath` 并自愈 meta。`createProject` 先走同一发现，避免搬迁后静默创建第二块看板。
3. `await handle.attach({sessionId: agent.id, agentId: agent.id, source, role: 'worker'})`。
4. `agent.ctx.inject(['systemPrompt'], scope => scope.systemPrompt.section({name:'project:brief', order:9000, text:()=> handle.digest(agent.id)}))`。
5. 记录 `session -> handle`。

`agent/disposed`：`handle.detach(agent.id)`。  
`apply` 时对 `ctx.agents.list()` 也执行一次。

### 3.3 工具

5 个，按域在 `lib/host/tools/*.js` 注册（`lib/host/tools.js` 是兼容壳；运行时经
`lib/index.js` → `lib/host/tools/index.js` 注册）：

| 工具 | 关键参数 |
|---|---|
| `project_board` | view: brief/board/task/plan/plans/docs/doc/events/health; taskId?; docId?; planId?; limit?; maxBytes?; fresh? |
| `project_plan` | op: create/publish/revise/rename/archive/unarchive/focus/adopt/release; planId?; expectedRev?; baseVersion?; stepId?; taskIds?; title?; goal?; assumptions?; risks?; steps? |
| `project_task` | op: create/update/gate/ready/claim/begin/renew/submit/verify/reject/block/interrupt/unblock/release/reconcile/cancel/reopen; taskId?; expectedRev?; requiresAudit?; audit?; unassign?（human-only）; intent?; sideEffects?; ... |
| `project_doc` | op: get/put/list/link + register/inspect/update_meta/relocate/confirm/unregister/list_external; docId?; title?; kind?; body?; baseRev?; links?; maxBytes?; bindingId?; relPath?; expectedMetaRev?; expectedContentHash?; status?; reason?; includeUnregistered?; fresh?; preview? |
| `project_session` | op: init/checkpoint/handoff; name?; note; nextActions? |

- 解析 cwd：`exec.agent.session.header.cwd`；无 agent → 抛错。
- `handle.touch(exec.agent.id)` 续租。
- actor：`{kind:'agent', sessionId: exec.agent.id, agentId: exec.agent.id, callId: exec.callId, via:'tool'}`。
- `project_plan publish` 在无项目时用 cwd 创建。
- 工具错误：把 `BoardError` 转成 `new Error(JSON.stringify({code,message,details,next}))`。
- `output.schema` 用宽松 `{type:'object'}`；`output.render` 返回一段短文本；`presentCall` 返回 `{card:'generic', title, kind:'other', rawInput:args}`。
- 工具描述必须写清：先读后写、expectedRev、submit 不带 done；普通任务可由任意授权 agent verify（含提交者）；审计门需独立 agent 带 audit.report，human 始终可验收。

### 3.4 Prompt

`lib/host/prompt.js` 提供 `installPrompt(runtime, agent)`（装配期调用，`disposePrompt` 对称清理）：

- 用 `agent.ctx.inject(['systemPrompt'], ...)`。
- section name `project:brief`，order 9000，text 动态：每次装配读该会话当前 handle，没有项目时返回空字符串。
- **这是规则块的唯一权威投递点**：digest 的 RULES 段经由这里进入模型上下文；section 每请求重建，压缩后仍然在。
- 同一个 section 的存在也是"该会话已持有规则"的判据：`runtime.promptFibers.has(sessionId)`。host 工具据此决定 `view=brief` 要不要再带 RULES。
- 不注册第二个规则 section；新增或修改规则一律改 `lib/core/digest.js` 的 RULES 块。

### 3.4.1 brief 的去重契约

`project_board view=brief` 的结果是系统提示那段 digest 的**兜底副本**：

| 会话状态 | 传入 `handle.digest` | 输出 |
|---|---|---|
| `runtime.promptFibers.has(sessionId)` 为真（已挂 section） | `{ includeRules: false }` | 不含 RULES；其余各行与系统提示逐字节同一 |
| 为假（非 agent 会话 / 注入失败 / 无 agent） | 默认 `true` | 完整 digest，规则不能丢 |

- 两条路径都走同一个 `handle.digest` 确定性入口；`view=brief` 的返回结构（`digest` 字段 + brief 视图字段）不变。
- 本节只负责 RULES 段去重；整段视图的重复投递见 §3.4.2。两者都**只允许在生成时去重，不允许事后裁剪**——事后裁剪会让裁剪点之后的 KV cache 全失效。

### 3.4.2 只读视图的同参同文短路

`project_board` 的只读视图（除 `brief`）在同一会话、同一组参数、且**本次渲染结果与上次逐字节相同**时，只回一行：

~~~text
board rev <N> unchanged since <seq> (fresh=true to reprint)
~~~

- 判据是**渲染结果的逐字节比较**，不是 `rev` 相等：租约过期这类只随时间变化的状态不产生事件，用 `rev` 判会漏。
- 记忆只在 host 适配层（`lib/host/tools/board.js`），不进 core；core 的 digest 仍是 `(state, sessionId, includeRules)` 的纯函数。
- `fresh: true` 永远重印全文——压缩可能已经丢掉先前那次输出，agent 需要能拿回来。
- 文本有任何变化（卡片、计数、租约、计划状态）→ 照常全量返回；短路只省重复，不改内容。

### 3.5 HTTP

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
| PATCH | /projects/:id/docs/external/:docId | 元数据与状态（doc.external.update_meta） |
| POST | /projects/:id/docs/external/:docId/relocate | 重定位（doc.external.relocate） |
| POST | /projects/:id/docs/external/:docId/confirm | 写确认基线（doc.external.confirm） |
| POST | /projects/:id/docs/external/:docId/unregister | 解除登记墓碑（doc.external.unregister） |
| POST | /projects/:id/docs/external/:docId/fixed | 只读固定 Git 正文；fixed 或完整 commitOid/pathAtCommit，bindingId?；schemaVersion=1，不生成证据 |

外置端点登记在 `lib/shared/contract.js` 的 `API_PATHS`（`docsExternal`、`docsExternalDoc`）。外置接口的返回带 `schemaVersion:1`；写入 body 必须是 JSON 对象，字段白名单是 `DOC_EXTERNAL_WRITE_FIELDS` + 信封字段 `cmdId`/`schemaVersion`，未知字段、非 1 的 `schemaVersion`、与 URL 不一致的 `docId` 都在 `service.open` 之前以 `invalid-command`(400) 拒绝，因此 400 不会触发冷项目恢复写入。`GET /projects/:id/docs/:docId` 仍只解析内嵌正文，访问外置记录返回 `external-doc-operation-required`(409)；`GET /projects/:id/docs` 两种来源都列，行内 `source` 为 `inline`/`external`，外置行没有 `hash`/`size`。

返回：成功 `{ok:true, ...}`；失败 HTTP status + `{ok:false, error:{code,message,details}}`。

task/board/brief 的审计门摘要使用 `audit=1`，最近验收使用 `lastAudit` 与 `by.kind`；agent 的普通通过标为「AI验收（自述）」，审计记录标为「AI审计（自述）」，human 标为「人类验收记录」。UI gate/verify/reject 服从当前 allowedOps；已授权的网页操作使用 human actor。人类在 review 仍可开门，human verify 不要求报告。抽屉展示验收者、时间、报告、清单、证据 digest 和 warnings。

### 3.6 工具返回里的 projectId

所有 `project_board` / `project_task` 返回必须带 `projectId`，供内联卡片使用。

---

### 3.7 可选本机 MCP

`mcp.enabled` 默认关闭。插件配置省略 `mcp` 或 `enabled`、设为 `false`、传入非布尔值均不启动监听。仅配置自身的布尔值 `enabled: true` 启用。`mcp.port` 默认 `33109`，取 1 至 65535 的整数。配置、凭据或绑定失败时记录安全提示，网页和 DSH 工具继续运行。开关随插件配置加载生效，插件卸载关闭监听和读取工作。

启用时，端点为 `http://127.0.0.1:<port>/mcp`，与网页路由独立。传输层使用无会话的 Streamable HTTP JSON 响应，支持 `2025-11-25`、`2025-06-18` 和 `2025-03-26`。每个请求均校验本机地址、来源以及 `Authorization: Bearer …`。DSH 进程环境中的 `PROJECT_BOARD_MCP_TOKEN` 必须是 32 字节随机密钥的小写十六进制表示。Codex 配置通过环境变量引用相同凭据。该凭据能读取本机项目和任务的下述视图。密钥由启动环境保管。

| 工具 | 参数 | 返回 |
|---|---|---|
| `list_projects` | `limit?`, `after?` | `{projects, nextCursor}`。项目包含 id、名称、阶段和读取水位。不可读项目明确标记 `available:false` 并附安全错误。 |
| `list_tasks` | `projectId`, `state?`, `limit?`, `after?` | `{projectId, projectRev, tasks, nextCursor}`。卡片包含 id、标题、状态、任务版本和优先级。 |
| `get_task` | `projectId`, `taskId` | `{projectId, projectRev, task}`。详情额外包含描述、验收项及证据计数。 |
| `get_work_context` | `projectId`, `taskId?` | 从同一只读水位获取开工上下文。指定任务时返回任务详情，未指定时给出待确认的任务候选。 |

列表默认 30 条，上限 100，按 ID 排序。`nextCursor` 为下一页的 `after`，空值表示结束。每次读取独立取已验证水位。任务长字段和验收项数量有上限，`truncated` 标记裁剪。MCP 任务视图不公开 fencing token、运行时租约、工作区路径或证据正文。

明确指定任务、续做已知项目或交付已有任务时，先使用 `get_work_context`。项目 ID 须由可信上下文提供或经 `list_projects` 确认。工具不按本地路径、标题或名称猜测归属。返回 `{projectId, projectRev, project:{name,phase}, task, candidates, candidateCount, nextAction, stageWork}`，阶段提示与 brief 同义。

- 指定 `taskId` 时返回 `get_task` 的任务详情，加上 `requiresAudit` 和 `blocker`。阻塞信息来自当前任务记录，返回 `{code,note,truncated}` 或 `null`，code 上限 128、note 上限 400 个 UTF-16 代码单元。任务不存在返回 `not-found`。候选为空。
- 只指定项目时 `task:null`。候选是最多 5 个未结任务的摘要，先按 interrupted、in_progress、review、blocked、ready、backlog 排序，同状态按最近更新、再按 ID 排序。即使只有一张候选也须确认它与用户请求一致。`candidateCount` 是全部未结任务数。
- 项目查询的 `nextAction` 为 `select_task` 或 `no_open_task`。按 backlog、ready、in_progress、review、blocked、interrupted、done、canceled 的顺序，任务查询分别返回 `check_dependencies`、`check_claim`、`check_work_session`、`check_review`、`inspect_blocker`、`reconcile`、`read_outcome`、`read_outcome`。这些值只按已记录的任务状态给出提示。操作资格由写入口按项目、会话、租约和审计守卫重新判定。

同进程 writer 已打开时，从它已发布的状态取视图。其他情况下在锁外验证并投影可观测的日志前缀。其他进程正在写入时，锁外读取无法确认日志是否已完成同步，读取水位只供展示。读取不会创建项目、获取 writer、修尾、恢复任务或续租。视图中的 `in_progress` 来自日志状态，活跃租约由运行时另行判断。

#### 3.7.1 写凭据与工作会话

- 写入需同时启用 MCP 和 `mcp.write.enabled: true`，并设置 `mcp.write.projectIds` 为非空项目 ID 数组。另在启动环境提供独立的 `PROJECT_BOARD_MCP_WRITE_TOKEN`，同为 32 字节随机密钥的小写十六进制表示。缺失、格式错误或与读凭据相同均只关闭写入。每个凭据只发现和调用本类工具。网页与 DSH 工具沿用各自的授权。
- 写操作始终使用显式 `projectId`。项目授权、参数白名单、工作会话及其项目范围均在打开 writer 前校验。有效写请求打开冷项目时，沿用现有的 writer 恢复流程。工作区绑定继续负责目录发现和文件证据边界。
- `open_work_session({projectId})` 签发该项目的 `{sessionToken, expiresAt}`。每个 Agent 工作会话分别申请并保留自己的 token，同一工作会话处理任务和审查时复用它。它是会话凭据，24 小时内可重连，插件重新加载或 DSH 重启时失效。签发不打开项目或写入日志。首次成功领取将 `session/bound` 与任务事件写在同一 commit。服务端根据签发的工作会话生成 `actor`，归因为 `kind:agent`、`via:mcp` 及该会话独有的 `codex:mcp:<id>`。既有 `codex:mcp` 归因随历史保留。请求不可提供 actor、session ID 或角色。
- 禁用写开关、从授权清单移除项目或轮换写凭据后重新加载插件，既有工作会话失效。已经提交的记录保留，现有租约由 core 到期或重启恢复流程收口。归因粒度为共享此写凭据的 Codex 集成及其服务端工作会话。

#### 3.7.2 任务写操作

下列工具均接受 `projectId`、`sessionToken` 和 `requestId`，可选 `projectRev` 用于项目 CAS。已有任务的操作还需要 `taskId` 和当前任务 `rev`（参数 `expectedRev`）。每次新操作给一个新的 `requestId`（1 至 128 个字母、数字、点、下划线或连字符）。`begin_task`、`submit_task`、`release_task` 和 `interrupt_task` 要求领取返回的 `fencingToken`。

| 工具 | 额外参数 | 结果 |
|---|---|---|
| `create_task` | `title`, `acceptance`, `description?`, `priority?`, `weight?`, `deps?`, `labels?`, `requiresAudit?` | 创建独立任务并返回系统生成的 `taskId`。依赖就绪时进入 `ready`，否则进入 `backlog`。 |
| `update_task` | `title?`, `acceptance?`, `description?`, `priority?`, `weight?`, `deps?`, `labels?`, `requiresAudit?`, `reason?` | 编辑元数据。状态、依赖、租约归属和审计门沿用 `task.update` 的 agent 校验。 |
| `ready_task` | — | 验收项齐全且依赖完成时将 `backlog` 置为 `ready`。 |
| `claim_task` | — | 领取既有可领任务，返回 `lease: {fencingToken, expiresAt}`。 |
| `begin_task` | `summary`, `plannedSteps?`, `expectedArtifacts?` | 执行前写入 open intent。 |
| `submit_task` | `evidence` | 沿用 core 证据校验，成功进入 `review`。 |
| `verify_task` | `audit?` | 普通任务允许任意授权 Agent（含提交者）在 `review` 记录通过；审计门要求独立 Agent 并提供 `audit`。成功后进入 `done`。 |
| `reject_task` | `reason`, `audit?`, `fencingToken?`, `intent?` | 驳回 `review`，沿用 core 的租约、意图和返工规则。持有活动租约时须携带该租约的 token。 |
| `release_task` | `note?`, `intent?` | 放回 `ready`。有 open intent 时传 `intent: {outcome:"stopped", sideEffects, note?}`。 |
| `interrupt_task` | `note`, `sideEffects?` | 执行结果未知时进入 `interrupted`，由现有入口对账。 |

MCP 审查沿用 §2.6 的 `audit={report,checklist?:[{item,ok,note?}]}`、验收项和证据漂移校验。审计门的独立性按会话和既有 worker 记录判断，无法识别由同一操作者另开的会话。Agent 的验收和审计报告均为自述。人类可验收所有任务。漂移时可驳回返工或交给人类处理。MCP 不接受漂移刷新、豁免或清除委派参数。

成功返回 `{projectId, taskId, projectRev, taskRev, state, deduped}`，版本和状态是响应时可见的已提交状态。提交和验收回执可包含仅带错误码和严重程度的证据警告。原样重试同一工作会话、工具和参数会去重。创建重试返回原任务 ID。改动参数会产生新命令并重新校验版本与租约。领取重试只有在原授予的租约仍可用时才返回其 token，其他情况返回 `lease:null`。收到 `lease:null`、`stale-revision` 或 `fencing-stale` 时先重新读卡。出现 `log-write-uncertain` 或工作会话失效时，先核对日志和实际副作用再继续。租约沿用项目 TTL 与宽限期，超期或重启后按 §2.6 回收。驳回、解阻或重开可以产生待重新领取的任务，系统不向 MCP 会话隐式发放新租约。MCP 工具错误仅返回稳定错误码和安全提示。

#### 3.7.3 与 DSH 原生 Agent 工具的差异

MCP 按上面的读、写凭据分别提供目录，使用显式项目 ID。DSH 原生工具按已绑定的工作区解析项目。两端的 Agent 操作均受领域守卫约束。以下能力仍使用原生工具或已授权的网页入口。

| 原生工具 | MCP 已覆盖 | 仍缺的原生能力 |
|---|---|---|
| `project_board` | 项目和任务列表、任务详情、只读开工上下文 | 会话级租约和交付摘要、完整看板及任务 `allowedOps`、时间线和证据详情、计划/文档/事件/健康视图 |
| `project_task` | 建卡、编辑、就绪、领取、开始、提交、验收、驳回、释放、中断 | 独立的审计门调整、主动续租、阻塞/解阻、对账、取消、重开 |
| `project_plan` | — | 计划草稿、发布、版本管理、焦点和任务归属 |
| `project_doc` | — | 文档查询、登记、管理、定位和固定内容读取 |
| `project_session` | 项目工作会话签发 | 工作区初始化、检查点、交接 |

MCP 评审者通过已获授权的工作区或原生工具获取证据材料。人工验收继续使用网页入口。

## 4. Client（浏览器半）

源码在 `src/client/**`；`lib/client.js` 是 `npm run build:client` 生成的**唯一运行时 bundle**
（esbuild 只在开发期跑，产物提交进仓库）。构建外壳仍与 `dsh-button-plugin/lib/client.js` 一致：

~~~js
window.__ModuleLoader__.load({
  id: 'dsh-project-board',
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

契约要点：

- 4 个 slot：`main`（key `project-board`）、`sidebar.panellist`（id `project-board`, order 50, label「项目板」）、
  `conversation.session.header.utilities`（id `project-board-jump`，`inject().onOpen(cwd)`）、
  `tool.call.toolview`（key `project_board`，`inject().openPanel()`）。
- 只 require `react`；不 require ui-primitives，不新增运行时依赖。
- 命令与端点白名单**不**由 client 导出：`COMMAND_OPS` / `API_PATHS` / `TOOL_NAMES` 在
  `lib/shared/contract.js`，`test/client/client-smoke.mjs` 直接 import 共享契约做冻结断言
  （`exports.COMMANDS` / `exports.API_PATHS` 必须为 `undefined`）。
- 样式（M2 起）：`src/client/styles.css` 一次性注入 `<style data-plugin-css="dsh-project-board/ui.css">`
  的 `.pb-*` 样式表 + `--pb-*` 语义 token；token 映射宿主 `--dsw-*` 并带回退值，暗色走
  `[data-ds-dark-theme]`。原「样式全部 inline」作废（inline 无法表达 `:hover` /
  `:focus-visible` / `@container` / `prefers-reduced-motion`）。
- 禁止 `dangerouslySetInnerHTML` / `innerHTML`；文档正文按纯文本/简单 markdown 渲染
  （标题/列表/代码块/粗体/表格/chart DSL）。
- 数据：`src/client/transport.js` 是唯一 fetch 入口，`globalThis.__PROJECT_BOARD__` 取 token；
  `hooks.js` 轮询 2s，`document.visibilityState==='hidden'` 暂停；`races.js` 的请求票据保证
  迟到响应不覆盖新状态。
- 组件分布：`views/board-page.js`（BoardPage）、`views/task-drawer.js`（TaskDrawer）、
  `views/docs.js` + `views/doc-reader.js`（DocsPane）、`views/health.js`（HealthPane）、
  `views/plans.js` + `views/plan.js`（PlanPane）、`slots.js`（ToolCard / PanelIcon / QuickEntry）。
- 项目选择：localStorage `projectBoard.lastProject`；列表来自 `GET /projects`；无项目时显示创建表单
  （workspacePath + name）。
- TaskDrawer 动作按钮：claim/begin/submit/block/release/reconcile/verify/reject/cancel，
  以及 gate/reopen/override（按 `allowedOps`）；submit 用简单表单（summary + kind=note + acceptanceId）；
  按钮根据 `allowedOps` 禁用。
- 证据行只做轻量来源区分：file/doc 内容观测显示「内容指纹已记录」，固定 Git 不可观测显示「Git 不可观测」；command/test 显示「提交者自报」，历史 `execution` 行显示「历史执行记录」。不再用 success 徽标把哈希采样写成「已校验」。漂移豁免面板只列 file/doc 内容漂移（file-drift/doc-drift/file-missing/doc-missing），命令执行失败或执行凭据不属于豁免。
- 冲突 409：显示当前 rev 与消息，提供“刷新”。
- ToolCard：从 block content 取文本摘要；按钮 `props.openPanel()` 调 `ctx.layout.selectPanel('project-board')`。

client-smoke 测试（`test/client/client-smoke.mjs`，`npm run test:client`）：

- 用 fake `window.__ModuleLoader__` 捕获 load options；fake `require('react')` 返回最小 React stub；
  调用 factory；调用 apply 传入 fake `ctx.slots.inject/register`；断言 4 个 slot 及其
  key/id/order/label 与 `inject()` 返回值。
- 纯逻辑测试从 bundle 的 `__test`（54 键）取函数（filterCards / markdownBlocks /
  chartLayout / buildEvidence / commandBody / percentOf / stateTone / nextActionFor /
  planCanFocus 等）；组件与样式表从 `__ui`（27 键）取（`__ui.css`、`__ui.BoardView` 等）。
- 命令与端点冻结断言读 `lib/shared/contract.js`；源码里 `api('/…')` 前缀白名单；
  无 `dangerouslySetInnerHTML` / 无 `innerHTML`；只 require `react`；样式表含亮/暗 token、
  `:focus-visible`、`@container`、`prefers-reduced-motion`；无 DOM 渲染
  BoardView / TaskDrawer / DocsPane 不抛错。
- 再次 `apply` 不抛错（按挂载重复注册；样式注入幂等）。

---

## 5. CLI / 测试

### 5.1 CLI

`node scripts/deck.mjs <cmd> ...`，至少：

~~~text
init --workspace <path> [--name]
plan --workspace <path> --file <plan.json>
claim --workspace <path> --task <id>
begin --workspace <path> --task <id> --summary ...
submit --workspace <path> --task <id> --note ... --evidence <kind>:<ref>
verify --workspace <path> --task <id>
board --workspace <path>
brief --workspace <path>
~~~

用 `--json` 输出机器可读。CLI 只用于开发、诊断与 dogfood，不是产品接口；产品使用形态包括 UI、DSH agent 工具与可选本机 MCP。维护脚本独立于安装包。

离线损坏诊断与维护（参数不提供真实 store 默认值）：

```text
node scripts/salvage-log.mjs --root <absolute root> --project <id> --view board|health|events
node scripts/repair-log.mjs --root <absolute root> --project <id> [--keep head|tail] [--apply] [--force]
node scripts/repair-log.mjs --root <absolute root> --project <id> --truncate-to-valid-prefix
node scripts/repair-log.mjs --root <absolute root> --project <id> --truncate-to-valid-prefix --apply --confirm-data-loss <validHash>
```

- salvage 只读指定项目的 meta 与日志，不初始化 ProjectService/ProjectHandle，不 restore/recover，不使用 snapshot，不获取/清理锁，不写 root、meta、snapshot、tmp 或日志。返回 JSON，所有视图均标 `mode=read-only-prefix`、`current=false` 与显著“只读前缀，非当前状态”；`validSeq/validHash` 标明最后完整理解的 commit。边界诊断为 `partial`、exit 2（包括未知事件/版本），合法前缀输出 exit 0，读取/投影/参数失败 exit 1。事件兼容拒绝沿用 `reason:"unknown-event"`，附普通打开的诊断文案、项目 ID、事件类型、seq、分类和处理提示。health 只检查前缀的状态不变量，不证明当前日志健康、blob 内容或证据可用。events 包含前缀的全部事件索引。无一致读锁的在线观察可能随并发写变化，维护前应人工停写。
- `repair-log` 是唯一显式日志修复入口：普通模式修复可验证的 fork，不支持任意坏 JSON/hash；所有 dry-run 零写。prefix 模式仅支持坏 JSON（含不完整半尾）、seq、prev 或 hash 边界，保留原字节前缀，丢弃坏物理行及全部后继，拒绝空前缀、未知事件与不支持版本；不跳过坏行拼接尾部。输出丢弃物理行/字节范围、validSeq/validHash；后继 seq 不可信，RPO=validSeq，所有后继已发生业务状态可能丢失，外部副作用不会回滚。
- prefix apply 必须再次确认 validHash；任何现有 `lock.json`/`lock.json.claim`（含 stale）都拒绝，不允许 `--force`。人工先停写，再复用合作写锁，确认日志未变，以独占备份文件保存并 fsync 原字节后复核锁/原字节，再 tmp+fsync+rename。只清理本次自身锁，不自动删旧锁；不承诺对无视锁的 OS 写者提供原子隔离，也不承诺目录 fsync 的断电持久性。I/O 失败可能留下备份/tmp 供人工核对，不能盲目重试。恢复备份是独立人工决定，不可在新写入后盲目覆盖；代码回退不恢复被丢弃的状态。

`bin/wt.mjs`（当前 `bin` 仍暴露安装命令 `project-board-wt`）是维护者自用的 worktree 工具，不属于产品开源/发布面；把它移出发布包、与产品入口隔离的打包工作尚未完成。命令：`open / test / merge / close / list`。测试命令解析顺序：`package.json` 的 `scripts.test` →
`test/`、`tests/` 下的 `*.test.mjs` → `test/client/client-smoke.mjs`；缺 `node_modules` 时跳过导入裸包的测试。

### 5.2 必须通过的测试

`npm test` = `test:core` + `test:client` + `test:host`（测试数量以当前运行输出为准；migration-replay 的真实 store 用例在未设置 `PB_MIGRATION_PROJECT` 时跳过）。
`test:core` 覆盖 14 个文件，下面是最低必须语义（`test/core/core.test.mjs` 有对应 12 条）：

1. publish → 任务状态正确（无 deps ready / 有 deps backlog）。
2. claim 成功；第二次 claim → lease-held。
3. expectedRev 过期 → stale-revision，状态不变。
4. cmdId 重复 → deduped，只有 1 个 task/claimed。
5. done 级联：依赖任务 ready。
6. submit 缺 evidence → missing-evidence。
7. file evidence hash 不符 → 拒绝。
8. interrupted 恢复：写一条 begin 后模拟重启 → recover 后 interrupted；reconcile(completed) → review。
9. 重放：同一 commits → 深相等 state；snapshot+tail = full replay。
10. 截断尾行：最后一行不完整 → 打开成功，最后合法 commit 生效。
11. 并发：10 个并发 claim 同一 task → 恰好 1 成功。
12. 进度：done/total 推导；没有手动百分比。
13. 多计划并发：两个 active 计划交错 revise（各自 baseVersion CAS）、focus 切换、archive 拒绝 live work、adopt/release version+1、orphan 归位、digest 字节稳定。
14. 迁移/回放：复制项目 store 到 temp 后 open，rev/任务数/planHeads/focus/health 与复制前一致；副本可重复 open；原目录逐字节不变（真实 store 用例用 `PB_MIGRATION_PROJECT` 选择加入，CI 可重入）。
15. 计划外/orphan 任务：副本上计数并断言保持不变；不 adopt、不自动归位。

补充入口：

- `node test/client/client-smoke.mjs`：见 §4（bundle 冒烟 + 4 slot + `__test`/`__ui` + 冻结断言）。
- `node test/host/host-preflight.mjs`：fake ctx 注册 5 个工具，断言名称和 schema 存在。
- `node --test test/ops/architecture-map.test.mjs`：ARCHITECTURE 的 arch-map 与磁盘零缺失。
- 不依赖本机 DSH junction 的 CI 子集：`npm run test:ci`（core + client）。

### 5.3 编码约束

- 全部 ESM，`"type":"module"`；Node **22**（`node --test` / `fs` recursive 的下限）。
- **运行时无构建**：`lib/core`、`lib/host` 是手写 ESM，直接被 Node 加载；
  `lib/client.js` 是提交进仓库的 bundle，插件运行时不执行打包。
- **开发期可构建**：改 `src/client/**` 后跑 `npm run build:client`（esbuild 0.28.2，
  在 `tools/build/` 隔离安装），产物与源码一起提交。构建只在开发机发生。
- **TypeScript 仅开发期检查**：仓库的 `npm run typecheck` 使用隔离工具链与后端配置，`noEmit`，不改变运行入口或客户端；现有 JS 未全量开启语义检查。共享基础规则与 Node 专用配置分离；全量迁移与前端 TS/TSX 不属于当前实现。
- 样式只写在 `src/client/styles.css`，由 esbuild 以 text loader 内联；不要塞回 JS 字符串。
- 不引入第三方运行时依赖（除 `@deepseek-ai/dsh-tools` / `dsh-home-paths` 等宿主已有包）。
- 时间/随机可注入，便于测试。
- 文件写入用 `fs.writeFileSync` + `fsyncSync`；原子替换用 tmp + rename。
- 源码规模门禁：单文件 ≤ 450 行、普通函数 ≤ 80 行、React 组件 ≤ 200 行
  （`npm run audit:check`）。

---

## 6. 验收（M0–M4）

- `npm test` 全绿（core + client + smoke + host，数量以当前输出为准）。
- `npm run test:ci` 全绿（不依赖本机 DSH junction 的子集）。
- `npm run audit:check` 零违规（规模 / 分层 / 环）。
- `npm run check:architecture` 零缺失（ARCHITECTURE §2.1 ↔ 磁盘）。
- `node scripts/migrate-plans.mjs --project <id|dir> --dry-run` 在真实 store 副本上输出派生 planHeads、计划外/orphan 计数与 health 摘要，`sourceUnchanged: true`（用法见 MIGRATION.md）。
- 本机装配（`node scripts/install.mjs`）后，模型工具清单出现 5 个工具。
- 看板能从空项目创建一个 plan，显示任务；能 claim/begin/submit；人类能 verify。
- 崩掉/重启后，in_progress 任务变 interrupted，digest 顶部出现 RESUME CHECKLIST。
- 现有 DSH Web 功能不被破坏；回滚只需删 patch 行 + 链接。

---

## 7. 交付给子代理的边界

- **Core 代理**：只写 `lib/core/**`、`test/core/core.test.mjs` 与同组 core 测试、
  `scripts/deck.mjs`。不改 host/client。
- **Client 代理**：只写 `src/client/**`、`test/client/client-smoke.mjs`、`test/client/unit/**`。
  **不手改 `lib/client.js`**（构建产物，由 `npm run build:client` 生成）。不改 host/core。
- **Host 代理**：只写 `lib/host/**`、`test/host/host-tools.test.mjs`、`test/host/routes.test.mjs`、
  `test/host/host-preflight.mjs`。不改 core/client。
- **文档/契约**：`docs/CONTRACT.md`、`docs/ARCHITECTURE.md`、`README.md`/`docs/CONTRIBUTING.md` 由文档维护者改；
  跨面接口变更先改本文件与 `lib/shared/contract.js`，再改代码与快照测试。
- 任何跨面接口变更先改本文件，再改代码。

## 8. 历史读模型 · 送达面与摘要规则

- digest 三段（顺序固定在 `NEXT READY` 之后、`RULES` 之前）：
  - `LAST CHECKPOINT <seq> <at> <note≤160>`
  - `LAST VERIFIED <seq> <taskId> "<title>"`（最近 3 条 `task/verified`）
  - `FOCUS PLAN <planId> "<title>" v<n> <pct>%`（当前 focused plan）
- 所有字段过 `sanitizeField`（单行化 + 截断）；`at` 取事件里记录的 at，不读系统时钟；同状态同 session 必须字节相同。
- 事件渲染（`project_board view=events`）必须带 `actor.kind[:sessionId 尾 6]` 与 `cmdId` 尾 6；`view=task` 必须带 timeline 末 5 条。
- 历史摘要只允许可机械核对的形态（state from→to、acceptance m/n、doc rev n→m、plan version n→m 等）；数据在查询期从 `commits` 的 `data` 取，不写回 timeline 投影、不落盘。
- 索引只认事件自带归属（`event.taskId` / `event.data.id`）；跨实体查询一律查询期 join；禁止用 `doc.links` / `plan.steps.taskIds` / `task.deps` 回填归属（RFC-1 R2）。
- 语义：实体不存在或该时刻不存在 → 200 空结果；`asOf` 非法/越界 → `4xx asof-out-of-range`；`fromSeq` 非法 → `4xx bad-seq`。
