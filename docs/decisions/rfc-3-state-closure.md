# RFC-3 状态收口与归档写闸

> 状态：已替代（现行语义见[实现契约](<../CONTRACT.md>)；正文保留方案或决策时的语境）。

- 状态：Proposed（人审前）
- 日期：2026-10-28
- 范围：`task.block`/`unblock` 与 open intent；新增 `task.interrupt`；`release`/`cancel`/`reject`/`override` 的 intent 收口；archived 项目的写闸与归档前置；DESIGN T/I 表 diff；错误码；向后兼容；S4 租约活性约束。
- 不在范围：锁协议、提交边界/故障注入、salvage、CI 门禁、容量实现（各自有独立任务）。

## 0. 结论摘要

1. **open intent 是 WAL，不是普通状态字段**。它表示“副作用可能已经发生”。关闭它必须带结算记录；不允许静默 `abandoned`。
2. **block 只在“已停止 + 副作用有记录”时允许**。结果不明时 block 必须拒绝，走 `task.interrupt` → `interrupted` → `task.reconcile`。
3. **新增 `task.interrupt`**：把结果不明的任务停到 `interrupted`，保留 open intent，不假装副作用没发生。
4. **`release` / `cancel` / `override` 适用同一判据**；`reject` 做防御性同规则；`unblock` 不重建 intent，回到 in_progress 后必须重新 `begin`。
5. **archived 项目只允许 unarchive**；归档前置严格 A（有 in_progress / live lease / open intent 就拒绝）；入口预检 + 统一提交出口兜底；unarchive 同 commit 携带恢复事件；attach/detach 不落事件；recover 跳过。
6. 新增错误码：`intent-unresolved`、`project-archived`、`project-has-live-work`；`plan-archived` 扩展到所有“进入 in_progress”的路径。
7. **abandoned 的语义收窄**：只表示“这次尝试停止”，不表示没有副作用，也不表示已经回滚。
8. S4 租约活性约束见 §9；本 RFC 只冻结原则，不在本轮实现。

## 1. 现状与问题

当前实现（2026-10-28 工作树）：

- `task.block` 只校验 `lease.sessionId`，不校验 `fencingToken`；block 删 lease、置 `owner=null`，但不清 `work`、不关 open intent → `blocked + open intent`，违反 I6（`lib/core/commands/task-gov.js:13-33`）。
- `task.cancel` / `task.reject` 同样只校验 sessionId（`task-gov.js:167-170`、`lib/core/commands/task-work.js:174-177`）。
- `task.release` 直接 `work/abandoned` 并回 ready（`task-gov.js:79-90`），等于把“可能已发生副作用”当“没发生”。
- `task.override` 可以把 in_progress 改成任意状态，不处理 open intent（`task-gov.js:230-250`），是绕过 I6 的后门。
- `project.update` 可归档而不检查 in_progress/lease/intent（`lib/core/commands/project.js:14-24`）；`recover()` 打开归档项目仍可能追加 task 事件（`lib/core/handle.js:177-187`）；`attach`/`detach` 绕过 `command()` 直接 `_appendEvents`（`handle.js:189-212`）。
- `fsck` 不检查 open intent 与任务状态的对应关系（`lib/core/fsck.js:41-61`）。

## 2. Intent 结算模型

### 2.1 术语

- **open**：`work/intent` 已写，副作用阶段尚未收口；任务只能处于 `in_progress` 或 `interrupted`。
- **closed**：正常 `submit` 或 `reconcile(completed)` 收口，带结果/证据。
- **abandoned**：尝试停止，但没有“副作用没发生”或“已回滚”的承诺；必须带 `closeReason`、`outcome`、`sideEffects`、`actor`、`at`。
- **settlement**：对 open intent 的一次显式结算记录。

### 2.2 `intent` 结算对象（命令参数）

关闭 open intent 的治理命令（block/release/cancel/override/reject 防御路径）必须带：

```json
{
  "intent": {
    "outcome": "stopped",
    "sideEffects": [
      { "kind": "file", "ref": "src/foo.ts", "note": "已写入但未验证", "hash": "<可选 sha256>" },
      { "kind": "command", "ref": "npm test", "note": "退出码 1" }
    ],
    "note": "为什么停止这次尝试"
  }
}
```

