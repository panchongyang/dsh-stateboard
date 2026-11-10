# 计划 v2 设计：多实例、生命周期与可写管理面

- 状态：设计定稿（D1），C1 / C2 / H1 / U1 / U2 / T1 全部完成（2026-10-26 收口）
- 上游决策：[计划能力 v2](<decisions/plan-capability-v2.md>)
- 适用范围：lib/core、lib/host、lib/client.js、docs/CONTRACT.md、docs/DESIGN.md
- 一句话：计划是 initiative 级容器，可多实例、可归档、可聚焦；任务是唯一工作单元，不嵌套。

## 1. 术语与层级

| 层 | 对象 | 是否有状态机 | 说明 |
|---|---|---|---|
| 容器 | Plan / PlanHead | 有（draft/active/archived） | 一个 initiative 或交付目标 |
| 容器 | Step | 无 | 计划内的阶段，只做分组 |
| 工作单元 | Task | 有（8 状态） | 唯一可 claim / submit / verify 的对象 |
| 偏好 | focusPlanId | 无 | 人当前关注哪个计划 |

固定规则：

- 一个任务最多属于一个计划（planRef 单值）；不属于任何计划是合法状态（inbox）。
- 一个计划内，一个任务只出现在一个 step。
- 计划版本不可变；成员变化 = 新版本，不维护可变成员表。
- 计划不删除，只归档。

## 2. 数据模型

### 2.1 state 新增

    state.planHeads = {
      [planId]: {
        id, title,
        status: 'draft' | 'active' | 'archived',
        rev: number,                    // head 级 CAS
        currentVersion: number,         // draft 为 0
        draft: null | { goal, assumptions, risks, steps },
        archivedFrom: null | 'draft' | 'active',
        createdAt, updatedAt
      }
    }
    state.project.focusPlanId = planId | null
    state.project.currentPlanId    // 旧字段：只读兼容，迁移后不再写

    state.plans[planId + '@' + version]  // 不变：不可变版本快照
    state.currentPlans[planId]           // 不变：版本指针

### 2.2 PlanHead 与 PlanVersion 的分工

- head 承载身份、标题、状态、当前版本号、草稿。标题是 head 的属性；rename 不产生新版本。
- version 承载已发布的不可变内容：title、goal、assumptions、risks、steps[]、createdAt、publishedAt、supersedes。
- 草稿只存在 head.draft，不占版本号。publish 时物化为 version 1；之后 revise 产生 2、3……
- 历史版本保留旧标题，便于审计；列表与详情显示 head.title。

### 2.3 已发布版本的步骤

    steps: [{
      id: 's1',
      title: '阶段一',
      taskIds: ['tsk_...', 'tsk_...']
    }]

- steps 是成员关系的唯一事实源；task.planRef 是派生指针，由不变量 I16 校验。
- deps 仍只在任务图上表达顺序；step 不表达依赖。

### 2.4 完成度

- 不存 completed 字段。
- 计划完成 = 非 canceled 任务数大于 0 且全部 done；UI 显示派生徽章。
- 归档是显式动作；完成不会自动归档。
- 草稿进度恒为 0，taskCount 为 0。

## 3. 生命周期

| 当前 | 动作 | 结果 | 守卫 |
|---|---|---|---|
| — | plan.create | draft | 标题唯一（大小写不敏感，含 archived） |
| draft | plan.revise | draft（改 head.draft） | expectedRev |
| draft | plan.publish | active，currentVersion=1 | 至少 1 step（step 可为空）；每 task ≥1 acceptance；key 唯一；deps 存在且无环；同一 task 只在一个 step |
| active | plan.revise | active，version+1 | baseVersion == currentVersion；同 publish 校验；移除的任务标 orphaned |
| active | plan.adopt | active，version+1 | 任务 planRef 为空或指向本计划旧版本（orphaned）；step 必须存在；不得 in_progress |
| active | plan.release | active，version+1 | 任务必须在计划内；不得 in_progress；planRef 置 null，任务保留 |
| active | plan.archive | archived | 无 in_progress；无 live lease；archivedFrom='active' |
| draft | plan.archive | archived | archivedFrom='draft' |
| archived | plan.unarchive | archivedFrom 对应状态 | 无其他守卫 |
| active | plan.rename | active | 标题唯一；expectedRev；不产生版本 |
| 任意非 archived | plan.focus | focusPlanId 指向它 | 只能指向 active；human-only |

