# 方案：驳回/重做保委派人 · 接手交接审计 · 前置依赖可见

> 起因（2026-10-22）：三条用户体验问题——① 驳回/重做直接回「就绪」，委派人丢了；② 任务缺少接手/交接审计；③ 未就绪任务看不出在等哪个前置。
> 做法：只读代码 + 一个内部探针（当时用于核对，未随仓库分发），没有改任何产品代码。落板 7 个任务（T1-T7），依赖链在文末。

## 0. 一句话结论

| 问题 | 现状 | 判定 |
|---|---|---|
| 驳回回就绪 | 真的，而且是**必然**：submit 已删租约、清 owner，reject 只看「有没有租约」，所以永远走 ready 分支 | 实现与 DESIGN T11 不符，按缺陷修 |
| 重做回就绪 | 真的：reopen 无条件 ready，**连 deps 都不看**，实测会造出 ready 却 claim 不了的死路 | 缺陷（两处） |
| 接手/交接审计 | **一半有、一半没有**：事件层记录了 lease 与 session，但读模型把 payload 全丢了；没有「交接」这个动作 | 补写侧事实 + 补归属链读模型 |
| 未就绪看不出前置 | 真的：卡片模型里根本没有 deps 字段，抽屉也没有依赖区 | 读模型 + UI 都要补 |

## 1. 现状盘点（证据）

### 1.1 驳回为什么必回 ready

```
submit  (service.js:1122-1127) → state=review, owner=null, leases.delete(taskId)
reject  (service.js:1172-1179) → const lease = this._leaseOf(task.id)  // 必然是 null
                                 next.state = lease ? 'in_progress' : 'ready'  // ⇒ ready
```

- DESIGN.md:194（T11）写的是「review → in_progress / ready；**in_progress 需新 lease**」，CONTRACT.md:318 同义。代码里没有「新 lease」这一步。
- CONTRACT.md:318 写 reject 的 reason 必填；代码 `String(cmd.reason || '')`（:1178）**从不校验**，空理由也能驳回。
- `allowedOps.reject`（model.js:226）只看 `review`，不看理由。

### 1.2 重做为什���更糟

```
reopen  (service.js:1335-1345) → next.state = 'ready';  // 不检查 deps、不检查 assignee
```

- 探针实测：T_STUCK 依赖的 T1 被 cancel 后，T_STUCK 仍可被 reopen 成 ready，随后 `claim` 报 `dependency-unmet`——一个**点不动的 ready 卡**。
- 同理，`post-submit` 的 deps 变更、cancel 了前置、plan revise 改了依赖，都不会重新核算依赖方状态。
- 级联只在 verify 与 auto-verify 时跑（service.js:1139、1163），cancel 之后没有级联；依赖已 canceled 的任务会永远留在 backlog。

### 1.3 接手/交接：事件有，审计没有

| 已有事件 | 载荷 | 读模型里还剩什么 |
|---|---|---|
| `lease/granted` | taskId, sessionId, agentId, epoch, token, acquiredAt, expiresAt | 只剩 `{seq, at, type, taskId, actor, cmdId}`（store.js:48-55、115-122） |
| `lease/revoked` / `lease/expired` | 同 lease；**无 revoke 原因** | 同上；过期/关闭/手动释放长得一模一样 |
| `task/claimed` / `task/released` / `task/interrupted` | 完整 Task | 同上 |
| `session/bound` / `session/detached` / `session/handoff` | binding / note | 同上；handoff 只是备注，**不搬任务** |

- 客户端的「时间线」只画 `#seq · 代理/人类 · 时间`（client.js:2152-2160）——**谁**、**为什么**都没有。
- `release` 收了 `note` 却直接丢弃（service.js:1219-1240）；`task/readied` 不区分「人工置就绪 / 依赖级联 / 租约过期 / 会话关闭」。
- 没有交接命令：换人只能 `release` + 另一会话 `claim`，两段之间无因果关系，中间还可能被第三人抢走。
- `task.owner` 在 submit 后就置 null，所以 review 状态的任务**没有负责人**，出问题时不知道找谁。

### 1.4 前置依赖：数据在，views 不带