规则：

- `outcome` 只接受 `stopped` 或 `unknown`。
- **`stopped`**：允许关闭 intent；`sideEffects` 必须是数组（可以为空，表示“已确认没有已知副作用”）。
- **`unknown`**：任何会离开 `in_progress`/`interrupted` 的命令都必须拒绝，错误码 `intent-unresolved`；唯一合法路径是 `task.interrupt`。
- `sideEffects`：最多 50 条，序列化后 ≤16 KiB；`kind ∈ {file, command, network, other}`；`ref` 非空，≤1000 字符；`note` ≤500 字符；`hash` 可选。**这是声明，不是验证**；宿主不会替模型证明副作用真的发生/没发生。后续“命令证据执行留痕”任务再加强。
- 有 open intent 但缺少 `intent` / `outcome` 不是 `stopped` → `intent-unresolved`（409），`details` 带 `{taskId, intentId, hint, allowedOps:['task.interrupt']}`。
- 没有 open intent 却传 `intent` → `invalid-command`（400），避免调用方误以为结算生效。

### 2.3 block

| 场景 | 结果 |
|---|---|
| in_progress + open intent + `outcome=stopped` + sideEffects | 允许；同一 commit 写 `work/abandoned`（带 `closeReason='blocked'`, `outcome`, `sideEffects`, `settlementNote`, `closedBy`, `closedAt`, `token`）+ `lease/revoked` + `task/blocked`；任务 `blocker.resumeTo='in_progress'`，`work` 保留（attempt 连续） |
| in_progress + open intent + `outcome=unknown` / 缺 intent | 拒绝 `intent-unresolved`；任务仍 in_progress；日志、rev、lease 不变 |
| in_progress + 无 open intent | 允许；非 human 必须有 live lease + 正确 `fencingToken`；human 可强制；写 `lease/revoked` + `task/blocked` |
| review + 无 open intent | 允许；review 通常无 lease，非 human 无 lease 会被拒；human 可 block；`resumeTo='review'` |
| review + 遗留 open intent（I6 违反） | 防御性按上表处理：必须 `stopped` 才允许；否则 `intent-unresolved` |

补充：

- block 不改变 `assignee`（保留“谁做过”），只清 `owner`。
- block 不重建 intent；unblock 也不重建。
- `intent.outcome='unknown'` 时**不要自动转 interrupted**：保持调用方显式选择，避免 block 偷偷改变状态类型。调用方应改用 `task.interrupt`。

### 2.4 新增 `task.interrupt`

用途：执行者/人类确认“副作用结果不明”，把任务停到 `interrupted` 等待对账；不关闭 intent。

```
task.interrupt { taskId, expected.entityRev, fencingToken?, note, sideEffects? }
```

- **正常路径**：任务 `in_progress`；有 live lease；非 human 必须是 lease owner 且 token 匹配；human 可强制（撤销他人 lease）。`note` 必填。可选 `sideEffects` 记录已观察到的部分副作用（同 §2.2 schema，可空）。
- **遗留修复路径**：任务在 `blocked/review/ready/backlog` 但存在 open intent（旧数据 I6 违反）时，**仅 human** 可 interrupt；用于把异常状态停到 interrupted 再 reconcile。
- 事件：若有 lease → `lease/revoked`（reason `interrupted`）；然后 `task/interrupted`。任务数据新增：

```json
{
  "state": "interrupted",
  "owner": null,
  "assignee": null,
  "interrupt": {
    "at": "...",
    "by": { "kind": "agent", "sessionId": "...", "agentId": "..." },
    "note": "...",
    "sideEffects": [],
    "previousState": "in_progress",
    "previousBlocker": null
  }
}
```

- `work` 保留，open intent 保持 open；I6 成立（interrupted 允许 open intent）。
- `blocker` 清空；如来自 blocked，`previousBlocker` 保留在 `interrupt` 里。
- 不允许从 `interrupted`/`done`/`canceled` 进入；`illegal-transition`。
- `allowedOps` 对 in_progress owner/human 暴露 `interrupt`；对遗留异常状态仅 human 暴露。

### 2.5 release / cancel / override / reject / unblock

