# 设计草案：AI 驳回与第三方审计门（审查治理 v6）

> 状态：已替代（现行语义见[实现契约](<../CONTRACT.md>)；正文保留方案或决策时的语境）。

日期：2026-11-02
状态：v6 方案待实现（用户拍板 B：无迁移 marker）
基线：master `f9ca3e6`（证据只记录、提交进入 review、显式验收）
风险级别：R3（状态机 / 角色与授权 / 证据审计 / 事件兼容 / schema 迁移）

**用户拍板（2026-11-02）**：
1. 旧门直接降级为第三方审计门；不做 `auditMode` 两档 opt-in；存量 `gate:human` 任务直接获得 agent 审计能力。
2. 发布里彻底去掉 `requiresHumanReview` / `gate:human` 字样；选 A（重命名 + 隔离旧数据），收紧为 A+：运行时只认 v3，v2 store 必须由发布包外的迁移脚本升级；`npm pack` 产物零旧名。
3. **不新增 `schema/upgraded` 事件**（B）：迁移使用既有事件：`project/updated` 把 `schemaVersion` 升到 3 + 全量 `task/updated` 新字段，受影响草稿追加既有 `plan/updated` 保留门定义；运行时检查 `schemaVersion>=3`。代价：旧代码回滚读 v3 日志会静默丢门，回滚只能恢复迁移前备份（本来就按备份回滚）。

## 0. 一句话

两条能力：**任何 agent 都可驳回 review 任务**；**门控任务改为第三方审计门**——人，或与实现者独立的 agent，都可以审计；agent 审计必须留下锚定证据/worker 快照的报告，通过后同一命令直接 done。同时完成 schema 改名 `requiresAudit` / `gate:audit`，发布包零旧名，且不引入新事件类型。

## 1. 现状（master f9ca3e6）