- `cardOf`（model.js:181-199）字段：id/title/state/rev/priority/labels/planRef/owner/acceptance/evidenceCount/blocked/updatedAt——**没有 deps**。看板、brief.next、plan 页全都用它。
- `taskView` 有完整的 `task.deps`（裸 id），但没有标题/状态，没做「哪条没满足」。
- `allowedOps.ready` 的原因恒为 `'deps are not done'`（model.js:237），UI 翻译成「依赖未完成」。
- 客户端 grep `deps` 只有错误文案映射（client.js:118、143），没有任何依赖视图。
- DESIGN.md:185（T2）写了「或有 waiver」，**waiver 从未实现**。

### 1.5 内部探针实测（未随仓库分发）

```json
afterSubmit: { "state": "review", "owner": null, "lease": null }
afterReject: { "state": "ready",  "owner": null, "lease": null, "rejection": { "reason": "needs rework", "by": "human" } }
afterReopen: { "state": "ready",  "depsDone": [["tsk_…", "canceled"]] }
claimStuck:  "dependency-unmet: dependencies are not done"
timelineKeys: ["seq","at","type","taskId","actor","cmdId"]      // 没有 data
grantedPayload: ["taskId","sessionId","agentId","epoch","token","acquiredAt","expiresAt"]  // 只在 commits.jsonl
```

## 2. 方案

### A. 驳回/重做不换委派人（T1）

**核心：把「当前租约」和「这件事归谁」拆开。**

- 新增 `task.assignee = {sessionId, agentId, epoch, at, by}`：claim 时写入，**submit 后保留**，评审期间卡片与抽屉都能看到「这件事谁在负责」。
- `reject`：
  1. reason 必填（对齐 CONTRACT）；
  2. 若 assignee 存在、binding 存在且未 detach、且该会话当前 lease 数 < `maxPerSession` → 用 `_grantLease` 续给原会话，`state=in_progress`，原会话**不必 re-claim**；
  3. 否则 → `ready` + assignment 记录 `cause='assignee-gone' | 'assignee-busy'`，让「为什么换人」可读；
  4. human 可传 `unassign: true` 显式要求回 ready。
- `unblock` 走同一套恢复规则（blocker 解除时回到 in_progress 也续给原会话）。
- `reopen`：先判依赖——deps 未全部 done → **backlog**；满足时若 assignee 仍在 → in_progress，否则 ready。reason 必填。
- 不做：不自动开新会话、不做 autopilot；不改变 `owner` 的语义（owner 仍是「活租约的镜像」）。

**为什么不用「review 期间保留租约」**：评审可能隔天，租约 TTL 900s 会周期性过期；且保留租约会让原会话无法再领别的任务（session WIP=1）。用 assignee 字段 + 按需续租，既保住人，又不占并发名额。

### B. 接手/交接审计（T2）

**写侧补事实，读侧做归属链；不建第二套历史。**

- 新规范事件 `task/assignment`：
  ```js
  { taskId, from: {sessionId,agentId,epoch}|null, to: {...}|null,
    cause: 'claim'|'resume'|'reject'|'unblock'|'release'|'expire'|'detach'|'block'|'verify'|'handoff'|'reopen',
    reason: string, by: {kind,sessionId}, at }
  ```
  在 claim / reject / unblock / release / expire / attach-detach / block / verify / handoff / reopen / reconcile-resume 处统一写。（lease 事件保留，向后兼容；`task/assignment` 是读模型的唯一来源。）
- 投影：`applyEvent`（model.js:36）里累积 `state.assignments[taskId]`。它随 snapshot 持久化、由 commits 重放重建——**没有第二事实源**，重启后不丢。
- 读模型：`taskView` 增 `assignee` 与 `ownership`（倒序、上限 50）；`allowedOps` 增 `handoff`。
- 新命令 `task.handoff`：human 或租约持有者；`to.sessionId` + `reason` 必填；目标必须已绑定且未 detach；效果 = 撤销旧租约 + 授给目标 + 保持 in_progress + 一条 `cause='handoff'` 记录。这是「交接」第一次成为一等动作。
- `release` 的 note、`reject` 的 reason、`block` 的 note 一律进 assignment（并保留原有 task 字段）。
- 与既有规划的关系：[历史、审计、回滚的分层](../decisions/history-audit-rollback-layering.md)决定的「审计 / 历史(A) / 回滚(B)」；本项属于**写侧事实 + 任务级归属链**，A（历史读模型）的 entity 索引以后直接消费 `task/assignment`，不重做一套。