| 命令 | 有 open intent 时 | 无 open intent 时 |
|---|---|---|
| `release` | 必须 `stopped` + sideEffects；否则 `intent-unresolved`。允许则 `work/abandoned(closeReason='released')` + `task/released` + `lease/revoked`，回 ready，`work=null` | 现有行为；token 校验不变 |
| `cancel` | 必须 `stopped` + sideEffects；否则 `intent-unresolved`。允许则 `work/abandoned(closeReason='canceled')` + `task/canceled` + `lease/revoked` | 现有行为；有 live lease 时非 human 补 token 校验 |
| `override` | 必须 `stopped` + sideEffects；否则 `intent-unresolved`。允许则先 `work/abandoned(closeReason='override')`，再 `task/updated` + `override/applied`；可转任意目标状态 | 现有行为；archived 项目由 §3 拦截 |
| `reject`（防御路径） | review 正常无 open intent；若遗留 open intent，必须 `stopped` 才允许，先关 intent 再 reject | 现有行为；有 live lease 时非 human 补 token 校验 |
| `unblock` | **拒绝** `intent-unresolved`，提示先 `task.interrupt` 再 reconcile；不得把 open intent 带进新的 lease | 现有行为；回 `resumeTo`，不重建 intent；下次 `begin` 才开新 attempt |

`reject` 的 token 校验只针对“存在 live lease 且 actor 非 human”的场景；review 通常无 lease，不额外加门槛。

### 2.6 reconcile

`reconcile` 是“结果不明”的唯一合法收口。保留现有三选择，补充结算记录：

- `resume`：旧 intent → `abandoned`，`resolution='redo'`，`resolutionNote=note`；新 lease；新 intent（attempt+1）。
- `completed`：旧 intent → `closed`，`resolution='applied'`，`resolutionNote=note`；可附 evidence；→ review。
- `discard`：旧 intent → `abandoned`，`resolution='discarded'`，`resolutionNote=note`；→ ready。
- `note` 必填；事件带 `closedBy`、`closedAt`、`resolution`。
- `discard` 不表示“没发生副作用”，只表示“不再继续这次尝试，接受可能残留的副作用”。health/digest 应能显示该记录。

### 2.7 unblock 与 begin

- `unblock` 不创建 intent、不复活旧 intent。
- 若 `resumeTo='in_progress'` 且 assignee 仍存活、WIP 未满，`unblock` 发新 lease；任务 in_progress、无 open intent。执行者在副作用前必须重新 `begin`。
- `begin` 的 `attempt = (task.work?.attempt || 0) + 1`；block 保留 `work`，所以 attempt 连续；release/cancel/override 若清空 `work`，attempt 从 1 重新开始（现有行为，本文不改）。
- 若 `unblock` 无法发 lease，回 ready（现有行为）；不自动 begin。

## 3. Archived 项目写闸

### 3.1 允许的写操作

**archived 项目上唯一允许的写是 unarchive**：

- `project.update` 且 `phase ∈ {active, paused}`；允许同命令带 `name`/`policy`（视为 unarchive 的一部分）。
- 其余所有 mutating op：`task.*`、`plan.*`、`doc.*`、`project.relocate`、`session.checkpoint/handoff`、`override` → `project-archived`（409）。
- `project.update` 在 archived 上改 name/policy 但 phase 不是 active/paused → `project-archived`。
- 读操作（query/health/digest/list）不拦。

### 3.2 归档前置（严格 A）

`project.update` 把 phase 从非 archived 改为 archived 前，必须检查：

1. 任何任务 `state === 'in_progress'`；
2. 任何 live lease（按 `_leaseOf`/未过期判断，不只看 `leases.size`）；
3. 任何 `state.intents[*].status === 'open'`。

任一命中 → `project-has-live-work`（409），`details` 带 `{inProgress:[], leases:[], openIntents:[]}`（最多各 20 个）。**不自动撤销、不提供 override 捷径**；调用方必须先 submit / release / reconcile / interrupt。

### 3.3 两层守卫