说明：

- draft 不出现在看板，只在计划列表可见；可以编辑、发布或归档。
- 归档不撤销 lease；所以先要求没有 in_progress。review / ready / backlog 可以随计划一起归档（只读）。
- 归档计划的任务仍可按任务状态机继续吗？不。归档后不允许新 claim；已有的 review 由人类决定 verify 或先 unarchive。C1 必须在 claim 守卫里增加“任务所属计划 archived → 拒绝 claim”。
- unarchive 回到 archive 前的状态；active 计划的 currentVersion 不变。
- 计划标题唯一性强，rename 冲突返回 plan-title-taken。

## 4. 命令面

所有命令都带 cmdId + actor；head 级修改用 expectedRev；版本级修改用 baseVersion；project 级（focus）用 projectRev。

### 4.1 plan.create

    { op: 'plan.create', title, goal?, assumptions?, risks?, steps? }

- 创建 head（status=draft，currentVersion=0，rev=1），draft = {goal, assumptions, risks, steps}。
- steps 可省略；省略时 draft.steps=[]。
- 事件：plan/created（完整 head）。
- 不做：不创建任务，不设 focus。

### 4.2 plan.revise

    { op: 'plan.revise', planId, expectedRev?, baseVersion?, title?, goal?, assumptions?, risks?, steps }

- draft：要求 expectedRev == head.rev；只更新 head.draft（title 也接受）；事件 plan/updated。
- active：要求 baseVersion == head.currentVersion；走现有 revise 逻辑（normalizeSteps → 校验 → version+1 → add/update/orphan）；事件 plan/revised + plan/superseded + task/updated|created|orphaned。
- archived：拒绝，错误 plan-archived。
- 不允许跨计划搬任务；需要先 release 再 adopt。

### 4.3 plan.publish

    { op: 'plan.publish', planId, expectedRev }

- 只允许 draft；事件 plan/published + 每个 task/created；同一 commit。
- 旧兼容：project_plan publish 不带 planId 时 = create + publish（单计划时代的行为保留）。
- 发布后 head.currentVersion=1，head.draft=null，status=active；若项目没有 focus，则自动 focus 到它。

### 4.4 plan.rename

    { op: 'plan.rename', planId, expectedRev, title }

- 只改 head.title 与 updatedAt；不产生新版本；事件 plan/updated。
- 标题唯一性检查包含 archived 计划。

### 4.5 plan.archive / plan.unarchive

    { op: 'plan.archive', planId, expectedRev }
    { op: 'plan.unarchive', planId, expectedRev }

- archive 守卫：head 非 archived；计划内没有 in_progress 任务；没有该计划任务的 live lease。
- 事件 plan/archived / plan/unarchived；archivedFrom 记录来源。
- 若 focusPlanId == planId，archive 后 focusPlanId 置 null（同 commit）。

### 4.6 plan.focus

    { op: 'plan.focus', planId | null, projectRev? }

- human-only（管理偏好）；agent 调用返回 forbidden-role。
- planId 必须 active；null 清空。
- 事件 plan/focused；写 project.focusPlanId 与 project 快照。

### 4.7 plan.adopt

    { op: 'plan.adopt', planId, baseVersion, taskIds, stepId }

- 只允许 active；stepId 必须存在。
- 每个 task 必须存在；planRef 为空，或指向本计划的旧版本（orphaned，重新归位）；不得 in_progress。
- 生成 version+1：steps 复制当前版本，把 taskIds 追加到目标 step；task.planRef 更新；事件 plan/revised + plan/superseded + task/updated。
- 不修改任务的 title/description/acceptance/deps。
- 幂等：已是当前版本成员的 taskId 跳过；已在别的计划 → plan-task-in-use；orphaned 归位后清 orphaned 标记。

### 4.8 plan.release

    { op: 'plan.release', planId, baseVersion, taskIds }

- 只允许 active；每个 task 当前 planRef.planId 必须是该计划。
- 不得 in_progress；生成 version+1，从所有 step 移除；task.planRef=null；任务保留。
- 与 orphan 的区别：orphan 是 revise 移除但保留旧 planRef 指针；release 是显式移出，planRef 清空，任务回到 inbox。

### 4.9 事件与 applyEvent