### C. 未就绪任务的前置可见性（T3）

- `cardOf` 增派生字段（全部只读、只放 id/title/state）：
  ```js
  deps: [{id, title, state, done}],
  blockedBy: [...未满足的],        // backlog/ready 卡直接能渲染
  depsState: 'satisfied'|'waiting'|'stuck'   // stuck = 前置 canceled/orphaned，永远满足不了
  ```
- `allowedOps.ready.reason` 具体化：`依赖未完成: 标题(in_progress), 标题2(backlog)`，并把结构化 `blockers` 一并返回。
- 级联补全：`cancel` 之后也跑 `cascadeReady`；依赖方到不了就标 `stuck`（只读标记，不改状态机）。
- 逃生口（兑现 DESIGN T2 的 waiver）：人类 `task.ready` 可在 deps 未满足时带 `waiver` 理由放行，事件保留 `waiver.reason`。
- UI（T5）：backlog 卡「等待 N 个前置」徽章 + 抽屉 `pb-sec-deps` 依赖区（可跳转、stuck 警示）。
- UI（T6）：抽屉 `pb-sec-owner` 负责人区 + 时间线补会话短 id 与原因。

## 3. 迁移与兼容

- 旧任务没有 `assignee`：不回溯伪造；reject 时按 `assignee-gone` 回 ready，与今天行为一致（只是原因可读）。
- 旧 snapshot 没有 `assignments`：加载时初始化为 `{}`（store 打开路径要补默认值，fsck 不报错）。
- 旧 commits 没有任何 `task/assignment`：`ownership` 为空数组，页面显示「本项目开启审计前无记录」。
- 事件只增不改：hash 链、replay、as-of 全部继续成立。

## 4. 风险与待定

- **续租给已死会话**：会让任务被占最多 900s。缓解=只续给「已绑定且未 detach」的会话，且受 session WIP 限制；过期路径会写 `cause='expire'` 并回 ready。
- **在飞冲突**：UI 2.0 P3「任务抽屉重构」（另一个会话中进行）同样改 `TaskDrawer`。T5/T6 应排在 P3 合并之后再动手，否则两边会打架。
- **投影体积**：assignment 全量保留（审计需要）；UI 只取最近 50 条。
- **待定（顺带发现）**：`task.update` 对 agent 需要租约（service.js:935），意味着 **agent 无法给 backlog 任务改依赖**，只能人改。要不要放开「backlog/ready 且无租约时允许 agent 改 deps」？建议在 T3/T4 里定，倾向放开并审计。

## 5. 落板任务（7 条）

| # | 任务 | 优先级 | 依赖 |
|---|---|---|---|
| T1 | 核心：驳回/重做不换委派人 + 依赖守卫 | P130 | — |
| T2 | 核心：接手/交接审计（assignment + 归属链 + handoff） | P135 | T1 |
| T3 | 核心：前置可见性（blockedBy / depsState / 级联 / waiver） | P140 | T2 |
| T4 | 契约：工具参数 + CONTRACT/DESIGN 同步 | P145 | T3 |
| T5 | 客户端：卡片与抽屉的前置依赖可视化 | P150 | T3, T4 |
| T6 | 客户端：负责人 / 接手历史 | P155 | T2, T4 |
| T7 | 回归与文档：三条验收线端到端 + README/CHANGELOG | P160 | T5, T6 |

## 6. 验收口径（怎么算这轮问题真的解决）

1. review → 驳回 → **同一个会话**继续，不需要 re-claim；会话没了才回 ready，且原因可读。
2. 任何一个任务在抽屉里能回答：现在谁负责、上一次是谁、为什么换手（含过期/关闭/交接）。
3. 任何一个 backlog 卡片能回答：在等哪几个前置、各自什么状态、是不是已经 stuck。