1. **入口预检**：`ProjectHandle.command()` 在 dedupe/expected 校验后、`_execute` 前检查 `state.project.phase === 'archived'`；非 unarchive 直接抛 `project-archived`。目的：在 handler 写 blob、改内存 lease 等副作用之前拒绝。
2. **提交出口兜底**：`_appendEvents()` 增加 `allowArchived` 参数；`state.project.phase === 'archived'` 且未允许时抛 `project-archived`。只有 unarchive 命令传 `allowArchived:true`。这覆盖未来新增命令、`attach/detach`、`recover`、`expire` 等所有直接调用 `_appendEvents` 的路径。

### 3.4 session / recover / expire

- `attach` / `detach`：archived 项目**不落事件**；只在内存 `state.bindings` 更新（与 readOnly 路径一致）。不把绑定写进日志；需要持久绑定就先 unarchive。读看板不受影响。
- `recover()`：archived 项目直接返回，**不追加任何事件**；不设置 `recovered=true`（留给 unarchive 处理）。
- `expireLeases` / sweep：archived 项目直接返回，不写事件；如有遗留 lease，health 告警（见 3.6）。
- `command()` 在 unarchive 成功后设置 `handle.recovered=true`。

### 3.5 unarchive 与恢复事件

- unarchive 的 `project.update` 在同一 commit 内携带恢复事件：先 `project/updated`（phase active/paused），再对每个 in_progress 任务写 `task/interrupted`（有 open intent）或 `task/readied`（无 open intent），复用 `releasedTask` 规则。
- 事件顺序保证“先解除归档，再恢复”；恢复事件与 unarchive 同一 cmdId，避免“unarchive 成功但恢复丢失”。
- 不写 `lease/expired`：进程内 lease 表在打开时已空；恢复事件只表达任务状态。此点与 DESIGN T8 的“lease/expired”表述有轻量不一致，实现时二选一，但不要在 unarchive commit 里凭空造 lease。
- 若 archived 项目无 live work，只写 `project/updated`。
- 恢复后任务进入 interrupted 的，走 `reconcile` 对账；进入 ready 的，可重新 claim/begin。

### 3.6 旧数据异常

- 打开 archived 项目时 `recover` 跳过，health/fsck 必须告警：`archived-live-work`（存在 in_progress / open intent / live lease）。
- 人工恢复 active 后，unarchive 同 commit 恢复；再对账。
- 遗留 `blocked + open intent`（旧 block 产生）：`unblock` 拒绝（`intent-unresolved`），由 human 用 `task.interrupt` 停到 interrupted，再 reconcile。
- 不自动改写旧事件；不把旧 `abandoned` 记录补造成新 schema。

### 3.7 plan archived（I21 的进入 in_progress 漏口）

- `claim` 已有 `plan-archived` 检查；本 RFC 要求所有“进入 in_progress”的路径统一检查 `task.planRef` 指向的 plan head 未 archived：
  - `unblock` 发 lease 前；
  - `reconcile(choice='resume')` 发 lease 前；
  - `reopen` 发 lease 前；
  - `reject` 重授 lease 前；
  - `override` 直接转 in_progress 前（human 也不绕）。
- 命中 → `plan-archived`（409），不改变任务/日志。
- 本文只补“进入 in_progress”的漏口；I21 的“archived 计划完全不产生任务状态变化”是更严格的目标，另立任务评估（本轮不扩）。

## 4. 命令、错误码与兼容性

### 4.1 受影响命令

| op | 变化 | 错误码 |
|---|---|---|
| task.block | 非 human 校验 token；有 open intent 必须 `stopped` + sideEffects；review 防御路径 | `fencing-stale`, `intent-unresolved`, `invalid-command` |
| task.unblock | 有 open intent 拒绝；不重建 intent | `intent-unresolved` |
| task.interrupt | **新增**；in_progress owner/human；遗留异常状态仅 human | `illegal-transition`, `lease-expired`, `fencing-stale` |
| task.release | 有 open intent 必须 `stopped`；关闭时带结算 | `intent-unresolved` |
| task.cancel | 有 open intent 必须 `stopped`；补 token（有 lease 时） | `intent-unresolved`, `fencing-stale` |
| task.reject | 补 token（有 lease 时）；遗留 intent 防御 | `fencing-stale`, `intent-unresolved` |
| task.reconcile | 补 `resolution`/`resolutionNote`；语义不变 | — |
| override | 有 open intent 必须 `stopped`；archived 项目拦截 | `intent-unresolved`, `project-archived` |
| project.update | 归档前置；archived 只允许 unarchive；unarchive 携带恢复 | `project-has-live-work`, `project-archived` |
| project.relocate | archived 拦截 | `project-archived` |
| doc.put / plan.* / session.* | archived 拦截 | `project-archived` |
| session.attach/detach | archived 不落事件（内存绑定） | — |
| recover/expire | archived 跳过 | — |