| 事件 | data | 语义 |
|---|---|---|
| plan/created | head | upsert head |
| plan/updated | head | rename / draft 变更 |
| plan/published | version + head | 版本入库、head.currentVersion=1、status=active |
| plan/revised | version + head | 版本入库、head.currentVersion=version |
| plan/superseded | 旧 version | 旧版本只读 |
| plan/archived | head | status=archived，清 focus（如指向它） |
| plan/unarchived | head | 回到 archivedFrom |
| plan/focused | {planId, projectRev} | 更新 project.focusPlanId |

applyEvent 必须幂等；同一事件 replay 两次结果相同。旧日志没有 head 事件，由 normalizePlanHeads 派生（§7）。

## 5. 读模型

### 5.1 PlanSummary

    {
      id, title, status, rev, currentVersion,
      focus: boolean,
      stepCount, taskCount,
      progress: { total, done, percent },
      steps: [{ id, title, taskIds }],
      archivedFrom, createdAt, updatedAt
    }

steps 带标题和已发布版本的任务 ID，供任务卡显示计划名和步骤名，并为推进视图提供成员归属。草案摘要的 taskIds 为空。

### 5.2 board

- 保持现有字段；新增 focusPlanId、plans: PlanSummary[]（仅 active）。
- plan 字段保留 = focus plan 的完整详情（兼容旧客户端）；没有 focus 时为 null。
- 前端用 board.plans 的 steps 做 join。任务卡投影和派发顺序见 [读模型契约](CONTRACT.md#25-query)。

### 5.3 view=plans

    { plans: PlanSummary[], focusPlanId, rev }

- 默认返回 draft + active + archived，按 status（active → draft → archived）与 updatedAt 排序。
- 可选 includeArchived=false 过滤；默认 true 供管理页使用。

### 5.4 view=plan

- 带 planId：返回该计划当前版本详情 + steps 展开 + progress。
- 不带 planId：保持旧行为，返回 focus plan。
- planId 不存在：plan-not-found。
- 草稿：返回 head.draft 的 steps（tasks 为空），progress 0。

### 5.5 brief

- 新增 plans: { active, draft, archived, focusPlanId } 摘要。
- next / attention 不变。

## 6. 宿主 / HTTP / 工具

### 6.1 工具

project_plan 新增 op：

    create / revise / publish / rename / archive / unarchive / focus / adopt / release

- 参数新增：planId、expectedRev、baseVersion、stepId、taskIds。
- 权限：create/revise/publish/adopt/release/rename/archive/unarchive 允许 agent + human；focus 仅 human（人的关注偏好）。
- project_board 新增 view=plans；view=plan 的 planId 变为常规参数。
- 工具描述更新：一个项目可有多个计划；计划=initiative；不要创建容器任务；归档用 archive，不删除。

### 6.2 HTTP

| method | path | 说明 |
|---|---|---|
| GET | /projects/:id/plans | 计划列表（PlanSummary[]） |
| GET | /projects/:id/plans/:planId | 计划详情 |
| GET | /projects/:id/plans/current | focus 别名（兼容） |

- 写仍然只走 POST /projects/:id/commands；不新增写端点。
- GET /plans 支持 includeArchived=0/1。

### 6.3 错误码

| code | status | 触发 |
|---|---|---|
| plan-not-found | 404 | planId 不存在 |
| plan-title-taken | 409 | 标题重复 |
| plan-not-draft | 409 | publish 需要 draft |
| plan-not-active | 409 | adopt/release/focus 需要 active |
| plan-archived | 409 | 对 archived 计划写操作 |
| plan-has-live-work | 409 | 归档时存在 in_progress 或 live lease |
| plan-task-in-use | 409 | 任务已属于其他计划 |
| plan-step-not-found | 400 | adopt 的目标 step 不存在 |
| plan-task-in-progress | 409 | adopt/release 的任务正在执行 |

NEXT 提示：先 project_board view=plans 读计划与 rev；冲突时重读再试；归档前先释放租约。

## 7. 迁移与兼容

### 7.1 版本

- meta.json / state.schemaVersion 使用3；计划能力 v2 是领域版本，不是运行时 store schema。
- 运行时拒绝低于3的 store，在可写尾修复前返回 schema-migration-required。维护者停宿主后使用包外离线升级脚本；接口与备份回滚见 [迁移](<MIGRATION.md>)。
- 升级保留原始 commit 与不可变计划版本键，使用既有 project/updated + 全量 task/updated；受影响草稿用既有 plan/updated 将门定义转为 requiresAudit / gate:audit。没有新事件类型，不自动归位成员。

### 7.2 派生算法（normalizePlanHeads，幂等）

对每个 plan id：

1. 收集所有版本，取最大 version。
2. 若 planHeads[id] 已存在且 currentVersion 有效，跳过。
3. 否则建 head：title=最新版本 title，status='active'，rev=1，currentVersion=最大版本，draft=null，archivedFrom=null，createdAt=最早版本 createdAt，updatedAt=最新版本 publishedAt。
4. 若 project.focusPlanId 为空且 project.currentPlanId 存在且在 heads 中，则 focusPlanId=currentPlanId。

- 该函数在 replay 结束、snapshot 加载、standalone 打开时都跑一次；纯函数、无事件。
- 旧日志中的 plan/published/revised 由 applyEvent 照旧写 plans/currentPlans；head 由 normalize 补。

### 7.3 兼容

- 旧字段 project.currentPlanId 保留只读：读时优先 focusPlanId，没有再回退 currentPlanId。
- 旧 board.plan 字段保留（focus 别名）。
- 旧 /plans/current 保留（focus 别名）。
- 旧工具行为：publish 不带 planId 仍可创建计划并发布；但一旦项目已有计划，不再 409，而是创建第二个计划。
- 计划外任务不自动归位；由人用 plan.adopt 或 UI 决定。（2026-10-26 实测计划外 15 条、orphaned 5 条；早期文案「29 条」已过期。核对入口 scripts/migrate-plans.mjs，规则与回滚边界见 docs/MIGRATION.md。）

## 8. 并发与幂等

- 单项目单日志，所有写串行提交；跨进程仍用 lock 只读降级。
- head 级命令：expectedRev（head.rev）不匹配 → stale-revision。
- 版本级命令：baseVersion 不匹配 → stale-revision（details 带 currentVersion）。
- focus：projectRev 不匹配 → stale-revision。
- cmdId 幂等沿用现有实现；重复命令返回原结果。
- 两个会话编辑不同计划不会互相冲突；编辑同一计划按 baseVersion 串行。
- adopt/release 内部复用 revise 的校验与事件构造，避免两套逻辑漂移。

## 9. 不变量

| # | 不变量 | 检查时机 | 违反 |
|---|---|---|---|
| I16 | 每个 task.planRef 指向存在的 plan@version，且该版本某个 step 含该 task | commit / fsck | 拒绝 / 告警 |
| I17 | planHeads[id].currentVersion 指向存在的版本；status=active 时 currentVersion ≥ 1；draft 时 =0 | commit / fsck | 拒绝 |
| I18 | focusPlanId 为空或指向 active 计划 | commit / fsck | 拒绝 / 告警 |
| I19 | 计划标题在项目内唯一（大小写不敏感，含 archived） | create/rename | plan-title-taken |
| I20 | 一个任务最多属于一个计划；同一计划内一个 task 只出现在一个 step | publish/revise/adopt/release/fsck | 拒绝 |
| I21 | archived 计划不产生任务状态变化；归档前无 in_progress / live lease | archive / claim | plan-has-live-work |

补充：

- I9（依赖无环）仍只作用于任务图；计划步骤不参与依赖。
- I11 扩展为“published plan 的所有 step 任务存在且 planRef 的 planId/version 匹配，或被显式 release”。
- fsck 对旧项目先 normalize 再检查，避免历史项目误报。

## 10. 测试矩阵

core（C1/C2）：

- 多计划：create ×2、active ×2、标题冲突、rename、archive/unarchive、focus 切换与清空。
- 生命周期：draft revise 不产生版本；publish 原子建任务；active revise 版本 +1；archived 写拒绝。
- 守卫：归档带 in_progress / live lease 拒绝；archived 计划任务 claim 拒绝。
- adopt/release：加入、移出、重复 adopt 幂等、跨计划拒绝、in_progress 拒绝、版本 +1。
- 迁移：合成旧 store 的离线升级/重放后 heads/focus 派生正确，草稿门定义保留，digest 稳定；schemaVersion3 写出。
- 不变量：I16–I21 每条至少一个反例测试。
- 并发：同一计划 baseVersion 冲突；不同计划并发 revise 不冲突。

host（H1）：

- project_plan 全部 op 的参数与错误码；focus 的 human-only 权限。
- project_board view=plans / view=plan&planId；board.plans 只含 active；旧字段兼容。
- GET /plans、/plans/:id、/plans/current；includeArchived。

client（U1/U2）：

- 纯逻辑：计划过滤、计划内外分类、步骤名 join、diff 概要、表单归一化。
- COMMANDS 白名单含 plan.*；所有写走 /commands。
- 人类验收：计划列表、新建、归档、聚焦、编辑、冲突提示；截图不少于 5 张。

T1（回归收口）：

- 多计划并发：两个 active 计划交错 revise（各自 baseVersion CAS）、focus 切换与归档清 focus、archive 拒绝 live work 且不影响兄弟计划、adopt/release version+1、orphan 归位、board/plans 读模型过滤、digest 字节稳定（test/core/plan-concurrency.test.mjs）。
- 迁移/回放：hermetic 副本用例 + 真实旧项目副本（PB_MIGRATION_PROJECT 选择加入，CI 可重入）；副本前后 rev/任务数/planHeads/focus/health 不变、原目录逐字节不变、计划外/orphan 保持原状（test/storage/migration-replay.test.mjs）。
- host/client：/plans 三路由与 plan.revise/publish/adopt/release/archive 错误码；host-tools 全 op 错误码与 view=plans；client-smoke 多计划列表/聚焦/过滤纯逻辑。
- 文档：CONTRACT/README/MIGRATION/CHANGELOG 收口。

## 11. 实施顺序与归属

| 任务 | 内容 | 依赖 |
|---|---|---|
| D1 | 本设计与 DESIGN/CONTRACT/README 同步 | — |
| C1 | planHeads、多实例、draft/active/archived、focus、normalize、fsck、单测 | D1 |
| C2 | adopt/release、版本化成员、orphan、并发测试 | C1 |
| H1 | 工具 op、view=plans、/plans 路由、prompt、测试 | C1,C2 |
| U1 | 计划列表/新建/归档/聚焦、看板过滤、R2 分类 | H1 |
| U2 | 计划详情编辑、orphan 警告、baseVersion 冲突 | U1 |
| T1 | 迁移回归、并发、client-smoke、文档收口 | C2,H1,U2 |

截至 2026-10-26：D1–T1 全部完成。迁移核对入口是 `scripts/migrate-plans.mjs`（用法与回滚边界见 docs/MIGRATION.md）；回归测试在 test/core/plan-concurrency.test.mjs 与 test/storage/migration-replay.test.mjs。

C1 完成前不要动 lib/client.js 的计划页；U1 之前不要删除旧 /plans/current 与 board.plan。

## 12. 已拍板与待定

已拍板：

1. draft 不进看板，只在计划列表显示。
2. 归档允许有 review/ready/backlog 任务，但禁止 in_progress / live lease。
3. 跨计划移动 = release → adopt 两步，不做跨计划原子移动。
4. adopt 的目标 step 必须已存在；不存在先 revise 加 step。
5. 计划完成是派生徽章，不新增状态；归档才是显式退役。
6. task.create 不接受 planRef；成员关系只通过计划版本变化。
7. 计划标题全局唯一（含 archived）。
8. 计划删除不做；归档不可逆（可 unarchive，但无 delete）。

已随实现确认：

- head.rev 与 project.rev 的事件粒度：head 快照随 plan/created、plan/published、plan/revised 事件写，replay 后 normalizePlanHeads 兜底（C1 落地）。
- archived 计划的 review 任务：UI 计划页对 archived 只读（planCanEdit=false）；归档前守卫拒绝 in_progress / live lease（U2 落地）。
- plan.adopt 的 taskIds 数量：当前不设上限（不变量 I20 仍保证同一计划内单步唯一）；将来需要再限（可参考 doc.links 上限 100）。

## 13. 非目标

- 任务 parentId / 子任务 / 父子 rollup。
- step 嵌套（保留为未来扩展；只允许容器层）。
- 跨项目计划、计划模板、计划复制、计划删除。
- 计划实时协同编辑、拖拽排序、甘特图。
- 自动把会话 plan mode 文本导入计划。