- submit 通过材料覆盖与内容审计后，门控和非门控任务均进入 review，删除租约，保留 `assignee`；`reconcile completed` 同样进入 review，均不因材料类型、强度或执行结果直接 done（见[提交与验收契约](<../CONTRACT.md#26-plan--task-规则>)）。
- 有效验收策略为 `manual`。持久旧 `auto` 配置与历史 `verifiedBy='policy'` 完成记录按原值保留，不驱动新操作自动完成；新写 `auto` 配置返回 `invalid-command`。
- verify 只允许 human；agent 调用得到 `forbidden-role`。verify 是验收者的背书/验收记录，不是看板对结论正确性的保证；看板不执行或重跑 command/test，也不判断其退出码（见[当前 verify 实现](<../../lib/core/commands/task-work.js#L194-L251>)）。
- reject 允许 human 或租约持有者；review 正常没有租约，所以除 human 外无人能驳回（见[当前 reject 实现](<../../lib/core/commands/task-work.js#L254-L301>)）。
- `allowedOps` 同样把 verify 限制为 human、reject 限制为 human/租约持有者；门控由 `requiresHumanReview` / `gate:human` 表达，门控任务只有 human 能 cancel（见[当前门与操作权限](<../../lib/core/model.js#L402-L413>)）。
- 下文的任意 agent 驳回、独立 agent 显式 verify、审计记录及 schema v3 均属于待实现方案。

## 2. 目标 / 非目标

目标：

1. review 任务可被 AI（任意 agent）驳回，reason 必填、留痕；原实现者（assignee）仍优先接回。
2. 门控任务 = 第三方审计门：审计者可以是 human，也可以是与实现者独立的 agent。
3. agent 审计必须留痕 + 报告：审计对象锚定证据快照（digest）与 worker 快照，报告/清单持久化在任务与 `task/verified` / `task/rejected` 事件里。
4. agent 审计通过后可在同一命令内自主 done，不需要 human 再点。
5. human 仍是最终兜底：human 可 verify/reject/cancel/reopen/override；`refreshDrift` / `acknowledgeDrift` 仍只属于 human。
6. **schema 改名 + 发布包纯净**：新字段 `requiresAudit`、新标签 `gate:audit`；`npm pack` 产物（`lib`/`src`/`bin`/README/CONTRACT）零旧名；旧名只在 `scripts/`、`test/`、历史档案。

非目标：

- 不保留两档门，不做 `auditMode` opt-in。
- 不重写历史 commit（不选 B 的日志重写）：旧 commit 中的旧名保留为不可变历史；运行时拒绝 v2 store，迁移脚本负责升级。
- **不新增事件类型**：`schemaVersion` 从 2 升 3 通过 `project/updated` 表达；迁移用全量 `task/updated`；受影响草稿定义使用既有 `plan/updated`。
- 不引入新角色/凭据系统（不做 verifier token、签发、撤销、作用域）。
- 提交与验收分开：新 submit/reconcile completed 均进入 review，由获授权的验收者显式 verify 后完成；材料覆盖、类型、内容指纹或报告本身不触发 done。verify 是验收者记录，不是系统对交付正确性的证明。
- 不改变 lease/fencing/intent，不引入基于材料强弱的自动完成或看板内 command/test 执行；agent 的「已复核」是声明 + 留痕，不是系统重验。
- 不做会话血统级独立性（session 级；见 D3 与风险）。

## 3. 术语

- **audit gate（审计门）**：`requiresAudit=true` / `gate:audit`；必须由第三方审计（human 或独立 agent）。
- **legacy gate（旧门）**：`requiresHumanReview` / `gate:human`，只存在于 v2 日志/快照；运行时**不认识**，由 `scripts/migrate-gate-v3.mjs` 一次性升级。
- **v3 store**：`state.schemaVersion >= 3`、当前任务全量新字段的 store；运行时只打开 v3。
- **auditor**：对 review 任务做审计并给出 verdict 的 actor；human 或 agent。
- **independent**：agent auditor 的 sessionId/agentId 不等于任何 worker，且不在任何 evidence 的 `producedBy` 里。
- **worker set**：当前 assignee + 所有 evidence（含 superseded）的 producedBy + `task.workers`。
- **audit record**：`task.lastAudit`（见 D4）。

## 4. 决策

### D1 新 schema：`requiresAudit` / `gate:audit`；运行时硬切

- 任务字段改为 `requiresAudit: boolean`；标签改为 `gate:audit`。
- 新 API/工具/计划/UI/文档只出现 `requiresAudit` / `gate:audit`；不再写 `requiresHumanReview` / `gate:human`。
- **运行时不含旧名**：没有 `lib/core/legacy/gate-v2.js`；打开 store 后若 `state.schemaVersion < 3`，抛 `schema-migration-required`（409/503，提示运行迁移脚本），不解析旧字段、不猜测。
- 旧 v2 store 的升级只由 `scripts/migrate-gate-v3.mjs` 完成；该脚本不在 `package.json files` 里，不进发布包。
- `isHumanReviewRequired` 改为 `isAuditGate`；`resolveHumanGate` 改为 `resolveAuditGate`；plan-life/task-intake 全部改用新名。
- `cardOf` / task view / tool schema / client payload 只暴露 `requiresAudit`。
- `task.create/update/gate`、`plan.create/publish/revise` 的顶层字段及计划 step/task 定义按白名单校验；未知字段、显式非 boolean 的 requiresAudit、gate:* 命名空间中非 gate:audit 标签返回 `invalid-command`（400），不能静默变成非门控。草稿写入前校验，publish 重验存量草稿；没有旧别名识别器，也不是全部操作的全局严格白名单，不增加人类技术批准。
- `schemaVersion`：`project/created`、启动 meta、normalize、snapshot 全部升到 3；旧 v2 项目打开时拒绝，要求迁移。

### D2 agent verify 的范围与门变更限制

- 新提交一律进入 review。agent verify 只对审计门任务开放，须由独立 agent 带报告显式调用；非门控任务由 human 显式 verify（agent 仍可 reject）。submit 或材料满足验收要求均不代替 verify。
- **review 状态**：agent 不得改 `requiresAudit` / 门标签（`allowedOps.gate` 对 agent 置灰）；否则 agent 可先给别人的 review 任务开门再自审。human 不受限。
- **in_progress/ready/backlog**：agent 仍可按现有规则「只能开、不能关」；非 human 关门仍 `forbidden-role`。
- 不需要 `gateAtSubmit` 快照：review 下 agent 不能改门，human 改门由 human 自己负责；verify 以当前门状态为准。
- 门控任务 cancel 仍仅 human；review 对第三方 agent 的 block 仍不允许（review 无租约）。文档写清。

### D3 独立性判定（P1-1）

- 独立集合 = `task.assignee` ∪ **所有** evidence（含 superseded）的 `producedBy` ∪ `task.workers`。
- `task.workers`：claim / reject 续租 / reopen 续租 / unblock 续租时追加 `{sessionId, agentId, at, cause}`，去重、上限 20；覆盖「曾 claim/begin 但没留下 active evidence」的前任 worker。
- 不把 `createdBy` 算作 worker：主控/创建者通常只拆任务，不应因此失去审计资格。
- `auditIndependenceProblem(task, actor)` 放在 `lib/core/model.js`，`allowedOps` 与 `taskVerify` 共用；`taskView` 构造 agent actor 时补 `agentId`（`views.js:103`）。
- 无 assignee 且无 workers：agent 不得 verify（`forbidden-role`，details.reason=`worker-unknown`）；human 不受限。
- 已知边界：同一 agent 拉起新 session/子 agent 可绕过 session 级独立性。这是本设计接受的限制；`lastAudit.workers` 快照 + report + commit actor 用于事后追责；R3 关键交付仍建议 human 复核。

### D4 agent 审计 payload、留痕与生命周期（P1-2/P1-3）

- `project_task op=verify` 新增可选 `audit` 对象：`{ report: string, checklist?: [{item, ok, note?}] }`。
- agent verify 必填 `audit.report`（trim 后 20–4000 字）；`checklist` 可选，最多 50 项，`item` ≤200 字，`note` ≤500 字。
- 服务端在 verify 时重新跑 `auditEvidence`；计算 evidence digest（active evidence 的 id/kind/ref/hash 规范化后的 sha256）、实质验收范围 `scopeDigest` 与历史锚点 `taskRev`，写 `lastAudit`。
- `lastAudit = { id, at, gate: true, by: {kind, sessionId, agentId, via}, verdict: 'pass'|'fail', report, checklist, evidence: {count, digest}, workers: [{sessionId, agentId}], warnings, taskRev, scopeDigest }`。
- **taskRev**：取审计命令写入后的 `next.rev`，作为不可变的正整数历史锚点，满足 `taskRev <= task.rev`；后续元数据变更不重写它，也不表示发生新审计。
- **scopeDigest**：独立于 evidence.digest 的规范化验收范围指纹，绑定标题/说明、依赖、验收项及材料覆盖、审计门、active evidence 与 producedBy、worker 集合；排除 planRef/orphaned/priority/weight/rev 等管理元数据。agent 审计 done 的实质范围经 plan.revise 改动时返回 409 `audit-scope-locked`，应先由 human reopen 再返工重提；复用既有 reopen，不增加人类技术审批配置或新审批门。
- **生命周期**：
  - `begin`（新 attempt）清 `lastAudit`；`reopen` 清 `lastAudit`、verified 字段。
  - `submit` 不清上一轮 fail（同一 attempt 内 fail → 重提保留，便于审计；begin 已清上一轮）。
  - agent verify pass：写 `lastAudit`（pass）、`verifiedBy='agent'`、`verifiedAt`、state=done。
  - human verify pass：写 `lastAudit`（kind=human，report 取 reason/note，可空）、`verifiedBy='human'`；覆盖之前的 fail，避免 done 上挂旧 fail。
  - agent/human reject 带 `audit`：写 `lastAudit`（fail），`rejection` 只存 `{reason, at, by, byKind, auditId}`，不复制整份 report。
  - reject 不带 audit：保留 rejection；不写 lastAudit。
- **留痕方式**：不新增事件；`task/verified` / `task/rejected` 的完整 task payload 携带 `lastAudit`，commit.actor 即审计者。若后续需要独立审计时间线，再按事件兼容契约加迁移/回滚方案。
- **声明边界**：agent 的 report 是自述；服务端验证的是证据快照、worker 独立性与证据审计结果。command 类证据不会被重跑，report 不能声称「已重跑 command」。文档必须写清。

### D5 agent 审计不能绕过漂移闸门（P1-3）

- agent verify 执行内容观测 `auditEvidence`；hard 错误 → 409 `evidence-drift`，agent 不得 `refreshDrift` / `acknowledgeDrift`（这两项保持 human-only）。hard 按现行内容/结构与读取安全规则判定；command/test 失败、自报或无执行签名不是 hard 漂移，固定 Git 内容暂时不可观测只给 warning，不伪称匹配。
- agent 显式传 `acknowledgeDrift`/`refreshDrift` → 403 `forbidden-role`（不能静默忽略）。
- agent 收到的 409 details 里 `canAcknowledgeDrift=false`、`canRefresh=false`；next 提示「reject 退回重做，或让 human 处理」。
- soft warning 可放行，但写入 `lastAudit.warnings`（上限 20 条）。

### D6 驳回（P1-4）

- review、无 live lease：任何 agent 或 human 可 reject；reason 必填。
- review、有 live lease（遗留数据）：非 human 只有租约持有者可按旧规则 reject，并 `_assertLease`；其他 agent 得到 `forbidden-role`/`lease-held`。
- `unassign` 仍仅 human；agent 不能强制清空委派人。
- 驳回后的 lease 续给逻辑不变：assignee 存活 → in_progress + 续租；否则 ready；`_assertPlanActive` 失败按现有错误处理（需测试）。
- 允许 worker 自己驳回（撤回重做）；需测试。
- `rejection` 记录补 `byKind`（human/agent）、可选 `auditId`。
- **接受的 DoS 面**：任何 agent 可驳回任何 review 任务（含门控），没有速率限制；反复 reject→resubmit 的乒乓是可见的 `task/rejected` 事件，v1 不自动限流，后续可加冷却。此条写入 CONTRACT 的风险说明。
- 事件仍是 `task/rejected`（完整 task）。

### D7 allowedOps 与门操作（P0-2/P1）

- reject：review && (human || agent) && (无 live lease || 是租约持有者)。
- verify：review && (human || (gate && independent agent))。
- gate：`gateable && (isHuman || (task.state !== 'review' && !gated))`；agent 在 review 下不能开关门。
- 其他 op 不变：门控任务 cancel 仍仅 human；review 下第三方 agent 不能 block（无租约）；文档写清。
- 代码/读模型统一 `requiresAudit` / `gate:audit`。

### D8 不变量（fsck / health）（P1-5）

- 新增 I23：`state==='done'` 且 `verifiedBy==='agent'` 时，必须有 `lastAudit`：
  - verdict='pass'、report 非空；
  - `lastAudit.taskRev` 为正整数且不大于当前 `task.rev`，保留原审计锚点；
  - 必须有 `lastAudit.scopeDigest`，且匹配当前规范化实质验收范围；管理元数据变化不要求重审，不重写旧锚点；
  - `lastAudit.workers` 不含 auditor 的 sessionId/agentId；
  - 否则 `health.ok=false`。
- 只检查 `verifiedBy==='agent'`。`verifiedBy==='policy'` 的 done 仅作历史兼容，不判为异常，新提交不生成此类自动完成记录；`verifiedBy` 为空（override 到 done）不报。
- I23 同时要求 `lastAudit.evidence` 的 count/digest 与当前 active evidence 记录匹配，worker 快照与当前集合匹配，审计者仍独立；不重读文件、不执行命令，只比较持久化范围与身份。
- 旧日志/旧任务没有 `lastAudit`：只对 agent 审计的 done 报错；历史 human/policy 不追溯。

### D9 工具 / 读模型 / 发布包纯净

- `project_task` 参数/描述/示例只出现 `requiresAudit`；`audit` 对象用于 verify/reject 报告。
- `project_board` task/brief/board 摘要：`audit=1`、`lastAudit`；不再出现 `humanReview`。
- 客户端源码 `src/client` 与构建产物：`requiresAudit` / `gate:audit`；Badge「需审计」；抽屉「审计门」；展示 lastAudit；不再出现「人审」。
- CONTRACT/DESIGN/README/CHANGELOG 只写新名；`docs/operations/MIGRATION.md` 记录旧名 → 新名迁移与回滚（docs 不进包）。
- **发布包门禁**：`npm pack` 后在 tarball 的 `package/lib`、`package/src`、`package/bin`、`README.md`、`docs/CONTRACT.md` 内 grep `requiresHumanReview|gate:human`，必须为 0；否则 release gate 失败。脚本放 `scripts/check-release-purity.mjs`（不进包）。
- 旧名只允许出现在：`scripts/migrate-gate-v3.mjs`、`scripts/check-release-purity.mjs`、`test/`、`docs/`、历史档案；运行时代码（`lib`/`src`/`bin`）grep 旧名必须为 0。
- 客户端构建：改 `src/client` 后 `npm run build:client` 并核对产物，不直接改 `lib/client.js`。

### D10 迁移、schemaVersion 3、回滚与发布干净（B：无新事件）

- **新 schema**：`requiresAudit` / `gate:audit`；`state.schemaVersion` 从 2 升 3。
- **不新增事件类型**：没有 `schema/upgraded`。`project/updated` 携带 `schemaVersion:3`；迁移 commit 同时写全量 `task/updated`；受影响草稿定义使用既有 `plan/updated`。
- **运行时硬切**：新代码打开 store 后，若 `state.schemaVersion < 3`，抛 `schema-migration-required`，不解析旧字段；旧 v2 store 必须先用迁移脚本升级。
- **迁移脚本** `scripts/migrate-gate-v3.mjs`（发布包外）：
  1. 默认 dry-run；`--apply` 才写；先整目录备份。
  2. 停宿主后打开 store；用脚本内自带的 v2 读取器（旧名只在这里）重放任务。
  3. 追加一个迁移 commit：`project/updated`（schemaVersion 3）在前；随后对**每一个**任务（含 done/canceled/backlog/blocked/interrupted/orphaned）写 `task/updated` 全量新字段/新标签，确保旧 v2 任务事件之后的终态正确。
  4. 为含旧门字段/标签的草稿 head 追加既有 `plan/updated`，保留所有草稿任务定义；写新 snapshot（schemaVersion 3），关闭前验证重放/health/计数；输出迁移报告（备份路径、任务数、事件数、hash）。
  5. 幂等：已是 v3 且无旧字段 → no-op。
- **为什么不用运行时 legacy reader**：它会被 `npm pack` 打进 `lib`，发布包不纯净。A+ 把旧名移出运行时/发布包；代价是 v2 store 必须显式迁移，运行时不再兼容旧 store。
- **回滚**：无 marker；旧代码读 v3 日志不会拒开，可能静默丢门（`requiresHumanReview` 缺失 → 当非门控）。**回滚只能恢复迁移前备份 + 旧构建**，发布说明写清，不承诺双向兼容。
- **发布干净**：`npm pack` 产物零旧名；历史 commit 仍含旧名但不在包内且只在本机 store；迁移脚本/测试不在包内。
- **候选交付**：计划 v7 使用一个统一候选任务承接六组验收；T1–T6 只是内部实施阶段，不设置逐阶段人工验收前置，也不需要中途部署。核心 schema/权限关键问题集中检查一次，候选完成后做一次独立总审与用户统一验收；修复按影响范围定向复测。合入、迁移、部署与重启另行授权。

## 5. 命令与数据形状（摘要）

### 5.1 verify（agent）

```text
project_task op=verify taskId expectedRev audit={report, checklist?}
```

校验顺序：task/rev → state review → gate（requiresAudit）→ independence → acceptance met → audit report/limits → auditEvidence → done。

错误：

- 非 review → 409 `illegal-transition`
- 非门控 → 403 `forbidden-role`（reason=`not-audit-gate`）
- 非独立 / 无 worker → 403 `forbidden-role`（`not-independent`/`worker-unknown`）
- 缺报告 / 超限 → 400 `invalid-command`
- agent 传 refresh/ack → 403 `forbidden-role`
- 证据 hard → 409 `evidence-drift`（canAcknowledgeDrift=false）

### 5.2 reject（agent）

```text
project_task op=reject taskId expectedRev reason=... audit={report, checklist?}?
```

校验：task/rev → state review → reason → (lease? owner/human) → 结算 intent → 续租/回 ready → `task/rejected`。

### 5.3 门

```text
project_task op=gate taskId expectedRev requiresAudit=true|false
```

- `true` = 打开审计门；`false` = 关闭（仅 human）。
- agent 在 review 状态下调用 → `forbidden-role`；agent 关 → `forbidden-role`。
- 旧参数名不再接受；旧 store 先跑迁移脚本。

## 6. 威胁模型与边界

- **自审/分身**：session 级独立性挡不住同一 agent 拉起新 session/子 agent；worker 可通过子代理自审。缓解：worker 快照 + report + 证据 digest + commit actor；R3 关键交付建议 human 复核。
- **越权开门**：agent 在 review 下不能开关门；非 review 只能开不能关；human 是唯一能关的人。
- **伪造报告**：报告是自述；系统验证证据快照与独立性，不验证文字，不重跑 command。抽样/事后审计兜底。
- **越权驳回**：驳回不产生 done，只回工作态；reason + actor 留痕；不会改证据/删文件；乒乓 DoS 可见，v1 接受。
- **租约滥用**：review 正常无租约；有租约时只允许持有者，避免第三方撤销活租约。
- **回滚**：无 marker；旧代码读 v3 日志可能静默丢门；回滚只能恢复迁移前备份；不撤销已完成的 agent 审计。
- **human 自审**：UI human actor 不区分「实现者」与「审计者」；本版保持 human 最终权威，不新增 human 独立性校验（如需要另立任务）。

## 7. 测试计划（R3）

- 发布包纯净：`npm pack` 后对 `package/lib`、`package/src`、`package/bin`、`package/README.md`、`package/docs/CONTRACT.md` grep 旧名 = 0；CI release gate。
- 迁移：v2 fixture（旧字段/标签、含终态任务）跑 `migrate-gate-v3` dry-run 零写入、apply 幂等、备份/health/重放通过；迁移后每个任务都有新字段/标签、schemaVersion=3；旧 commit 仍在但不影响终态。
- 运行时硬切：v2 store 打开 → `schema-migration-required`；v3 store 打开正常；迁移 commit 允许既有 project/updated、task/updated、受影响草稿 plan/updated，不含新事件类型（event compat 无新增）。
- 门语义：迁移后门控任务 agent verify 可用（独立 agent + report）；非门控 agent verify 仍 403。
- 门权限：review 下 agent 开关门 403；非 review agent 关门 403、开门允许；human 可开关；allowedOps reason。
- 独立性：assignee、superseded evidence producedBy、task.workers、无 worker、subagent 自审负例；createdBy 不作为 worker（正例）。
- lastAudit：pass/fail、human 覆盖、reopen/begin 清理、report/checklist 上限、不可变正整数 taskRev 历史锚点、workers 快照、scopeDigest 与 I23；元数据变更可保留审计，实质 plan.revise 改动 agent done 返回 audit-scope-locked，先 human reopen。
- 输入形状：六个 intake/plan 命令及嵌套 step/task 的未知字段、requiresAudit 非 boolean、未知 gate:* 标签均 400 且零业务写入；草稿 publish 重验；合法 gate:audit 与普通标签保留。
- agent drift：refresh/ack → 403；hard → 409 且 details 对 agent 显示不可 refresh/ack；零副作用（events/blobs/lease/rev 不变）。
- reject：无租约任意 agent、有租约 owner/human、unassign human、自驳、plan inactive、byKind、auditId。
- 回归：门控/非门控 × submit/reconcile completed × 持久旧 auto/manual 策略均停在 review；失败/自报/无签名 command/test 可作材料，不按执行结论报 hard 漂移，不触发 done。human 显式 verify/refresh/ack、审计门独立 agent 带报告显式 verify、非门控 agent verify 拒绝均覆盖；event compat 与历史 policy done/empty 记录按原值保留，fsck I23 不误报。
- 工具/UI：tool schema/描述、audit 参数转发、board/brief 文案、client smoke/unit、`npm run build:client` 产物核对。
- 门禁：`npm run check:strict`、`npm run check:architecture`、`npm run audit:check`；候选独立 worktree + 测试实例；R3 独立审查；用户验收。
- 回滚演练：恢复迁移前备份后旧代码可用；无 marker 时旧代码读 v3 可能丢门，发布说明明确只能备份回滚。

## 8. 统一候选执行与验收（计划 v7）

一个统一候选任务承接下列六组验收；不拆成六次人工闸门。核心 schema/授权关键点集中检查一次，完成后一次独立总审，再由用户统一验收。修复按影响范围定向验证，不重复多轮全量审查；不需要在 T2/T3 之间部署。下列 T1–T6 为候选内部阶段与验收分组。

- **T1 核心 A（R3）**：AI 驳回 review 任务（守卫、allowedOps、byKind、测试）。deps: D4、D5。
- **T2 schema v3（R3）**：`requiresAudit`/`gate:audit` 改名；运行时硬切（v2 拒开）；`schemaVersion` 升 3；`scripts/migrate-gate-v3.mjs`（无新事件）；发布包纯净门禁；迁移测试。deps: T1。
- **T3 审计门 verify（R3）**：门语义、review 门权限、独立性、lastAudit、I23、agent verify 测试。deps: T2。
- **T4 表面 A（R2）**：project_task `audit`/`requiresAudit` 参数、board/brief/task 摘要、NEXT 文案。deps: T3。
- **T5 表面 B（R2）**：客户端显示迁移/审计展示、CONTRACT/DESIGN/README/CHANGELOG、构建产物。deps: T3；可与 T4 并行。
- **T6 集成验收（R3）**：全量门禁、R3 矩阵、迁移/回滚演练、`npm pack` 纯净检查、独立审计、用户验收。deps: T4、T5。

## 9. 已决策 / 剩余确认

已由用户拍板：

1. 旧门直接降级为审计门，不做两档 opt-in。
2. 彻底改名：`requiresAudit` / `gate:audit`；选 A，收紧为 A+（运行时硬切、迁移脚本不进包），不重写历史。
3. **不新增 `schema/upgraded` 事件（B）**：迁移使用既有事件：`project/updated` schemaVersion 3 + 全量 `task/updated` + 受影响草稿的既有 `plan/updated`；回滚只能恢复迁移前备份。
4. 旧历史 commit 仍含旧名，但只在本机 store，不在发布包；运行时拒绝 v2 store。

实现默认（除非反对）：

1. review 下 agent 不得开关门（P0-2）。
2. `createdBy` 不算 worker。
3. 任何 agent 可驳回任何 review 任务（接受乒乓 DoS 面）。
4. human verify 不强制报告。
5. 审计报告内联，不强制落 project_doc。

## 10. 风险与回退

- 最大风险是 schema 改名迁移：v2 store 必须一次性升级；迁移脚本要覆盖所有终态任务；无 marker 时旧代码回滚不安全。缓解：dry-run + 备份 + 回放/health 验证 + 迁移测试 + 发布包纯净门禁。
- 运行时不再兼容 v2 store：已有项目必须跑迁移脚本；未跑时 fail-closed，不会静默丢门。
- 存量门控任务直接变为 agent 可审计；用户已明确接受，发布说明写清。
- 独立性是 session 级，无法防同一 agent 的子代理自审；R3 关键交付建议 human 复核。
- 驳回 DoS：v1 不自动限流；事件可见，后续可加冷却。
- 回滚：无 marker，旧代码读 v3 日志可能静默丢门；只能恢复迁移前备份；不撤销已完成的 agent 审计。
- 开工前置：D4、D5 与产品边界收敛均已验收；从基线 `f9ca3e6` 在专用候选工作树推进。计划 v7 的唯一候选任务承接六组验收，最终一次独立审查与用户统一验收；本文不授权合入、真实迁移、部署或重启。