### 4.2 新增错误码

| code | status | 触发 |
|---|---|---|
| intent-unresolved | 409 | 关闭 open intent 时缺 `intent.outcome='stopped'` + sideEffects，或声明 unknown；`details.hint` 指向 `task.interrupt`/`task.reconcile` |
| project-archived | 409 | archived 项目上的非 unarchive 写 |
| project-has-live-work | 409 | 归档时存在 in_progress / live lease / open intent |

`plan-archived`、`fencing-stale`、`illegal-transition`、`invalid-command` 沿用。

## 5. DESIGN diff

### 5.1 T 表

替换 T6：

| # | From | Command | To | 守卫 | 产出事件 |
|---|---|---|---|---|---|
| T6 | in_progress / review | block | blocked | 非 human 需 live lease + fencingToken；有 open intent 时必须 `intent.outcome='stopped'` + sideEffects，否则 `intent-unresolved`；review 可无 lease | work/abandoned（有 intent）+ lease/revoked（in_progress）+ task/blocked |

替换 T7：

| # | From | Command | To | 守卫 | 产出事件 |
|---|---|---|---|---|---|
| T7 | in_progress | release | ready | lease + token；有 open intent 必须 stopped + sideEffects | work/abandoned + lease/revoked + task/released |

替换 T13：

| # | From | Command | To | 守卫 | 产出事件 |
|---|---|---|---|---|---|
| T13 | 任意非终态 | cancel | canceled | owner/human；有 live lease 时非 human 校验 token；有 open intent 必须 stopped + sideEffects | work/abandoned + lease/revoked + task/canceled |

新增 T15：

| # | From | Command | To | 守卫 | 产出事件 |
|---|---|---|---|---|---|
| T15 | in_progress（正常；遗留异常状态仅 human） | interrupt | interrupted | note 必填；in_progress 需 lease（human 可 force）；open intent 保留不关闭 | lease/revoked（若有）+ task/interrupted |

更新 T9/T12/T14 的守卫/说明：

- T9 reconcile：三选择分别写 `resolution=redo|applied|discarded`；note 必填。
- T12 unblock：有 open intent 拒绝；不重建 intent；回 `resumeTo` 后重新 begin。
- T14 reopen：清 work；不重建 intent（现状）。
- override（T 表外）：有 open intent 必须 stopped；archived 项目拦截。

项目级补充（放在 T 表后）：

| # | From | Command | To | 守卫 | 产出事件 |
|---|---|---|---|---|---|
| P1 | active/paused | project.update(phase=archived) | archived | 无 in_progress / live lease / open intent，否则 `project-has-live-work` | project/updated |
| P2 | archived | project.update(phase=active/paused) | active/paused | 仅 unarchive；同 commit 携带恢复事件 | project/updated + task/interrupted 或 task/readied |

### 5.2 I 表

替换 I6：

> I6：open intent ⇒ 任务 ∈ {in_progress, interrupted}；关闭 open intent 只允许 submit(closed)、reconcile(resolution)、或治理命令(block/release/cancel/override) 带 `outcome='stopped'` + sideEffects；禁止以 unknown 关闭。

替换 I14：

> I14：archived 项目不再产生事件（除 unarchive；unarchive 同 commit 可携带恢复事件）。

新增 I22：

> I22：intent 关闭必须带结算记录（status + closeReason/resolution + actor + at）；历史记录缺字段不追溯，但新命令不得产生无结算的 abandoned/closed。commit 时拒绝；fsck 只对新格式告警。

补充 I21 执行口径：

> I21：archived 计划不产生任务状态变化；进入 in_progress 的路径必须检查 planRef 计划未归档（claim 已检查，unblock/reconcile-resume/reopen/reject/override 需补）。全量禁写另立任务。

