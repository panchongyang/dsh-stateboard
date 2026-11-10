# 增补：过滤规则 v1.1（done 时间窗 + 多计划作用域）

> 状态：待评审（未实现、未建任务）
> 覆盖主文档 [过滤规则 v1](./filter-rules-v1.md) 的 §3.2（状态）与 §3.4（计划）；其余条款不变。
> 触发规则：**（排除 done 的所有任务 + 24 小时内的 done）AND（n1、n2、n3 计划内）**

## 1. 结论：v1 原样表达不了

两处缺口：

1. **状态维度没有 per-value 时间限定**：多选只能表达“全部 done / 不含 done”。若新增独立“时间”维度，跨维 AND 会把 `非 done` 与 `done 且 24h 内` 变成交集（空集），无法表达并集。
2. **计划维度只有单计划 + 步骤**：不能表达 `n1 OR n2 OR n3` 的多计划。

修法不是引入 OR 规则树，而是把两个限定放回各自维度内部：

- 时间窗是 **`done` 这个状态值的限定词**，不是独立维度；
- 多计划是 **计划维度内部的多作用域 OR**，不是“planIds 维度 + steps 维度”。

这样“跨维 AND、维内 OR”的总原则不变。

---

## 2. 状态维度 v1.1

### 2.1 Schema

```json
"states": {
  "values": ["backlog", "ready", "in_progress", "review", "blocked", "interrupted", "done"],
  "doneWithinHours": 24
}
```

- `values`：仍是 8 个状态的多选，维内 OR。
- `doneWithinHours`：整数 `1..8760` 或 `null`；只对 `values` 里的 `done` 生效。
- `null` = 所有 done（不设时间窗）。

### 2.2 匹配

```text
if values.length === 0:
    stateOK = true
else if card.state !== 'done':
    stateOK = values.includes(card.state)
else:
    stateOK = values.includes('done')
              && (doneWithinHours == null
                  || parsedUpdatedAt(card.updatedAt) >= now - doneWithinHours * 3600_000)
```

- 非 done 状态不受 `doneWithinHours` 影响。
- `done` 的 `updatedAt` 解析失败（缺失/非法）：时间窗开启时视为不命中；时间窗关闭时正常命中。
- 时间窗是**滚动窗口**，相对每次匹配的 `now`，不是相对方案创建/保存时间。

### 2.3 规范化

- `values` 不含 `done` 时，`doneWithinHours` 强制归 `null`（惰性值不进入相等比较）。
- `values` 为空 = 关闭（`doneWithinHours` 也归 `null`）。
- 原有“选中全部 8 个状态 → 归零关闭”规则加一个例外：
  - `doneWithinHours === null`：全部选中 → `values=[]`（关闭）；
  - `doneWithinHours !== null`：**保留全部选中**（语义是“所有非 done + 最近 N 小时的 done”，不等于关闭）。
- `doneWithinHours` 非整数/越界 → `null`（该限定失效，不拖垮整条规则）。

### 2.4 UI

- 勾选 `已完成` 时，出现一个小选择：`全部 / 1 小时 / 24 小时 / 7 天`（分别存 `null / 1 / 24 / 168`）。
- “活跃（未完成）”快捷项 = 选中 6 个非 done 状态，`doneWithinHours=null`；用户再勾 `已完成` 并选 24h，即得到目标并集。
- 规则摘要文案：`状态：活跃 + 24h 内完成`。

---

## 3. 计划维度 v1.1

### 3.1 Schema

```json
"plan": {
  "mode": "any" | "unplanned" | "planned" | "scopes",
  "scopes": [
    { "planId": "pln_n1", "stepIds": [] },
    { "planId": "pln_n2", "stepIds": [] },
    { "planId": "pln_n3", "stepIds": [] }
  ]
}
```

- `mode` 仍互斥：
  - `any`：关闭；
  - `unplanned`：`planRef == null`；
  - `planned`：`planRef != null`；
  - `scopes`：命中任一作用域。
- 每个 scope = `planId` + `stepIds[]`；`stepIds=[]` 表示**该计划全部步骤**。
- 维内 OR：多个 scope 之间 OR；scope 内是“计划 AND（步骤为空 OR 步骤在集合中）”。
- 步骤始终绑定在计划下，不存在“只选步骤不选计划”的悬空规则。

### 3.2 匹配

```text
planOK =
  mode === 'any'      ? true :
  mode === 'unplanned'? !card.planRef :
  mode === 'planned'  ? !!card.planRef :
  !!card.planRef && scopes.some(s =>
      s.planId === card.planRef.planId
      && (s.stepIds.length === 0 || s.stepIds.includes(card.planRef.stepId)))
```

### 3.3 规范化

- `mode !== 'scopes'` → `scopes=[]`。
- `mode === 'scopes'` 且 `scopes=[]` → 归 `mode='any'`（关闭），不是 `planned`。
- 同一 planId 的多个 scope 合并：
  - 只要有一个 scope 的 `stepIds=[]`（整计划），该计划合并为整计划；
  - 否则 `stepIds` 去重取并集。
- `planId` 为空/非法的 scope 丢弃；全部丢弃 → `any`。
- 计划被归档/暂不在目录：scope 保留（按 planId 仍能匹配卡片），UI 摘要标“计划不可用”，不静默删除。

### 3.4 UI