### 5.3 DESIGN 4.5 文案

把“intent 的三种收尾”改为：

> `closed`（submit / reconcile completed）、`abandoned`（block/release/cancel/override 带结算，或 reconcile resume/discard）、`open`（崩溃/中断待对账）。abandoned 只表示尝试停止，不表示无副作用或已回滚；每条 abandoned 必须记录 closeReason、outcome、sideEffects、actor、at。

## 6. CONTRACT diff

- `task.block` payload：`code, note, intent?`；`intent` schema 见 §2.2。
- `task.release` payload：`note?, intent?`。
- `task.cancel` payload：`reason, intent?`。
- `override` payload：`taskId, toState, reason, intent?`。
- `task.reject` payload：`reason, intent?`（仅遗留 intent 防御用）。
- 新增 `task.interrupt`：`taskId, note, sideEffects?`；host `project_task` op 枚举加 `interrupt`。
- `project_task` 工具 schema：`fencingToken` 描述改为“begin/submit/release/block/interrupt/cancel/reject（有 live lease 时）”；新增 `intent` 参数说明。
- 错误码表加 §4.2 三行。
- `task.block` 旧客户端不传 token：非 human + live lease → `fencing-stale`；human 不受影响。
- 旧客户端在 open intent 上调用 block/release/cancel/override 且不传 `intent`：`intent-unresolved`。这是**有意 breaking**，不提供兼容模式；CHANGELOG 必须写明。
- `task.interrupt` 是新 op；旧客户端不会调用，不影响。
- `project.update` 归档带 live work 现在失败；旧自动化必须先收尾。
- `project.update` 在 archived 上做非 unarchive 现在失败；旧自动化会收到 `project-archived`。

## 7. 兼容性与迁移

- 无需数据迁移：新增字段是 additive；旧 `work/abandoned` 无 `closeReason/outcome` 仍可重放，I22 只约束新命令。
- 旧 `blocked + open intent`：health 告警；`unblock` 拒绝；human `task.interrupt` 停在 interrupted 后 reconcile。
- 旧 archived 项目含 in_progress/open intent：打开不写事件，health 告警；unarchive 同 commit 恢复。
- 降级风险：新日志里的 `task/interrupted` 带 `interrupt` 字段，旧代码的 `applyTaskEvent` 会原样存 task，忽略字段；旧代码不认识 `task.interrupt` op（客户端不会发）。可接受。
- 版本：0.x 下按 breaking 处理，CHANGELOG 写“变更 + 迁移步骤”；具体版本号交给发布任务，不在本 RFC 定。

## 8. 实现任务映射

- `inv-fencing`：§2 全部 + `task.interrupt` + token 补齐 + host schema/CONTRACT + 单测。**该任务现有验收只写 block/cancel/reject，实施时按本文扩展到 release/override/interrupt；不新增重复任务。**
- `inv-archived`：§3 全部 + 入口/出口守卫 + 归档前置 + unarchive 恢复 + attach/detach/recover/expire + plan-archived 进入 in_progress 检查。
- `inv-fsck`：I6/I22/archived-live-work 检查；health 告警。
- `inv-matrix`：矩阵加入 settlement/unknown/interrupt/archived/unarchive/legacy 场景。
- 文档：上述任务各自更新 DESIGN/CONTRACT；本 RFC 作为决策依据，不作为最终规范文本。
- 需要评审时确认的“验收扩展”：inv-fencing 从 3 个命令扩到 6 个命令；inv-archived 从 `handle.command` 扩到 `_appendEvents` 单入口。这是轻量不一致，已在本文标注。

## 9. 移交 S4：租约活性约束（不在本 RFC 实现）

S4 对应任务的验收必须补以下条款：

1. **binding 存在 ≠ 会话活着**。binding 只证明曾经 attach；续租必须有明确活性判据或有限宽限期。
2. 活性判据（建议默认）：`lastSeenAt`（由真实工具调用/attach/heartbeat 更新）在 `leaseTtl + grace` 内；或 `renew` 调用本身携带当前 token + binding epoch。`grace` 默认 = 1×TTL，S4 可调。
3. 续租必须带当前 `fencingToken` 与 binding `epoch`；token/epoch 不匹配 → `fencing-stale`，不得延长。
4. 连续无进展续租上限默认 2 次；超过后 lease 到期 → interrupted/ready；必须 reconcile 或重新 claim。进展 = 新的 work/result、evidence、submit 或明确的 note。
5. 一旦执行权被回收并产生新 token，旧执行器的 `touch`/`renew` 不得复活旧租约：旧 token → `fencing-stale`；旧 epoch 的 touch → no-op/拒绝；旧执行器必须重新读板并 reconcile。
6. health 区分“过期但可续”与“已回收/interrupted”两态；digest 不把可续租约算成死租约。
7. 测试：父会话等待子代理期间不误收子会话租约；空闲会话不能无限续租；回收后旧 token renew 被拒；旧 epoch touch 不影响新 lease。
8. 以上数值是默认建议，S4 以测试/实测调整；但“binding 不算活性”“回收后不可复活”是冻结原则。

## 10. 本轮拍板清单（评审重点）

| # | 拍板 | 理由 |
|---|---|---|
| D1 | `intent` 参数名与 §2.2 schema | 与现有 `work/intent` 事件对齐；避免新顶层概念 |
| D2 | 新增 `task.interrupt`，不把 unknown 静默转 interrupted | 状态变化必须显式，且需要 note/actor |
| D3 | block 遇 unknown 拒绝，不自动 interrupt | 保留调用方选择；错误信息给出下一步 |
| D4 | release/cancel/override 同判据；reject 防御性同判据 | 任何关闭 intent 的路径都不能藏不确定性 |
| D5 | archived 入口预检 + `_appendEvents` 出口兜底 | 单入口兜底覆盖未来命令；入口预检防 blob/内存副作用 |
| D6 | archived 项目 attach/detach 不落事件（内存绑定） | 读看板不能因归档被阻断；I14 不允许写 |
| D7 | unarchive 同 commit 携带恢复事件 | 避免“unarchive 成功、恢复丢失”；只允许这一种 archived 写 |
| D8 | 归档前置按 live lease 判断，不按 `leases.size` | 过期 lease 不应阻止归档 |
| D9 | 遗留 blocked+open intent 用 human `task.interrupt` 修复 | 不自动改写历史；unblock 拒绝把不确定性带进新 lease |
| D10 | plan-archived 只补“进入 in_progress”路径 | 全量 I21 禁写影响面大，另立任务；本轮不扩 |
| D11 | 旧客户端无兼容模式，block/release/cancel/override 在 open intent 上会失败 | 安全优先；CHANGELOG 明示 |
| D12 | S4 活性默认 grace=1×TTL、2 次无进展续租 | 先给可测试默认，S4 用实测调 |

## 11. 验收对照

- **acc1（block/unblock + open intent）**：§2.3、§2.5、§2.7 明确 in_progress/review、allow/reject、abandoned 语义、unblock 不重建 intent。
- **acc2（archived 唯一写 + 前置）**：§3.1、§3.2 明确唯一 unarchive、严格 A 前置、逐条对应 I14（§5.2）。
- **acc3（命令/错误码/T-I diff/兼容）**：§4、§5、§6、§7 给出受影响命令、错误码、T/I diff、旧客户端行为。

实现阶段必须补的测试（供 inv-* 任务引用）：

1. block：stopped → blocked + abandoned 带结算；unknown/缺 intent → 409 且零写入；stopped 缺 sideEffects → 400。
2. unblock → in_progress 后 begin → attempt+1；旧 intent 不复活。
3. interrupt：in_progress → interrupted + intent 仍 open + lease 撤销；旧 token 后 renew/touch 失效。
4. 遗留 blocked+open intent：unblock 拒绝；human interrupt 成功；reconcile 三种收口。
5. release/cancel/override 在 open intent 上的 stopped/unknown 分支；override 不得留下 open intent。
6. archived：归档前置三种命中各一例；归档后 task/doc/plan/project.relocate 全 409；unarchive 同 commit 恢复；attach/detach 零事件；recover 零事件。
7. plan archived：unblock/reconcile-resume/reopen/reject 重授/override 进 in_progress 全 `plan-archived`。
8. 拒绝操作日志字节数/rev/lease 不变（矩阵任务统一覆盖）。