- 模式选“指定计划/步骤”后：计划多选（chips），每个已选计划可展开选择步骤（步骤 chips）。
- 目标规则只需选 `n1/n2/n3` 三个计划，不展开步骤，即三个 `stepIds=[]` 的 scope。
- 换项目时 scope 属于旧项目 → 清空计划维度并提示（沿用按项目隔离的原则）。

---

## 4. 目标规则的精确表示

```json
{
  "query": "",
  "states": {
    "values": ["backlog", "ready", "in_progress", "review", "blocked", "interrupted", "done"],
    "doneWithinHours": 24
  },
  "gate": "any",
  "plan": {
    "mode": "scopes",
    "scopes": [
      { "planId": "pln_n1", "stepIds": [] },
      { "planId": "pln_n2", "stepIds": [] },
      { "planId": "pln_n3", "stepIds": [] }
    ]
  },
  "labels": { "mode": "any", "values": [] },
  "priority": { "max": null }
}
```

等价的判定式：

```text
stateOK = (state !== 'done' && values.includes(state))
       || (state === 'done' && values.includes('done')
           && updatedAt >= now - 24h)
planOK  = planRef != null && planRef.planId ∈ {n1, n2, n3}   // stepIds=[] ⇒ 整计划
result  = stateOK && planOK
```

UI 读法：

- 状态：`全部活跃状态` + `已完成（24 小时内）`
- 计划：`指定计划：n1、n2、n3`（不限步骤）
- 其余维度关闭。

> 备注：如果 `n1/n2/n3` 实际指**步骤**而非计划，则把三个 scope 改成 `{ planId: <所属计划>, stepIds: ["n1"] }` 的形式；同一计划下的多个步骤可合并进一个 scope。语义仍是“任一 scope 命中”。

---

## 5. 正交性复查

1. **时间限定不新增维度**：它只改写 `done` 这个值的匹配，因此“非 done OR 最近 done”能在一个维度内用 OR 完成；跨维仍是 AND。
2. **计划仍是一个维度**：多计划与步骤都是该维度的内部作用域；不引入独立的 `planIds`/`stepIds` 两个维度，避免“步骤脱离计划”的悬空组合。
3. **全选归零的例外必须写进契约**：带 `doneWithinHours` 时全选状态 ≠ 关闭；否则目标规则会被规范化错误地清空。
4. **否定仍只由模式表达**：没有 `not done`；用“选中哪些状态”表达。
5. **时间窗存相对小时数，不存绝对时间**：方案应用/刷新/隔天打开都相对当前时间重新计算；预设可复现的是“规则”，不是“当时的结果集”。
6. **比较相等（dirty 判定）包含 `doneWithinHours` 与 scopes**；惰性值（done 未选时的窗口、非 scopes 模式的 scopes）先归零再比较。

---

## 6. 时间字段取舍（已定）

- **v1.1 用 `card.updatedAt` 作为 done 的时间依据**，不新增字段、不改 core/读模型。
- 理由：done 是终态；`taskUpdate` 拒绝终态，`taskVerify`/auto-verify 会把 `updatedAt` 推到完成时刻，因此 `updatedAt` 对 done 卡片是足够好的完成时间近似。此判断写入文档，避免被误解为“精确完成时刻”。
- 若以后要求审计级精确，可给 `cardOf` 增加只读 `verifiedAt`（task 上已有该字段），匹配时 `verifiedAt || updatedAt`。那是**小范围 core 读模型增补**，需要单独升级边界与契约测试，不在本次 v1.1 内。
- 时间窗边界：`now - N*3600_000` 含等号；测试覆盖 `now-1ms / now / now+1ms` 的边界。
- `now` 由调用方注入（board 每轮刷新取一次），匹配函数保持纯函数；不读系统时钟，便于单测与“同一帧一致”。

---

## 7. 对原计划任务/验收的影响

- **t1 规则模型**：新增 `doneWithinHours` 与 `plan.scopes` 的规范化/匹配/相等/摘要；新增“全选状态 + 时间窗不归零”的反例测试。
- **t2 存储**：v2 schema 按本增补调整；迁移仍映射 v0 的 `state/plan`，`doneWithinHours` 默认 `null`。
- **t3 接入**：匹配上下文增加 `{ now, plans }`；board 每轮刷新注入同一个 `now`，保证列/托盘/列表同一帧结果一致。
- **t5 UI**：状态节增加 done 时间窗选择；计划节改为多选计划 + 可展开步骤。
- **t9 验收**：新增目标规则的端到端 fixture——`(全部非 done + 24h done) AND (n1|n2|n3)` 的命中 id 集合与手算一致；边界时间、跨天重开、预设重新应用（窗口相对 now 平移）各一条。
- 风险仍是 R2；唯一新增风险是“时间依赖导致 UI 不稳定”，用注入 `now` + 固定时钟测试 + 每轮刷新一次取时消除。

---

## 8. 边界备注

- `canceled`：board payload 不返回 canceled 卡片；若未来返回，“排除 done”需显式勾选/不勾选 canceled，当前默认不选。
- `n1/n2/n3` 若为步骤：用 `scopes[{planId, stepIds:[...]}]`，仍是一维 OR。
- 规则摘要：`状态：活跃 + 24h 内完成`；`计划：n1、n2、n3`。
- 本增补不改变主文档的其余决策：跨维 AND、维内 OR、方案快照、按项目隔离、看板/列表同源。
